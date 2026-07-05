# 🔐 Secure Git Sync

Secure Git Sync is an Obsidian desktop plugin for password-confirmed Git sync, optional encrypted remote note snapshots, and direct LAN vault sync.

[中文说明](README.zh-CN.md)

## 🧭 What It Does

Secure Git Sync is built for users who already use Git to back up or move an Obsidian vault, but want stronger control over private notes and local-first workflows.

The plugin can:

- Reuse an existing vault `.git` repository and import its configured remotes.
- Add new remotes from common Git hosting providers or generic SSH/HTTPS URLs.
- Keep local vault files readable as normal Markdown.
- Store remote note snapshots as encrypted objects when encrypted sync is enabled.
- Sync directly with another device on the same LAN without Git.

## ✅ Feature Summary

- Password confirmation before push, pull, and sync operations.
- Encrypted remote note snapshots enabled by default for new settings.
- Plaintext local vault files and local Git working tree.
- Import existing local `.git/config` remotes without rewriting their URLs.
- Support for GitHub, GitLab, Gitee, AtomGit, generic SSH remotes, and generic HTTPS remotes.
- Multiple remotes in one vault, including local remotes with multiple push URLs.
- Pull, push, sync, status, conflict review, and conflict resolution UI.
- Optional Obsidian settings sync.
- Optional plugin runtime artifact sync with local plugin state excluded.
- LAN sync for devices on the same Wi-Fi/LAN, with device discovery and manual target selection.
- Incremental local change index under `.secure-git-sync/index/`.
- Large local cache moved out of `data.json` into `.secure-git-sync/local-cache.json`.
- Faster encrypted sync path using one remote session for pull and push.
- Optional post-sync verification instead of mandatory full verification after every sync.
- Batched Git object reads and limited-concurrency note processing for large vaults.
- Sharded encrypted manifest support with legacy full-manifest compatibility.
- Release artifacts generated only under `release/`.

## 🌟 What Makes It Different

Secure Git Sync is not a hosted sync service. It is a local-first Obsidian plugin that uses the Git remotes and devices you choose.

Its main split is local usability versus remote privacy:

- Locally, your vault remains normal Markdown and normal Obsidian configuration.
- Remotely, note files can be represented as encrypted objects and encrypted manifests.
- Git remains the transport layer for remote repositories.
- LAN sync is available for direct device-to-device vault copy on trusted local networks.

The plugin also tries to cooperate with existing Git workflows. If a vault already has remotes in `.git/config`, you can import and reuse them instead of forcing the plugin to recreate the remote setup.

## 🛡️ Encryption Model

When encrypted Git sync is enabled, the remote repository stores notes in this layout:

```text
.obsidian/                         # selected Obsidian settings, plaintext
.secure-git-sync/
  manifest.enc                     # legacy full encrypted manifest
  manifest-index.enc               # encrypted shard index
  manifest-shards/
    00.enc                         # encrypted manifest shard
    ...
  keyring.json                     # optional password-wrapped vault key
  objects/
    ab/<object-id>.enc             # encrypted note object
```

The plugin uses a random 256-bit vault key for note content. The administrator password wraps that vault key. New keyrings use Argon2id, while older PBKDF2-SHA-256 keyrings can still be unlocked and migrated.

Each note object is encrypted with AES-256-GCM. The vault-relative path is used as authenticated additional data, binding encrypted content to its intended path.

## 📡 LAN Sync

LAN sync is designed for trusted devices on the same Wi-Fi or local network.

- Disabled by default.
- Does not use Git.
- Does not encrypt transfer content by default.
- Discovers nearby devices automatically and also supports manual refresh.
- Lets you choose the target device before syncing.
- Copies newer and missing files in both directions.
- Does not propagate deletions yet, to avoid accidental destructive sync.

Because LAN sync starts a local HTTP listener and UDP discovery listener, your operating system firewall may ask whether Obsidian can communicate on the local network.

## 🏗️ Architecture

The plugin is organized around these modules:

- `src/main.ts`: Obsidian plugin entry point, commands, setting tab, modals, operation panel, unlock flow, progress UI, and LAN controls.
- `src/git.ts`: Git orchestration, encrypted push/pull/sync, plaintext compatibility, conflict handling, remote import, manifest management, and performance cache.
- `src/lan.ts`: Local network discovery, peer HTTP server, device manifest comparison, and direct file transfer.
- `src/crypto.ts`: Password verification, key wrapping, key migration, AES-GCM encryption, decryption, and hashing helpers.
- `src/providers.ts`: Hosted Git provider integrations for repository browsing and creation.
- `src/types.ts`: Settings, remotes, providers, password config, sync state, cache types, and LAN settings.
- `release/build-release.mjs`: Build and package script for release artifacts.

The Git sync engine uses Git subprocesses, but guards command execution with an allowlist and path checks. Git is only run inside the vault or the plugin's internal temporary/cache workspaces.

## ⚙️ Runtime Flow

Encrypted sync now favors a single remote session:

1. Fetch the selected remote branch into the internal Git workspace.
2. Read the encrypted manifest, preferring sharded manifests and falling back to the legacy full manifest.
3. Use the local change index and cache to avoid unnecessary full note hashing.
4. Hash and encrypt changed notes with limited concurrency.
5. Read changed remote blobs in batches where possible.
6. Apply pull-side changes and prepare push-side encrypted objects.
7. Write the updated manifest, shard index, and shards.
8. Commit and push the updated encrypted snapshot when needed.

Expensive checks are now more selective:

- Pre-sync difference inspection is skipped unless confirmation is enabled.
- Post-sync remote consistency verification is optional and can be run manually.
- The UI records stage timings so slow phases are easier to identify.

## 📦 Sync Scope

Encrypted mode treats notes as encrypted remote objects. Selected Obsidian configuration can still be synchronized as plaintext.

The plugin excludes noisy or unsafe runtime state, including:

- `.git/`
- `.secure-git-sync/`
- `.secure-git-sync-conflicts/`
- `.secure-git-sync-trash/`
- conflict-copy files
- plugin dependency/cache directories
- plugin local state files such as `data.json`, `cache.json`, and `workspace.json`
- Secure Git Sync's own local `data.json`

Plugin runtime sync only includes the runtime artifacts needed by Obsidian:

- `manifest.json`
- `main.js`
- `styles.css`

## 🚀 Installation

Install the built plugin files into this Obsidian plugin folder:

```text
<vault>/.obsidian/plugins/secure-git-sync/
```

Runtime files:

```text
manifest.json
main.js
styles.css
```

Then enable `Secure Git Sync` in Obsidian's Community plugins settings.

## 🧪 Build And Release

Install dependencies:

```bash
npm install
```

Build a local plugin folder under `release/`:

```bash
npm run build
```

Create a full release package:

```bash
npm run release
```

Release output:

```text
release/secure-git-sync-<version>/
  manifest.json
  main.js
  styles.css
release/secure-git-sync-<version>.zip
release/secure-git-sync-<version>.sha256
```

The repository root must not contain generated `main.js`. Build and release artifacts are kept under `release/`.

## ![Buy Me a Coffee](assets/buy-me-a-coffee.png) Buy Me a Coffee (Currently not available)

If Secure Git Sync helps your Obsidian workflow, support links are reserved here for future use:

- [WeChat Pay](assets/wechat-pay-placeholder.svg)
- [Alipay](assets/alipay-placeholder.svg)

Thank you for helping keep the plugin maintained, tested, and improved.

## 🤖 Automation

GitHub Actions release automation lives at `.github/workflows/release.yml`. It can run manually, by pushing an `x.x.x` version tag such as `0.2.1`, or by changing the plugin version on `main`. The action builds the release package and publishes a GitHub Release for `<manifest.version>` when that release does not already exist.
