export interface RemoteConfig {
  id: string;
  name: string;
  url: string;
  branch: string;
  providerAccountId?: string;
  useLocalGitConfig?: boolean;
  urlCount?: number;
}

export type UiLanguage = "zh" | "en";

export type GitProviderId = "github" | "gitlab" | "gitee" | "atomgit";

export type ProxyMode = "off" | "system" | "custom";

export interface ProviderAccount {
  id: string;
  provider: GitProviderId;
  label: string;
  token: string;
  apiBaseUrl: string;
  defaultRemoteUrlType: "https" | "ssh";
}

export type KeyDerivationFunction = "PBKDF2-SHA-256" | "Argon2id";

export interface KdfParams {
  iterations: number;
  memoryKiB?: number;
  parallelism?: number;
  hashLength?: number;
}

export interface PasswordConfig {
  version?: number;
  username?: string;
  keyId?: string;
  salt: string;
  wrappedKeyIv?: string;
  wrappedKeyCiphertext?: string;
  verifierIv: string;
  verifierCiphertext: string;
  iterations: number;
  hint: string;
  kdf?: KeyDerivationFunction;
  kdfParams?: KdfParams;
  cipher?: "AES-256-GCM";
}

export interface SecureGitSettings {
  uiLanguage: UiLanguage | null;
  encryptionEnabled: boolean;
  activeRemoteId: string;
  remotes: RemoteConfig[];
  providerAccounts: ProviderAccount[];
  password: PasswordConfig | null;
  localKeyringPath: string;
  syncKeyringToRemote: boolean;
  commitMessageTemplate: string;
  deleteMissingFilesOnPull: boolean;
  confirmBeforeSyncDifferences: boolean;
  conflictRetentionDays: number;
  noteTrashRetentionDays: number;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  autoSyncUnlockDuration: string;
  proxyMode: ProxyMode;
  proxyUrl: string;
  proxyNoProxy: string;
  lastSyncAt: string;
  lastSyncSummary: string;
  noteBlockIndex: Record<string, NoteFileBlockIndex>;
  noteFileCache: Record<string, NoteFileCacheEntry>;
}

export const DEFAULT_SETTINGS: SecureGitSettings = {
  uiLanguage: null,
  encryptionEnabled: true,
  activeRemoteId: "",
  remotes: [],
  providerAccounts: [],
  password: null,
  localKeyringPath: "",
  syncKeyringToRemote: false,
  commitMessageTemplate: "Secure Git Sync: {{date}}",
  deleteMissingFilesOnPull: false,
  confirmBeforeSyncDifferences: false,
  conflictRetentionDays: 30,
  noteTrashRetentionDays: 30,
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 30,
  autoSyncUnlockDuration: "same-as-panel",
  proxyMode: "off",
  proxyUrl: "",
  proxyNoProxy: "",
  lastSyncAt: "",
  lastSyncSummary: "",
  noteBlockIndex: {},
  noteFileCache: {},
};

export interface NoteBlockRecord {
  id: string;
  hash: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface NoteFileBlockIndex {
  fileId?: string;
  blocks: NoteBlockRecord[];
  deletedBlocks?: NoteBlockRecord[];
  updatedAt: string;
}

export interface NoteFileCacheEntry extends NoteFileBlockIndex {
  hash: string;
  size: number;
  mtimeMs: number;
  objectPath: string;
  contentUpdatedAt?: string;
  pathUpdatedAt?: string;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
}

export type GitProgressKind = "start" | "end" | "info";

export interface GitProgressEvent {
  phase: "local" | "network" | "crypto" | "git";
  kind: GitProgressKind;
  message: string;
  elapsedMs?: number;
}

export type ConflictChoice = "merge" | "local" | "remote";

export interface SyncConflictResolution {
  notes: ConflictChoice;
  obsidian: ConflictChoice;
  plugins: ConflictChoice;
}

export interface DifferenceCounts {
  localOnly: number;
  remoteOnly: number;
  modified: number;
  samples: string[];
}

export interface SyncDifferenceSummary {
  notes: DifferenceCounts;
  obsidian: DifferenceCounts;
  plugins: DifferenceCounts;
  obsidianDecisions?: string[];
  pluginDecisions?: string[];
  hasDifferences: boolean;
  hasPluginFiles: boolean;
  requiresConfirmation: boolean;
}
