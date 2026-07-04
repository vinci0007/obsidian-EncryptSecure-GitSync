# Secure Git Sync

Secure Git Sync is an Obsidian desktop plugin for password-confirmed Git push and pull, with optional note-only encryption for remote repositories.

[中文说明](README.zh-CN.md)

## Description

Secure Git Sync keeps your local vault readable while giving remote Git storage a safer encrypted note snapshot. It uses the current vault repository, supports common Git hosting providers and self-hosted remotes, and asks for the administrator password before push, pull, or sync operations.

## Highlights

- Push, pull, sync, and status actions from an Obsidian ribbon panel.
- Works with GitHub, GitLab, Gitee, AtomGit, and generic/self-hosted Git remotes.
- Multiple remotes can be configured while still using the vault's single `.git` repository.
- Optional note-only encryption for remote snapshots.
- Local vault files and local Git history stay plaintext.
- New keyrings use Argon2id for password wrapping, with PBKDF2 keyrings still readable for migration.
- AES-256-GCM encrypts note objects and the encrypted manifest.
- `.obsidian/` settings are synchronized as plaintext, while plugin local state and development files are excluded.
- Conflict copies, plugin state, temporary smoke-test folders, and dependency folders are excluded from sync and source control.
- Chinese and English UI text are bundled; English is the default documentation language.

## Encryption Model

When encryption is enabled, Secure Git Sync writes this remote layout:

```text
.obsidian/                    # plaintext Obsidian settings
.secure-git-sync/
  manifest.enc                # encrypted path -> object map
  keyring.json                # optional password-wrapped vault key
  objects/
    ab/<object-id>.enc        # encrypted note objects
```

The plugin uses a random 256-bit vault key for note data. The administrator password derives a wrapping key through Argon2id for new keyrings. Older PBKDF2-SHA-256 keyrings can still be unlocked and are rewrapped as Argon2id after a successful unlock.

Remote note objects are encrypted with AES-256-GCM. The vault-relative path is authenticated as additional data, so encrypted content is bound to its path.

## Sync Scope

Tracked source files are development files only. Root-level build output such as `main.js` is ignored and should not be committed. Release artifacts are generated under `release/`.

Runtime plugin files are:

- `manifest.json`
- `main.js`
- `styles.css`

When syncing plugin files between vaults, Secure Git Sync only syncs runtime plugin artifacts and never syncs local plugin state such as `data.json`, dependencies, source code, release folders, or build configuration.

Conflict copy files are excluded from note sync, `.obsidian` sync, plugin sync, and Git staging. The plugin's own conflict-management folder remains local.

## Development

```bash
npm install
npm run build
```

`npm run build` creates the root `main.js` bundle for local testing. The file is ignored by Git.

## Release

Build the local release package:

```bash
npm run release
```

This creates:

```text
release/secure-git-sync-<version>/
  manifest.json
  main.js
  styles.css
release/secure-git-sync-<version>.zip
release/secure-git-sync-<version>.sha256
```

GitHub Actions release automation lives at `.github/workflows/release.yml`. It can be run manually, by pushing an `x.x.x` version tag such as `0.1.4`, or by changing the plugin version on `main`. The action builds the release package and publishes a GitHub Release for `<manifest.version>` when that release does not already exist.

## Installation

Copy only the runtime files into:

```text
<vault>/.obsidian/plugins/secure-git-sync/
```

Then enable the plugin in Obsidian.
