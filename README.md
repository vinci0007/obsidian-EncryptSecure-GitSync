# Secure Git Sync

An Obsidian desktop plugin for password-confirmed Git push and pull, with optional note-only encryption.

## What It Does

- Uses the current vault directory and its `.git` repository.
- Supports generic Git remotes such as GitHub, Gitee, GitLab, AtomGit, and self-hosted Git servers.
- Lets you configure multiple remotes while still using the same local `.git` repository.
- Lets you authorize provider accounts with personal access tokens, browse repositories, and create private repositories.
- Prompts for Chinese or English UI on first use, with a language switch in settings.
- Adds a left ribbon icon that opens a sync action panel.
- Provides manual Pull, Push, Sync, and Status buttons in the action panel and settings.
- Supports optional auto sync with a configurable minute interval.
- Requires the administrator password before push, pull, or sync.
- Blocks use until the administrator password is created.
- Supports changing the password and setting a password hint.
- Optionally encrypts note files for the remote while leaving the local vault and local `.git` history plaintext.

## Encryption Model

The encryption mode is inspired by password-derived, end-to-end note encryption designs:

- PBKDF2-SHA-256 derives a password wrapping key.
- A random 256-bit vault key encrypts note objects and the encrypted manifest.
- The vault key is wrapped by the password-derived key, so changing the password does not re-encrypt notes.
- AES-256-GCM encrypts note file bytes with a random IV per file.
- The file path is authenticated as additional data, so encrypted content is bound to its path.
- The encrypted manifest stores versioned crypto metadata for migration.
- Obsidian settings under `.obsidian/` are synced as plaintext, except `.obsidian/plugins/**`.
- Plugin install folders and `node_modules` are intentionally excluded from encrypted remote snapshots and pull conflict checks.

When encryption is enabled, the local vault and local `.git` history stay plaintext. Remote encryption uses an object-level layout:

```text
.obsidian/                    # plaintext plugin and vault settings
.secure-git-sync/
  manifest.enc                # encrypted path -> object map
  objects/
    ab/<object-id>.enc        # encrypted note objects
```

Push reads the encrypted manifest from the remote, compares plaintext SHA-256 hashes, reuses unchanged encrypted objects, encrypts only changed notes, writes a new encrypted manifest, and pushes the result. Pull refuses to overwrite uncommitted local note or `.obsidian/` changes, then fetches the encrypted manifest, downloads the referenced objects, decrypts notes back into the vault, writes `.obsidian/` as plaintext, and commits the resulting plaintext changes locally.

The temporary repository is still used as a Git transport sandbox, but it no longer checks out a full encrypted copy of the vault. It uses Git partial fetch when the remote supports it.

Pull uses a single full fetch of the remote branch so all referenced encrypted objects arrive in one network pass, then decrypts notes locally. Push keeps a partial fetch of the manifest to decide which encrypted objects can be reused.

## Provider Accounts

Provider accounts are used only to browse and create repositories through hosting APIs. Git push and pull still use the remote URL and your system Git authentication.

Supported account buttons:

- GitHub
- GitLab
- Gitee
- AtomGit, using a GitLab-compatible API shape by default

You can:

- Save multiple provider accounts.
- Browse repositories from an account.
- Create a new repository, private by default.
- Choose SSH or HTTPS clone URLs.
- Add the selected repository as a remote in the current vault's single `.git/config`.
- Still manually add any remote URL for self-hosted Git or unsupported providers.

When adding a provider account, the plugin opens the provider's token page in the browser and also shows an "Open authorization page" button in the authorization modal.

Tokens are stored in the plugin settings so the repository browser can call provider APIs again. Do not paste tokens into remote URLs unless you intentionally want Git itself to use that URL.

## Sync Controls

Secure Git Sync adds a ribbon icon to Obsidian's left sidebar. Clicking it opens an action panel with:

- Sync (primary)
- Status
- Pull
- Push
- Auto sync toggle
- Auto sync interval in minutes
- Auto sync unlock duration

The panel opens only after a one-time unlock. Enter the administrator password once and choose how long the unlock session stays valid:

- Only this panel
- 5 / 30 / 60 / 300 / 720 / 1440 minutes
- 7 / 30 days
- Forever

While a session is valid, Sync, Status, Pull, and Push run directly without asking for the password again. The vault key is held in memory only for the chosen duration and is never written to disk.

The panel shows a persistent status line at the top with an icon and message, the current unlock state, and the last sync time with a summary. Buttons disable and show live phase progress while an operation is running, so you can always see whether a click registered and what stage is in flight (local, network, crypto, git) with elapsed time per phase.

When encrypted Sync detects differences between local and remote content, it shows a difference dialog before applying changes. You can choose local or remote separately for:

- Notes
- Obsidian configuration under `.obsidian/`
- Syncable Obsidian plugins under `.obsidian/plugins/`

Secure Git Sync can synchronize its own installed plugin files when the plugin folder contains only runtime artifacts. It only syncs:

- `.obsidian/plugins/secure-git-sync/manifest.json`
- `.obsidian/plugins/secure-git-sync/main.js`
- `.obsidian/plugins/secure-git-sync/styles.css`

It never syncs Secure Git Sync's `data.json`, because that file may contain password wrapping metadata, remote settings, provider account tokens, and other local device state. Development files such as `node_modules`, `src`, `release`, `package.json`, and build config files are also excluded.

When both local and remote contain Secure Git Sync plugin files, the plugin compares `version` and `releaseDate` in `manifest.json` and only lets the newer plugin artifact overwrite an older one. This prevents an old device from downgrading a newer local plugin during sync.

Auto sync runs at the configured interval. Its unlock duration defaults to "same as panel duration". You can set an independent auto sync unlock duration; choosing any independent duration requires entering the administrator password again before the setting is saved. If the auto sync unlock session has expired, it raises an unlock prompt titled "Auto sync needs the administrator password to continue", then runs the deferred sync once you unlock successfully.

## Git Authentication Fallback

If a remote was added from a provider account and uses an HTTPS URL, Secure Git Sync can use the saved provider token as a temporary `GIT_ASKPASS` credential during push, pull, and encrypted transport operations. This helps when Git Credential Manager is expired or missing.

The token is not written into the remote URL or `.git/config`; it is passed through environment variables to a temporary askpass script and removed after the Git operation.

SSH remotes still require a working SSH key. To use token fallback, add the repository as an HTTPS remote from the provider browser or edit the remote URL manually.

Full OAuth browser flows are not bundled because they require provider-specific OAuth application client IDs. The current implementation uses personal access tokens created through each provider's web UI.

## Encryption Algorithm Notes

The implementation deliberately uses WebCrypto-native primitives:

- PBKDF2-SHA-256 for password wrapping key material.
- AES-256-GCM for authenticated encryption.
- SHA-256 for plaintext change detection.

This is simpler and more portable inside Obsidian/Electron than adding Argon2 and XChaCha20-Poly1305 libraries immediately. A stronger Notesnook-style profile can be added later with Argon2id plus XChaCha20-Poly1305, but that adds bundled crypto dependencies, parameter migration, and compatibility handling. The manifest already includes algorithm metadata so future migrations can be introduced without changing the remote layout.

## Development

```bash
npm install
npm run build
```

## Release

Build the local release package:

```bash
npm run release
```

This creates:

```text
release/secure-git-sync-0.1.0/
  manifest.json
  main.js
  styles.css
release/secure-git-sync-0.1.0.zip
release/secure-git-sync-0.1.0.sha256
```

The local release script lives at `release/build-release.mjs`. GitHub Actions release automation lives at `.github/workflows/release.yml`; it runs on `workflow_dispatch` or tags like `v0.1.0`.

For normal installation, copy only the built plugin files into:

```text
<vault>/.obsidian/plugins/secure-git-sync/
```

Required runtime files:

- `manifest.json`
- `main.js`
- `styles.css`

Do not copy `node_modules`, `src`, `package.json`, `package-lock.json`, `tsconfig.json`, or `esbuild.config.mjs` into the Obsidian plugin directory. They are only needed for development and rebuilding `main.js`.

Then enable the plugin in Obsidian.
