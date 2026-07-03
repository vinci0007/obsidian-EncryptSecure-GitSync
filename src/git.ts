import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { normalizePath } from "obsidian";
import { decryptFileBytes, decryptJson, encryptFileBytes, encryptJson, sha256Hex, verifyPassword } from "./crypto";
import { DifferenceCounts, GitProviderId, GitProgressEvent, GitRunResult, NoteBlockRecord, NoteFileBlockIndex, PasswordConfig, ProviderAccount, RemoteConfig, SecureGitSettings, SyncConflictResolution, SyncDifferenceSummary } from "./types";

const EXCLUDED_TOP_LEVEL = new Set([".git", ".obsidian"]);
const SECURE_DIR = ".secure-git-sync";
const MANIFEST_PATH = `${SECURE_DIR}/manifest.enc`;
const MANIFEST_AAD = `${SECURE_DIR}/manifest`;
const KEYRING_PATH = `${SECURE_DIR}/keyring.json`;
const DEFAULT_SYNC_RESOLUTION: SyncConflictResolution = {
  notes: "merge",
  obsidian: "merge",
  plugins: "merge",
};
const CONFLICTS_DIR = ".secure-git-sync-conflicts";
const NOTE_TRASH_DIR = ".secure-git-sync-trash";
const CONFLICT_COPY_PATHSPEC_EXCLUSIONS = [
  ":(exclude)**/*.sync-conflict-*",
  ":(exclude)**/* (conflicted copy*",
  ":(exclude)**/* (conflict copy*",
  ":(exclude)**/*\u51b2\u7a81\u526f\u672c*",
];
const SELF_PLUGIN_DIR_NAMES = new Set(["secure-git-sync", "obsidian-secure-git-sync"]);
const SELF_PLUGIN_RUNTIME_FILES = new Set(["manifest.json", "main.js", "styles.css"]);

interface EncryptedManifestFile {
  id?: string;
  hash: string;
  size: number;
  objectPath: string;
  updatedAt: string;
  contentUpdatedAt?: string;
  pathUpdatedAt?: string;
  blocks?: NoteBlockRecord[];
  deletedBlocks?: NoteBlockRecord[];
}

interface EncryptedManifestTombstone {
  id: string;
  path: string;
  deletedAt: string;
  lastHash?: string;
}

interface EncryptedManifest {
  version: 1 | 2;
  crypto: {
    kdf: "PBKDF2-SHA-256" | "Argon2id";
    kdfParams?: {
      iterations: number;
      memoryKiB?: number;
      parallelism?: number;
      hashLength?: number;
    };
    cipher: "AES-256-GCM";
    keyWrapCipher?: "AES-256-GCM";
    keyId?: string;
    manifestAad: string;
    objectAad: "vault-relative-path";
  };
  files: Record<string, EncryptedManifestFile>;
  tombstones?: Record<string, EncryptedManifestTombstone>;
  plaintext?: EncryptedPlaintextSnapshot;
}

interface EncryptedPlaintextSnapshot {
  obsidianHash?: string;
  obsidianFiles?: Record<string, PlaintextSnapshotFile>;
}

interface PlaintextSnapshotFile {
  oid: string;
  size: number;
}

interface TreeEntry {
  oid: string;
  file: string;
}

interface TreeEntryWithSize extends TreeEntry {
  size: number;
}

interface GitAuthContext {
  env?: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

interface PluginVersionInfo {
  version: string;
  releaseDate: string;
  buildTime: string;
}

interface PluginSyncChoice {
  useRemote: boolean;
  reason: string;
}

interface ProtectedInitialPullFile {
  file: string;
  contents: Buffer;
  category: keyof SyncConflictResolution;
}

interface InitialPullMergeResult {
  restoredPluginFiles: number;
  mergedFiles: number;
  conflictCopies: number;
}

interface PullEncryptedResult {
  restored: number;
  plaintextChanged: boolean;
  key: CryptoKey;
  importedRemoteKey: boolean;
  importedLocalKeyring: boolean;
  remoteKeyring?: PasswordConfig;
}

export interface SyncCredential {
  username: string;
  password: string;
  localKeyring?: PasswordConfig | null;
}

export interface PullResult {
  summary: string;
  restored: number;
  plaintextChanged: boolean;
  conflictCopies: number;
  conflictDirs: string[];
  remoteEncrypted: boolean;
  key?: CryptoKey;
}

export interface ConflictFilePair {
  id: string;
  conflictDir: string;
  category: keyof SyncConflictResolution;
  file: string;
  localConflictPath?: string;
  remoteConflictPath?: string;
  hasLocal: boolean;
  hasRemote: boolean;
}

export interface ConflictFileContent extends ConflictFilePair {
  localText: string;
  remoteText: string;
  isText: boolean;
}

export interface NoteConsistencyResult extends DifferenceCounts {
  consistent: boolean;
  localNotes: number;
  remoteNotes: number;
}

type ProgressFn = (event: GitProgressEvent) => void;

async function timed<T>(phase: GitProgressEvent["phase"], message: string, fn: () => Promise<T>, onProgress?: ProgressFn): Promise<T> {
  onProgress?.({ phase, kind: "start", message });
  const start = Date.now();
  try {
    const result = await fn();
    onProgress?.({ phase, kind: "end", message, elapsedMs: Date.now() - start });
    return result;
  } catch (error) {
    onProgress?.({ phase, kind: "end", message: `${message} (failed)`, elapsedMs: Date.now() - start });
    throw error;
  }
}

export class GitService {
  constructor(private readonly vaultPath: string) {}

  async ensureRepository(): Promise<void> {
    if (!(await exists(path.join(this.vaultPath, ".git")))) {
      await this.git(["init"]);
    }
  }

  async ensureRemote(remote: RemoteConfig): Promise<void> {
    await this.ensureRepository();
    const remotes = (await this.gitText(["remote"])).split(/\r?\n/).filter(Boolean);
    if (remotes.includes(remote.name)) {
      await this.git(["remote", "set-url", remote.name, remote.url]);
    } else {
      await this.git(["remote", "add", remote.name, remote.url]);
    }
  }

  async push(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    key: CryptoKey | null,
    onProgress?: ProgressFn,
    options: { includePlugins?: boolean; credential?: SyncCredential } = {},
  ): Promise<string> {
    await this.ensureRemote(remote);
    const auth = await createGitAuthContext(remote, settings);

    try {
      const remoteEncrypted = !settings.encryptionEnabled
        ? await timed("network", `detect encrypted remote ${remote.name}/${remote.branch}`, () => this.remoteHasEncryptedManifest(remote, auth.env), onProgress)
        : false;
      const useEncryptedRemote = settings.encryptionEnabled || remoteEncrypted;
      if (!useEncryptedRemote) {
        await timed("local", "commit plaintext", () => this.commitLocalPlaintext(settings.commitMessageTemplate), onProgress);
        await timed("network", `push HEAD to ${remote.name}/${remote.branch}`, () => this.git(["push", remote.name, `HEAD:${remote.branch}`], auth.env), onProgress);
        return `Pushed to ${remote.name}/${remote.branch}.`;
      }

      if (!key) {
        throw new Error("Encryption key is required.");
      }

      await timed("local", "commit plaintext", () => this.commitLocalPlaintext(settings.commitMessageTemplate, true, Boolean(options.includePlugins)), onProgress);
      const result = await this.pushEncryptedObjects(remote, settings, key, auth.env, onProgress, Boolean(options.includePlugins), options.credential);
      if (result.skipped) {
        return `No encrypted changes to push to ${remote.name}/${remote.branch}.`;
      }
      const detected = remoteEncrypted ? " Auto-detected encrypted remote." : "";
      return `Pushed encrypted snapshot to ${remote.name}/${remote.branch}: ${result.changed} changed, ${result.reused} reused.${detected}`;
    } finally {
      await auth.cleanup();
    }
  }

  async pull(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    key: CryptoKey | null,
    onProgress?: ProgressFn,
    resolution: SyncConflictResolution = DEFAULT_SYNC_RESOLUTION,
    credential?: SyncCredential,
  ): Promise<PullResult> {
    await this.ensureRemote(remote);
    const auth = await createGitAuthContext(remote, settings);

    try {
      const remoteEncrypted = !settings.encryptionEnabled
        ? await timed("network", `detect encrypted remote ${remote.name}/${remote.branch}`, () => this.remoteHasEncryptedManifest(remote, auth.env), onProgress)
        : false;
      const useEncryptedRemote = settings.encryptionEnabled || remoteEncrypted;
      if (!useEncryptedRemote) {
        return await this.pullPlaintext(remote, settings, auth.env, onProgress, resolution);
      }

      if (!key) {
        throw new Error("Encryption key is required.");
      }

      const pullState = await this.pullEncryptedObjects(remote, settings, key, auth.env, onProgress, resolution, credential);
      key = pullState.key;
      if (pullState.remoteKeyring) {
        settings.password = pullState.remoteKeyring;
      }
      if (pullState.plaintextChanged) {
        await timed("local", "commit pulled plaintext", () => this.commitLocalPlaintext(settings.commitMessageTemplate, true, resolution.plugins !== "local"), onProgress);
      } else {
        onProgress?.({ phase: "local", kind: "info", message: "no pulled plaintext changes to commit" });
      }
      await this.pruneConflictCopies(settings.conflictRetentionDays);
      const conflictDirs = await this.listConflictDirs();
      const conflictCopies = await countConflictFiles(this.vaultPath);
      return {
        summary: `${remoteEncrypted ? "Auto-detected encrypted remote. " : ""}${pullState.importedRemoteKey ? "Imported remote encryption key. " : ""}${pullState.importedLocalKeyring ? "Imported local keyring. " : ""}Pulled and decrypted ${pullState.restored} encrypted notes from ${remote.name}/${remote.branch}.`,
        restored: pullState.restored,
        plaintextChanged: pullState.plaintextChanged,
        conflictCopies,
        conflictDirs,
        remoteEncrypted: true,
        key,
      };
    } finally {
      await auth.cleanup();
    }
  }

  async status(): Promise<string> {
    await this.ensureRepository();
    return this.gitText(["status", "--short", "--branch"]);
  }

  async hasLocalPlaintextChanges(includePlugins = false): Promise<boolean> {
    await this.ensureRepository();
    const commonExclusions = commonSyncPathspecExclusions();
    const pathspecs = includePlugins
      ? [".", ...selfPluginPathspecExclusions(), ...commonExclusions]
      : [".", ":(exclude).obsidian/plugins/**", ...commonExclusions];
    const porcelain = await this.gitText(["status", "--porcelain", "--", ...pathspecs]);
    return porcelain.trim().length > 0;
  }

  async inspectEncryptedDifferences(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    key: CryptoKey | null,
    onProgress?: ProgressFn,
  ): Promise<SyncDifferenceSummary> {
    await this.ensureRemote(remote);
    if (!settings.encryptionEnabled) {
      return emptyDifferenceSummary();
    }
    if (!key) {
      throw new Error("Encryption key is required.");
    }

    const auth = await createGitAuthContext(remote, settings);
    const tempRepo = await createTempGitRepo();
    try {
      await this.gitAt(tempRepo, ["remote", "add", remote.name, remote.url], null, auth.env);
      const hasRemote = await timed("network", `fetch ${remote.name}/${remote.branch} for differences`, () => this.fetchRemoteBranch(tempRepo, remote, auth.env), onProgress);
      if (!hasRemote) {
        return emptyDifferenceSummary();
      }

      const manifest = await timed("crypto", "decrypt remote manifest for differences", () => this.readRemoteManifest(tempRepo, key), onProgress);
      const localNotes = await localHashMap(this.vaultPath, await collectNoteFiles(this.vaultPath));
      const remoteNotes = new Map(Object.entries(manifest.files).map(([file, entry]) => [normalizeVaultPath(file), entry.hash]));
      const notes = compareHashMaps(localNotes, remoteNotes);

      const localAllObsidianSnapshot = await this.localPlaintextObsidianSnapshot(true);
      const remoteAllObsidianSnapshot = await this.remotePlaintextObsidianSnapshot(tempRepo, true);
      const localConfigSnapshot = filterPlaintextSnapshot(localAllObsidianSnapshot, isPlaintextObsidianSyncPath);
      const remoteConfigSnapshot = filterPlaintextSnapshot(remoteAllObsidianSnapshot, isPlaintextObsidianSyncPath);
      const localPluginSnapshot = filterPlaintextSnapshot(localAllObsidianSnapshot, isSyncablePluginPath);
      const remotePluginSnapshot = filterPlaintextSnapshot(remoteAllObsidianSnapshot, isSyncablePluginPath);
      const obsidian = comparePlaintextSnapshots(localConfigSnapshot, remoteConfigSnapshot);
      const plugins = comparePlaintextSnapshots(localPluginSnapshot, remotePluginSnapshot);
      const obsidianDecisions = await this.describeObsidianDecisions(tempRepo, localConfigSnapshot, remoteConfigSnapshot);
      const pluginDecisions = await this.describePluginDecisions(tempRepo, localPluginSnapshot, remotePluginSnapshot);

      return {
        notes,
        obsidian,
        plugins,
        obsidianDecisions,
        pluginDecisions,
        hasPluginFiles: Object.keys(localPluginSnapshot.obsidianFiles ?? {}).length > 0
          || Object.keys(remotePluginSnapshot.obsidianFiles ?? {}).length > 0,
        hasDifferences: hasDifferences(notes) || hasDifferences(obsidian) || hasDifferences(plugins),
        requiresConfirmation: false,
      };
    } finally {
      await removeTempRepo(tempRepo);
      await auth.cleanup();
    }
  }

  async verifyRemoteNoteConsistency(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    key: CryptoKey | null,
    onProgress?: ProgressFn,
  ): Promise<NoteConsistencyResult> {
    if (!settings.encryptionEnabled) {
      return { ...emptyDifferenceSummary().notes, consistent: true, localNotes: 0, remoteNotes: 0 };
    }
    if (!key) {
      throw new Error("Encryption key is required.");
    }
    const auth = await createGitAuthContext(remote, settings);
    const tempRepo = await createTempGitRepo();
    try {
      await this.gitAt(tempRepo, ["remote", "add", remote.name, remote.url], null, auth.env);
      const hasRemote = await timed("network", `fetch ${remote.name}/${remote.branch} for note verification`, () => this.fetchRemoteBranch(tempRepo, remote, auth.env), onProgress);
      if (!hasRemote) {
        const localNotes = await collectNoteFiles(this.vaultPath);
        return { localOnly: localNotes.length, remoteOnly: 0, modified: 0, samples: localNotes.slice(0, 8), consistent: localNotes.length === 0, localNotes: localNotes.length, remoteNotes: 0 };
      }
      const manifest = await timed("crypto", "decrypt remote manifest for note verification", () => this.readRemoteManifest(tempRepo, key), onProgress);
      const localNotes = await collectNoteFiles(this.vaultPath);
      const localNotesMap = await localHashMap(this.vaultPath, localNotes);
      const remoteNotesMap = new Map(Object.entries(manifest.files).map(([file, entry]) => [normalizeVaultPath(file), entry.hash]));
      const counts = compareHashMaps(localNotesMap, remoteNotesMap);
      return {
        ...counts,
        consistent: !hasDifferences(counts),
        localNotes: localNotes.length,
        remoteNotes: remoteNotesMap.size,
      };
    } finally {
      await removeTempRepo(tempRepo);
      await auth.cleanup();
    }
  }

  private async describeObsidianDecisions(
    tempRepo: string,
    localSnapshot: EncryptedPlaintextSnapshot,
    remoteSnapshot: EncryptedPlaintextSnapshot,
  ): Promise<string[]> {
    const localFiles = localSnapshot.obsidianFiles ?? {};
    const remoteFiles = remoteSnapshot.obsidianFiles ?? {};
    const files = Array.from(new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)])).sort();
    const decisions: string[] = [];
    for (const file of files) {
      if (decisions.length >= 40) {
        decisions.push(`.obsidian: ${files.length - decisions.length} more files`);
        break;
      }
      const localFile = localFiles[file];
      const remoteFile = remoteFiles[file];
      if (localFile && !remoteFile) {
        decisions.push(`.obsidian: keep local (local only): ${file}`);
        continue;
      }
      if (!localFile && remoteFile) {
        decisions.push(`.obsidian: use remote (remote only): ${file}`);
        continue;
      }
      if (!localFile || !remoteFile || (localFile.oid === remoteFile.oid && localFile.size === remoteFile.size)) {
        continue;
      }
      const useRemote = await this.shouldUseRemotePlaintextFile(tempRepo, file);
      decisions.push(`.obsidian: ${useRemote ? "use remote" : "keep local"} (newer timestamp): ${file}`);
    }
    return decisions;
  }

  private async describePluginDecisions(
    tempRepo: string,
    localSnapshot: EncryptedPlaintextSnapshot,
    remoteSnapshot: EncryptedPlaintextSnapshot,
  ): Promise<string[]> {
    const localFiles = localSnapshot.obsidianFiles ?? {};
    const remoteFiles = remoteSnapshot.obsidianFiles ?? {};
    const localDirs = pluginDirsFromSnapshot(localSnapshot);
    const remoteDirs = pluginDirsFromSnapshot(remoteSnapshot);
    const changedDirs = new Set<string>();
    for (const file of new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)])) {
      const localFile = localFiles[file];
      const remoteFile = remoteFiles[file];
      if (!localFile || !remoteFile || localFile.oid !== remoteFile.oid || localFile.size !== remoteFile.size) {
        const pluginDir = pluginDirFromPath(file);
        if (pluginDir) {
          changedDirs.add(pluginDir);
        }
      }
    }
    const pluginDirs = Array.from(changedDirs).sort();
    const decisions: string[] = [];
    for (const pluginDir of pluginDirs) {
      if (decisions.length >= 40) {
        decisions.push(`plugin: ${pluginDirs.length - decisions.length} more plugins`);
        break;
      }
      if (localDirs.has(pluginDir) && !remoteDirs.has(pluginDir)) {
        decisions.push(`plugin ${pluginDir}: keep local (local plugin only)`);
        continue;
      }
      if (!localDirs.has(pluginDir) && remoteDirs.has(pluginDir)) {
        decisions.push(`plugin ${pluginDir}: use remote (remote plugin only)`);
        continue;
      }
      const choice = await this.pluginSyncChoice(tempRepo, pluginDir);
      decisions.push(`plugin ${pluginDir}: ${choice.useRemote ? "use remote" : "keep local"} (${choice.reason})`);
    }
    return decisions;
  }

  private async pullPlaintext(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    authEnv?: NodeJS.ProcessEnv,
    onProgress?: ProgressFn,
    resolution: SyncConflictResolution = DEFAULT_SYNC_RESOLUTION,
  ): Promise<PullResult> {
    const hasLocalHead = await timed("git", "check local git history", () => this.hasLocalHead(), onProgress);
    if (!hasLocalHead) {
      const hasRemote = await timed("network", `fetch ${remote.name}/${remote.branch} for initial pull`, () => this.fetchRemoteBranch(this.vaultPath, remote, authEnv), onProgress);
      if (!hasRemote) {
        return {
          summary: `Remote branch ${remote.name}/${remote.branch} has no commits yet.`,
          restored: 0,
          plaintextChanged: false,
          conflictCopies: 0,
          conflictDirs: [],
          remoteEncrypted: false,
        };
      }
      const remoteFiles = await timed("git", "list remote files for initial pull", async () => Array.from((await this.listTreeEntries(this.vaultPath, "FETCH_HEAD", ".")).keys()), onProgress);
      const remotePluginChoices = resolution.plugins === "merge"
        ? await timed("local", "compare plugin versions for initial pull", () => this.pluginSyncChoices(this.vaultPath, remoteFiles.filter(isSyncablePluginPath)), onProgress)
        : new Map<string, PluginSyncChoice>();
      this.reportPluginSyncChoices(remotePluginChoices, onProgress);
      const protectedLocalFiles = await timed("local", "protect local files before initial pull", () => this.protectLocalFilesBeforeInitialCheckout(remoteFiles, remotePluginChoices, resolution), onProgress);
      await timed("git", `checkout ${remote.branch} from ${remote.name}/${remote.branch}`, () => this.checkoutFetchedPlaintextBranch(remote, authEnv), onProgress);
      const initialMerge = await timed("local", "merge protected local files after initial pull", () => this.mergeProtectedInitialPullFiles(protectedLocalFiles, resolution), onProgress);
      if (protectedLocalFiles.length > 0) {
        await timed("local", "commit initialized plaintext", () => this.commitLocalPlaintext(settings.commitMessageTemplate), onProgress);
      }
      await this.pruneConflictCopies(settings.conflictRetentionDays);
      const conflictDirs = await this.listConflictDirs();
      const conflictCopies = await countConflictFiles(this.vaultPath);
      return {
        summary: initialPlaintextPullSummary(remote, protectedLocalFiles.length, initialMerge),
        restored: remoteFiles.length,
        plaintextChanged: true,
        conflictCopies,
        conflictDirs,
        remoteEncrypted: false,
      };
    }

    await timed("local", "commit plaintext before pull", () => this.commitLocalPlaintext(settings.commitMessageTemplate), onProgress);
    const mergeConflictCopies = await timed("network", `pull from ${remote.name}/${remote.branch}`, () => this.pullPlaintextBranch(remote, authEnv), onProgress);
    await this.pruneConflictCopies(settings.conflictRetentionDays);
    const conflictDirs = await this.listConflictDirs();
    const conflictCopies = await countConflictFiles(this.vaultPath);
    return {
      summary: mergeConflictCopies > 0
        ? `Pull found ${mergeConflictCopies} Git conflict files. Saved local and remote copies for manual resolution.`
        : `Pulled from ${remote.name}/${remote.branch}.`,
      restored: 0,
      plaintextChanged: true,
      conflictCopies,
      conflictDirs,
      remoteEncrypted: false,
    };
  }

  private async commitLocalPlaintext(template: string, encryptedMode = false, includePlugins = false): Promise<void> {
    const commonExclusions = commonSyncPathspecExclusions();
    if (encryptedMode) {
      const exclusions = includePlugins
        ? [...selfPluginPathspecExclusions(), ...commonExclusions]
        : [":(exclude).obsidian/plugins/**", ...commonExclusions];
      await this.git(["add", "--all", "--", ".", ...exclusions]);
    } else {
      await this.git(["add", "--all", "--", ".", ...selfPluginPathspecExclusions(), ...commonExclusions]);
    }
    const staged = await this.gitText(["diff", "--cached", "--name-only"]);
    if (!staged.trim()) {
      return;
    }
    await this.git(["commit", "-m", renderCommitMessage(template)]);
  }

  private async hasLocalHead(): Promise<boolean> {
    return this.tryGitAt(this.vaultPath, ["rev-parse", "--verify", "HEAD"]);
  }

  private async pullPlaintextBranch(remote: RemoteConfig, authEnv?: NodeJS.ProcessEnv): Promise<number> {
    try {
      await this.git(["pull", "--no-rebase", "--no-edit", remote.name, remote.branch], authEnv);
      return 0;
    } catch (error) {
      if (isUnrelatedHistoriesError(error)) {
        await this.git(["pull", "--no-rebase", "--no-edit", "--allow-unrelated-histories", remote.name, remote.branch], authEnv);
        return 0;
      }
      const resolved = await this.resolvePlaintextGitConflicts(authEnv);
      if (resolved.saved === 0 && resolved.resolved > 0) {
        return 0;
      }
      const saved = resolved.saved > 0 ? resolved.saved : await this.savePlaintextGitConflictCopies();
      if (saved > 0) {
        await this.tryGitAt(this.vaultPath, ["merge", "--abort"], authEnv);
        return saved;
      }
      throw error;
    }
  }

  private async savePlaintextGitConflictCopies(): Promise<number> {
    const output = await this.gitText(["diff", "--name-only", "--diff-filter=U", "-z"]);
    const files = output.split("\0").map(normalizeVaultPath).filter(Boolean);
    let saved = 0;
    for (const file of files) {
      try {
        const localBytes = (await this.git(["show", `:2:${file}`])).stdout;
        const remoteBytes = (await this.git(["show", `:3:${file}`])).stdout;
        await this.saveConflictCopies(file, localBytes, remoteBytes, conflictCategoryForPath(file));
        saved += 1;
      } catch {
        // Binary/submodule or incomplete conflict stage; leave Git's error path intact.
      }
    }
    return saved;
  }

  private async resolvePlaintextGitConflicts(authEnv?: NodeJS.ProcessEnv): Promise<{ resolved: number; saved: number }> {
    const output = await this.gitText(["diff", "--name-only", "--diff-filter=U", "-z"]);
    const files = output.split("\0").map(normalizeVaultPath).filter(Boolean);
    let resolved = 0;
    let saved = 0;
    for (const file of files) {
      const localBytes = await this.readGitStageFileBytes(file, 2);
      const remoteBytes = await this.readGitStageFileBytes(file, 3);
      if (!localBytes && !remoteBytes) {
        continue;
      }
      const category = conflictCategoryForPath(file);
      const merged = await this.mergePlaintextConflictFile(file, category, localBytes, remoteBytes);
      if (merged) {
        await writeFileInRoot(this.vaultPath, file, merged);
        await this.git(["add", "--", file], authEnv);
        resolved += 1;
        continue;
      }
      if (localBytes && remoteBytes) {
        await this.saveConflictCopies(file, localBytes, remoteBytes, category);
        saved += 1;
      }
    }
    if (saved === 0 && resolved > 0) {
      await this.git(["commit", "--no-edit"], authEnv);
    }
    return { resolved, saved };
  }

  private async readGitStageFileBytes(file: string, stage: 1 | 2 | 3): Promise<Buffer | null> {
    try {
      return (await this.git(["show", `:${stage}:${file}`])).stdout;
    } catch {
      return null;
    }
  }

  private async mergePlaintextConflictFile(
    file: string,
    category: keyof SyncConflictResolution,
    localBytes: Buffer | null,
    remoteBytes: Buffer | null,
  ): Promise<Buffer | null> {
    if (!localBytes) {
      return remoteBytes;
    }
    if (!remoteBytes) {
      return localBytes;
    }
    if (sha256Hex(localBytes) === sha256Hex(remoteBytes)) {
      return localBytes;
    }
    if (category === "plugins") {
      return await this.choosePluginConflictBytes(file, localBytes, remoteBytes);
    }
    const baseBytes = await this.readGitStageFileBytes(file, 1);
    const merged = await tryMergeFileBytes(this.vaultPath, file, baseBytes, localBytes, remoteBytes);
    if (merged) {
      return merged;
    }
    if (category === "notes") {
      return mergeInitialNoteBytes(localBytes, remoteBytes);
    }
    if (category === "obsidian") {
      return mergeInitialObsidianBytes(file, localBytes, remoteBytes);
    }
    return null;
  }

  private async choosePluginConflictBytes(file: string, localBytes: Buffer, remoteBytes: Buffer): Promise<Buffer> {
    const pluginDir = pluginDirFromPath(file);
    if (!pluginDir) {
      return remoteBytes;
    }
    const localManifest = await this.readPluginManifestFromConflictStage(pluginDir, 2);
    const remoteManifest = await this.readPluginManifestFromConflictStage(pluginDir, 3);
    if (localManifest && remoteManifest) {
      return comparePluginVersions(remoteManifest, localManifest) >= 0 ? remoteBytes : localBytes;
    }
    if (remoteManifest && !localManifest) {
      return remoteBytes;
    }
    if (localManifest && !remoteManifest) {
      return localBytes;
    }
    return remoteBytes;
  }

  private async readPluginManifestFromConflictStage(pluginDir: string, stage: 2 | 3): Promise<PluginVersionInfo | null> {
    const bytes = await this.readGitStageFileBytes(`.obsidian/plugins/${pluginDir}/manifest.json`, stage);
    return bytes ? parsePluginVersionInfo(bytes) : null;
  }

  private async checkoutFetchedPlaintextBranch(remote: RemoteConfig, authEnv?: NodeJS.ProcessEnv): Promise<void> {
    await this.git(["checkout", "-B", remote.branch, "FETCH_HEAD"], authEnv);
    await this.tryGitAt(this.vaultPath, ["branch", "--set-upstream-to", `${remote.name}/${remote.branch}`, remote.branch], authEnv);
  }

  private async protectLocalFilesBeforeInitialCheckout(
    remoteFiles: string[],
    remotePluginChoices: Map<string, PluginSyncChoice>,
    resolution: SyncConflictResolution,
  ): Promise<ProtectedInitialPullFile[]> {
    const protectedFiles: ProtectedInitialPullFile[] = [];
    const removed = new Set<string>();
    for (const file of remoteFiles.map(normalizeVaultPath).filter(Boolean)) {
      if (removed.has(file)) {
        continue;
      }
      const localPath = path.join(this.vaultPath, file);
      if (!(await exists(localPath))) {
        continue;
      }
      const stat = await fs.stat(localPath);
      if (stat.isFile()) {
        const localBytes = await fs.readFile(localPath);
        const remoteBytes = (await this.git(["show", `FETCH_HEAD:${file}`])).stdout;
        if (sha256Hex(localBytes) !== sha256Hex(remoteBytes) && this.shouldProtectInitialLocalFile(file, remotePluginChoices, resolution)) {
          protectedFiles.push({
            file,
            contents: localBytes,
            category: conflictCategoryForPath(file),
          });
        }
      } else if (stat.isDirectory()) {
        await this.saveDirectoryConflictCopy(file);
      }
      await fs.rm(localPath, { recursive: true, force: true });
      removed.add(file);
    }
    return protectedFiles;
  }

  private shouldProtectInitialLocalFile(
    file: string,
    remotePluginChoices: Map<string, PluginSyncChoice>,
    resolution: SyncConflictResolution,
  ): boolean {
    if (isSyncablePluginPath(file)) {
      if (resolution.plugins === "local") {
        return true;
      }
      if (resolution.plugins === "remote") {
        return false;
      }
      const pluginDir = pluginDirFromPath(file);
      return Boolean(pluginDir && remotePluginChoices.get(pluginDir)?.useRemote === false);
    }
    if (isPlaintextObsidianSyncPath(file)) {
      return resolution.obsidian !== "remote";
    }
    return resolution.notes !== "remote";
  }

  private async mergeProtectedInitialPullFiles(
    protectedFiles: ProtectedInitialPullFile[],
    resolution: SyncConflictResolution,
  ): Promise<InitialPullMergeResult> {
    let restoredPluginFiles = 0;
    let mergedFiles = 0;
    let conflictCopies = 0;
    for (const item of protectedFiles) {
      const remotePath = path.join(this.vaultPath, item.file);
      const remoteBytes = await exists(remotePath) ? await fs.readFile(remotePath) : Buffer.alloc(0);
      if (item.category === "plugins") {
        await writeFileInRoot(this.vaultPath, item.file, item.contents);
        restoredPluginFiles += 1;
        continue;
      }
      const choice = item.category === "obsidian" ? resolution.obsidian : resolution.notes;
      if (choice === "local") {
        await writeFileInRoot(this.vaultPath, item.file, item.contents);
        mergedFiles += 1;
        continue;
      }
      if (sha256Hex(item.contents) === sha256Hex(remoteBytes)) {
        continue;
      }
      const merged = item.category === "notes"
        ? mergeInitialNoteBytes(item.contents, remoteBytes)
        : mergeInitialObsidianBytes(item.file, item.contents, remoteBytes);
      if (merged) {
        await writeFileInRoot(this.vaultPath, item.file, merged);
        mergedFiles += 1;
        continue;
      }
      await this.saveConflictCopies(item.file, item.contents, remoteBytes, item.category);
      conflictCopies += 1;
    }
    return { restoredPluginFiles, mergedFiles, conflictCopies };
  }

  private async saveDirectoryConflictCopy(file: string): Promise<void> {
    const sourceRoot = path.join(this.vaultPath, file);
    const timestamp = conflictTimestamp();
    const conflictRoot = `${CONFLICTS_DIR}/${timestamp}/${conflictCategoryForPath(file)}/local/${file}`;
    const files: string[] = [];
    await walk(sourceRoot, "", files, () => true);
    for (const child of files) {
      await writeFileInRoot(this.vaultPath, `${conflictRoot}/${child}`, await fs.readFile(path.join(sourceRoot, child)));
    }
  }

  private async shouldUseRemotePlaintextFile(repoPath: string, file: string): Promise<boolean> {
    const remoteTime = await this.latestRemoteFileTime(repoPath, file);
    if (remoteTime <= 0) {
      return false;
    }
    try {
      const stat = await fs.stat(path.join(this.vaultPath, file));
      return remoteTime > stat.mtimeMs;
    } catch {
      return true;
    }
  }

  private async latestRemoteFileTime(repoPath: string, file: string): Promise<number> {
    try {
      const output = await this.gitTextAt(repoPath, ["log", "-1", "--format=%ct", "FETCH_HEAD", "--", file]);
      const seconds = Number.parseInt(output.trim(), 10);
      return Number.isFinite(seconds) ? seconds * 1000 : 0;
    } catch {
      return 0;
    }
  }

  private async latestRemoteSelfPluginRuntimeTime(repoPath: string): Promise<number> {
    try {
      const output = await this.gitTextAt(repoPath, ["log", "-1", "--format=%ct", "FETCH_HEAD", "--", ...selfPluginRuntimePaths()]);
      const seconds = Number.parseInt(output.trim(), 10);
      return Number.isFinite(seconds) ? seconds * 1000 : 0;
    } catch {
      return 0;
    }
  }

  private async latestLocalSelfPluginRuntimeTime(): Promise<number> {
    let latest = 0;
    for (const file of selfPluginRuntimePaths()) {
      const localPath = path.join(this.vaultPath, file);
      if (await exists(localPath)) {
        latest = Math.max(latest, (await fs.stat(localPath)).mtimeMs);
      }
    }
    return latest;
  }

  private async latestRemotePluginRuntimeTime(repoPath: string, pluginDir: string): Promise<number> {
    try {
      const output = await this.gitTextAt(repoPath, ["log", "-1", "--format=%ct", "FETCH_HEAD", "--", ...pluginRuntimePathspecs(pluginDir)]);
      const seconds = Number.parseInt(output.trim(), 10);
      return Number.isFinite(seconds) ? seconds * 1000 : 0;
    } catch {
      return 0;
    }
  }

  private async latestLocalPluginRuntimeTime(pluginDir: string): Promise<number> {
    let latest = 0;
    const files = (await collectSyncablePluginFiles(this.vaultPath)).filter((file) => pluginDirFromPath(file) === pluginDir);
    for (const file of files) {
      const localPath = path.join(this.vaultPath, file);
      if (await exists(localPath)) {
        latest = Math.max(latest, (await fs.stat(localPath)).mtimeMs);
      }
    }
    return latest;
  }

  private async pushEncryptedObjects(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    key: CryptoKey,
    authEnv?: NodeJS.ProcessEnv,
    onProgress?: ProgressFn,
    includePlugins = false,
    credential?: SyncCredential,
  ): Promise<{ changed: number; reused: number; skipped: boolean }> {
    const tempRepo = await createTempGitRepo();
    try {
      await this.gitAt(tempRepo, ["remote", "add", remote.name, remote.url], null, authEnv);
      const hasRemote = await timed("network", `fetch ${remote.name}/${remote.branch} (manifest)`, () => this.fetchRemoteBranch(tempRepo, remote, authEnv), onProgress);
      const previousManifest = hasRemote ? await timed("crypto", "decrypt remote manifest", () => this.readRemoteManifest(tempRepo, key), onProgress) : emptyManifest();
      const previousObjects = hasRemote ? await timed("git", "list existing encrypted objects", () => this.listTreeEntries(tempRepo, "FETCH_HEAD", `${SECURE_DIR}/objects`), onProgress) : new Map<string, string>();
      const nextManifest: EncryptedManifest = emptyManifest(settings.password ?? undefined);
      const nextTombstones: Record<string, EncryptedManifestTombstone> = { ...(previousManifest.tombstones ?? {}) };
      nextManifest.tombstones = nextTombstones;
      const previousByHash = manifestFilesByHash(previousManifest);
      let changed = 0;
      let reused = 0;
      let metadataChanged = false;

      if (hasRemote) {
        await this.gitAt(tempRepo, ["read-tree", "--empty"]);
      }

      const noteFiles = await collectNoteFiles(this.vaultPath);
      onProgress?.({ phase: "local", kind: "info", message: `${noteFiles.length} note files` });
      await timed("crypto", `encrypt ${noteFiles.length} note files`, async () => {
        for (const file of noteFiles) {
          const now = new Date().toISOString();
          const absolutePath = path.join(this.vaultPath, file);
          const [plain, stat] = await Promise.all([fs.readFile(absolutePath), fs.stat(absolutePath)]);
          const changedAt = new Date(stat.mtimeMs).toISOString();
          const hash = sha256Hex(plain);
          const existing = previousManifest.files[file];
          const movedFrom = previousByHash.get(hash);
          const identitySource = existing ?? movedFrom;
          const identityPath = manifestPathForEntry(previousManifest, identitySource);
          const previousLocalIndex = settings.noteBlockIndex[file] ?? manifestEntryToBlockIndex(identitySource);
          const blockDocument = buildIndexedNoteDocument(plain, previousLocalIndex, changedAt);
          if (identitySource?.id) {
            delete nextTombstones[identitySource.id];
          }
          if (existing?.hash === hash && previousObjects.has(existing.objectPath)) {
            const nextFile = withFileIdentity(existing, identitySource, file, false);
            nextFile.blocks = blockDocument.blocks;
            nextFile.deletedBlocks = blockDocument.deletedBlocks;
            nextManifest.files[file] = nextFile;
            metadataChanged ||= !existing.id || !existing.blocks || !sameBlockRecords(existing.blocks, blockDocument.blocks);
            settings.noteBlockIndex[file] = {
              fileId: nextFile.id,
              blocks: blockDocument.blocks,
              deletedBlocks: blockDocument.deletedBlocks,
              updatedAt: now,
            };
            await this.addExistingBlobToIndex(tempRepo, existing.objectPath, previousObjects.get(existing.objectPath)!);
            reused += 1;
            continue;
          }

          const objectPath = encryptedObjectPath(file, hash);
          const encrypted = await encryptFileBytes(plain, key, file);
          const fileId = identitySource?.id ?? randomUUID();
          nextManifest.files[file] = {
            id: fileId,
            hash,
            size: plain.byteLength,
            objectPath,
            updatedAt: now,
            contentUpdatedAt: existing?.hash === hash ? identitySource?.contentUpdatedAt ?? now : now,
            pathUpdatedAt: identityPath === file ? identitySource?.pathUpdatedAt ?? now : now,
            blocks: blockDocument.blocks,
            deletedBlocks: blockDocument.deletedBlocks,
          };
          settings.noteBlockIndex[file] = {
            fileId,
            blocks: blockDocument.blocks,
            deletedBlocks: blockDocument.deletedBlocks,
            updatedAt: now,
          };
          await this.addNewBlobToIndex(tempRepo, objectPath, encrypted);
          changed += 1;
        }
      }, onProgress);

      for (const [file, entry] of Object.entries(previousManifest.files)) {
        if (!nextManifest.files[file] && entry.id) {
          nextTombstones[entry.id] = {
            id: entry.id,
            path: file,
            deletedAt: new Date().toISOString(),
            lastHash: entry.hash,
          };
          delete settings.noteBlockIndex[file];
        }
      }

      const obsidianSnapshot = await timed("local", "hash .obsidian snapshot", () => this.localPlaintextObsidianSnapshot(includePlugins), onProgress);
      const remoteObsidianSnapshot = hasRemote
        ? await timed("git", "read remote .obsidian snapshot", () => this.remotePlaintextObsidianSnapshot(tempRepo, includePlugins), onProgress)
        : emptyPlaintextSnapshot();
      nextManifest.plaintext = {
        obsidianHash: obsidianSnapshot.obsidianHash,
        obsidianFiles: obsidianSnapshot.obsidianFiles,
      };
      const remoteNoteCount = Object.keys(previousManifest.files).length;
      const hasNoteChanges = changed > 0 || metadataChanged || remoteNoteCount !== noteFiles.length;
      const hasObsidianChanges = hasRemote ? !samePlaintextSnapshot(obsidianSnapshot, remoteObsidianSnapshot) : true;
      if (hasRemote && !hasNoteChanges && !hasObsidianChanges) {
        onProgress?.({ phase: "local", kind: "info", message: "no encrypted changes to push" });
        return { changed, reused, skipped: true };
      }

      await timed("git", "stage changed .obsidian files", () => this.syncPlaintextObsidianFiles(tempRepo, obsidianSnapshot, remoteObsidianSnapshot), onProgress);
      if (settings.syncKeyringToRemote && credential && settings.password) {
        await timed("crypto", "write remote keyring", () => this.writeRemoteKeyring(tempRepo, settings.password!), onProgress);
      }
      await this.addNewBlobToIndex(tempRepo, MANIFEST_PATH, await encryptJson(nextManifest, key, MANIFEST_AAD));

      const tree = (await this.gitTextAt(tempRepo, ["write-tree"])).trim();
      const parentArgs = hasRemote ? ["-p", "FETCH_HEAD"] : [];
      const commit = (await this.gitTextAt(tempRepo, [
        "commit-tree",
        tree,
        ...parentArgs,
        "-m",
        renderCommitMessage(settings.commitMessageTemplate),
      ])).trim();
      await timed("network", `push encrypted snapshot to ${remote.name}/${remote.branch}`, () => this.gitAt(tempRepo, ["push", remote.name, `${commit}:refs/heads/${remote.branch}`], null, authEnv), onProgress);

      return { changed, reused, skipped: false };
    } finally {
      await removeTempRepo(tempRepo);
    }
  }

  private async pullEncryptedObjects(
    remote: RemoteConfig,
    settings: SecureGitSettings,
    key: CryptoKey,
    authEnv?: NodeJS.ProcessEnv,
    onProgress?: ProgressFn,
    resolution: SyncConflictResolution = DEFAULT_SYNC_RESOLUTION,
    credential?: SyncCredential,
  ): Promise<PullEncryptedResult> {
    const tempRepo = await createTempGitRepo();
    try {
      await this.gitAt(tempRepo, ["remote", "add", remote.name, remote.url], null, authEnv);
      const hasRemote = await timed("network", `fetch ${remote.name}/${remote.branch} (manifest)`, () => this.fetchRemoteBranch(tempRepo, remote, authEnv), onProgress);
      if (!hasRemote) {
        return { restored: 0, plaintextChanged: false, key, importedRemoteKey: false, importedLocalKeyring: false };
      }
      const resolved = await timed("crypto", "decrypt remote manifest", () => this.readRemoteManifestWithFallback(tempRepo, key, credential), onProgress);
      const manifest = resolved.manifest;
      key = resolved.key;
      const remoteNoteSet = new Set(Object.keys(manifest.files));
      onProgress?.({ phase: "local", kind: "info", message: `${remoteNoteSet.size} remote notes` });
      let restored = 0;
      let plaintextChanged = false;

      if (resolution.notes !== "local") {
        const localNoteHashes = await timed("local", "hash local notes", async () => localHashMap(this.vaultPath, await collectNoteFiles(this.vaultPath)), onProgress);
        const changedRemoteNotes = Object.entries(manifest.files).filter(([file, entry]) => localNoteHashes.get(normalizeVaultPath(file)) !== entry.hash);
        for (const [file, entry] of Object.entries(manifest.files)) {
          if (localNoteHashes.get(normalizeVaultPath(file)) === entry.hash) {
            syncNoteIndexFromManifest(file, entry, settings);
          }
        }
        await timed("crypto", `decrypt ${changedRemoteNotes.length} changed notes`, async () => {
          for (const [file, entry] of changedRemoteNotes) {
            const encrypted = (await this.gitAt(tempRepo, ["show", `FETCH_HEAD:${entry.objectPath}`])).stdout;
            const plaintext = await decryptFileBytes(encrypted, key, file);
            const hash = sha256Hex(plaintext);
            if (hash !== entry.hash) {
              throw new Error(`Decrypted content hash mismatch for ${file}.`);
            }
            await this.applyRemoteFile(file, plaintext, resolution.notes, "notes", tempRepo, entry.contentUpdatedAt ?? entry.updatedAt, entry, settings);
            restored += 1;
            plaintextChanged = true;
          }
        }, onProgress);
      } else {
        onProgress?.({ phase: "local", kind: "info", message: "kept local notes" });
      }

      const restoredObsidianFiles = await timed("git", "restore .obsidian files", () => this.restorePlaintextObsidianFiles(tempRepo, resolution, manifest.plaintext, onProgress), onProgress);
      plaintextChanged ||= restoredObsidianFiles > 0;

      if (settings.deleteMissingFilesOnPull && resolution.notes === "remote") {
        const localFiles = await collectNoteFiles(this.vaultPath);
        for (const file of localFiles) {
          if (!remoteNoteSet.has(file)) {
            await this.moveNoteToTrash(file);
          }
        }
        await this.pruneNoteTrash(settings.noteTrashRetentionDays);
      }

      return { restored, plaintextChanged, key, importedRemoteKey: resolved.importedRemoteKey, importedLocalKeyring: resolved.importedLocalKeyring, remoteKeyring: resolved.remoteKeyring };
    } finally {
      await removeTempRepo(tempRepo);
    }
  }

  private async fetchRemoteBranch(tempRepo: string, remote: RemoteConfig, authEnv?: NodeJS.ProcessEnv): Promise<boolean> {
    if (await this.tryGitAt(tempRepo, ["fetch", "--filter=blob:none", remote.name, remote.branch], authEnv)) {
      return true;
    }
    return this.tryGitAt(tempRepo, ["fetch", remote.name, remote.branch], authEnv);
  }

  private async remoteHasEncryptedManifest(remote: RemoteConfig, authEnv?: NodeJS.ProcessEnv): Promise<boolean> {
    const tempRepo = await createTempGitRepo();
    try {
      await this.gitAt(tempRepo, ["remote", "add", remote.name, remote.url], null, authEnv);
      const hasRemote = await this.fetchRemoteBranch(tempRepo, remote, authEnv);
      if (!hasRemote) {
        return false;
      }
      if (await this.treeHasPath(tempRepo, "FETCH_HEAD", MANIFEST_PATH, authEnv)) {
        return true;
      }
      await this.tryGitAt(tempRepo, ["fetch", remote.name, remote.branch], authEnv);
      return this.treeHasPath(tempRepo, "FETCH_HEAD", MANIFEST_PATH, authEnv);
    } finally {
      await removeTempRepo(tempRepo);
    }
  }

  private async treeHasPath(cwd: string, ref: string, file: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      const output = (await this.gitAt(cwd, ["ls-tree", "-r", "-z", ref, "--", file], null, env)).stdout.toString("utf8");
      return parseTreeEntries(output).some((entry) => entry.file === normalizeVaultPath(file));
    } catch {
      return false;
    }
  }

  private async localBlobOidMap(files: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (files.length === 0) {
      return map;
    }
    const input = Buffer.from(`${files.join("\n")}\n`, "utf8");
    const output = (await this.gitAt(this.vaultPath, ["hash-object", "--no-filters", "--stdin-paths"], input)).stdout.toString("utf8");
    const hashes = output.split(/\r?\n/).filter(Boolean);
    files.forEach((file, index) => {
      map.set(file, hashes[index] ?? "");
    });
    return map;
  }

  private async localPlaintextObsidianSnapshot(includePlugins: boolean): Promise<EncryptedPlaintextSnapshot> {
    const files = await collectPlaintextObsidianFiles(this.vaultPath, includePlugins);
    const oidMap = await this.localBlobOidMap(files);
    const obsidianFiles: Record<string, PlaintextSnapshotFile> = {};
    for (const file of files.sort()) {
      const stat = await fs.stat(path.join(this.vaultPath, file));
      obsidianFiles[file] = {
        oid: oidMap.get(file) ?? "",
        size: stat.size,
      };
    }
    const sortedFiles = sortPlaintextSnapshotFiles(obsidianFiles);
    return {
      obsidianHash: sha256Hex(JSON.stringify(sortedFiles)),
      obsidianFiles: sortedFiles,
    };
  }

  private async remotePlaintextObsidianSnapshot(tempRepo: string, includePlugins: boolean): Promise<EncryptedPlaintextSnapshot> {
    const entries = await this.gitTextAt(tempRepo, ["ls-tree", "-r", "-z", "--long", "FETCH_HEAD", "--", ".obsidian"]);
    const obsidianFiles: Record<string, PlaintextSnapshotFile> = {};
    for (const entry of parseLongTreeEntries(entries)) {
      if (!isPlaintextObsidianSyncPath(entry.file) && !(includePlugins && isSyncablePluginPath(entry.file))) {
        continue;
      }
      obsidianFiles[entry.file] = {
        oid: entry.oid,
        size: entry.size,
      };
    }
    return {
      obsidianHash: sha256Hex(JSON.stringify(sortPlaintextSnapshotFiles(obsidianFiles))),
      obsidianFiles: sortPlaintextSnapshotFiles(obsidianFiles),
    };
  }

  private async syncPlaintextObsidianFiles(
    tempRepo: string,
    localSnapshot: EncryptedPlaintextSnapshot,
    remoteSnapshot: EncryptedPlaintextSnapshot,
  ): Promise<void> {
    const localFiles = localSnapshot.obsidianFiles ?? {};
    const remoteFiles = remoteSnapshot.obsidianFiles ?? {};
    for (const [file, local] of Object.entries(localFiles)) {
      const remote = remoteFiles[file];
      if (remote && remote.oid === local.oid && remote.size === local.size) {
        await this.addExistingBlobToIndex(tempRepo, file, remote.oid);
      } else {
        await this.addNewBlobToIndex(tempRepo, file, await fs.readFile(path.join(this.vaultPath, file)));
      }
    }
  }

  private async mergeNoteByBlocks(
    file: string,
    localBytes: Buffer,
    remoteBytes: Buffer,
    remoteEntry: EncryptedManifestFile,
    settings: SecureGitSettings,
  ): Promise<Buffer | null> {
    if (!isTextMergeCandidate(file, localBytes, remoteBytes)) {
      return null;
    }
    const localIndex = settings.noteBlockIndex[file];
    const remoteIndex = manifestEntryToBlockIndex(remoteEntry);
    if (!localIndex || !remoteIndex || remoteIndex.blocks.length === 0) {
      return null;
    }

    const stat = await fs.stat(path.join(this.vaultPath, file));
    const changedAt = new Date(stat.mtimeMs).toISOString();
    const localDoc = buildIndexedNoteDocument(localBytes, localIndex, changedAt);
    const remoteDoc = buildIndexedNoteDocument(remoteBytes, remoteIndex);
    const merged = mergeIndexedBlocks(localDoc, remoteDoc);
    if (!merged) {
      return null;
    }

    const nextIndex = {
      fileId: remoteEntry.id ?? localIndex.fileId,
      blocks: merged.index.blocks,
      deletedBlocks: merged.index.deletedBlocks,
      updatedAt: new Date().toISOString(),
    };
    settings.noteBlockIndex[file] = nextIndex;
    if (sameBlockRecords(merged.index.blocks, remoteDoc.blocks)) {
      return remoteBytes;
    }
    if (sameBlockRecords(merged.index.blocks, localDoc.blocks)) {
      return localBytes;
    }
    return Buffer.from(merged.text, "utf8");
  }

  private async readRemoteManifest(tempRepo: string, key: CryptoKey): Promise<EncryptedManifest> {
    try {
      const encrypted = (await this.gitAt(tempRepo, ["show", `FETCH_HEAD:${MANIFEST_PATH}`])).stdout;
      return decryptJson<EncryptedManifest>(encrypted, key, MANIFEST_AAD);
    } catch (error) {
      if (isMissingGitObjectError(error)) {
        return emptyManifest();
      }
      throw error;
    }
  }

  private async readRemoteManifestWithFallback(
    tempRepo: string,
    key: CryptoKey,
    credential?: SyncCredential,
  ): Promise<{ manifest: EncryptedManifest; key: CryptoKey; importedRemoteKey: boolean; importedLocalKeyring: boolean; remoteKeyring?: PasswordConfig }> {
    try {
      return {
        manifest: await this.readRemoteManifest(tempRepo, key),
        key,
        importedRemoteKey: false,
        importedLocalKeyring: false,
      };
    } catch {
      if (!credential) {
        throw new Error("Remote is encrypted with a different data key. Unlock with the same username and password used by the remote vault.");
      }

      const remoteKeyring = await this.readRemoteKeyring(tempRepo);
      const candidates = [
        remoteKeyring ? { source: "remote" as const, keyring: remoteKeyring } : null,
        credential.localKeyring ? { source: "local" as const, keyring: credential.localKeyring } : null,
      ].filter((candidate): candidate is { source: "remote" | "local"; keyring: PasswordConfig } => Boolean(candidate));

      if (candidates.length === 0) {
        throw new Error("Remote encryption keyring is missing. Open a device that can decrypt this remote and push once with the updated plugin.");
      }

      for (const candidate of candidates) {
        try {
          const remoteKey = await verifyPassword(credential.username, credential.password, candidate.keyring);
          return {
            manifest: await this.readRemoteManifest(tempRepo, remoteKey),
            key: remoteKey,
            importedRemoteKey: candidate.source === "remote",
            importedLocalKeyring: candidate.source === "local",
            remoteKeyring: candidate.keyring,
          };
        } catch {
          // Try the next available keyring before reporting a credential mismatch.
        }
      }

      if (!remoteKeyring && credential.localKeyring) {
        throw new Error("Local keyring does not match this encrypted remote vault or the username/password is incorrect.");
      }
      throw new Error("Username or password is incorrect, or it does not match the remote encrypted vault.");
    }
  }

  private async readRemoteKeyring(tempRepo: string): Promise<PasswordConfig | null> {
    try {
      return JSON.parse((await this.gitAt(tempRepo, ["show", `FETCH_HEAD:${KEYRING_PATH}`])).stdout.toString("utf8")) as PasswordConfig;
    } catch (error) {
      if (isMissingGitObjectError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeRemoteKeyring(tempRepo: string, passwordConfig: PasswordConfig): Promise<void> {
    await this.addNewBlobToIndex(tempRepo, KEYRING_PATH, Buffer.from(`${JSON.stringify(passwordConfig, null, 2)}\n`, "utf8"));
  }

  private async listTreeEntries(tempRepo: string, ref: string, treePath: string): Promise<Map<string, string>> {
    const entries = await this.gitTextAt(tempRepo, ["ls-tree", "-r", "-z", ref, "--", treePath]);
    const map = new Map<string, string>();
    for (const entry of parseTreeEntries(entries)) {
      map.set(entry.file, entry.oid);
    }
    return map;
  }

  private async restorePlaintextObsidianFiles(
    tempRepo: string,
    resolution: SyncConflictResolution,
    manifestSnapshot?: EncryptedPlaintextSnapshot,
    onProgress?: ProgressFn,
  ): Promise<number> {
    const remoteSnapshot = manifestSnapshot?.obsidianFiles
      ? filterPlaintextSnapshot(manifestSnapshot, (file) => isPlaintextObsidianSyncPath(file) || (resolution.plugins !== "local" && isSyncablePluginPath(file)))
      : await this.remotePlaintextObsidianSnapshot(tempRepo, resolution.plugins !== "local");
    const localSnapshot = await this.localPlaintextObsidianSnapshot(resolution.plugins !== "local");
    const remoteSnapshotFiles = remoteSnapshot.obsidianFiles ?? {};
    const localSnapshotFiles = localSnapshot.obsidianFiles ?? {};
    const files = Object.keys(remoteSnapshotFiles)
      .filter((file) => ((resolution.obsidian === "remote" || resolution.obsidian === "merge") && isPlaintextObsidianSyncPath(file))
        || ((resolution.plugins === "remote" || resolution.plugins === "merge") && isSyncablePluginPath(file)));
    const remotePluginFiles = files.filter(isSyncablePluginPath);
    const remotePluginChoices = resolution.plugins === "merge"
      ? await this.pluginSyncChoices(tempRepo, remotePluginFiles)
      : new Map<string, PluginSyncChoice>();
    this.reportPluginSyncChoices(remotePluginChoices, onProgress);
    let changed = 0;
    const remotePluginDirsToApply = pluginDirsUsingRemote(remotePluginChoices);
    if (resolution.plugins === "merge" && remotePluginDirsToApply.size > 0) {
      changed += await this.removeLocalPluginFilesMissingFromRemote(remotePluginFiles, remotePluginDirsToApply);
    }
    for (const file of files) {
      const choice = isSyncablePluginPath(file) ? resolution.plugins : resolution.obsidian;
      if (isSyncablePluginPath(file)) {
        const pluginDir = pluginDirFromPath(file);
        if (choice === "merge" && (!pluginDir || !remotePluginChoices.get(pluginDir)?.useRemote)) {
          continue;
        }
      }
      const localSnapshotFile = localSnapshotFiles[file];
      const remoteSnapshotFile = remoteSnapshotFiles[file];
      if (localSnapshotFile && remoteSnapshotFile && localSnapshotFile.oid === remoteSnapshotFile.oid && localSnapshotFile.size === remoteSnapshotFile.size) {
        continue;
      }
      const contents = (await this.gitAt(tempRepo, ["show", `FETCH_HEAD:${file}`])).stdout;
      if (isSyncablePluginPath(file)) {
        await this.applyRemoteFile(file, contents, choice === "merge" ? "remote" : choice, "plugins", tempRepo, undefined, undefined, undefined, { saveConflictCopy: false });
        changed += 1;
        continue;
      }
      const remoteUpdatedAt = new Date(await this.latestRemoteFileTime(tempRepo, file)).toISOString();
      await this.applyRemoteFile(file, contents, choice, "obsidian", tempRepo, remoteUpdatedAt);
      changed += 1;
    }
    return changed;
  }

  private async pluginSyncChoices(tempRepo: string, remotePluginFiles: string[]): Promise<Map<string, PluginSyncChoice>> {
    const remotePluginDirs = Array.from(new Set(remotePluginFiles.map(pluginDirFromPath).filter(Boolean) as string[]));
    const choices = new Map<string, PluginSyncChoice>();
    for (const pluginDir of remotePluginDirs) {
      choices.set(pluginDir, await this.pluginSyncChoice(tempRepo, pluginDir));
    }
    return choices;
  }

  private reportPluginSyncChoices(choices: Map<string, PluginSyncChoice>, onProgress?: ProgressFn): void {
    let reported = 0;
    for (const [pluginDir, choice] of choices.entries()) {
      if (reported >= 12) {
        onProgress?.({ phase: "local", kind: "info", message: `plugin sync choices: ${choices.size - reported} more` });
        return;
      }
      onProgress?.({
        phase: "local",
        kind: "info",
        message: `plugin ${pluginDir}: keep ${choice.useRemote ? "remote" : "local"} (${choice.reason})`,
      });
      reported += 1;
    }
  }

  private async pluginSyncChoice(tempRepo: string, pluginDir: string): Promise<PluginSyncChoice> {
    const remote = await this.readPluginManifestFromRemote(tempRepo, pluginDir);
    const local = await this.readPluginManifestFromLocal(pluginDir);
    if (!remote) {
      return { useRemote: false, reason: "remote plugin manifest missing" };
    }
    if (!local) {
      return { useRemote: true, reason: "local plugin missing" };
    }
    const versionCompare = comparePluginVersions(remote, local);
    if (versionCompare > 0) {
      return { useRemote: true, reason: "remote plugin version is newer" };
    }
    if (versionCompare < 0) {
      return { useRemote: false, reason: "local plugin version is newer" };
    }
    const [remoteTime, localTime] = await Promise.all([
      this.latestRemotePluginRuntimeTime(tempRepo, pluginDir),
      this.latestLocalPluginRuntimeTime(pluginDir),
    ]);
    return remoteTime >= localTime
      ? { useRemote: true, reason: "remote plugin files are newer or equal" }
      : { useRemote: false, reason: "local plugin files are newer" };
  }

  private async removeLocalPluginFilesMissingFromRemote(remotePluginFiles: string[], remotePluginChoices: Set<string>): Promise<number> {
    const remoteSet = new Set(remotePluginFiles.map((file) => normalizeVaultPath(file)));
    const localPluginFiles = await collectSyncablePluginFiles(this.vaultPath);
    let removed = 0;
    for (const file of localPluginFiles) {
      const pluginDir = pluginDirFromPath(file);
      if (pluginDir && remotePluginChoices.has(pluginDir) && !remoteSet.has(file)) {
        await fs.rm(path.join(this.vaultPath, file), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async applyRemoteFile(
    file: string,
    remoteBytes: Buffer,
    choice: SyncConflictResolution[keyof SyncConflictResolution],
    category: keyof SyncConflictResolution,
    tempRepo: string,
    remoteUpdatedAt?: string,
    remoteEntry?: EncryptedManifestFile,
    settings?: SecureGitSettings,
    options: { saveConflictCopy?: boolean } = {},
  ): Promise<void> {
    const saveConflictCopy = options.saveConflictCopy !== false;
    const localPath = path.join(this.vaultPath, file);
    if (choice === "local") {
      return;
    }
    if (!(await exists(localPath))) {
      await writeFileInRoot(this.vaultPath, file, remoteBytes);
      syncNoteIndexFromManifest(file, remoteEntry, settings);
      return;
    }

    const localBytes = await fs.readFile(localPath);
    if (sha256Hex(localBytes) === sha256Hex(remoteBytes)) {
      syncNoteIndexFromManifest(file, remoteEntry, settings);
      return;
    }

    if (choice === "remote") {
      if (saveConflictCopy) {
        await this.saveConflictCopies(file, localBytes, remoteBytes, category);
      }
      await writeFileInRoot(this.vaultPath, file, remoteBytes);
      syncNoteIndexFromManifest(file, remoteEntry, settings);
      return;
    }

    if (category === "notes" && remoteEntry && settings) {
      const blockMerged = await this.mergeNoteByBlocks(file, localBytes, remoteBytes, remoteEntry, settings);
      if (blockMerged) {
        await writeFileInRoot(this.vaultPath, file, blockMerged);
        return;
      }
    }
    const baseBytes = await this.readLocalBaseFileBytes(file);
    if (!baseBytes && choice === "merge") {
      const initialMerged = category === "notes"
        ? mergeInitialNoteBytes(localBytes, remoteBytes)
        : category === "obsidian"
          ? mergeInitialObsidianBytes(file, localBytes, remoteBytes)
          : null;
      if (initialMerged) {
        await writeFileInRoot(this.vaultPath, file, initialMerged);
        syncMergedNoteIndex(file, initialMerged, remoteEntry, settings);
        return;
      }
    }
    const merged = await tryMergeFileBytes(tempRepo, file, baseBytes, localBytes, remoteBytes);
    if (merged) {
      await writeFileInRoot(this.vaultPath, file, merged);
      syncMergedNoteIndex(file, merged, remoteEntry, settings);
      return;
    }
    if (category === "obsidian" && choice === "merge") {
      const useRemote = await shouldPreferRemoteNote(localPath, remoteUpdatedAt);
      if (useRemote) {
        await writeFileInRoot(this.vaultPath, file, remoteBytes);
      }
      return;
    }
    if (saveConflictCopy) {
      await this.saveConflictCopies(file, localBytes, remoteBytes, category);
    }
    if (category === "notes") {
      const useRemote = await shouldPreferRemoteNote(localPath, remoteUpdatedAt);
      if (useRemote) {
        await writeFileInRoot(this.vaultPath, file, remoteBytes);
        syncNoteIndexFromManifest(file, remoteEntry, settings);
      }
      return;
    }
    if (canWriteConflictMarker(file, localBytes, remoteBytes)) {
      await writeFileInRoot(this.vaultPath, file, buildConflictMarker(localBytes, remoteBytes));
    }
  }

  private async readLocalBaseFileBytes(file: string): Promise<Buffer | null> {
    try {
      return (await this.git(["show", `HEAD:${file}`])).stdout;
    } catch {
      return null;
    }
  }

  private async saveConflictCopies(
    file: string,
    localBytes: Buffer,
    remoteBytes: Buffer,
    category: keyof SyncConflictResolution,
  ): Promise<void> {
    const timestamp = conflictTimestamp();
    const conflictRoot = `${CONFLICTS_DIR}/${timestamp}/${category}`;
    await writeFileInRoot(this.vaultPath, `${conflictRoot}/local/${file}`, localBytes);
    await writeFileInRoot(this.vaultPath, `${conflictRoot}/remote/${file}`, remoteBytes);
  }

  async listConflictDirs(): Promise<string[]> {
    const root = path.join(this.vaultPath, CONFLICTS_DIR);
    if (!(await exists(root))) {
      return [];
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeVaultPath(path.join(CONFLICTS_DIR, entry.name)))
      .sort()
      .reverse();
  }

  async listConflictFilePairs(): Promise<ConflictFilePair[]> {
    const dirs = await this.listConflictDirs();
    const pairs = new Map<string, ConflictFilePair>();
    for (const conflictDir of dirs) {
      for (const category of ["notes", "obsidian", "plugins"] as Array<keyof SyncConflictResolution>) {
        for (const side of ["local", "remote"] as const) {
          const sideRoot = path.join(this.vaultPath, conflictDir, category, side);
          if (!(await exists(sideRoot))) {
            continue;
          }
          const files: string[] = [];
          await walk(sideRoot, "", files, () => true);
          for (const file of files) {
            const normalizedFile = normalizeVaultPath(file);
            const id = `${conflictDir}\0${category}\0${normalizedFile}`;
            const existing = pairs.get(id) ?? {
              id,
              conflictDir,
              category,
              file: normalizedFile,
              hasLocal: false,
              hasRemote: false,
            };
            const conflictPath = normalizeVaultPath(path.join(conflictDir, category, side, normalizedFile));
            if (side === "local") {
              existing.localConflictPath = conflictPath;
              existing.hasLocal = true;
            } else {
              existing.remoteConflictPath = conflictPath;
              existing.hasRemote = true;
            }
            pairs.set(id, existing);
          }
        }
      }
    }
    return Array.from(pairs.values()).sort((left, right) => left.conflictDir === right.conflictDir
      ? left.file.localeCompare(right.file)
      : right.conflictDir.localeCompare(left.conflictDir));
  }

  async readConflictFile(pair: ConflictFilePair): Promise<ConflictFileContent> {
    const localBytes = pair.localConflictPath ? await fs.readFile(path.join(this.vaultPath, pair.localConflictPath)) : Buffer.alloc(0);
    const remoteBytes = pair.remoteConflictPath ? await fs.readFile(path.join(this.vaultPath, pair.remoteConflictPath)) : Buffer.alloc(0);
    const isText = !localBytes.includes(0) && !remoteBytes.includes(0);
    return {
      ...pair,
      localText: isText ? localBytes.toString("utf8") : "",
      remoteText: isText ? remoteBytes.toString("utf8") : "",
      isText,
    };
  }

  async saveResolvedConflict(pair: ConflictFilePair, contents: string): Promise<void> {
    await writeFileInRoot(this.vaultPath, pair.file, Buffer.from(contents, "utf8"));
    if (pair.localConflictPath) {
      await fs.rm(path.join(this.vaultPath, pair.localConflictPath), { force: true });
    }
    if (pair.remoteConflictPath) {
      await fs.rm(path.join(this.vaultPath, pair.remoteConflictPath), { force: true });
    }
    await this.pruneEmptyConflictDirs(pair.conflictDir);
  }

  getConflictRootPath(): string {
    return path.join(this.vaultPath, CONFLICTS_DIR);
  }

  private async pruneConflictCopies(retentionDays: number): Promise<void> {
    if (retentionDays <= 0) {
      return;
    }
    const root = path.join(this.vaultPath, CONFLICTS_DIR);
    if (!(await exists(root))) {
      return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const timestamp = parseConflictTimestamp(entry.name);
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async pruneEmptyConflictDirs(conflictDir: string): Promise<void> {
    const conflictRoot = path.resolve(this.vaultPath, CONFLICTS_DIR);
    let current = path.resolve(this.vaultPath, conflictDir);
    while (current.startsWith(conflictRoot) && current !== conflictRoot) {
      const entries = await fs.readdir(current).catch(() => null);
      if (!entries || entries.length > 0) {
        return;
      }
      await fs.rmdir(current).catch(() => undefined);
      current = path.dirname(current);
    }
  }

  private async moveNoteToTrash(file: string): Promise<void> {
    const source = path.join(this.vaultPath, file);
    if (!(await exists(source))) {
      return;
    }
    const destination = path.join(this.vaultPath, NOTE_TRASH_DIR, conflictTimestamp(), normalizeVaultPath(file));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }

  private async pruneNoteTrash(retentionDays: number): Promise<void> {
    if (retentionDays <= 0) {
      return;
    }
    const root = path.join(this.vaultPath, NOTE_TRASH_DIR);
    if (!(await exists(root))) {
      return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const timestamp = parseConflictTimestamp(entry.name);
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async addExistingBlobToIndex(tempRepo: string, file: string, oid: string): Promise<void> {
    await this.gitAt(tempRepo, ["update-index", "--add", "--cacheinfo", "100644", oid, file]);
  }

  private async addNewBlobToIndex(tempRepo: string, file: string, contents: Buffer): Promise<void> {
    const hash = (await this.gitAt(tempRepo, ["hash-object", "-w", "--stdin"], contents)).stdout.toString("utf8").trim();
    await this.addExistingBlobToIndex(tempRepo, file, hash);
  }

  private async shouldUseRemoteSelfPlugin(tempRepo: string): Promise<boolean> {
    const remote = await this.readSelfPluginManifestFromRemote(tempRepo);
    if (!remote) {
      return true;
    }
    const local = await this.readSelfPluginManifestFromLocal();
    if (!local) {
      return true;
    }
    const versionCompare = comparePluginVersions(remote, local);
    if (versionCompare !== 0) {
      return versionCompare > 0;
    }
    const [remoteTime, localTime] = await Promise.all([
      this.latestRemoteSelfPluginRuntimeTime(tempRepo),
      this.latestLocalSelfPluginRuntimeTime(),
    ]);
    return remoteTime >= localTime;
  }

  private async readSelfPluginManifestFromRemote(tempRepo: string): Promise<PluginVersionInfo | null> {
    for (const pluginDir of SELF_PLUGIN_DIR_NAMES) {
      const manifest = await this.readPluginManifestFromRemote(tempRepo, pluginDir);
      if (manifest) {
        return manifest;
      }
    }
    return null;
  }

  private async readSelfPluginManifestFromLocal(): Promise<PluginVersionInfo | null> {
    for (const pluginDir of SELF_PLUGIN_DIR_NAMES) {
      const manifest = await this.readPluginManifestFromLocal(pluginDir);
      if (manifest) {
        return manifest;
      }
    }
    return null;
  }

  private async readPluginManifestFromRemote(tempRepo: string, pluginDir: string): Promise<PluginVersionInfo | null> {
    try {
      const contents = (await this.gitAt(tempRepo, ["show", `FETCH_HEAD:.obsidian/plugins/${pluginDir}/manifest.json`])).stdout;
      return parsePluginVersionInfo(contents);
    } catch {
      return null;
    }
  }

  private async readPluginManifestFromLocal(pluginDir: string): Promise<PluginVersionInfo | null> {
    const filePath = path.join(this.vaultPath, ".obsidian", "plugins", pluginDir, "manifest.json");
    if (await exists(filePath)) {
      return parsePluginVersionInfo(await fs.readFile(filePath));
    }
    return null;
  }

  private async gitText(args: string[]): Promise<string> {
    return (await this.git(args)).stdout.toString("utf8");
  }

  private async gitTextAt(cwd: string, args: string[]): Promise<string> {
    return (await this.gitAt(cwd, args)).stdout.toString("utf8");
  }

  private git(args: string[], env?: NodeJS.ProcessEnv): Promise<GitRunResult> {
    return this.gitAt(this.vaultPath, args, null, env);
  }

  private async tryGitAt(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      await this.gitAt(cwd, args, null, env);
      return true;
    } catch {
      return false;
    }
  }

  private gitAt(cwd: string, args: string[], input: Buffer | null = null, env?: NodeJS.ProcessEnv): Promise<GitRunResult> {
    return runGitAt(cwd, args, input, env);
  }
}

export async function collectNoteFiles(vaultPath: string): Promise<string[]> {
  const results: string[] = [];
  await walk(vaultPath, "", results, isNotePath);
  return results;
}

export async function collectPlaintextObsidianFiles(vaultPath: string, includePlugins = false): Promise<string[]> {
  const obsidianPath = path.join(vaultPath, ".obsidian");
  if (!(await exists(obsidianPath))) {
    return [];
  }

  const results: string[] = [];
  await walk(
    vaultPath,
    ".obsidian",
    results,
    (file) => isPlaintextObsidianSyncPath(file) || (includePlugins && isSyncablePluginPath(file)),
    (file) => {
      const normalized = normalizeVaultPath(file);
      if (normalized === ".obsidian/plugins") {
        return includePlugins;
      }
      if (normalized.startsWith(".obsidian/plugins/")) {
        return includePlugins && isSyncablePluginDirectory(normalized);
      }
      return normalized.startsWith(".obsidian/");
    },
  );
  return results;
}

export async function collectSyncablePluginFiles(vaultPath: string): Promise<string[]> {
  const pluginsPath = path.join(vaultPath, ".obsidian", "plugins");
  if (!(await exists(pluginsPath))) {
    return [];
  }

  const results: string[] = [];
  await walk(vaultPath, ".obsidian/plugins", results, isSyncablePluginPath, isSyncablePluginDirectory);
  return results;
}

async function localHashMap(root: string, files: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const batchSize = 32;
  for (let index = 0; index < files.length; index += batchSize) {
    await Promise.all(files.slice(index, index + batchSize).map(async (file) => {
      hashes.set(normalizeVaultPath(file), sha256Hex(await fs.readFile(path.join(root, file))));
    }));
  }
  return hashes;
}

function compareHashMaps(local: Map<string, string>, remote: Map<string, string>): DifferenceCounts {
  const counts: DifferenceCounts = {
    localOnly: 0,
    remoteOnly: 0,
    modified: 0,
    samples: [],
  };
  const sample = (label: string, file: string) => {
    if (counts.samples.length < 8) {
      counts.samples.push(`${label}: ${file}`);
    }
  };

  for (const [file, hash] of local.entries()) {
    const remoteHash = remote.get(file);
    if (!remoteHash) {
      counts.localOnly += 1;
      sample("local", file);
    } else if (remoteHash !== hash) {
      counts.modified += 1;
      sample("modified", file);
    }
  }
  for (const file of remote.keys()) {
    if (!local.has(file)) {
      counts.remoteOnly += 1;
      sample("remote", file);
    }
  }

  return counts;
}

function comparePlaintextSnapshots(local: EncryptedPlaintextSnapshot, remote: EncryptedPlaintextSnapshot): DifferenceCounts {
  const localFiles = local.obsidianFiles ?? {};
  const remoteFiles = remote.obsidianFiles ?? {};
  const counts: DifferenceCounts = {
    localOnly: 0,
    remoteOnly: 0,
    modified: 0,
    samples: [],
  };
  const sample = (label: string, file: string) => {
    if (counts.samples.length < 8) {
      counts.samples.push(`${label}: ${file}`);
    }
  };

  for (const [file, localFile] of Object.entries(localFiles)) {
    const remoteFile = remoteFiles[file];
    if (!remoteFile) {
      counts.localOnly += 1;
      sample("local", file);
    } else if (remoteFile.oid !== localFile.oid || remoteFile.size !== localFile.size) {
      counts.modified += 1;
      sample("modified", file);
    }
  }
  for (const file of Object.keys(remoteFiles)) {
    if (!localFiles[file]) {
      counts.remoteOnly += 1;
      sample("remote", file);
    }
  }

  return counts;
}

function filterPlaintextSnapshot(snapshot: EncryptedPlaintextSnapshot, predicate: (file: string) => boolean): EncryptedPlaintextSnapshot {
  const obsidianFiles: Record<string, PlaintextSnapshotFile> = {};
  for (const [file, entry] of Object.entries(snapshot.obsidianFiles ?? {})) {
    if (predicate(file)) {
      obsidianFiles[file] = entry;
    }
  }
  const sortedFiles = sortPlaintextSnapshotFiles(obsidianFiles);
  return {
    obsidianHash: sha256Hex(JSON.stringify(sortedFiles)),
    obsidianFiles: sortedFiles,
  };
}

function pluginDirsFromSnapshot(snapshot: EncryptedPlaintextSnapshot): Set<string> {
  const dirs = new Set<string>();
  for (const file of Object.keys(snapshot.obsidianFiles ?? {})) {
    const pluginDir = pluginDirFromPath(file);
    if (pluginDir) {
      dirs.add(pluginDir);
    }
  }
  return dirs;
}

function samePlaintextSnapshot(a: EncryptedPlaintextSnapshot, b: EncryptedPlaintextSnapshot): boolean {
  const aFiles = a.obsidianFiles ?? {};
  const bFiles = b.obsidianFiles ?? {};
  const aNames = Object.keys(aFiles);
  const bNames = Object.keys(bFiles);
  if (aNames.length !== bNames.length) {
    return false;
  }
  return aNames.every((file) => aFiles[file].oid === bFiles[file]?.oid && aFiles[file].size === bFiles[file]?.size);
}

function sortPlaintextSnapshotFiles(files: Record<string, PlaintextSnapshotFile>): Record<string, PlaintextSnapshotFile> {
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function hasDifferences(counts: DifferenceCounts): boolean {
  return counts.localOnly > 0 || counts.remoteOnly > 0 || counts.modified > 0;
}

function emptyDifferenceSummary(): SyncDifferenceSummary {
  const empty = (): DifferenceCounts => ({ localOnly: 0, remoteOnly: 0, modified: 0, samples: [] });
  return {
    notes: empty(),
    obsidian: empty(),
    plugins: empty(),
    obsidianDecisions: [],
    pluginDecisions: [],
    hasDifferences: false,
    hasPluginFiles: false,
    requiresConfirmation: false,
  };
}

async function walk(
  root: string,
  relativeDir: string,
  results: string[],
  shouldInclude: (vaultRelativePath: string) => boolean,
  shouldDescend: (vaultRelativePath: string) => boolean = shouldInclude,
): Promise<void> {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = normalizeVaultPath(path.join(relativeDir, entry.name));
    if (!relativePath) {
      continue;
    }

    if (entry.isDirectory()) {
      if (shouldDescend(relativePath)) {
        await walk(root, relativePath, results, shouldInclude, shouldDescend);
      }
    } else if (entry.isFile() && shouldInclude(relativePath)) {
      results.push(relativePath);
    }
  }
}

async function countConflictFiles(vaultPath: string): Promise<number> {
  const root = path.join(vaultPath, CONFLICTS_DIR);
  if (!(await exists(root))) {
    return 0;
  }
  const files: string[] = [];
  await walk(vaultPath, CONFLICTS_DIR, files, () => true);
  return files.length;
}

async function createTempGitRepo(): Promise<string> {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "secure-git-sync-"));
  await runGitAt(tempRepo, ["init"]);
  await runGitAt(tempRepo, ["config", "user.name", "Secure Git Sync"]);
  await runGitAt(tempRepo, ["config", "user.email", "secure-git-sync@local"]);
  return tempRepo;
}

async function removeTempRepo(tempRepo: string): Promise<void> {
  const resolvedTemp = path.resolve(tempRepo);
  const resolvedRoot = path.resolve(os.tmpdir());
  if (!resolvedTemp.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Refusing to remove a directory outside the system temp folder.");
  }
  await removeTempPathWithRetries(resolvedTemp);
}

async function writeFileInRoot(root: string, vaultRelativePath: string, contents: Buffer): Promise<void> {
  const absolutePath = path.join(root, vaultRelativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function tryMergeFileBytes(
  tempRepo: string,
  file: string,
  baseBytes: Buffer | null,
  localBytes: Buffer,
  remoteBytes: Buffer,
): Promise<Buffer | null> {
  if (!baseBytes || !isTextMergeCandidate(file, baseBytes, localBytes, remoteBytes)) {
    return null;
  }

  const mergeDir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-git-sync-merge-"));
  try {
    const localPath = path.join(mergeDir, "local");
    const basePath = path.join(mergeDir, "base");
    const remotePath = path.join(mergeDir, "remote");
    await fs.writeFile(localPath, localBytes);
    await fs.writeFile(basePath, baseBytes);
    await fs.writeFile(remotePath, remoteBytes);
    try {
      await runGitAt(tempRepo, ["merge-file", "-q", localPath, basePath, remotePath]);
      return fs.readFile(localPath);
    } catch {
      return null;
    }
  } finally {
    await removeTempMergeDir(mergeDir);
  }
}

async function removeTempMergeDir(tempDir: string): Promise<void> {
  const resolvedTemp = path.resolve(tempDir);
  const resolvedRoot = path.resolve(os.tmpdir());
  if (!resolvedTemp.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Refusing to remove a directory outside the system temp folder.");
  }
  await removeTempPathWithRetries(resolvedTemp);
}

async function removeTempPathWithRetries(target: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(80 * (attempt + 1));
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTextMergeCandidate(file: string, ...contents: Buffer[]): boolean {
  const extension = path.extname(file).toLowerCase();
  const textExtensions = new Set([".md", ".markdown", ".txt", ".css", ".js", ".ts", ".json", ".yaml", ".yml"]);
  if (!textExtensions.has(extension)) {
    return false;
  }
  return contents.every((content) => !content.includes(0));
}

function mergeInitialNoteBytes(localBytes: Buffer, remoteBytes: Buffer): Buffer | null {
  if (!isTextMergeCandidate("note.md", localBytes, remoteBytes)) {
    return null;
  }
  const localBlocks = splitNoteBlocks(localBytes.toString("utf8"));
  const remoteBlocks = splitNoteBlocks(remoteBytes.toString("utf8"));
  if (localBlocks.length === 0) {
    return remoteBytes;
  }
  if (remoteBlocks.length === 0) {
    return localBytes;
  }
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const block of [...localBlocks, ...remoteBlocks]) {
    const hash = sha256Hex(Buffer.from(block, "utf8"));
    if (!seen.has(hash)) {
      merged.push(block);
      seen.add(hash);
    }
  }
  return Buffer.from(`${merged.join("\n\n")}\n`, "utf8");
}

function mergeInitialObsidianBytes(file: string, localBytes: Buffer, remoteBytes: Buffer): Buffer | null {
  if (!isTextMergeCandidate(file, localBytes, remoteBytes)) {
    return null;
  }
  if (path.extname(file).toLowerCase() === ".json") {
    const mergedJson = mergeJsonBytes(localBytes, remoteBytes);
    if (mergedJson) {
      return mergedJson;
    }
  }
  return mergeInitialTextBytes(localBytes, remoteBytes);
}

function mergeInitialTextBytes(localBytes: Buffer, remoteBytes: Buffer): Buffer | null {
  const localText = localBytes.toString("utf8").replace(/\r\n/g, "\n");
  const remoteText = remoteBytes.toString("utf8").replace(/\r\n/g, "\n");
  if (localText === remoteText) {
    return remoteBytes;
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of [...localText.split("\n"), ...remoteText.split("\n")]) {
    const key = line.trimEnd();
    if (key.length === 0 || !seen.has(key)) {
      lines.push(line);
      if (key.length > 0) {
        seen.add(key);
      }
    }
  }
  return Buffer.from(lines.join("\n").replace(/\n*$/, "\n"), "utf8");
}

function mergeJsonBytes(localBytes: Buffer, remoteBytes: Buffer): Buffer | null {
  try {
    const localJson = JSON.parse(localBytes.toString("utf8")) as unknown;
    const remoteJson = JSON.parse(remoteBytes.toString("utf8")) as unknown;
    return Buffer.from(`${JSON.stringify(mergeJsonValues(localJson, remoteJson), null, 2)}\n`, "utf8");
  } catch {
    return null;
  }
}

function mergeJsonValues(localValue: unknown, remoteValue: unknown): unknown {
  if (isPlainRecord(localValue) && isPlainRecord(remoteValue)) {
    const result: Record<string, unknown> = { ...remoteValue };
    for (const [key, value] of Object.entries(localValue)) {
      result[key] = key in result ? mergeJsonValues(value, result[key]) : value;
    }
    return result;
  }
  if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
    const merged = [...remoteValue];
    const seen = new Set(remoteValue.map((item) => JSON.stringify(item)));
    for (const item of localValue) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        merged.push(item);
        seen.add(key);
      }
    }
    return merged;
  }
  return remoteValue ?? localValue;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canWriteConflictMarker(file: string, ...contents: Buffer[]): boolean {
  const extension = path.extname(file).toLowerCase();
  return [".md", ".markdown", ".txt"].includes(extension) && contents.every((content) => !content.includes(0));
}

async function shouldPreferRemoteNote(localPath: string, remoteUpdatedAt?: string): Promise<boolean> {
  const remoteTimestamp = Date.parse(remoteUpdatedAt ?? "");
  if (!Number.isFinite(remoteTimestamp)) {
    return false;
  }
  try {
    const stat = await fs.stat(localPath);
    return remoteTimestamp > stat.mtimeMs;
  } catch {
    return true;
  }
}

function buildConflictMarker(localBytes: Buffer, remoteBytes: Buffer): Buffer {
  return Buffer.from([
    "<<<<<<< LOCAL",
    localBytes.toString("utf8"),
    "=======",
    remoteBytes.toString("utf8"),
    ">>>>>>> REMOTE",
    "",
  ].join("\n"), "utf8");
}

function syncNoteIndexFromManifest(file: string, remoteEntry?: EncryptedManifestFile, settings?: SecureGitSettings): void {
  if (!remoteEntry || !settings) {
    return;
  }
  const index = manifestEntryToBlockIndex(remoteEntry);
  if (index) {
    settings.noteBlockIndex[file] = index;
  }
}

function syncMergedNoteIndex(file: string, contents: Buffer, remoteEntry?: EncryptedManifestFile, settings?: SecureGitSettings): void {
  if (!remoteEntry || !settings || !isTextMergeCandidate(file, contents)) {
    return;
  }
  const previousIndex = settings.noteBlockIndex[file] ?? manifestEntryToBlockIndex(remoteEntry);
  const index = buildIndexedNoteDocument(contents, previousIndex);
  settings.noteBlockIndex[file] = {
    fileId: remoteEntry.id ?? previousIndex?.fileId,
    blocks: index.blocks,
    deletedBlocks: index.deletedBlocks,
    updatedAt: new Date().toISOString(),
  };
}

function conflictTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseConflictTimestamp(value: string): number {
  return Date.parse(value.replace(/-(\d{3})Z$/, ".$1Z").replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4"));
}

function runGitAt(cwd: string, args: string[], input: Buffer | null = null, env?: NodeJS.ProcessEnv): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, {
      cwd,
      env,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 50,
      encoding: "buffer",
    }, (error, stdout, stderr) => {
      const result = {
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
      };
      if (error) {
        reject(new Error(result.stderr.toString("utf8") || error.message));
        return;
      }
      resolve(result);
    });

    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

function parseTreeEntries(output: string): TreeEntry[] {
  return output.split("\0").filter(Boolean).map((entry) => {
    const tabIndex = entry.indexOf("\t");
    const meta = entry.slice(0, tabIndex).split(" ");
    return {
      oid: meta[2],
      file: normalizeVaultPath(entry.slice(tabIndex + 1)),
    };
  });
}

function parseLongTreeEntries(output: string): TreeEntryWithSize[] {
  return output.split("\0").filter(Boolean).flatMap((entry) => {
    const tabIndex = entry.indexOf("\t");
    if (tabIndex < 0) {
      return [];
    }
    const meta = entry.slice(0, tabIndex).trim().split(/\s+/);
    if (meta.length < 4) {
      return [];
    }
    return [{
      oid: meta[2],
      size: Number.parseInt(meta[3], 10) || 0,
      file: normalizeVaultPath(entry.slice(tabIndex + 1)),
    }];
  });
}

function isMissingGitObjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /path .* does not exist in|exists on disk, but not in|invalid object name|bad revision|unknown revision|fatal:.*not a valid object name/i.test(message);
}

function emptyManifest(passwordConfig?: PasswordConfig): EncryptedManifest {
  return {
    version: 2,
    crypto: {
      kdf: passwordConfig?.kdf ?? "PBKDF2-SHA-256",
      kdfParams: passwordConfig?.kdfParams ?? { iterations: passwordConfig?.iterations ?? 310000 },
      cipher: "AES-256-GCM",
      keyWrapCipher: "AES-256-GCM",
      keyId: passwordConfig?.keyId ?? "legacy",
      manifestAad: MANIFEST_AAD,
      objectAad: "vault-relative-path",
    },
    files: {},
    tombstones: {},
  };
}

function emptyPlaintextSnapshot(): EncryptedPlaintextSnapshot {
  return {
    obsidianHash: sha256Hex(JSON.stringify({})),
    obsidianFiles: {},
  };
}

function manifestFilesByHash(manifest: EncryptedManifest): Map<string, EncryptedManifestFile> {
  const map = new Map<string, EncryptedManifestFile>();
  for (const entry of Object.values(manifest.files)) {
    map.set(entry.hash, entry);
  }
  return map;
}

function manifestPathForEntry(manifest: EncryptedManifest, entry: EncryptedManifestFile | undefined): string | null {
  if (!entry) {
    return null;
  }
  for (const [file, candidate] of Object.entries(manifest.files)) {
    if (candidate === entry || (entry.id && candidate.id === entry.id)) {
      return normalizeVaultPath(file);
    }
  }
  return null;
}

function withFileIdentity(
  entry: EncryptedManifestFile,
  identitySource: EncryptedManifestFile | undefined,
  file: string,
  contentChanged: boolean,
): EncryptedManifestFile {
  const now = new Date().toISOString();
  return {
    ...entry,
    id: identitySource?.id ?? entry.id ?? randomUUID(),
    contentUpdatedAt: contentChanged ? now : identitySource?.contentUpdatedAt ?? entry.contentUpdatedAt ?? entry.updatedAt,
    pathUpdatedAt: identitySource ? identitySource.pathUpdatedAt ?? entry.pathUpdatedAt ?? entry.updatedAt : now,
    updatedAt: entry.updatedAt || now,
  };
}

interface IndexedBlock {
  id: string;
  text: string;
  hash: string;
  updatedAt: string;
}

interface IndexedNoteDocument {
  blocks: NoteBlockRecord[];
  deletedBlocks: NoteBlockRecord[];
  indexedBlocks: IndexedBlock[];
}

function manifestEntryToBlockIndex(entry: EncryptedManifestFile | undefined): NoteFileBlockIndex | undefined {
  if (!entry?.blocks) {
    return undefined;
  }
  return {
    fileId: entry.id,
    blocks: entry.blocks,
    deletedBlocks: entry.deletedBlocks,
    updatedAt: entry.contentUpdatedAt ?? entry.updatedAt,
  };
}

function buildIndexedNoteDocument(contents: Buffer, previousIndex?: NoteFileBlockIndex, changedAt = new Date().toISOString()): IndexedNoteDocument {
  const textBlocks = splitNoteBlocks(contents.toString("utf8"));
  const previousBlocks = previousIndex?.blocks ?? [];
  const previousDeleted = previousIndex?.deletedBlocks ?? [];
  const previousByHash = new Map<string, NoteBlockRecord[]>();
  previousBlocks.forEach((block) => {
    const list = previousByHash.get(block.hash) ?? [];
    list.push(block);
    previousByHash.set(block.hash, list);
  });

  const usedPrevious = new Set<string>();
  const indexedBlocks = textBlocks.map((text, index) => {
    const hash = sha256Hex(text);
    const exact = previousByHash.get(hash)?.find((block) => !usedPrevious.has(block.id));
    const positional = previousBlocks[index] && !usedPrevious.has(previousBlocks[index].id) ? previousBlocks[index] : undefined;
    const source = exact ?? positional;
    if (source) {
      usedPrevious.add(source.id);
    }
    return {
      id: source?.id ?? randomUUID(),
      text,
      hash,
      updatedAt: source && source.hash === hash ? source.updatedAt : changedAt,
    };
  });

  const deletedBlocks = [...previousDeleted];
  for (const block of previousBlocks) {
    if (!usedPrevious.has(block.id)) {
      deletedBlocks.push({
        ...block,
        deletedAt: block.deletedAt ?? changedAt,
      });
    }
  }

  return {
    indexedBlocks,
    blocks: indexedBlocks.map(({ id, hash, updatedAt }) => ({ id, hash, updatedAt })),
    deletedBlocks: dedupeBlockRecords(deletedBlocks),
  };
}

function splitNoteBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return [];
  }
  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trimEnd())
    .filter((block) => block.length > 0);
}

function mergeIndexedBlocks(localDoc: IndexedNoteDocument, remoteDoc: IndexedNoteDocument): { text: string; index: NoteFileBlockIndex } | null {
  const localById = new Map(localDoc.indexedBlocks.map((block) => [block.id, block]));
  const remoteById = new Map(remoteDoc.indexedBlocks.map((block) => [block.id, block]));
  const localDeleted = new Map(localDoc.deletedBlocks.map((block) => [block.id, block]));
  const remoteDeleted = new Map(remoteDoc.deletedBlocks.map((block) => [block.id, block]));
  const order = mergedBlockOrder(localDoc.indexedBlocks, remoteDoc.indexedBlocks);
  const mergedBlocks: IndexedBlock[] = [];
  const deletedBlocks: NoteBlockRecord[] = [];

  for (const id of order) {
    const local = localById.get(id);
    const remote = remoteById.get(id);
    const localDeletion = localDeleted.get(id);
    const remoteDeletion = remoteDeleted.get(id);
    const chosen = chooseMergedBlock(local, remote, localDeletion, remoteDeletion);
    if (chosen) {
      mergedBlocks.push(chosen);
    } else {
      const deleted = newestBlockRecord(localDeletion, remoteDeletion);
      if (deleted) {
        deletedBlocks.push(deleted);
      }
    }
  }

  return {
    text: mergedBlocks.map((block) => block.text).join("\n\n"),
    index: {
      blocks: mergedBlocks.map(({ id, hash, updatedAt }) => ({ id, hash, updatedAt })),
      deletedBlocks: dedupeBlockRecords([...localDoc.deletedBlocks, ...remoteDoc.deletedBlocks, ...deletedBlocks]),
      updatedAt: new Date().toISOString(),
    },
  };
}

function mergedBlockOrder(localBlocks: IndexedBlock[], remoteBlocks: IndexedBlock[]): string[] {
  const order = localBlocks.map((block) => block.id);
  for (let index = 0; index < remoteBlocks.length; index += 1) {
    const id = remoteBlocks[index].id;
    if (order.includes(id)) {
      continue;
    }
    const previousRemote = remoteBlocks.slice(0, index).reverse().find((block) => order.includes(block.id));
    if (previousRemote) {
      order.splice(order.indexOf(previousRemote.id) + 1, 0, id);
      continue;
    }
    const nextRemote = remoteBlocks.slice(index + 1).find((block) => order.includes(block.id));
    if (nextRemote) {
      order.splice(order.indexOf(nextRemote.id), 0, id);
      continue;
    }
    order.push(id);
  }
  return order;
}

function chooseMergedBlock(
  local: IndexedBlock | undefined,
  remote: IndexedBlock | undefined,
  localDeletion: NoteBlockRecord | undefined,
  remoteDeletion: NoteBlockRecord | undefined,
): IndexedBlock | null {
  if (local && remote) {
    return local.hash === remote.hash ? local : newerIndexedBlock(local, remote);
  }
  if (local) {
    return isDeletionNewer(remoteDeletion, local.updatedAt) ? null : local;
  }
  if (remote) {
    return isDeletionNewer(localDeletion, remote.updatedAt) ? null : remote;
  }
  return null;
}

function newerIndexedBlock(a: IndexedBlock, b: IndexedBlock): IndexedBlock {
  return Date.parse(a.updatedAt) >= Date.parse(b.updatedAt) ? a : b;
}

function isDeletionNewer(deletion: NoteBlockRecord | undefined, updatedAt: string): boolean {
  if (!deletion?.deletedAt) {
    return false;
  }
  return Date.parse(deletion.deletedAt) > Date.parse(updatedAt);
}

function newestBlockRecord(a: NoteBlockRecord | undefined, b: NoteBlockRecord | undefined): NoteBlockRecord | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return Date.parse(a.deletedAt ?? a.updatedAt) >= Date.parse(b.deletedAt ?? b.updatedAt) ? a : b;
}

function dedupeBlockRecords(records: NoteBlockRecord[]): NoteBlockRecord[] {
  const byId = new Map<string, NoteBlockRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing || Date.parse(record.deletedAt ?? record.updatedAt) >= Date.parse(existing.deletedAt ?? existing.updatedAt)) {
      byId.set(record.id, record);
    }
  }
  return Array.from(byId.values());
}

function sameBlockRecords(a: NoteBlockRecord[], b: NoteBlockRecord[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((block, index) => block.id === b[index]?.id && block.hash === b[index]?.hash && block.updatedAt === b[index]?.updatedAt);
}

function encryptedObjectPath(file: string, hash: string): string {
  const objectId = sha256Hex(`${normalizeVaultPath(file)}\0${hash}`);
  return `${SECURE_DIR}/objects/${objectId.slice(0, 2)}/${objectId}.enc`;
}

function isNotePath(vaultRelativePath: string): boolean {
  const normalized = normalizeVaultPath(vaultRelativePath);
  const firstSegment = normalized.split("/")[0];
  return Boolean(normalized)
    && !isConflictCopyPath(normalized)
    && !EXCLUDED_TOP_LEVEL.has(firstSegment)
    && firstSegment !== SECURE_DIR
    && firstSegment !== CONFLICTS_DIR
    && firstSegment !== NOTE_TRASH_DIR;
}

function isPlaintextObsidianSyncPath(vaultRelativePath: string): boolean {
  const normalized = normalizeVaultPath(vaultRelativePath);
  return normalized.startsWith(".obsidian/")
    && !isConflictCopyPath(normalized)
    && normalized !== ".obsidian/plugins"
    && !normalized.startsWith(".obsidian/plugins/");
}

function isSyncablePluginPath(vaultRelativePath: string): boolean {
  const normalized = normalizeVaultPath(vaultRelativePath);
  if (isConflictCopyPath(normalized)) {
    return false;
  }
  if (!normalized.startsWith(".obsidian/plugins/")) {
    return false;
  }
  const pluginDir = normalized.split("/")[2];
  if (!pluginDir) {
    return false;
  }
  if (SELF_PLUGIN_DIR_NAMES.has(pluginDir)) {
    return isSelfPluginRuntimePath(normalized);
  }
  return true;
}

function isSyncablePluginDirectory(vaultRelativePath: string): boolean {
  const normalized = normalizeVaultPath(vaultRelativePath);
  if (isConflictCopyPath(normalized)) {
    return false;
  }
  if (!normalized.startsWith(".obsidian/plugins/")) {
    return false;
  }
  const parts = normalized.split("/");
  const pluginDir = parts[2];
  if (!pluginDir) {
    return false;
  }
  const dirName = parts[parts.length - 1];
  if (dirName === "node_modules" || dirName === ".git") {
    return false;
  }
  if (SELF_PLUGIN_DIR_NAMES.has(pluginDir) && ["src", "release", ".github"].includes(dirName)) {
    return false;
  }
  return true;
}

function pluginDirFromPath(vaultRelativePath: string): string | null {
  const parts = normalizeVaultPath(vaultRelativePath).split("/");
  return parts[0] === ".obsidian" && parts[1] === "plugins" && parts[2] ? parts[2] : null;
}

function isSelfPluginRuntimePath(vaultRelativePath: string): boolean {
  const normalized = normalizeVaultPath(vaultRelativePath);
  const parts = normalized.split("/");
  return parts.length === 4
    && parts[0] === ".obsidian"
    && parts[1] === "plugins"
    && SELF_PLUGIN_DIR_NAMES.has(parts[2])
    && SELF_PLUGIN_RUNTIME_FILES.has(parts[3]);
}

function conflictCategoryForPath(vaultRelativePath: string): keyof SyncConflictResolution {
  if (isSyncablePluginPath(vaultRelativePath)) {
    return "plugins";
  }
  if (isPlaintextObsidianSyncPath(vaultRelativePath)) {
    return "obsidian";
  }
  return "notes";
}

function isConflictCopyPath(vaultRelativePath: string): boolean {
  const baseName = path.basename(normalizeVaultPath(vaultRelativePath));
  return /\.sync-conflict-\d{8,}-\d{6,}/i.test(baseName)
    || /\((conflicted copy|conflict copy)[^)]*\)/i.test(baseName)
    || /\u51b2\u7a81\u526f\u672c/.test(baseName);
}

function commonSyncPathspecExclusions(): string[] {
  return [
    `:(exclude)${SECURE_DIR}/**`,
    `:(exclude)${CONFLICTS_DIR}/**`,
    `:(exclude)${NOTE_TRASH_DIR}/**`,
    ...CONFLICT_COPY_PATHSPEC_EXCLUSIONS,
  ];
}

function selfPluginPathspecExclusions(): string[] {
  const exclusions: string[] = [];
  for (const pluginDir of SELF_PLUGIN_DIR_NAMES) {
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/data.json`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/node_modules/**`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/src/**`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/release/**`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/.github/**`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/package.json`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/package-lock.json`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/tsconfig.json`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/esbuild.config.mjs`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/versions.json`);
    exclusions.push(`:(exclude).obsidian/plugins/${pluginDir}/README.md`);
  }
  return exclusions;
}

function selfPluginRuntimePaths(): string[] {
  const paths: string[] = [];
  for (const pluginDir of SELF_PLUGIN_DIR_NAMES) {
    for (const file of SELF_PLUGIN_RUNTIME_FILES) {
      paths.push(`.obsidian/plugins/${pluginDir}/${file}`);
    }
  }
  return paths;
}

function pluginRuntimePathspecs(pluginDir: string): string[] {
  if (SELF_PLUGIN_DIR_NAMES.has(pluginDir)) {
    return Array.from(SELF_PLUGIN_RUNTIME_FILES).map((file) => `.obsidian/plugins/${pluginDir}/${file}`);
  }
  return [`.obsidian/plugins/${pluginDir}`];
}

function pluginDirsUsingRemote(choices: Map<string, PluginSyncChoice>): Set<string> {
  const result = new Set<string>();
  for (const [pluginDir, choice] of choices.entries()) {
    if (choice.useRemote) {
      result.add(pluginDir);
    }
  }
  return result;
}

function parsePluginVersionInfo(contents: Buffer): PluginVersionInfo | null {
  try {
    const value = JSON.parse(contents.toString("utf8")) as { version?: string; releaseDate?: string; buildTime?: string };
    if (!value.version) {
      return null;
    }
    return {
      version: value.version,
      releaseDate: value.releaseDate ?? "",
      buildTime: value.buildTime ?? "",
    };
  } catch {
    return null;
  }
}

function comparePluginVersions(a: PluginVersionInfo, b: PluginVersionInfo): number {
  const versionCompare = compareSemver(a.version, b.version);
  if (versionCompare !== 0) {
    return versionCompare;
  }
  const releaseDateCompare = parseDateLike(a.releaseDate) - parseDateLike(b.releaseDate);
  if (releaseDateCompare !== 0) {
    return releaseDateCompare;
  }
  return parseDateLike(a.buildTime) - parseDateLike(b.buildTime);
}

function parseDateLike(value: string): number {
  const timestamp = Date.parse(value || "1970-01-01T00:00:00.000Z");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareSemver(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function isUnrelatedHistoriesError(error: unknown): boolean {
  return error instanceof Error && /refusing to merge unrelated histories/i.test(error.message);
}

function initialPlaintextPullSummary(remote: RemoteConfig, protectedLocalFiles: number, mergeResult: InitialPullMergeResult): string {
  const details: string[] = [];
  if (protectedLocalFiles > 0) {
    details.push(`Protected ${protectedLocalFiles} local files before checkout.`);
  }
  if (mergeResult.mergedFiles > 0) {
    details.push(`Merged ${mergeResult.mergedFiles} local files after checkout.`);
  }
  if (mergeResult.restoredPluginFiles > 0) {
    details.push(`Kept newer local plugin files (${mergeResult.restoredPluginFiles}).`);
  }
  if (mergeResult.conflictCopies > 0) {
    details.push(`Saved ${mergeResult.conflictCopies} conflict copies.`);
  }
  return [`Initialized from ${remote.name}/${remote.branch}.`, ...details].join(" ");
}

function normalizeVaultPath(filePath: string): string {
  return normalizePath(filePath).replace(/^\/+/, "");
}

function renderCommitMessage(template: string): string {
  return template.replace("{{date}}", new Date().toISOString());
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createGitAuthContext(remote: RemoteConfig, settings: SecureGitSettings): Promise<GitAuthContext> {
  const baseEnv = {
    ...process.env,
    ...proxyEnv(settings),
  };
  if (!remote.providerAccountId || !/^https?:\/\//i.test(remote.url)) {
    return {
      env: baseEnv,
      cleanup: async () => undefined,
    };
  }

  const account = settings.providerAccounts.find((item) => item.id === remote.providerAccountId);
  if (!account?.token) {
    return {
      env: baseEnv,
      cleanup: async () => undefined,
    };
  }

  const askpassPath = await createAskpassScript();
  const env = {
    ...baseEnv,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    OSGS_GIT_USERNAME: gitUsernameForProvider(account),
    OSGS_GIT_PASSWORD: account.token,
  };

  return {
    env,
    cleanup: async () => {
      await fs.rm(askpassPath, { force: true });
    },
  };
}

async function createAskpassScript(): Promise<string> {
  const extension = process.platform === "win32" ? ".cmd" : ".sh";
  const askpassPath = path.join(os.tmpdir(), `secure-git-sync-askpass-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "echo %~1 | findstr /I \"Username\" >nul",
      "if %errorlevel%==0 (",
      "  echo %OSGS_GIT_USERNAME%",
      ") else (",
      "  echo %OSGS_GIT_PASSWORD%",
      ")",
      "",
    ].join("\r\n")
    : [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*|*username*) printf '%s\\n' \"$OSGS_GIT_USERNAME\" ;;",
      "  *) printf '%s\\n' \"$OSGS_GIT_PASSWORD\" ;;",
      "esac",
      "",
    ].join("\n");
  await fs.writeFile(askpassPath, script, { mode: 0o700 });
  return askpassPath;
}

function gitUsernameForProvider(account: ProviderAccount): string {
  const usernames: Record<GitProviderId, string> = {
    github: "x-access-token",
    gitlab: "oauth2",
    gitee: account.label || "git",
    atomgit: "oauth2",
  };
  return usernames[account.provider];
}

function proxyEnv(settings: SecureGitSettings): NodeJS.ProcessEnv {
  if (settings.proxyMode === "off") {
    return {};
  }
  if (settings.proxyMode === "system") {
    return {
      HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
      ALL_PROXY: process.env.ALL_PROXY ?? process.env.all_proxy,
      NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy,
      http_proxy: process.env.http_proxy ?? process.env.HTTP_PROXY,
      https_proxy: process.env.https_proxy ?? process.env.HTTPS_PROXY,
      all_proxy: process.env.all_proxy ?? process.env.ALL_PROXY,
      no_proxy: process.env.no_proxy ?? process.env.NO_PROXY,
    };
  }
  const proxyUrl = settings.proxyUrl.trim();
  if (!proxyUrl) {
    return {};
  }
  const noProxy = settings.proxyNoProxy.trim();
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
