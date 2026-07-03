import esbuild from "esbuild";
import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const runRoot = path.join(rootDir, ".tmp-real-sync-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const bundlePath = path.join(runRoot, "runner.cjs");

await fs.mkdir(runRoot, { recursive: true });

const entry = String.raw`
const { execFile } = require("child_process");
const { promises: fs } = require("fs");
const path = require("path");
const assert = require("assert");
const { GitService } = require("./src/git.ts");
const { createPasswordConfig, verifyPassword } = require("./src/crypto.ts");
const { DEFAULT_SETTINGS } = require("./src/types.ts");

process.env.GIT_AUTHOR_NAME = "Secure Git Sync Test";
process.env.GIT_AUTHOR_EMAIL = "secure-git-sync-test@example.local";
process.env.GIT_COMMITTER_NAME = "Secure Git Sync Test";
process.env.GIT_COMMITTER_EMAIL = "secure-git-sync-test@example.local";

const runRoot = ${JSON.stringify(runRoot)};

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, encoding: "buffer", maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr && stderr.toString("utf8")) || error.message));
        return;
      }
      resolve((stdout && stdout.toString("utf8")) || "");
    });
  });
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

async function read(file) {
  return fs.readFile(file, "utf8");
}

function settings(overrides = {}) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    commitMessageTemplate: "test sync {{date}}",
    ...overrides,
  };
}

function remoteConfig(remotePath) {
  return { id: "origin", name: "origin", url: remotePath, branch: "main" };
}

function progress(label) {
  return (event) => {
    if (event.kind === "end" || event.kind === "info") {
      console.log(label + " | " + event.phase + " | " + event.message + (event.elapsedMs == null ? "" : " | " + event.elapsedMs + "ms"));
    }
  };
}

async function createSeedRemote(name, files) {
  const dir = path.join(runRoot, name);
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "--bare", remote]);
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ["init"]);
  await git(seed, ["checkout", "-b", "main"]);
  await git(seed, ["config", "user.name", "Secure Git Sync Test"]);
  await git(seed, ["config", "user.email", "secure-git-sync-test@example.local"]);
  for (const [file, text] of Object.entries(files)) {
    await write(path.join(seed, file), text);
  }
  await git(seed, ["add", "--all"]);
  await git(seed, ["commit", "-m", "seed"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "origin", "main"]);
  return { dir, remote };
}

async function testPlaintextInitialMerge() {
  const { dir, remote } = await createSeedRemote("plain-initial", {
    "test1.md": "# Shared\nremote line\n",
    ".obsidian/app.json": JSON.stringify({ remoteOnly: true, alwaysUpdateLinks: true }, null, 2) + "\n",
    ".obsidian/plugins/example/manifest.json": JSON.stringify({ id: "example", name: "Example", version: "1.0.0", releaseDate: "2026-01-01", buildTime: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
    ".obsidian/plugins/example/main.js": "module.exports = 'remote-v1';\n",
    ".obsidian/plugins/example/styles.css": "/* remote v1 */\n",
  });
  const vault = path.join(dir, "vault-a");
  await write(path.join(vault, "test1.md"), "# Shared\nlocal line\n");
  await write(path.join(vault, ".obsidian/app.json"), JSON.stringify({ localOnly: true, alwaysUpdateLinks: false }, null, 2) + "\n");
  await write(path.join(vault, ".obsidian/plugins/example/manifest.json"), JSON.stringify({ id: "example", name: "Example", version: "2.0.0", releaseDate: "2026-06-30", buildTime: "2026-06-30T00:00:00.000Z" }, null, 2) + "\n");
  await write(path.join(vault, ".obsidian/plugins/example/main.js"), "module.exports = 'local-v2';\n");
  const service = new GitService(vault);
  const result = await service.pull(remoteConfig(remote), settings({ encryptionEnabled: false }), null, progress("plain initial"), { notes: "merge", obsidian: "merge", plugins: "merge" });
  const note = await read(path.join(vault, "test1.md"));
  assert(note.includes("local line"), "plaintext initial merge lost local note content");
  assert(note.includes("remote line"), "plaintext initial merge lost remote note content");
  const appJson = JSON.parse(await read(path.join(vault, ".obsidian/app.json")));
  assert.equal(appJson.localOnly, true, "plaintext initial merge lost local .obsidian JSON key");
  assert.equal(appJson.remoteOnly, true, "plaintext initial merge lost remote .obsidian JSON key");
  const plugin = JSON.parse(await read(path.join(vault, ".obsidian/plugins/example/manifest.json")));
  assert.equal(plugin.version, "2.0.0", "plaintext initial merge did not keep newer local plugin");
  await service.push(remoteConfig(remote), settings({ encryptionEnabled: false }), null, progress("plain initial push"), { includePlugins: true });
  const verify = path.join(dir, "verify");
  await git(dir, ["clone", "-b", "main", remote, verify]);
  const remotePlugin = JSON.parse(await read(path.join(verify, ".obsidian/plugins/example/manifest.json")));
  assert.equal(remotePlugin.version, "2.0.0", "plaintext push did not update remote to newer plugin");
  console.log("PASS plaintext initial merge: " + result.summary);
}

async function testEncryptedInitialMerge() {
  const dir = path.join(runRoot, "encrypted-initial");
  const remote = path.join(dir, "remote.git");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "--bare", remote]);
  const password = await createPasswordConfig("admin", "correct horse battery staple", "");
  const key = await verifyPassword("admin", "correct horse battery staple", password);
  const vault1Settings = settings({ encryptionEnabled: true, password });
  const vault1 = path.join(dir, "vault-1");
  await write(path.join(vault1, "alpha.md"), "# Alpha\nremote line\n");
  await write(path.join(vault1, ".obsidian/app.json"), JSON.stringify({ remoteOnly: true }, null, 2) + "\n");
  await write(path.join(vault1, ".obsidian/plugins/example/manifest.json"), JSON.stringify({ id: "example", name: "Example", version: "1.0.0", releaseDate: "2026-01-01", buildTime: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n");
  await write(path.join(vault1, ".obsidian/plugins/example/main.js"), "module.exports = 'remote-v1';\n");
  const service1 = new GitService(vault1);
  await service1.push(remoteConfig(remote), vault1Settings, key, progress("encrypted seed"), { includePlugins: true });

  const vault2Settings = settings({ encryptionEnabled: true, password });
  const vault2 = path.join(dir, "vault-2");
  await write(path.join(vault2, "alpha.md"), "# Alpha\nlocal line\n");
  await write(path.join(vault2, ".obsidian/app.json"), JSON.stringify({ localOnly: true }, null, 2) + "\n");
  await write(path.join(vault2, ".obsidian/plugins/example/manifest.json"), JSON.stringify({ id: "example", name: "Example", version: "2.0.0", releaseDate: "2026-06-30", buildTime: "2026-06-30T00:00:00.000Z" }, null, 2) + "\n");
  await write(path.join(vault2, ".obsidian/plugins/example/main.js"), "module.exports = 'local-v2';\n");
  const service2 = new GitService(vault2);
  const result = await service2.pull(remoteConfig(remote), vault2Settings, key, progress("encrypted pull"), { notes: "merge", obsidian: "merge", plugins: "merge" });
  const note = await read(path.join(vault2, "alpha.md"));
  assert(note.includes("local line"), "encrypted initial merge lost local note content");
  assert(note.includes("remote line"), "encrypted initial merge lost remote note content");
  const appJson = JSON.parse(await read(path.join(vault2, ".obsidian/app.json")));
  assert.equal(appJson.localOnly, true, "encrypted initial merge lost local .obsidian JSON key");
  assert.equal(appJson.remoteOnly, true, "encrypted initial merge lost remote .obsidian JSON key");
  const plugin = JSON.parse(await read(path.join(vault2, ".obsidian/plugins/example/manifest.json")));
  assert.equal(plugin.version, "2.0.0", "encrypted initial merge did not keep newer local plugin");
  await service2.push(remoteConfig(remote), vault2Settings, key, progress("encrypted push"), { includePlugins: true });
  const vault3 = path.join(dir, "vault-3");
  await fs.mkdir(vault3, { recursive: true });
  const vault3Settings = settings({ encryptionEnabled: true, password });
  const service3 = new GitService(vault3);
  await service3.pull(remoteConfig(remote), vault3Settings, key, progress("encrypted verify"), { notes: "merge", obsidian: "merge", plugins: "merge" });
  const verifyNote = await read(path.join(vault3, "alpha.md"));
  assert(verifyNote.includes("local line") && verifyNote.includes("remote line"), "encrypted verification vault did not receive merged note");
  const verifyPlugin = JSON.parse(await read(path.join(vault3, ".obsidian/plugins/example/manifest.json")));
  assert.equal(verifyPlugin.version, "2.0.0", "encrypted verification vault did not receive newer plugin");
  console.log("PASS encrypted initial merge: " + result.summary);
}

async function testEncryptedRemoteAutoDetectWhenLocalToggleOff() {
  const dir = path.join(runRoot, "encrypted-toggle-off");
  const remote = path.join(dir, "remote.git");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "--bare", remote]);
  const password = await createPasswordConfig("admin", "correct horse battery staple", "");
  const key = await verifyPassword("admin", "correct horse battery staple", password);
  const seedSettings = settings({ encryptionEnabled: true, password });
  const seedVault = path.join(dir, "seed-vault");
  await write(path.join(seedVault, "remote-only.md"), "# Remote only\nthis must be restored\n");
  await write(path.join(seedVault, ".obsidian/app.json"), JSON.stringify({ remoteOnly: true }, null, 2) + "\n");
  const seedService = new GitService(seedVault);
  await seedService.push(remoteConfig(remote), seedSettings, key, progress("encrypted toggle seed"), { includePlugins: true });

  const localVault = path.join(dir, "local-toggle-off");
  await fs.mkdir(localVault, { recursive: true });
  const localSettings = settings({ encryptionEnabled: false, password });
  const localService = new GitService(localVault);
  const pullResult = await localService.pull(remoteConfig(remote), localSettings, key, progress("encrypted toggle pull"), { notes: "merge", obsidian: "merge", plugins: "merge" });
  const note = await read(path.join(localVault, "remote-only.md"));
  assert(note.includes("this must be restored"), "encrypted remote was not restored when local encryption toggle is off");
  await localService.push(remoteConfig(remote), localSettings, key, progress("encrypted toggle push"), { includePlugins: true });
  console.log("PASS encrypted remote auto-detect with local toggle off: " + pullResult.summary);
}

async function testEncryptedRemoteKeyringImport() {
  const dir = path.join(runRoot, "encrypted-keyring-import");
  const remote = path.join(dir, "remote.git");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "--bare", remote]);

  const remotePassword = await createPasswordConfig("admin", "correct horse battery staple", "remote hint");
  const remoteKey = await verifyPassword("admin", "correct horse battery staple", remotePassword);
  const seedSettings = settings({ encryptionEnabled: true, password: remotePassword, syncKeyringToRemote: true });
  const seedVault = path.join(dir, "seed-vault");
  await write(path.join(seedVault, "remote-keyring.md"), "# Remote keyring\nimport me\n");
  const seedService = new GitService(seedVault);
  await seedService.push(remoteConfig(remote), seedSettings, remoteKey, progress("keyring seed"), {
    includePlugins: true,
    credential: { username: "admin", password: "correct horse battery staple" },
  });
  const keyringTree = await git(dir, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main", "--", ".secure-git-sync/keyring.json"]);
  assert(keyringTree.includes(".secure-git-sync/keyring.json"), "encrypted push did not write remote keyring");

  const localPassword = await createPasswordConfig("admin", "correct horse battery staple", "local hint");
  const localKey = await verifyPassword("admin", "correct horse battery staple", localPassword);
  const localSettings = settings({ encryptionEnabled: false, password: localPassword });
  const localVault = path.join(dir, "new-local-vault");
  await fs.mkdir(localVault, { recursive: true });
  const localService = new GitService(localVault);
  const pullResult = await localService.pull(remoteConfig(remote), localSettings, localKey, progress("keyring pull"), { notes: "merge", obsidian: "merge", plugins: "merge" }, { username: "admin", password: "correct horse battery staple" });
  const note = await read(path.join(localVault, "remote-keyring.md"));
  assert(note.includes("import me"), "new local vault did not decrypt remote note through keyring");
  assert(pullResult.summary.includes("Imported remote encryption key."), "keyring import was not reported");
  assert.equal(localSettings.password.keyId, remotePassword.keyId, "local settings were not switched to the remote data key envelope");
  await localService.push(remoteConfig(remote), localSettings, pullResult.key, progress("keyring push"), {
    includePlugins: true,
    credential: { username: "admin", password: "correct horse battery staple" },
  });
  console.log("PASS encrypted remote keyring import: " + pullResult.summary);
}

async function testEncryptedLocalKeyringFallback() {
  const dir = path.join(runRoot, "encrypted-local-keyring-fallback");
  const remote = path.join(dir, "remote.git");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "--bare", remote]);

  const remotePassword = await createPasswordConfig("admin", "correct horse battery staple", "remote hint");
  const remoteKey = await verifyPassword("admin", "correct horse battery staple", remotePassword);
  const seedSettings = settings({ encryptionEnabled: true, password: remotePassword });
  const seedVault = path.join(dir, "seed-vault");
  await write(path.join(seedVault, "local-keyring.md"), "# Local keyring\nfallback import\n");
  const seedService = new GitService(seedVault);
  await seedService.push(remoteConfig(remote), seedSettings, remoteKey, progress("local keyring seed"), {
    includePlugins: true,
    credential: { username: "admin", password: "correct horse battery staple" },
  });
  const keyringTree = await git(dir, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main", "--", ".secure-git-sync/keyring.json"]);
  assert(!keyringTree.includes(".secure-git-sync/keyring.json"), "seed remote unexpectedly contains keyring");

  const localPassword = await createPasswordConfig("admin", "correct horse battery staple", "local hint");
  const localKey = await verifyPassword("admin", "correct horse battery staple", localPassword);
  const localSettings = settings({ encryptionEnabled: false, password: localPassword });
  const localVault = path.join(dir, "new-local-vault");
  await fs.mkdir(localVault, { recursive: true });
  const localService = new GitService(localVault);
  const pullResult = await localService.pull(remoteConfig(remote), localSettings, localKey, progress("local keyring pull"), { notes: "merge", obsidian: "merge", plugins: "merge" }, {
    username: "admin",
    password: "correct horse battery staple",
    localKeyring: remotePassword,
  });
  const note = await read(path.join(localVault, "local-keyring.md"));
  assert(note.includes("fallback import"), "new local vault did not decrypt remote note through local keyring fallback");
  assert(pullResult.summary.includes("Imported local keyring."), "local keyring import was not reported");
  assert.equal(localSettings.password.keyId, remotePassword.keyId, "local settings were not switched to the imported local keyring envelope");
  console.log("PASS encrypted local keyring fallback: " + pullResult.summary);
}

async function testPlaintextExistingConflictAutoMerge() {
  const { dir, remote } = await createSeedRemote("plain-existing-conflict", {
    "conflict.md": "# Conflict\nbase line\n",
  });
  const vault = path.join(dir, "vault-local");
  await fs.mkdir(vault, { recursive: true });
  const service = new GitService(vault);
  await service.pull(remoteConfig(remote), settings({ encryptionEnabled: false }), null, progress("plain existing init"), { notes: "merge", obsidian: "merge", plugins: "merge" });
  const remoteWork = path.join(dir, "remote-work");
  await git(dir, ["clone", "-b", "main", remote, remoteWork]);
  await git(remoteWork, ["checkout", "main"]);
  await write(path.join(remoteWork, "conflict.md"), "# Conflict\nremote edit\n");
  await git(remoteWork, ["add", "--all"]);
  await git(remoteWork, ["commit", "-m", "remote edit"]);
  await git(remoteWork, ["push", "origin", "main"]);
  await write(path.join(vault, "conflict.md"), "# Conflict\nlocal edit\n");
  const result = await service.pull(remoteConfig(remote), settings({ encryptionEnabled: false }), null, progress("plain existing pull"), { notes: "merge", obsidian: "merge", plugins: "merge" });
  const note = await read(path.join(vault, "conflict.md"));
  assert(note.includes("local edit"), "plaintext existing conflict merge lost local edit");
  assert(note.includes("remote edit"), "plaintext existing conflict merge lost remote edit");
  assert.equal(result.conflictCopies, 0, "plaintext existing conflict should auto-merge notes without conflict copies");
  console.log("PASS plaintext existing conflict auto merge: " + result.summary);
}

async function main() {
  await testPlaintextInitialMerge();
  await testEncryptedInitialMerge();
  await testEncryptedRemoteAutoDetectWhenLocalToggleOff();
  await testEncryptedRemoteKeyringImport();
  await testEncryptedLocalKeyringFallback();
  await testPlaintextExistingConflictAutoMerge();
  console.log("ALL REAL SYNC SMOKE TESTS PASSED");
}

main().catch((error) => {
  console.error("REAL SYNC SMOKE TEST FAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;

await esbuild.build({
  stdin: {
    contents: entry,
    resolveDir: rootDir,
    loader: "js",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath,
  plugins: [{
    name: "obsidian-normalize-path-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub" }));
      build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        loader: "js",
        contents: "exports.normalizePath = (value) => String(value || '').replace(/\\\\/g, '/').replace(/\\/+/g, '/');",
      }));
    },
  }],
});

const result = spawnSync(process.execPath, [bundlePath], {
  cwd: runRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
