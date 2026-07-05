# 🔐 Secure Git Sync

Secure Git Sync is an Obsidian desktop plugin for password-confirmed Git sync with encrypted remote note snapshots. It keeps your local vault readable, while the remote repository can store note content as AES-256-GCM encrypted objects.

[中文说明](README.zh-CN.md)

## 🧭 What It Does

Secure Git Sync is built for users who already trust Git as their backup and multi-device transport, but want a safer remote layout for private notes. The plugin can use a vault's existing `.git` repository, import existing local remotes, or add new remotes from common Git hosting providers.

The core workflow is simple:

- Unlock the plugin with the administrator password.
- Choose a configured remote.
- Run pull, push, sync, or status from the Obsidian ribbon panel.
- Keep local files plaintext and readable.
- Store remote note snapshots encrypted when encryption is enabled.

## ✨ Feature Summary

- Password confirmation before push, pull, and sync operations.
- Encrypted remote note snapshots enabled by default for new settings.
- Plaintext local vault files and local Git working tree.
- Import existing local `.git/config` remotes without rewriting their URLs.
- Support for GitHub, GitLab, Gitee, AtomGit, generic SSH remotes, and generic HTTPS remotes.
- Multiple remotes in one vault, including local remotes with multiple push URLs.
- Pull, push, sync, status, conflict review, and conflict resolution UI.
- Optional Obsidian settings sync.
- Optional plugin runtime artifact sync with local plugin state excluded.
- Administrator password wrapping with Argon2id for new keyrings.
- PBKDF2 keyring compatibility for older configurations.
- AES-256-GCM encrypted note objects and manifests.
- Incremental note cache to avoid re-hashing unchanged files.
- Limited-concurrency hash/encrypt pipeline for large vaults.
- Sharded encrypted manifest support with legacy full-manifest compatibility.
- Persistent internal Git cache under `.secure-git-sync/git-cache`.
- Release artifacts generated only under `release/`.

## 🌟 What Makes It Different

Secure Git Sync is not a hosted sync service. It is a local-first Obsidian plugin that uses the Git remotes you choose.

Its most important distinction is the split between local usability and remote privacy:

- Locally, your vault remains normal Markdown and normal Obsidian configuration.
- Remotely, note files can be represented as encrypted objects and an encrypted manifest.
- Git remains the transport layer, so you can use your own GitHub, GitLab, Gitee, GitCode, SSH, or self-hosted Git remote.

The plugin also tries to cooperate with existing Git workflows. If a vault already has remotes in `.git/config`, you can import and reuse them instead of forcing the plugin to recreate the remote setup.

## 🛡️ Encryption Model

When encrypted sync is enabled, the remote repository stores notes in this layout:

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

## 🏗️ Architecture

The plugin is organized around a few main parts:

- `src/main.ts`: Obsidian plugin entry point, commands, setting tab, modals, operation panel, unlock flow, and user-visible progress.
- `src/git.ts`: Git orchestration, encrypted push/pull, plaintext compatibility, conflict handling, remote import, file scanning, manifest management, and performance cache.
- `src/crypto.ts`: Password verification, key wrapping, key migration, AES-GCM encryption, decryption, and hashing helpers.
- `src/providers.ts`: Hosted Git provider API integrations for repository browsing and creation.
- `src/types.ts`: Settings, remotes, providers, password config, sync state, and cache types.
- `release/build-release.mjs`: Build and package script for release artifacts.

The sync engine uses Git subprocesses, but guards command execution with an allowlist and path checks. It only runs Git inside the vault or the plugin's internal temporary/cache workspaces.

## ⚙️ Runtime Flow

Encrypted push:

1. Ensure the vault has a Git repository and the selected remote is available.
2. Fetch the remote branch into an internal Git workspace.
3. Read the encrypted manifest, preferring sharded manifests and falling back to the legacy full manifest.
4. Scan note paths.
5. Reuse cached file hash and block metadata when size and mtime are unchanged.
6. Hash and encrypt only changed notes with limited concurrency.
7. Reuse unchanged remote encrypted objects.
8. Write the updated manifest, shard index, and shards.
9. Create a Git commit in the internal workspace and push it to the selected remote branch.

Encrypted pull:

1. Fetch the selected remote branch.
2. Read and decrypt the manifest.
3. Compare local hashes with remote manifest entries, using local cache where possible.
4. Decrypt only changed remote notes.
5. Merge or apply files according to the selected conflict strategy.
6. Save conflict copies when automatic merge is not safe.
7. Update local note indexes and cache metadata.

Plaintext compatibility:

- If encryption is disabled, the plugin can still run ordinary Git push/pull flows.
- If a remote already contains encrypted manifests, the plugin can auto-detect that and use encrypted handling.

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

## 🧰 Build And Release

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

## ![Buy Me a Coffee](assets/buy-me-a-coffee.png) Currently not available

If Secure Git Sync helps your Obsidian workflow, you can support ongoing development here:

- [WeChat Pay](assets/wechat-pay-placeholder.svg)
- [Alipay](assets/alipay-placeholder.svg)

Thank you for helping keep the plugin maintained, tested, and improved.

## 🤖 Automation

GitHub Actions release automation lives at `.github/workflows/release.yml`. It can run manually, by pushing an `x.x.x` version tag such as `0.2.0`, or by changing the plugin version on `main`. The action builds the release package and publishes a GitHub Release for `<manifest.version>` when that release does not already exist.
