import * as dgram from "dgram";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { promises as fs } from "fs";

const PROTOCOL = "secure-git-sync-lan-v1";
const LAN_CONCURRENCY = 6;

export interface LanSyncSettings {
  lanSyncEnabled: boolean;
  lanDeviceId: string;
  lanDeviceName: string;
  lanDiscoveryPort: number;
  lanHttpPort: number;
}

export interface LanPeer {
  id: string;
  name: string;
  host: string;
  port: number;
  lastSeen: number;
}

export interface LanProgressEvent {
  phase: "scan" | "network" | "apply";
  message: string;
  elapsedMs?: number;
}

interface LanManifestFile {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

interface LanManifest {
  deviceId: string;
  files: LanManifestFile[];
}

type ProgressFn = (event: LanProgressEvent) => void;

export class LanSyncService {
  private server: http.Server | null = null;
  private socket: dgram.Socket | null = null;
  private settings: LanSyncSettings | null = null;
  private currentPort = 0;
  private readonly peerMap = new Map<string, LanPeer>();

  constructor(private readonly vaultPath: string, private readonly configDir: string) {}

  peers(): LanPeer[] {
    const cutoff = Date.now() - 1000 * 60 * 5;
    return Array.from(this.peerMap.values())
      .filter((peer) => peer.lastSeen >= cutoff)
      .sort((left, right) => right.lastSeen - left.lastSeen);
  }

  async start(settings: LanSyncSettings): Promise<void> {
    this.settings = settings;
    if (!settings.lanSyncEnabled) {
      await this.stop();
      return;
    }
    await this.startHttpServer(settings);
    await this.startDiscovery(settings);
    await this.refresh();
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async refresh(): Promise<void> {
    if (!this.socket || !this.settings) {
      return;
    }
    const payload = this.discoveryPayload("discover");
    this.socket.setBroadcast(true);
    this.socket.send(payload, this.settings.lanDiscoveryPort, "255.255.255.255");
    for (const address of broadcastAddresses()) {
      this.socket.send(payload, this.settings.lanDiscoveryPort, address);
    }
  }

  async syncWith(peer: LanPeer, onProgress?: ProgressFn): Promise<string> {
    const localManifest = await timedLan("scan", "scan local files", () => this.buildManifest(), onProgress);
    const remoteManifest = await timedLan("network", `read manifest from ${peer.name}`, () => this.fetchJson<LanManifest>(peer, "/manifest"), onProgress);
    const localByPath = new Map(localManifest.files.map((file) => [file.path, file]));
    const remoteByPath = new Map(remoteManifest.files.map((file) => [file.path, file]));
    const paths = Array.from(new Set([...localByPath.keys(), ...remoteByPath.keys()])).sort();
    let uploaded = 0;
    let downloaded = 0;
    let skipped = 0;

    await timedLan("apply", `sync ${paths.length} files`, async () => {
      await mapLimit(paths, LAN_CONCURRENCY, async (filePath) => {
        const local = localByPath.get(filePath);
        const remote = remoteByPath.get(filePath);
        if (local && !remote) {
          await this.uploadFile(peer, filePath);
          uploaded += 1;
          return;
        }
        if (!local && remote) {
          await this.downloadFile(peer, filePath);
          downloaded += 1;
          return;
        }
        if (!local || !remote || local.hash === remote.hash) {
          skipped += 1;
          return;
        }
        if (remote.mtimeMs > local.mtimeMs) {
          await this.downloadFile(peer, filePath);
          downloaded += 1;
        } else {
          await this.uploadFile(peer, filePath);
          uploaded += 1;
        }
      });
    }, onProgress);

    return `LAN sync with ${peer.name}: ${uploaded} uploaded, ${downloaded} downloaded, ${skipped} unchanged.`;
  }

  private async startHttpServer(settings: LanSyncSettings): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.currentPort = await listenOnAvailablePort(this.server, settings.lanHttpPort);
  }

  private async startDiscovery(settings: LanSyncSettings): Promise<void> {
    if (this.socket) {
      return;
    }
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("message", (message, remote) => {
      this.handleDiscoveryMessage(message, remote.address);
    });
    await new Promise<void>((resolve) => {
      this.socket!.bind(settings.lanDiscoveryPort, () => resolve());
    });
  }

  private handleDiscoveryMessage(message: Buffer, host: string): void {
    if (!this.settings) {
      return;
    }
    try {
      const payload = JSON.parse(message.toString("utf8")) as { protocol?: string; action?: string; id?: string; name?: string; port?: number };
      if (payload.protocol !== PROTOCOL || !payload.id || payload.id === this.settings.lanDeviceId || !payload.port) {
        return;
      }
      this.peerMap.set(payload.id, {
        id: payload.id,
        name: payload.name || payload.id,
        host,
        port: payload.port,
        lastSeen: Date.now(),
      });
      if (payload.action === "discover") {
        this.socket?.send(this.discoveryPayload("announce"), this.settings.lanDiscoveryPort, host);
      }
    } catch {
      // Ignore unrelated LAN traffic.
    }
  }

  private discoveryPayload(action: "discover" | "announce"): Buffer {
    const settings = this.settings!;
    return Buffer.from(JSON.stringify({
      protocol: PROTOCOL,
      action,
      id: settings.lanDeviceId,
      name: settings.lanDeviceName,
      port: this.currentPort || settings.lanHttpPort,
    }), "utf8");
  }

  private async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/info") {
        this.sendJson(response, {
          protocol: PROTOCOL,
          id: this.settings?.lanDeviceId,
          name: this.settings?.lanDeviceName,
          port: this.currentPort,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/manifest") {
        this.sendJson(response, await this.buildManifest());
        return;
      }
      if (request.method === "GET" && url.pathname === "/file") {
        const filePath = this.requestPath(url);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(await fs.readFile(this.resolveVaultPath(filePath)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/file") {
        const filePath = this.requestPath(url);
        const body = await readRequestBody(request);
        const absolutePath = this.resolveVaultPath(filePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, body);
        this.sendJson(response, { ok: true });
        return;
      }
      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      response.writeHead(400);
      response.end(error instanceof Error ? error.message : String(error));
    }
  }

  private requestPath(url: URL): string {
    const value = normalizeVaultPath(url.searchParams.get("path") ?? "");
    if (!value || !this.shouldSyncPath(value)) {
      throw new Error("Invalid LAN sync path.");
    }
    return value;
  }

  private async buildManifest(): Promise<LanManifest> {
    const files: string[] = [];
    await walkVault(this.vaultPath, "", files, (filePath) => this.shouldSyncPath(filePath));
    const manifestFiles = await mapLimit(files.sort(), LAN_CONCURRENCY, async (filePath) => {
      const absolutePath = this.resolveVaultPath(filePath);
      const stat = await fs.stat(absolutePath);
      const bytes = await fs.readFile(absolutePath);
      return {
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    return {
      deviceId: this.settings?.lanDeviceId ?? "",
      files: manifestFiles,
    };
  }

  private shouldSyncPath(filePath: string): boolean {
    const normalized = normalizeVaultPath(filePath);
    const first = normalized.split("/")[0];
    if (!normalized || [".git", ".secure-git-sync", ".secure-git-sync-conflicts", ".secure-git-sync-trash"].includes(first)) {
      return false;
    }
    const config = normalizeVaultPath(this.configDir);
    return normalized !== `${config}/plugins/secure-git-sync/data.json`
      && normalized !== `${config}/plugins/secure-git-sync/cache.json`
      && normalized !== `${config}/plugins/obsidian-secure-git-sync/data.json`
      && normalized !== `${config}/plugins/obsidian-secure-git-sync/cache.json`;
  }

  private async uploadFile(peer: LanPeer, filePath: string): Promise<void> {
    const bytes = await fs.readFile(this.resolveVaultPath(filePath));
    await this.postBytes(peer, `/file?path=${encodeURIComponent(filePath)}`, bytes);
  }

  private async downloadFile(peer: LanPeer, filePath: string): Promise<void> {
    const bytes = await this.fetchBytes(peer, `/file?path=${encodeURIComponent(filePath)}`);
    const absolutePath = this.resolveVaultPath(filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, bytes);
  }

  private async fetchJson<T>(peer: LanPeer, pathname: string): Promise<T> {
    return JSON.parse((await this.fetchBytes(peer, pathname)).toString("utf8")) as T;
  }

  private fetchBytes(peer: LanPeer, pathname: string): Promise<Buffer> {
    return requestBytes({ method: "GET", host: peer.host, port: peer.port, path: pathname });
  }

  private postBytes(peer: LanPeer, pathname: string, bytes: Buffer): Promise<Buffer> {
    return requestBytes({ method: "POST", host: peer.host, port: peer.port, path: pathname }, bytes);
  }

  private sendJson(response: http.ServerResponse, value: unknown): void {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  private resolveVaultPath(filePath: string): string {
    const normalized = normalizeVaultPath(filePath);
    const root = path.resolve(this.vaultPath);
    const resolved = path.resolve(root, normalized);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("Refusing to access a path outside the vault.");
    }
    return resolved;
  }
}

async function timedLan<T>(phase: LanProgressEvent["phase"], message: string, fn: () => Promise<T>, onProgress?: ProgressFn): Promise<T> {
  const started = Date.now();
  const result = await fn();
  onProgress?.({ phase, message, elapsedMs: Date.now() - started });
  return result;
}

function listenOnAvailablePort(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, attemptsLeft: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(port + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "0.0.0.0");
    };
    tryPort(preferredPort, 20);
  });
}

function requestBytes(options: http.RequestOptions, body?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(bytes.toString("utf8") || `HTTP ${response.statusCode}`));
          return;
        }
        resolve(bytes);
      });
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function broadcastAddresses(): string[] {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family !== "IPv4" || item.internal || !item.address || !item.netmask) {
        continue;
      }
      const address = ipv4ToNumber(item.address);
      const mask = ipv4ToNumber(item.netmask);
      addresses.add(numberToIpv4((address & mask) | (~mask >>> 0)));
    }
  }
  return Array.from(addresses);
}

function ipv4ToNumber(value: string): number {
  return value.split(".").reduce((result, part) => ((result << 8) + Number(part)) >>> 0, 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 255)).join(".");
}

async function walkVault(root: string, relativeDir: string, results: string[], shouldInclude: (filePath: string) => boolean): Promise<void> {
  const absoluteDir = resolveWithinRoot(root, relativeDir || ".");
  let entries: Array<import("fs").Dirent>;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relativePath = normalizeVaultPath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (shouldInclude(relativePath)) {
        await walkVault(root, relativePath, results, shouldInclude);
      }
    } else if (entry.isFile() && shouldInclude(relativePath)) {
      results.push(relativePath);
    }
  }
}

function resolveWithinRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Refusing to access a path outside the vault.");
  }
  return resolvedTarget;
}

function normalizeVaultPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}
