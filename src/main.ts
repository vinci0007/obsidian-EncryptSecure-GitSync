import {
  App,
  ButtonComponent,
  DropdownComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { promises as fs } from "fs";
import * as path from "path";
import { createPasswordConfig, isUsernameRequired, randomId, rewrapPasswordConfig, shouldUpgradePasswordConfig, verifyPassword } from "./crypto";
import { ConflictFileContent, ConflictFilePair, GitService, NoteConsistencyResult, PullResult, SyncCredential } from "./git";
import { GitProviderClient, getProviderDefinition, PROVIDERS, ProviderRepo } from "./providers";
import { DEFAULT_SETTINGS, DifferenceCounts, GitProgressEvent, GitProviderId, PasswordConfig, ProviderAccount, RemoteConfig, SecureGitSettings, SyncConflictResolution, SyncDifferenceSummary, UiLanguage } from "./types";

const TEXT = {
  en: {
    cmdPush: "Push",
    cmdPull: "Pull",
    cmdSync: "Pull then push",
    cmdStatus: "Show Git status",
    cmdChangePassword: "Change administrator password",
    workingTreeClean: "Working tree is clean.",
    settingsTitle: "Secure Git Sync",
    language: "Language",
    languageDesc: "Choose the plugin UI language.",
    activeChinese: "Chinese active",
    switchChinese: "中文",
    activeEnglish: "English active",
    switchEnglish: "English",
    encryption: "Encryption",
    encryptionDesc: "Encrypt note files in Git snapshots. The live vault files stay readable locally.",
    passwordHint: "Password hint",
    noPasswordYet: "No administrator password has been created yet.",
    localKeyring: "Local keyring import/export",
    localKeyringDesc: "Use a local keyring as the fallback import source. Export writes the current keyring to the same path.",
    localKeyringPath: "Current local keyring path",
    localKeyringPathDesc: "Import source and export target. If empty, Secure Git Sync uses keyring.json in the plugin folder.",
    selectLocalKeyring: "Select keyring",
    exportLocalKeyring: "Export keyring",
    keyringExported: "Local keyring exported.",
    syncKeyringToRemote: "Sync keyring to remote",
    syncKeyringToRemoteDesc: "Off by default. When enabled, encrypted push stores a password-wrapped keyring at .secure-git-sync/keyring.json in the remote repository.",
    clear: "Clear",
    changeAdminPassword: "Change administrator password",
    change: "Change",
    commitMessage: "Commit message",
    commitMessageDesc: "Use {{date}} to insert the current ISO timestamp.",
    deleteMissing: "Delete missing note files on encrypted pull",
    deleteMissingDesc: "When enabled, local note files absent from the remote encrypted snapshot are removed.",
    noteTrashRetentionDays: "Note trash retention",
    noteTrashRetentionDaysDesc: "Days to keep notes moved to the Secure Git Sync trash. Use 0 to keep them forever.",
    confirmBeforeSyncDifferences: "Confirm differences before sync",
    confirmBeforeSyncDifferencesDesc: "When disabled, sync auto-merges notes, Obsidian settings, and plugins first. Conflicts are reported after sync.",
    conflictRetentionDays: "Conflict copy retention",
    conflictRetentionDaysDesc: "Days to keep conflict copies. Use 0 to keep them forever.",
    remotes: "Remotes",
    active: "Active",
    use: "Use",
    edit: "Edit",
    remove: "Remove",
    addRemote: "Add remote",
    addRemoteDesc: "All remotes share the current vault's single local .git repository.",
    add: "Add",
    providerAccounts: "Provider accounts",
    browse: "Browse",
    authorize: "Authorize",
    authorizeDesc: "Add a personal access token, then browse or create repositories.",
    createAdminPassword: "Create administrator password",
    passwordRequired: "Secure Git Sync cannot run until this password is created.",
    username: "Username",
    password: "Password",
    confirmPassword: "Confirm password",
    create: "Create",
    usernameRequired: "Username is required.",
    passwordTooShort: "Use at least 8 characters.",
    passwordsDoNotMatch: "Passwords do not match.",
    credentialIncorrect: "Username or password is incorrect.",
    confirmAdminPassword: "Confirm administrator password",
    hint: "Hint",
    continue: "Continue",
    currentUsername: "Current username",
    currentPassword: "Current password",
    newUsername: "New username",
    newPassword: "New password",
    confirmNewPassword: "Confirm new password",
    gitRemote: "Git remote",
    remoteName: "Remote name",
    remoteUrl: "Remote URL",
    branch: "Branch",
    save: "Save",
    remoteFieldsRequired: "Remote name, URL, and branch are required.",
    label: "Label",
    apiBaseUrl: "API base URL",
    token: "Token",
    remoteUrlType: "Remote URL type",
    tokenHelpPrefix: "Create a token, then paste it here:",
    accountFieldsRequired: "Label, API base URL, and token are required.",
    repositories: "Repositories",
    loadingRepos: "Loading repositories...",
    repoBrowserDesc: "Select an existing repository or create a new one. The remote is added to the current vault's single .git config.",
    existingRepo: "Existing repository",
    private: "private",
    addSelected: "Add selected",
    selectRepoFirst: "Select a repository first.",
    createRepo: "Create repository",
    repoName: "Repository name",
    privateRepo: "Private repository",
    createAndAdd: "Create and add",
    repoNameRequired: "Repository name is required.",
    addedRemote: "Added remote",
    passwordCreated: "Administrator password created.",
    passwordChanged: "Administrator password changed.",
    createPasswordFirst: "Create the administrator password before using Secure Git Sync.",
    addRemoteFirst: "Add a Git remote in Secure Git Sync settings first.",
    chooseLanguageTitle: "Choose UI language",
    chooseLanguageDesc: "Select the language used by Secure Git Sync.",
    operationPanel: "Secure Git Sync actions",
    operations: "Operations",
    manualSync: "Manual sync",
    pull: "Pull",
    push: "Push",
    sync: "Sync",
    status: "Status",
    autoSync: "Auto sync",
    autoSyncDesc: "When enabled, Secure Git Sync runs at the configured interval while the panel unlock session is valid.",
    autoSyncInterval: "Auto sync interval",
    autoSyncIntervalDesc: "Interval in minutes. Minimum is 1 minute.",
    autoSyncUnlockDuration: "Auto sync unlock duration",
    autoSyncUnlockDurationDesc: "Defaults to the panel unlock duration. Choosing an independent duration requires the administrator password.",
    proxy: "Proxy",
    proxyDesc: "Configure Git network proxy. Supports http, https, socks4, and socks5 URLs supported by Git.",
    proxyMode: "Proxy mode",
    proxyOff: "Off",
    proxySystem: "System environment",
    proxyCustom: "Custom proxy URL",
    proxyUrl: "Proxy URL",
    proxyUrlDesc: "Examples: http://127.0.0.1:7890, socks5://127.0.0.1:1080",
    proxyNoProxy: "No proxy",
    proxyNoProxyDesc: "Comma-separated hosts that bypass the proxy.",
    autoSyncNeedsUnlock: "Auto sync needs the administrator password to continue.",
    operationNeedsUnlock: "Enter the administrator password to continue.",
    sameAsPanelDuration: "Same as panel duration",
    confirmAutoSyncDuration: "Confirm auto sync unlock duration",
    openAuthPage: "Open authorization page",
    unlockPanel: "Unlock Secure Git Sync",
    sessionDuration: "Unlock duration",
    oneTime: "Only this panel",
    fiveMinutes: "5 minutes",
    thirtyMinutes: "30 minutes",
    oneHour: "1 hour",
    fiveHours: "5 hours",
    twelveHours: "12 hours",
    twentyFourHours: "24 hours",
    sevenDays: "7 days",
    thirtyDays: "30 days",
    forever: "Forever",
    unlockedUntil: "Unlocked until",
    unlockedThisPanel: "Unlocked for this panel",
    unlockedForever: "Unlocked permanently",
    locked: "Locked",
    currentStatus: "Current status",
    lastSync: "Last sync",
    neverSynced: "Never synced",
    idle: "Ready",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    operationStarted: "Started",
    operationBusy: "Another operation is already running.",
    statusLoaded: "Git status loaded.",
    syncCompleted: "Sync completed",
    pullCompleted: "Pull completed",
    pushCompleted: "Push completed",
    elapsed: "Elapsed",
    localPhase: "Local",
    networkPhase: "Network",
    cryptoPhase: "Crypto",
    gitPhase: "Git",
    panelLockedDesc: "Enter the administrator password once to use this panel without confirming every operation.",
    syncDifferencesTitle: "Sync differences",
    syncDifferencesDesc: "Remote and local content differ. Merge keeps both sides and creates conflict copies when automatic merge is not safe.",
    notesCategory: "Notes",
    obsidianCategory: "Obsidian configuration",
    pluginsCategory: "Obsidian plugins",
    localOnly: "local only",
    remoteOnly: "remote only",
    modified: "modified",
    keepLocal: "Keep local",
    useRemote: "Use remote",
    mergeBoth: "Merge and keep both",
    continueSync: "Continue sync",
    cancel: "Cancel",
    syncCancelled: "Sync cancelled.",
    pluginSyncWarning: "Plugin code can change Obsidian behavior. Only use remote plugins from a repository you trust.",
    autoDecisionDetails: "Automatic decisions to apply after confirmation",
    noNoteConflictsInScope: "No note conflicts found. Switch to all files to review configuration or plugin conflicts.",
    conflicts: "Conflicts",
    conflictCopies: "Conflict copies",
    conflictResultsTitle: "Sync conflicts",
    conflictResultsDesc: "Automatic merge created conflict copies. Review these files before continuing to edit or sync.",
    openConflictFolder: "Open conflict folder",
    resolveConflicts: "Resolve conflicts",
    conflictResolverTitle: "Resolve conflict",
    conflictFile: "Conflict file",
    noResolvableConflicts: "No text conflict files found.",
    chooseLocal: "Local",
    chooseRemote: "Remote",
    chooseBoth: "Both",
    chooseAllLocal: "Use all local",
    chooseAllRemote: "Use all remote",
    chooseAllBoth: "Keep all both",
    resultColumn: "Result",
    saveResolved: "Save resolved file",
    resolvedSaved: "Resolved file saved.",
    binaryConflictUnsupported: "This conflict is not a text file. Open the conflict folder to resolve it manually.",
    preview: "Preview",
    conflictScope: "Conflict scope",
    noteConflictsOnly: "Notes only",
    allConflicts: "All files",
    finalContent: "Final content to save",
    finalContentDesc: "This editor is the exact content that will be written back to the original note. You can edit it directly before saving.",
    noteConsistencyOk: "Notes verified: local and remote match.",
    noteConsistencyFailed: "Notes verification found differences.",
    saveAndSync: "Save and sync",
    resultUpdated: "Selection applied to final content.",
    noConflictCopies: "No conflict copies.",
  },
  zh: {
    cmdPush: "输入密码确认后推送",
    cmdPull: "输入密码确认后拉取",
    cmdSync: "输入密码确认后先拉取再推送",
    cmdStatus: "显示 Git 状态",
    cmdChangePassword: "修改主管理员密码",
    workingTreeClean: "工作区是干净的。",
    settingsTitle: "安全 Git 同步",
    language: "界面语言",
    languageDesc: "选择插件界面使用的语言。",
    activeChinese: "中文已启用",
    switchChinese: "中文",
    activeEnglish: "英文已启用",
    switchEnglish: "English",
    encryption: "加密",
    encryptionDesc: "远端同步时加密笔记文件，本地仓库和本地笔记保持明文可读。",
    passwordHint: "密码提示",
    noPasswordYet: "尚未创建主管理员密码。",
    localKeyring: "本地 keyring 导入/导出",
    localKeyringDesc: "本地 keyring 用作备用导入来源；导出会写入同一个路径。",
    localKeyringPath: "当前本地 keyring 路径",
    localKeyringPathDesc: "作为导入来源和导出目标。留空时使用插件目录中的 keyring.json。",
    selectLocalKeyring: "选择 keyring",
    exportLocalKeyring: "导出 keyring",
    keyringExported: "本地 keyring 已导出。",
    syncKeyringToRemote: "同步 keyring 到远端",
    syncKeyringToRemoteDesc: "默认关闭。开启后，加密推送会把经密码包裹的 keyring 写入远端仓库的 .secure-git-sync/keyring.json。",
    clear: "清除",
    changeAdminPassword: "修改主管理员密码",
    change: "修改",
    commitMessage: "提交信息",
    commitMessageDesc: "使用 {{date}} 插入当前 ISO 时间戳。",
    deleteMissing: "加密拉取时删除远端不存在的本地笔记",
    deleteMissingDesc: "开启后，本地存在但远端加密快照中不存在的笔记会被删除。",
    noteTrashRetentionDays: "笔记垃圾箱保留时间",
    noteTrashRetentionDaysDesc: "Secure Git Sync 垃圾箱中的笔记保留天数。填 0 表示永久保留。",
    confirmBeforeSyncDifferences: "同步前确认差异",
    confirmBeforeSyncDifferencesDesc: "关闭时会先自动合并笔记、Obsidian 配置与插件；如有冲突，同步后在面板中显示。",
    conflictRetentionDays: "冲突副本保留时间",
    conflictRetentionDaysDesc: "冲突副本保留天数。填 0 表示永久保留。",
    remotes: "远程仓库",
    active: "当前",
    use: "使用",
    edit: "编辑",
    remove: "移除",
    addRemote: "添加远程仓库",
    addRemoteDesc: "所有远程仓库都写入当前 vault 的同一个本地 .git 仓库。",
    add: "添加",
    providerAccounts: "平台账号",
    browse: "浏览",
    authorize: "授权",
    authorizeDesc: "添加个人访问令牌后，可以浏览或创建远端仓库。",
    createAdminPassword: "创建主管理员密码",
    passwordRequired: "必须先创建此密码，Secure Git Sync 才能使用。",
    username: "用户名",
    password: "密码",
    confirmPassword: "确认密码",
    create: "创建",
    usernameRequired: "用户名不能为空。",
    passwordTooShort: "请至少使用 8 个字符。",
    passwordsDoNotMatch: "两次输入的密码不一致。",
    credentialIncorrect: "用户名或密码错误。",
    confirmAdminPassword: "确认主管理员密码",
    hint: "提示",
    continue: "继续",
    currentUsername: "当前用户名",
    currentPassword: "当前密码",
    newUsername: "新用户名",
    newPassword: "新密码",
    confirmNewPassword: "确认新密码",
    gitRemote: "Git 远程仓库",
    remoteName: "远程仓库名称",
    remoteUrl: "远程仓库 URL",
    branch: "分支",
    save: "保存",
    remoteFieldsRequired: "远程仓库名称、URL 和分支都不能为空。",
    label: "标签",
    apiBaseUrl: "API 基础 URL",
    token: "令牌",
    remoteUrlType: "远程 URL 类型",
    tokenHelpPrefix: "请先创建令牌，然后粘贴到这里：",
    accountFieldsRequired: "标签、API 基础 URL 和令牌都不能为空。",
    repositories: "仓库",
    loadingRepos: "正在加载仓库...",
    repoBrowserDesc: "选择已有仓库或创建新仓库。远程配置会添加到当前 vault 的同一个 .git 配置中。",
    existingRepo: "已有仓库",
    private: "私有",
    addSelected: "添加所选仓库",
    selectRepoFirst: "请先选择一个仓库。",
    createRepo: "创建仓库",
    repoName: "仓库名称",
    privateRepo: "私有仓库",
    createAndAdd: "创建并添加",
    repoNameRequired: "仓库名称不能为空。",
    addedRemote: "已添加远程仓库",
    passwordCreated: "主管理员密码已创建。",
    passwordChanged: "主管理员密码已修改。",
    createPasswordFirst: "请先创建主管理员密码再使用 Secure Git Sync。",
    addRemoteFirst: "请先在 Secure Git Sync 设置中添加 Git 远程仓库。",
    chooseLanguageTitle: "选择界面语言",
    chooseLanguageDesc: "请选择 Secure Git Sync 使用的界面语言。",
    operationPanel: "安全 Git 同步操作",
    operations: "操作",
    manualSync: "手动同步",
    pull: "拉取",
    push: "推送",
    sync: "同步",
    status: "状态",
    autoSync: "自动同步",
    autoSyncDesc: "开启后，Secure Git Sync 会按设定间隔弹出主管理员密码确认，再执行同步。",
    autoSyncInterval: "自动同步间隔",
    autoSyncIntervalDesc: "单位为分钟，最小 1 分钟。",
    autoSyncUnlockDuration: "自动同步解锁有效期",
    autoSyncUnlockDurationDesc: "默认与面板解锁有效期一致。选择独立有效期时，需要再次输入主管理员密码确认。",
    proxy: "代理",
    proxyDesc: "配置 Git 网络代理。支持 Git 可识别的 http、https、socks4、socks5 URL。",
    proxyMode: "代理模式",
    proxyOff: "关闭",
    proxySystem: "系统环境",
    proxyCustom: "自定义代理 URL",
    proxyUrl: "代理 URL",
    proxyUrlDesc: "例如：http://127.0.0.1:7890，socks5://127.0.0.1:1080",
    proxyNoProxy: "不走代理",
    proxyNoProxyDesc: "多个主机用英文逗号分隔。",
    autoSyncNeedsUnlock: "自动同步需要主管理员密码才能继续。",
    operationNeedsUnlock: "请输入主管理员密码后继续。",
    sameAsPanelDuration: "与面板有效期一致",
    confirmAutoSyncDuration: "确认自动同步解锁有效期",
    openAuthPage: "打开授权页面",
    unlockPanel: "解锁 Secure Git Sync",
    sessionDuration: "解锁有效期",
    oneTime: "仅本次面板",
    fiveMinutes: "5 分钟",
    thirtyMinutes: "30 分钟",
    oneHour: "1 小时",
    fiveHours: "5 小时",
    twelveHours: "12 小时",
    twentyFourHours: "24 小时",
    sevenDays: "7 天",
    thirtyDays: "30 天",
    forever: "永久有效",
    unlockedUntil: "已解锁至",
    unlockedThisPanel: "仅当前面板已解锁",
    unlockedForever: "已永久解锁",
    locked: "未解锁",
    currentStatus: "当前状态",
    lastSync: "上次同步",
    neverSynced: "尚未同步",
    idle: "就绪",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    operationStarted: "已开始",
    operationBusy: "已有操作正在执行。",
    statusLoaded: "Git 状态已加载。",
    syncCompleted: "同步完成",
    pullCompleted: "拉取完成",
    pushCompleted: "推送完成",
    elapsed: "耗时",
    localPhase: "本地",
    networkPhase: "网络",
    cryptoPhase: "加密",
    gitPhase: "Git",
    panelLockedDesc: "输入一次主管理员密码，即可在有效期内使用面板操作，无需每次确认。",
    syncDifferencesTitle: "同步差异",
    syncDifferencesDesc: "远端与本地内容不一致。合并会保留两边，无法安全自动合并时会生成冲突副本。",
    notesCategory: "笔记",
    obsidianCategory: "Obsidian 配置",
    pluginsCategory: "Obsidian 插件",
    localOnly: "仅本地",
    remoteOnly: "仅远端",
    modified: "已修改",
    keepLocal: "保留本地",
    useRemote: "使用远端",
    mergeBoth: "合并并保留两边",
    continueSync: "继续同步",
    cancel: "取消",
    syncCancelled: "已取消同步。",
    pluginSyncWarning: "插件代码会改变 Obsidian 行为。只有在信任该仓库时才使用远端插件。",
    autoDecisionDetails: "确认后将自动执行的处理明细",
    noNoteConflictsInScope: "没有找到笔记冲突。切换到全部文件可以查看配置或插件冲突。",
    conflicts: "冲突",
    conflictCopies: "冲突副本",
    conflictResultsTitle: "同步冲突",
    conflictResultsDesc: "自动合并已生成冲突副本。继续编辑或同步前，请先查看这些文件。",
    openConflictFolder: "打开冲突目录",
    resolveConflicts: "手动解决冲突",
    conflictResolverTitle: "解决冲突",
    conflictFile: "冲突文件",
    noResolvableConflicts: "没有找到可处理的文本冲突文件。",
    chooseLocal: "本地",
    chooseRemote: "远端",
    chooseBoth: "两边都保留",
    chooseAllLocal: "全部用本地",
    chooseAllRemote: "全部用远端",
    chooseAllBoth: "全部两边保留",
    resultColumn: "结果",
    saveResolved: "保存解决结果",
    resolvedSaved: "已保存解决后的文件。",
    binaryConflictUnsupported: "这个冲突不是文本文件，请打开冲突目录手动处理。",
    preview: "预览",
    conflictScope: "冲突范围",
    noteConflictsOnly: "只看笔记",
    allConflicts: "全部文件",
    finalContent: "最终保存内容",
    finalContentDesc: "这里就是会写回原笔记的内容，可以在保存前直接编辑。",
    noteConsistencyOk: "笔记校验通过：本地与远端一致。",
    noteConsistencyFailed: "笔记校验发现本地与远端不一致。",
    saveAndSync: "保存并同步",
    resultUpdated: "已应用到最终保存内容。",
    noConflictCopies: "没有冲突副本。",
  },
} as const;

type TextKey = keyof typeof TEXT.en;

function t(language: UiLanguage, key: TextKey): string {
  return TEXT[language][key] ?? TEXT.en[key];
}

function addAutoSyncDurationOptions(dropdown: DropdownComponent, language: UiLanguage): void {
  dropdown.addOption("same-as-panel", t(language, "sameAsPanelDuration"));
  for (const item of UNLOCK_DURATIONS) {
    dropdown.addOption(item.value, t(language, item.key as TextKey));
  }
}

type OperationMode = "push" | "pull" | "sync";
type OperationStateKind = "idle" | "running" | "completed" | "failed";

interface UnlockSession {
  key: CryptoKey;
  credential: SyncCredential;
  expiresAt: number | null;
  oneTime: boolean;
  durationValue: string;
}

interface OperationState {
  kind: OperationStateKind;
  message: string;
  startedAt?: number;
  finishedAt?: number;
  details: string[];
  conflictCopies?: number;
  conflictDirs?: string[];
}

const UNLOCK_DURATIONS = [
  { key: "oneTime", value: "one-time", minutes: 0 },
  { key: "fiveMinutes", value: "5", minutes: 5 },
  { key: "thirtyMinutes", value: "30", minutes: 30 },
  { key: "oneHour", value: "60", minutes: 60 },
  { key: "fiveHours", value: "300", minutes: 300 },
  { key: "twelveHours", value: "720", minutes: 720 },
  { key: "twentyFourHours", value: "1440", minutes: 1440 },
  { key: "sevenDays", value: "10080", minutes: 10080 },
  { key: "thirtyDays", value: "43200", minutes: 43200 },
  { key: "forever", value: "forever", minutes: null },
] as const;

export default class SecureGitSyncPlugin extends Plugin {
  settings: SecureGitSettings = DEFAULT_SETTINGS;
  private git!: GitService;
  private autoSyncIntervalId: number | null = null;
  private autoSyncRunning = false;
  private unlockSession: UnlockSession | null = null;
  private operationState: OperationState = { kind: "idle", message: "", details: [] };
  private operationListeners = new Set<() => void>();
  private operationRunning = false;
  private lastConflictCopies = 0;
  private lastConflictDirs: string[] = [];

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.git = new GitService(this.getVaultPath());
    await applyElectronProxy(this.settings);

    this.addCommand({
      id: "secure-git-sync-push",
      name: this.text("cmdPush"),
      callback: () => this.runPasswordProtected("push"),
    });

    this.addCommand({
      id: "secure-git-sync-pull",
      name: this.text("cmdPull"),
      callback: () => this.runPasswordProtected("pull"),
    });

    this.addCommand({
      id: "secure-git-sync-sync",
      name: this.text("cmdSync"),
      callback: () => this.runPasswordProtected("sync"),
    });

    this.addCommand({
      id: "secure-git-sync-status",
      name: this.text("cmdStatus"),
      callback: async () => {
        try {
          new Notice((await this.git.status()).trim() || this.text("workingTreeClean"));
        } catch (error) {
          new Notice(formatError(error));
        }
      },
    });

    this.addCommand({
      id: "secure-git-sync-open-actions",
      name: this.text("operationPanel"),
      callback: () => this.openOperationPanel(),
    });

    this.addCommand({
      id: "secure-git-sync-change-password",
      name: this.text("cmdChangePassword"),
      callback: () => this.changePassword(),
    });

    this.addRibbonIcon("git-branch", this.text("operationPanel"), () => {
      this.openOperationPanel();
    });

    this.addSettingTab(new SecureGitSyncSettingTab(this.app, this));
    this.setupAutoSync();

    if (!this.settings.uiLanguage) {
      window.setTimeout(() => {
        new LanguageSelectModal(this.app, async (language) => {
          await this.setLanguage(language);
          if (!this.settings.password) {
            this.openPasswordSetup();
          }
        }).open();
      }, 500);
    } else if (!this.settings.password) {
      window.setTimeout(() => {
        this.openPasswordSetup();
      }, 800);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await applyElectronProxy(this.settings);
  }

  language(): UiLanguage {
    return this.settings.uiLanguage ?? "en";
  }

  text(key: TextKey): string {
    return t(this.language(), key);
  }

  async setLanguage(language: UiLanguage): Promise<void> {
    this.settings.uiLanguage = language;
    await this.saveSettings();
  }

  openOperationPanel(): void {
    if (!this.settings.password) {
      new Notice(this.text("createPasswordFirst"));
      this.openPasswordSetup();
      return;
    }

    if (this.hasValidUnlockSession()) {
      new OperationPanelModal(this.app, this, this.language()).open();
      return;
    }

    new UnlockSessionModal(this.app, this.language(), this.settings.password.username ?? "", this.settings.password.hint, async (username, password, duration) => {
      await this.unlockWithPassword(username, password, duration);
      new OperationPanelModal(this.app, this, this.language()).open();
    }).open();
  }

  openPasswordSetup(): void {
    new PasswordSetupModal(this.app, this.language(), async (username, password, hint) => {
      await this.setInitialPassword(username, password, hint);
    }).open();
  }

  async setInitialPassword(username: string, password: string, hint: string): Promise<void> {
    this.settings.password = await createPasswordConfig(username, password, hint);
    await this.saveSettings();
    new Notice(this.text("passwordCreated"));
  }

  async addRemote(remote: RemoteConfig): Promise<void> {
    const existing = this.settings.remotes.find((item) => item.id === remote.id);
    if (existing) {
      Object.assign(existing, remote);
    } else {
      this.settings.remotes.push(remote);
    }
    this.settings.activeRemoteId ||= remote.id;
    await this.saveSettings();
    await this.git.ensureRemote(remote);
  }

  getActiveRemote(): RemoteConfig | null {
    return this.settings.remotes.find((remote) => remote.id === this.settings.activeRemoteId) ?? this.settings.remotes[0] ?? null;
  }

  async gitStatus(): Promise<string> {
    return this.git.status();
  }

  async runStatusOperation(): Promise<void> {
    if (this.operationRunning) {
      new Notice(this.text("operationBusy"));
      return;
    }

    this.operationRunning = true;
    const startedAt = Date.now();
    this.setOperationState({
      kind: "running",
      message: `${this.text("operationStarted")}: ${this.text("status")}`,
      startedAt,
      details: [],
    });

    try {
      const status = (await this.gitStatus()).trim() || this.text("workingTreeClean");
      const summary = `${this.text("statusLoaded")} ${this.text("elapsed")}: ${formatDuration(Date.now() - startedAt)}. ${status}`;
      this.setOperationState({
        kind: "completed",
        message: summary,
        startedAt,
        finishedAt: Date.now(),
        details: [status],
      });
      new Notice(summary);
    } catch (error) {
      const message = formatError(error);
      this.setOperationState({
        kind: "failed",
        message,
        startedAt,
        finishedAt: Date.now(),
        details: [],
      });
      new Notice(message);
    } finally {
      this.operationRunning = false;
    }
  }

  getOperationState(): OperationState {
    return {
      ...this.operationState,
      details: [...this.operationState.details],
      conflictDirs: [...(this.operationState.conflictDirs ?? [])],
    };
  }

  subscribeOperationState(listener: () => void): () => void {
    this.operationListeners.add(listener);
    return () => {
      this.operationListeners.delete(listener);
    };
  }

  getUnlockLabel(language: UiLanguage): string {
    if (!this.unlockSession || !this.hasValidUnlockSession()) {
      return t(language, "locked");
    }
    if (this.unlockSession.oneTime) {
      return t(language, "unlockedThisPanel");
    }
    if (this.unlockSession.expiresAt === null) {
      return t(language, "unlockedForever");
    }
    return `${t(language, "unlockedUntil")} ${new Date(this.unlockSession.expiresAt).toLocaleString()}`;
  }

  clearOneTimeUnlock(): void {
    if (this.unlockSession?.oneTime) {
      this.unlockSession = null;
    }
  }

  async unlockWithPassword(username: string, password: string, durationValue: string): Promise<void> {
    if (!this.settings.password) {
      throw new Error(this.text("createPasswordFirst"));
    }

    const currentConfig = this.settings.password;
    const key = await verifyPassword(username, password, currentConfig);
    if (shouldUpgradePasswordConfig(currentConfig)) {
      this.settings.password = await rewrapPasswordConfig(username, password, username, password, currentConfig.hint, currentConfig);
      await this.saveSettings();
    }
    this.unlockSession = this.buildSession(key, { username, password }, durationValue);
  }

  changeUnlockDuration(durationValue: string): void {
    if (!this.unlockSession || !this.hasValidUnlockSession()) {
      return;
    }
    this.unlockSession = this.buildSession(this.unlockSession.key, this.unlockSession.credential, durationValue);
  }

  getCurrentUnlockDuration(): string {
    return this.unlockSession?.durationValue ?? "1440";
  }

  getConflictRootPath(): string {
    return this.git.getConflictRootPath();
  }

  async getConflictDirs(): Promise<string[]> {
    return this.git.listConflictDirs();
  }

  async getConflictFilePairs(): Promise<ConflictFilePair[]> {
    return this.git.listConflictFilePairs();
  }

  async readConflictFile(pair: ConflictFilePair): Promise<ConflictFileContent> {
    return this.git.readConflictFile(pair);
  }

  async saveResolvedConflict(pair: ConflictFilePair, contents: string): Promise<void> {
    await this.git.saveResolvedConflict(pair, contents);
    await this.refreshConflictState();
  }

  async verifyRemoteNoteConsistency(remote: RemoteConfig, key: CryptoKey | null, progress: (event: GitProgressEvent) => void): Promise<NoteConsistencyResult> {
    return this.git.verifyRemoteNoteConsistency(remote, this.settings, key, progress);
  }

  private async buildOperationCredential(): Promise<SyncCredential | undefined> {
    if (!this.unlockSession?.credential) {
      return undefined;
    }
    return {
      ...this.unlockSession.credential,
      localKeyring: await this.loadLocalKeyringFallback(),
    };
  }

  private async loadLocalKeyringFallback(): Promise<PasswordConfig | null> {
    const explicitPath = this.settings.localKeyringPath.trim();
    const keyringPath = explicitPath || this.defaultLocalKeyringPath();
    if (!explicitPath && !(await fileExists(keyringPath))) {
      return null;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(keyringPath, "utf8")) as unknown;
      if (!isPasswordConfig(parsed)) {
        throw new Error("Invalid keyring file.");
      }
      return parsed;
    } catch (error) {
      throw new Error(`Local keyring could not be loaded: ${formatError(error)}`);
    }
  }

  async chooseLocalKeyringFile(): Promise<void> {
    const selected = await pickLocalKeyringFile(this.settings.localKeyringPath.trim() || this.defaultLocalKeyringPath());
    if (!selected) {
      return;
    }
    this.settings.localKeyringPath = selected;
    await this.saveSettings();
  }

  async exportLocalKeyring(): Promise<void> {
    if (!this.settings.password) {
      new Notice(this.text("createPasswordFirst"));
      this.openPasswordSetup();
      return;
    }
    const target = this.settings.localKeyringPath.trim() || this.defaultLocalKeyringPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(this.settings.password, null, 2)}\n`, "utf8");
    this.settings.localKeyringPath = target;
    await this.saveSettings();
    new Notice(this.text("keyringExported"));
  }

  private defaultLocalKeyringPath(): string {
    return path.join(this.getVaultPath(), ".obsidian", "plugins", "obsidian-secure-git-sync", "keyring.json");
  }

  async refreshConflictState(): Promise<void> {
    const dirs = await this.getConflictDirs();
    const pairs = await this.getConflictFilePairs();
    this.lastConflictCopies = pairs.reduce((count, pair) => count + (pair.hasLocal ? 1 : 0) + (pair.hasRemote ? 1 : 0), 0);
    this.lastConflictDirs = dirs;
    this.setOperationState({
      ...this.operationState,
      conflictCopies: this.lastConflictCopies,
      conflictDirs: this.lastConflictDirs,
    });
  }

  getEffectiveAutoSyncUnlockDuration(): string {
    return this.settings.autoSyncUnlockDuration === "same-as-panel"
      ? this.getCurrentUnlockDuration()
      : this.settings.autoSyncUnlockDuration;
  }

  requestAutoSyncUnlockDurationChange(value: string, onChanged?: () => void): void {
    if (value === "same-as-panel") {
      this.settings.autoSyncUnlockDuration = value;
      void this.saveSettings().then(() => onChanged?.());
      return;
    }

    if (!this.settings.password) {
      new Notice(this.text("createPasswordFirst"));
      this.openPasswordSetup();
      onChanged?.();
      return;
    }

    new UnlockSessionModal(
      this.app,
      this.language(),
      this.settings.password.username ?? "",
      this.settings.password.hint,
      async (username, password) => {
        await verifyPassword(username, password, this.settings.password!);
        this.settings.autoSyncUnlockDuration = value;
        await this.saveSettings();
        onChanged?.();
      },
      this.text("confirmAutoSyncDuration"),
      { initialDuration: value, hideDurationSelect: true },
    ).open();
  }

  private buildSession(key: CryptoKey, credential: SyncCredential, durationValue: string): UnlockSession {
    const duration = UNLOCK_DURATIONS.find((item) => item.value === durationValue) ?? UNLOCK_DURATIONS[6];
    return {
      key,
      credential,
      durationValue: duration.value,
      oneTime: duration.value === "one-time",
      expiresAt: duration.minutes === null
        ? null
        : duration.minutes <= 0
          ? Date.now()
          : Date.now() + duration.minutes * 60 * 1000,
    };
  }

  setupAutoSync(): void {
    if (this.autoSyncIntervalId !== null) {
      window.clearInterval(this.autoSyncIntervalId);
      this.autoSyncIntervalId = null;
    }

    if (!this.settings.autoSyncEnabled) {
      return;
    }

    const minutes = Math.max(1, Number(this.settings.autoSyncIntervalMinutes) || 1);
    this.autoSyncIntervalId = window.setInterval(() => {
      if (this.autoSyncRunning) {
        return;
      }
      this.autoSyncRunning = true;
      void this.runAutoSync().finally(() => {
        this.autoSyncRunning = false;
      });
    }, minutes * 60 * 1000);

    this.registerInterval(this.autoSyncIntervalId);
  }

  private async runAutoSync(): Promise<void> {
    if (!this.settings.password) {
      return;
    }
    const remote = this.getActiveRemote();
    if (!remote) {
      return;
    }

    if (this.hasValidUnlockSession()) {
      await this.runUnlockedOperation("sync", remote);
      return;
    }

    new UnlockSessionModal(
      this.app,
      this.language(),
      this.settings.password.username ?? "",
      this.settings.password.hint,
      async (username, password, duration) => {
        await this.unlockWithPassword(username, password, duration);
        const activeRemote = this.getActiveRemote();
        if (activeRemote) {
          await this.runUnlockedOperation("sync", activeRemote);
        }
      },
      this.text("autoSyncNeedsUnlock"),
      { initialDuration: this.getEffectiveAutoSyncUnlockDuration(), hideDurationSelect: true },
    ).open();
  }

  async runPasswordProtected(mode: "push" | "pull" | "sync"): Promise<void> {
    if (!this.settings.password) {
      new Notice(this.text("createPasswordFirst"));
      this.openPasswordSetup();
      return;
    }

    const remote = this.getActiveRemote();
    if (!remote) {
      new Notice(this.text("addRemoteFirst"));
      return;
    }

    if (!this.hasValidUnlockSession()) {
      new UnlockSessionModal(
        this.app,
        this.language(),
        this.settings.password.username ?? "",
        this.settings.password.hint,
        async (username, password, duration) => {
          await this.unlockWithPassword(username, password, duration);
          await this.runPasswordProtected(mode);
        },
        this.text("operationNeedsUnlock"),
      ).open();
      return;
    }

    await this.runUnlockedOperation(mode, remote);
  }

  async changePassword(): Promise<void> {
    if (!this.settings.password) {
      this.openPasswordSetup();
      return;
    }

    new ChangePasswordModal(this.app, this.language(), this.settings.password.username ?? "", this.settings.password.hint, async (oldUsername, oldPassword, newUsername, newPassword, hint) => {
      this.settings.password = await rewrapPasswordConfig(oldUsername, oldPassword, newUsername, newPassword, hint, this.settings.password!);
      await this.saveSettings();
      new Notice(this.text("passwordChanged"));
    }).open();
  }

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    const maybeBasePath = (adapter as unknown as { basePath?: string }).basePath;
    if (!maybeBasePath) {
      throw new Error("Secure Git Sync requires the desktop file-system adapter.");
    }
    return maybeBasePath;
  }

  private hasValidUnlockSession(): boolean {
    if (!this.unlockSession) {
      return false;
    }
    if (this.unlockSession.oneTime) {
      return true;
    }
    if (this.unlockSession.expiresAt === null) {
      return true;
    }
    if (Date.now() <= this.unlockSession.expiresAt) {
      return true;
    }
    this.unlockSession = null;
    return false;
  }

  private async runUnlockedOperation(mode: OperationMode, remote: RemoteConfig): Promise<void> {
    if (this.operationRunning) {
      new Notice(this.text("operationBusy"));
      return;
    }

    this.operationRunning = true;
    const startedAt = Date.now();
    this.setOperationState({
      kind: "running",
      message: `${this.text("operationStarted")}: ${this.text(mode)}`,
      startedAt,
      details: [],
    });

    try {
      const key = this.unlockSession?.key ?? null;
      let cryptoKey = key;
      const credential = await this.buildOperationCredential();
      const progress = (event: GitProgressEvent) => this.handleGitProgress(event);
      let summary = "";
      let pullResult: PullResult | null = null;

      if (mode === "pull") {
        const pullPlan = await this.prepareSyncPlan(remote, cryptoKey, progress);
        if (!pullPlan) {
          this.setOperationState({
            ...this.operationState,
            kind: "completed",
            message: this.text("syncCancelled"),
            finishedAt: Date.now(),
          });
          return;
        }
        pullResult = await this.git.pull(remote, this.settings, cryptoKey, progress, pullPlan.resolution, credential);
        if (pullResult.remoteEncrypted && !this.settings.encryptionEnabled) {
          this.settings.encryptionEnabled = true;
        }
        if (pullResult.key && this.unlockSession) {
          cryptoKey = pullResult.key;
          this.unlockSession.key = pullResult.key;
        }
        summary = pullResult.summary;
      } else if (mode === "push") {
        summary = await this.git.push(remote, this.settings, cryptoKey, progress, { includePlugins: true, credential });
      } else {
        const syncPlan = await this.prepareSyncPlan(remote, cryptoKey, progress);
        if (!syncPlan) {
          this.setOperationState({
            ...this.operationState,
            kind: "completed",
            message: this.text("syncCancelled"),
            finishedAt: Date.now(),
          });
          return;
        }
        pullResult = await this.git.pull(remote, this.settings, cryptoKey, progress, syncPlan.resolution, credential);
        if (pullResult.remoteEncrypted && !this.settings.encryptionEnabled) {
          this.settings.encryptionEnabled = true;
        }
        if (pullResult.key && this.unlockSession) {
          cryptoKey = pullResult.key;
          this.unlockSession.key = pullResult.key;
        }
        if (pullResult.conflictCopies > 0 || pullResult.conflictDirs.length > 0) {
          progress({ phase: "local", kind: "info", message: "conflicts require manual resolution before push" });
          summary = `${pullResult.summary} Resolve conflicts before pushing.`;
        } else if (!pullResult.plaintextChanged && !(await this.git.hasLocalPlaintextChanges(syncPlan.includePlugins))) {
          progress({ phase: "local", kind: "info", message: "no local changes to push" });
          summary = `${pullResult.summary} No local changes to push.`;
        } else {
          const pushSummary = await this.git.push(remote, this.settings, cryptoKey, progress, { includePlugins: syncPlan.includePlugins || pullResult.remoteEncrypted, credential });
          summary = `${pullResult.summary} ${pushSummary}`;
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (pullResult) {
        this.lastConflictCopies = pullResult.conflictCopies;
        this.lastConflictDirs = pullResult.conflictDirs;
      }
      const conflictSummary = pullResult && pullResult.conflictCopies > 0
        ? ` ${this.text("conflictCopies")}: ${pullResult.conflictCopies}.`
        : "";
      let verificationSummary = "";
      if (pullResult && this.settings.encryptionEnabled) {
        const verification = await this.verifyRemoteNoteConsistency(remote, cryptoKey, progress);
        verificationSummary = verification.consistent
          ? ` ${this.text("noteConsistencyOk")}`
          : ` ${this.text("noteConsistencyFailed")} ${verification.localOnly} local only, ${verification.remoteOnly} remote only, ${verification.modified} modified.`;
      }
      const finalSummary = `${this.text(`${mode}Completed` as TextKey)}. ${this.text("elapsed")}: ${formatDuration(elapsedMs)}.${conflictSummary}${verificationSummary} ${summary}`;
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastSyncSummary = finalSummary;
      await this.saveSettings();
      this.setOperationState({
        ...this.operationState,
        kind: "completed",
        message: finalSummary,
        finishedAt: Date.now(),
        conflictCopies: pullResult?.conflictCopies ?? this.lastConflictCopies,
        conflictDirs: pullResult?.conflictDirs ?? this.lastConflictDirs,
      });
      new Notice(finalSummary);
      if (pullResult && (pullResult.conflictCopies > 0 || pullResult.conflictDirs.length > 0)) {
        new SyncConflictsModal(this.app, this, this.language(), pullResult.conflictCopies, pullResult.conflictDirs, this.git.getConflictRootPath()).open();
      }
    } catch (error) {
      const message = formatError(error);
      this.setOperationState({
        ...this.operationState,
        kind: "failed",
        message,
        finishedAt: Date.now(),
      });
      new Notice(message);
    } finally {
      this.operationRunning = false;
      if (this.unlockSession?.oneTime && !document.querySelector(".secure-git-sync-panel")) {
        this.unlockSession = null;
      }
    }
  }

  private handleGitProgress(event: GitProgressEvent): void {
    const language = this.language();
    const phaseKey = `${event.phase}Phase` as TextKey;
    const line = event.elapsedMs === undefined
      ? `${t(language, phaseKey)}: ${event.message}`
      : `${t(language, phaseKey)}: ${event.message} (${formatDuration(event.elapsedMs)})`;
    const details = [...this.operationState.details];
    if (event.kind === "end" || event.kind === "info") {
      details.push(line);
    }
    this.setOperationState({
      ...this.operationState,
      message: line,
      details: details.slice(-10),
    });
  }

  private async prepareSyncPlan(
    remote: RemoteConfig,
    cryptoKey: CryptoKey | null,
    progress: (event: GitProgressEvent) => void,
  ): Promise<{ resolution: SyncConflictResolution; includePlugins: boolean } | null> {
    if (!this.settings.encryptionEnabled) {
      return {
        resolution: { notes: "merge", obsidian: "merge", plugins: "merge" },
        includePlugins: false,
      };
    }

    const differences = await this.git.inspectEncryptedDifferences(remote, this.settings, cryptoKey, progress);
    if (!differences.hasDifferences) {
      return {
        resolution: { notes: "merge", obsidian: "merge", plugins: "merge" },
        includePlugins: true,
      };
    }
    const mustConfirmSystemFiles = hasCategoryDifferences(differences.obsidian) || hasCategoryDifferences(differences.plugins);
    if (!this.settings.confirmBeforeSyncDifferences && !mustConfirmSystemFiles) {
      return {
        resolution: { notes: "merge", obsidian: "merge", plugins: "merge" },
        includePlugins: true,
      };
    }

    return new Promise((resolve) => {
      new SyncDifferencesModal(this.app, this.language(), differences, (resolution) => {
        if (!resolution) {
          resolve(null);
          return;
        }
        resolve({
          resolution,
          includePlugins: resolution.plugins !== "local" || differences.hasPluginFiles || hasCategoryDifferences(differences.plugins),
        });
      }).open();
    });
  }

  private setOperationState(state: OperationState): void {
    this.operationState = state;
    for (const listener of this.operationListeners) {
      listener();
    }
  }
}

class SecureGitSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SecureGitSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const language = this.plugin.language();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t(language, "settingsTitle") });

    new Setting(containerEl)
      .setName(t(language, "language"))
      .setDesc(t(language, "languageDesc"))
      .addButton((button) => button
        .setButtonText(this.plugin.settings.uiLanguage === "zh" ? t(language, "activeChinese") : t(language, "switchChinese"))
        .setDisabled(this.plugin.settings.uiLanguage === "zh")
        .onClick(async () => {
          await this.plugin.setLanguage("zh");
          this.display();
        }))
      .addButton((button) => button
        .setButtonText(this.plugin.settings.uiLanguage === "en" ? t(language, "activeEnglish") : t(language, "switchEnglish"))
        .setDisabled(this.plugin.settings.uiLanguage === "en")
        .onClick(async () => {
          await this.plugin.setLanguage("en");
          this.display();
        }));

    new Setting(containerEl)
      .setName(t(language, "encryption"))
      .setDesc(t(language, "encryptionDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.encryptionEnabled)
        .onChange(async (value) => {
          this.plugin.settings.encryptionEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t(language, "passwordHint"))
      .setDesc(this.plugin.settings.password?.hint || t(language, "noPasswordYet"));

    new Setting(containerEl)
      .setName(t(language, "localKeyring"))
      .setDesc(t(language, "localKeyringDesc"));

    new Setting(containerEl)
      .setName(t(language, "localKeyringPath"))
      .setDesc(t(language, "localKeyringPathDesc"))
      .addText((text) => text
        .setPlaceholder("C:\\path\\to\\keyring.json")
        .setValue(this.plugin.settings.localKeyringPath)
        .onChange(async (value) => {
          this.plugin.settings.localKeyringPath = value.trim();
          await this.plugin.saveSettings();
        }))
      .addButton((button) => button
        .setButtonText(t(language, "selectLocalKeyring"))
        .onClick(async () => {
          await this.plugin.chooseLocalKeyringFile();
          this.display();
        }))
      .addButton((button) => button
        .setButtonText(t(language, "exportLocalKeyring"))
        .onClick(async () => {
          await this.plugin.exportLocalKeyring();
          this.display();
        }))
      .addButton((button) => button
        .setButtonText(t(language, "clear"))
        .onClick(async () => {
          this.plugin.settings.localKeyringPath = "";
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName(t(language, "syncKeyringToRemote"))
      .setDesc(t(language, "syncKeyringToRemoteDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncKeyringToRemote)
        .onChange(async (value) => {
          this.plugin.settings.syncKeyringToRemote = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: t(language, "manualSync") });

    new Setting(containerEl)
      .setName(t(language, "operations"))
      .addButton((button) => button
        .setButtonText(t(language, "sync"))
        .setCta()
        .onClick(() => {
          void this.plugin.runPasswordProtected("sync");
        }))
      .addButton((button) => button
        .setButtonText(t(language, "status"))
        .onClick(() => {
          void this.plugin.runStatusOperation();
        }))
      .addButton((button) => button
        .setButtonText(t(language, "pull"))
        .onClick(() => {
          void this.plugin.runPasswordProtected("pull");
        }))
      .addButton((button) => button
        .setButtonText(t(language, "push"))
        .onClick(() => {
          void this.plugin.runPasswordProtected("push");
        }));

    new Setting(containerEl)
      .setName(t(language, "autoSync"))
      .setDesc(t(language, "autoSyncDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSyncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSync();
        }));

    new Setting(containerEl)
      .setName(t(language, "autoSyncInterval"))
      .setDesc(t(language, "autoSyncIntervalDesc"))
      .addText((text) => text
        .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
        .onChange(async (value) => {
          const minutes = Math.max(1, Math.floor(Number(value) || 1));
          this.plugin.settings.autoSyncIntervalMinutes = minutes;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSync();
        }));

    new Setting(containerEl)
      .setName(t(language, "autoSyncUnlockDuration"))
      .setDesc(t(language, "autoSyncUnlockDurationDesc"))
      .addDropdown((dropdown) => {
        addAutoSyncDurationOptions(dropdown, language);
        dropdown.setValue(this.plugin.settings.autoSyncUnlockDuration);
        dropdown.onChange((value) => {
          this.plugin.requestAutoSyncUnlockDurationChange(value, () => this.display());
        });
      });

    new Setting(containerEl)
      .setName(t(language, "changeAdminPassword"))
      .addButton((button) => button
        .setButtonText(t(language, "change"))
        .onClick(() => {
          void this.plugin.changePassword();
        }));

    new Setting(containerEl)
      .setName(t(language, "commitMessage"))
      .setDesc(t(language, "commitMessageDesc"))
      .addText((text) => text
        .setValue(this.plugin.settings.commitMessageTemplate)
        .onChange(async (value) => {
          this.plugin.settings.commitMessageTemplate = value.trim() || DEFAULT_SETTINGS.commitMessageTemplate;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t(language, "deleteMissing"))
      .setDesc(t(language, "deleteMissingDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.deleteMissingFilesOnPull)
        .onChange(async (value) => {
          this.plugin.settings.deleteMissingFilesOnPull = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t(language, "noteTrashRetentionDays"))
      .setDesc(t(language, "noteTrashRetentionDaysDesc"))
      .addText((text) => text
        .setValue(String(this.plugin.settings.noteTrashRetentionDays))
        .onChange(async (value) => {
          this.plugin.settings.noteTrashRetentionDays = Math.max(0, Math.floor(Number(value) || 0));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t(language, "confirmBeforeSyncDifferences"))
      .setDesc(t(language, "confirmBeforeSyncDifferencesDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.confirmBeforeSyncDifferences)
        .onChange(async (value) => {
          this.plugin.settings.confirmBeforeSyncDifferences = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t(language, "conflictRetentionDays"))
      .setDesc(t(language, "conflictRetentionDaysDesc"))
      .addText((text) => text
        .setValue(String(this.plugin.settings.conflictRetentionDays))
        .onChange(async (value) => {
          this.plugin.settings.conflictRetentionDays = Math.max(0, Math.floor(Number(value) || 0));
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: t(language, "proxy") });

    new Setting(containerEl)
      .setName(t(language, "proxyMode"))
      .setDesc(t(language, "proxyDesc"))
      .addDropdown((dropdown) => dropdown
        .addOption("off", t(language, "proxyOff"))
        .addOption("system", t(language, "proxySystem"))
        .addOption("custom", t(language, "proxyCustom"))
        .setValue(this.plugin.settings.proxyMode)
        .onChange(async (value) => {
          this.plugin.settings.proxyMode = value === "system" || value === "custom" ? value : "off";
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.proxyMode === "custom") {
      new Setting(containerEl)
        .setName(t(language, "proxyUrl"))
        .setDesc(t(language, "proxyUrlDesc"))
        .addText((text) => text
          .setPlaceholder("socks5://127.0.0.1:1080")
          .setValue(this.plugin.settings.proxyUrl)
          .onChange(async (value) => {
            this.plugin.settings.proxyUrl = value.trim();
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName(t(language, "proxyNoProxy"))
        .setDesc(t(language, "proxyNoProxyDesc"))
        .addText((text) => text
          .setPlaceholder("localhost,127.0.0.1")
          .setValue(this.plugin.settings.proxyNoProxy)
          .onChange(async (value) => {
            this.plugin.settings.proxyNoProxy = value.trim();
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl("h3", { text: t(language, "remotes") });

    for (const remote of this.plugin.settings.remotes) {
      new Setting(containerEl)
        .setName(`${remote.name} -> ${remote.branch}`)
        .setDesc(remote.url)
        .addButton((button) => button
          .setButtonText(remote.id === this.plugin.settings.activeRemoteId ? t(language, "active") : t(language, "use"))
          .setDisabled(remote.id === this.plugin.settings.activeRemoteId)
          .onClick(async () => {
            this.plugin.settings.activeRemoteId = remote.id;
            await this.plugin.saveSettings();
            this.display();
          }))
        .addButton((button) => button
          .setButtonText(t(language, "edit"))
          .onClick(() => {
            new RemoteModal(this.app, language, remote, async (updated) => {
              await this.plugin.addRemote(updated);
              this.display();
            }).open();
          }))
        .addButton((button) => button
          .setButtonText(t(language, "remove"))
          .onClick(async () => {
            this.plugin.settings.remotes = this.plugin.settings.remotes.filter((item) => item.id !== remote.id);
            if (this.plugin.settings.activeRemoteId === remote.id) {
              this.plugin.settings.activeRemoteId = this.plugin.settings.remotes[0]?.id ?? "";
            }
            await this.plugin.saveSettings();
            this.display();
          }));
    }

    new Setting(containerEl)
      .setName(t(language, "addRemote"))
      .setDesc(t(language, "addRemoteDesc"))
      .addButton((button) => button
        .setButtonText(t(language, "add"))
        .setCta()
        .onClick(() => {
          new RemoteModal(this.app, language, null, async (remote) => {
            await this.plugin.addRemote(remote);
            this.display();
          }).open();
        }));

    containerEl.createEl("h3", { text: t(language, "providerAccounts") });

    for (const account of this.plugin.settings.providerAccounts) {
      new Setting(containerEl)
        .setName(`${getProviderDefinition(account.provider).name}: ${account.label}`)
        .setDesc(account.apiBaseUrl)
        .addButton((button) => button
          .setButtonText(t(language, "browse"))
          .onClick(() => {
            new RepositoryBrowserModal(this.app, language, account, async (remote) => {
              await this.plugin.addRemote(remote);
              this.display();
            }).open();
          }))
        .addButton((button) => button
          .setButtonText(t(language, "edit"))
          .onClick(() => {
            new ProviderAccountModal(this.app, language, account.provider, account, async (updated) => {
              Object.assign(account, updated);
              await this.plugin.saveSettings();
              this.display();
            }).open();
          }))
        .addButton((button) => button
          .setButtonText(t(language, "remove"))
          .onClick(async () => {
            this.plugin.settings.providerAccounts = this.plugin.settings.providerAccounts.filter((item) => item.id !== account.id);
            await this.plugin.saveSettings();
            this.display();
          }));
    }

    for (const provider of PROVIDERS) {
      new Setting(containerEl)
        .setName(`${t(language, "authorize")} ${provider.name}`)
        .setDesc(t(language, "authorizeDesc"))
        .addButton((button) => button
          .setButtonText(t(language, "authorize"))
          .onClick(() => {
            new ProviderAccountModal(this.app, language, provider.id, null, async (account) => {
              this.plugin.settings.providerAccounts.push(account);
              await this.plugin.saveSettings();
              this.display();
            }).open();
          }));
    }
  }
}

class OperationPanelModal extends Modal {
  private statusEl!: HTMLElement;
  private statusIconEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private detailsEl!: HTMLElement;
  private lastSyncEl!: HTMLElement;
  private conflictEl!: HTMLElement;
  private unlockEl!: HTMLElement;
  private durationDropdown!: DropdownComponent;
  private unsubscribe = (): void => {};
  private actionButtons: ButtonComponent[] = [];

  constructor(
    app: App,
    private readonly plugin: SecureGitSyncPlugin,
    private readonly language: UiLanguage,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("secure-git-sync-panel");
    this.titleEl.setText(t(this.language, "operationPanel"));

    const statusBox = this.contentEl.createDiv({ cls: "secure-git-sync-status" });
    this.statusIconEl = statusBox.createDiv({ cls: "secure-git-sync-status-icon" });
    this.statusTextEl = statusBox.createDiv({ cls: "secure-git-sync-status-text" });
    this.detailsEl = statusBox.createDiv({ cls: "secure-git-sync-status-details" });

    this.unlockEl = this.contentEl.createEl("p", { cls: "secure-git-sync-unlock" });
    this.lastSyncEl = this.contentEl.createEl("p", { cls: "secure-git-sync-last-sync" });
    this.conflictEl = this.contentEl.createDiv({ cls: "secure-git-sync-conflicts" });

    this.contentEl.createEl("h3", { text: t(this.language, "manualSync") });

    const ops = new Setting(this.contentEl).setName(t(this.language, "operations"));
    const buttons: Array<{ mode: OperationMode | "status"; cta?: boolean; key: TextKey }> = [
      { mode: "sync", cta: true, key: "sync" },
      { mode: "status", key: "status" },
      { mode: "pull", key: "pull" },
      { mode: "push", key: "push" },
    ];
    this.actionButtons = [];
    for (const item of buttons) {
      ops.addButton((button) => {
        button
          .setButtonText(t(this.language, item.key))
          .onClick(() => {
            if (item.mode === "status") {
              void this.plugin.runStatusOperation();
            } else {
              void this.plugin.runPasswordProtected(item.mode);
            }
          });
        if (item.cta) {
          button.setCta();
        }
        this.actionButtons.push(button);
      });
    }

    this.contentEl.createEl("h3", { text: t(this.language, "autoSync") });

    new Setting(this.contentEl)
      .setName(t(this.language, "autoSync"))
      .setDesc(t(this.language, "autoSyncDesc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSyncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSync();
        }));

    new Setting(this.contentEl)
      .setName(t(this.language, "autoSyncInterval"))
      .setDesc(t(this.language, "autoSyncIntervalDesc"))
      .addText((text) => text
        .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
        .onChange(async (value) => {
          const minutes = Math.max(1, Math.floor(Number(value) || 1));
          this.plugin.settings.autoSyncIntervalMinutes = minutes;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSync();
        }));

    new Setting(this.contentEl)
      .setName(t(this.language, "autoSyncUnlockDuration"))
      .setDesc(t(this.language, "autoSyncUnlockDurationDesc"))
      .addDropdown((dropdown) => {
        addAutoSyncDurationOptions(dropdown, this.language);
        dropdown.setValue(this.plugin.settings.autoSyncUnlockDuration);
        dropdown.onChange((value) => {
          this.plugin.requestAutoSyncUnlockDurationChange(value, () => this.renderState());
        });
      });

    new Setting(this.contentEl)
      .setName(t(this.language, "sessionDuration"))
      .addDropdown((dropdown) => {
        for (const item of UNLOCK_DURATIONS) {
          dropdown.addOption(item.value, t(this.language, item.key as TextKey));
        }
        dropdown.setValue(this.plugin.getCurrentUnlockDuration());
        dropdown.onChange((value) => {
          this.plugin.changeUnlockDuration(value);
          this.renderState();
        });
        this.durationDropdown = dropdown;
      });

    this.unsubscribe = this.plugin.subscribeOperationState(() => this.renderState());
    this.renderState();
    void this.plugin.refreshConflictState();
  }

  onClose(): void {
    this.unsubscribe();
    this.plugin.clearOneTimeUnlock();
    this.modalEl.removeClass("secure-git-sync-panel");
  }

  private renderState(): void {
    const state = this.plugin.getOperationState();
    const icon = state.kind === "running" ? "\u25F4"
      : state.kind === "completed" ? "\u2714"
      : state.kind === "failed" ? "\u2716"
      : "\u25CF";
    this.statusIconEl.setText(icon);
    this.statusIconEl.className = `secure-git-sync-status-icon secure-git-sync-status-${state.kind}`;
    this.statusTextEl.setText(state.message || t(this.language, "idle"));
    this.detailsEl.empty();
    if (state.details.length > 0) {
      this.detailsEl.createEl("div", { text: state.details.join("\n").trim() });
    }

    this.unlockEl.setText(`${t(this.language, "currentStatus")}: ${this.plugin.getUnlockLabel(this.language)}`);
    this.lastSyncEl.setText(`${t(this.language, "lastSync")}: ${this.plugin.settings.lastSyncAt ? `${new Date(this.plugin.settings.lastSyncAt).toLocaleString()} \u2014 ${this.plugin.settings.lastSyncSummary}` : t(this.language, "neverSynced")}`);
    this.renderConflicts(state);
    if (this.durationDropdown) {
      this.durationDropdown.setValue(this.plugin.getCurrentUnlockDuration());
    }

    const running = state.kind === "running";
    for (const button of this.actionButtons) {
      button.setDisabled(running);
    }
    if (this.durationDropdown) {
      this.durationDropdown.setDisabled(running);
    }
  }

  private renderConflicts(state: OperationState): void {
    this.conflictEl.empty();
    const count = state.conflictCopies ?? 0;
    const dirs = state.conflictDirs ?? [];
    if (count <= 0 && dirs.length === 0) {
      this.conflictEl.createEl("p", { text: `${t(this.language, "conflicts")}: ${t(this.language, "noConflictCopies")}` });
      return;
    }
    this.conflictEl.createEl("p", { text: `${t(this.language, "conflictCopies")}: ${count}` });
    if (dirs.length > 0) {
      this.conflictEl.createEl("pre", {
        text: dirs.slice(0, 5).join("\n"),
        cls: "secure-git-sync-conflict-paths",
      });
    }
    new Setting(this.conflictEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "openConflictFolder"))
        .onClick(() => {
          openLocalFolder(this.plugin.getConflictRootPath());
        }))
      .addButton((button) => button
        .setButtonText(t(this.language, "resolveConflicts"))
        .onClick(async () => {
          const pairs = await this.plugin.getConflictFilePairs();
          if (pairs.length === 0) {
            new Notice(t(this.language, "noResolvableConflicts"));
            return;
          }
          new ConflictResolverModal(this.app, this.plugin, this.language, pairs).open();
        }));
  }
}

class SyncConflictsModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: SecureGitSyncPlugin,
    private readonly language: UiLanguage,
    private readonly conflictCopies: number,
    private readonly conflictDirs: string[],
    private readonly conflictRootPath: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t(this.language, "conflictResultsTitle"));
    this.contentEl.createEl("p", { text: t(this.language, "conflictResultsDesc") });
    this.contentEl.createEl("p", { text: `${t(this.language, "conflictCopies")}: ${this.conflictCopies}` });
    if (this.conflictDirs.length > 0) {
      this.contentEl.createEl("pre", {
        text: this.conflictDirs.slice(0, 10).join("\n"),
        cls: "secure-git-sync-conflict-paths",
      });
    }

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "openConflictFolder"))
        .setCta()
        .onClick(() => {
          openLocalFolder(this.conflictRootPath);
        }))
      .addButton((button) => button
        .setButtonText(t(this.language, "resolveConflicts"))
        .onClick(async () => {
          const pairs = await this.plugin.getConflictFilePairs();
          if (pairs.length === 0) {
            new Notice(t(this.language, "noResolvableConflicts"));
            return;
          }
          new ConflictResolverModal(this.app, this.plugin, this.language, pairs).open();
        }))
      .addButton((button) => button
        .setButtonText(t(this.language, "continue"))
        .onClick(() => this.close()));
  }
}

type ConflictBlockChoice = "local" | "remote" | "both" | "custom";

interface ConflictDiffBlock {
  id: number;
  equal: boolean;
  localLines: string[];
  remoteLines: string[];
  choice: ConflictBlockChoice;
  resultText: string;
}

class ConflictResolverModal extends Modal {
  private selectedPairId = "";
  private conflictScope: "notes" | "all" = "notes";
  private blocks: ConflictDiffBlock[] = [];
  private localText = "";
  private remoteText = "";
  private fileEl!: HTMLElement;
  private editorsEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private resultStatusEl!: HTMLElement;
  private previewEl!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly plugin: SecureGitSyncPlugin,
    private readonly language: UiLanguage,
    private pairs: ConflictFilePair[],
  ) {
    super(app);
    this.selectedPairId = (pairs.find((pair) => pair.category === "notes") ?? pairs[0])?.id ?? "";
  }

  onOpen(): void {
    this.modalEl.addClass("secure-git-sync-resolver-modal");
    this.titleEl.setText(t(this.language, "conflictResolverTitle"));
    this.fileEl = this.contentEl.createDiv();
    this.actionsEl = this.contentEl.createDiv({ cls: "secure-git-sync-resolver-actions" });
    this.editorsEl = this.contentEl.createDiv({ cls: "secure-git-sync-live-editors" });
    this.resultStatusEl = this.contentEl.createEl("div", { text: t(this.language, "saveResolved"), cls: "secure-git-sync-resolver-status" });
    this.previewEl = document.createElement("textarea");
    this.previewEl.addClass("secure-git-sync-resolver-preview");
    this.previewEl.setAttr("aria-label", t(this.language, "preview"));
    this.previewEl.addEventListener("input", () => {
      this.resultStatusEl.setText(t(this.language, "resultUpdated"));
    });
    this.diffEl = this.contentEl.createDiv({ cls: "secure-git-sync-resolver" });
    void this.renderSelected();
  }

  onClose(): void {
    this.modalEl.removeClass("secure-git-sync-resolver-modal");
  }

  private async renderSelected(): Promise<void> {
    this.fileEl.empty();
    this.diffEl.empty();
    const visiblePairs = this.visiblePairs();
    const pair = visiblePairs.find((item) => item.id === this.selectedPairId) ?? visiblePairs[0];
    if (!pair) {
      new Setting(this.fileEl)
        .setName(t(this.language, "conflictFile"))
        .setDesc(this.conflictScope === "notes" ? t(this.language, "noNoteConflictsInScope") : t(this.language, "noResolvableConflicts"))
        .addDropdown((dropdown) => {
          dropdown.addOption("notes", t(this.language, "noteConflictsOnly"));
          dropdown.addOption("all", t(this.language, "allConflicts"));
          dropdown.setValue(this.conflictScope);
          dropdown.onChange((value) => {
            this.conflictScope = value === "all" ? "all" : "notes";
            this.selectedPairId = this.visiblePairs()[0]?.id ?? "";
            void this.renderSelected();
          });
        });
      this.editorsEl.empty();
      this.previewEl.value = "";
      this.actionsEl.empty();
      return;
    }
    this.selectedPairId = pair.id;

    new Setting(this.fileEl)
      .setName(t(this.language, "conflictFile"))
      .setDesc(pair.file)
      .addDropdown((dropdown) => {
        dropdown.addOption("notes", t(this.language, "noteConflictsOnly"));
        dropdown.addOption("all", t(this.language, "allConflicts"));
        dropdown.setValue(this.conflictScope);
        dropdown.onChange((value) => {
          this.conflictScope = value === "all" ? "all" : "notes";
          this.selectedPairId = this.visiblePairs()[0]?.id ?? "";
          void this.renderSelected();
        });
      })
      .addDropdown((dropdown) => {
        for (const item of visiblePairs) {
          dropdown.addOption(item.id, `${categoryLabel(this.language, item.category)}: ${item.file}`);
        }
        dropdown.setValue(pair.id);
        dropdown.onChange((value) => {
          this.selectedPairId = value;
          void this.renderSelected();
        });
      });

    const conflict = await this.plugin.readConflictFile(pair);
    if (!conflict.isText) {
      this.editorsEl.empty();
      this.diffEl.createEl("p", { text: t(this.language, "binaryConflictUnsupported") });
      return;
    }
    this.localText = conflict.localText;
    this.remoteText = conflict.remoteText;
    this.blocks = buildConflictDiffBlocks(this.localText, this.remoteText);
    this.renderEditors();
    this.renderBlocks();
    this.renderActions(conflict);
    this.updatePreview();
  }

  private visiblePairs(): ConflictFilePair[] {
    const notePairs = this.pairs.filter((pair) => pair.category === "notes");
    const source = this.conflictScope === "notes" ? notePairs : this.pairs;
    return source.slice().sort((left, right) => left.category === right.category ? left.file.localeCompare(right.file) : categoryRank(left.category) - categoryRank(right.category));
  }

  private renderEditors(): void {
    this.editorsEl.empty();
    const resultPanel = this.editorsEl.createDiv({ cls: "secure-git-sync-live-editor-panel secure-git-sync-live-editor-result-panel" });
    resultPanel.createEl("label", { text: t(this.language, "finalContent"), cls: "secure-git-sync-live-editor-label" });
    resultPanel.createEl("p", { text: t(this.language, "finalContentDesc"), cls: "secure-git-sync-live-editor-desc" });
    resultPanel.appendChild(this.previewEl);
  }

  private renderBlocks(): void {
    this.diffEl.empty();
    const headerEl = this.diffEl.createDiv({ cls: "secure-git-sync-diff-header" });
    headerEl.createDiv({ text: t(this.language, "chooseLocal"), cls: "secure-git-sync-diff-header-cell" });
    headerEl.createDiv({ text: "", cls: "secure-git-sync-diff-header-cell" });
    headerEl.createDiv({ text: t(this.language, "chooseRemote"), cls: "secure-git-sync-diff-header-cell" });
    for (const block of this.blocks) {
      const blockEl = this.diffEl.createDiv({ cls: `secure-git-sync-diff-block secure-git-sync-choice-${block.choice} ${block.equal ? "secure-git-sync-diff-equal" : "secure-git-sync-diff-change"}` });
      this.addEditableDiffPane(blockEl, block, "local");
      const controlsEl = blockEl.createDiv({ cls: "secure-git-sync-diff-controls" });
      if (block.equal) {
        controlsEl.setText("=");
      } else {
        this.addChoiceButton(controlsEl, block, "local", `${t(this.language, "chooseLocal")} => ${t(this.language, "resultColumn")}`);
        this.addSideReplaceButton(controlsEl, block, "local-to-remote", `${t(this.language, "chooseLocal")} => ${t(this.language, "chooseRemote")}`);
        this.addChoiceButton(controlsEl, block, "remote", `${t(this.language, "chooseRemote")} => ${t(this.language, "resultColumn")}`);
        this.addSideReplaceButton(controlsEl, block, "remote-to-local", `${t(this.language, "chooseRemote")} => ${t(this.language, "chooseLocal")}`);
        this.addChoiceButton(controlsEl, block, "both", t(this.language, "chooseBoth"));
      }
      this.addEditableDiffPane(blockEl, block, "remote");
    }
  }

  private addEditableDiffPane(container: HTMLElement, block: ConflictDiffBlock, side: "local" | "remote"): void {
    const editorEl = container.createDiv({ cls: `secure-git-sync-diff-side secure-git-sync-diff-${side} secure-git-sync-diff-editor` });
    editorEl.setAttr("contenteditable", "plaintext-only");
    editorEl.setAttr("spellcheck", "false");
    editorEl.setAttr("role", "textbox");
    editorEl.setAttr("aria-multiline", "true");
    renderInlineDiffSide(editorEl, block.localLines.join("\n"), block.remoteLines.join("\n"), side, block.equal);
    editorEl.addEventListener("input", () => {
      this.updateBlockSide(block.id, side, editorEl.innerText);
    });
    editorEl.addEventListener("blur", () => {
      this.renderBlocks();
    });
  }

  private addChoiceButton(container: HTMLElement, block: ConflictDiffBlock, choice: ConflictBlockChoice, label: string): void {
    const button = new ButtonComponent(container)
      .setButtonText(label)
      .onClick(() => {
        block.choice = choice;
        block.resultText = resultTextForChoice(block, choice);
        this.renderBlocks();
        this.updatePreview();
        this.resultStatusEl.setText(t(this.language, "resultUpdated"));
      });
    if (block.choice === choice) {
      button.setCta();
    }
  }

  private addSideReplaceButton(container: HTMLElement, block: ConflictDiffBlock, direction: "local-to-remote" | "remote-to-local", label: string): void {
    new ButtonComponent(container)
      .setButtonText(label)
      .onClick(() => {
        this.applyBlockToSide(block.id, direction);
      });
  }

  private renderActions(conflict: ConflictFileContent): void {
    this.actionsEl.empty();
    new Setting(this.actionsEl)
      .addButton((button) => button
        .setButtonText(`${t(this.language, "chooseLocal")} -> ${t(this.language, "resultColumn")}`)
        .onClick(() => this.applyChoiceToAll("local")))
      .addButton((button) => button
        .setButtonText(`${t(this.language, "resultColumn")} -> ${t(this.language, "chooseLocal")}`)
        .onClick(() => this.copyResultToSide("local")))
      .addButton((button) => button
        .setButtonText(`${t(this.language, "chooseRemote")} -> ${t(this.language, "resultColumn")}`)
        .onClick(() => this.applyChoiceToAll("remote")))
      .addButton((button) => button
        .setButtonText(`${t(this.language, "resultColumn")} -> ${t(this.language, "chooseRemote")}`)
        .onClick(() => this.copyResultToSide("remote")));
    new Setting(this.actionsEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "chooseAllLocal"))
        .onClick(() => this.applyChoiceToAll("local")))
      .addButton((button) => button
        .setButtonText(t(this.language, "chooseAllRemote"))
        .onClick(() => this.applyChoiceToAll("remote")))
      .addButton((button) => button
        .setButtonText(t(this.language, "chooseAllBoth"))
        .onClick(() => this.applyChoiceToAll("both")));
    new Setting(this.actionsEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "saveResolved"))
        .setCta()
        .onClick(async () => {
          await this.plugin.saveResolvedConflict(conflict, this.previewEl.value);
          new Notice(t(this.language, "resolvedSaved"));
          this.pairs = await this.plugin.getConflictFilePairs();
          this.selectedPairId = this.visiblePairs()[0]?.id ?? "";
          void this.renderSelected();
        }))
      .addButton((button) => button
        .setButtonText(t(this.language, "saveAndSync"))
        .setCta()
        .onClick(async () => {
          await this.plugin.saveResolvedConflict(conflict, this.previewEl.value);
          new Notice(t(this.language, "resolvedSaved"));
          this.close();
          void this.plugin.runPasswordProtected("sync");
        }))
      .addButton((button) => button
        .setButtonText(t(this.language, "cancel"))
        .onClick(() => this.close()));
  }

  private applyChoiceToAll(choice: ConflictBlockChoice): void {
    for (const block of this.blocks) {
      if (block.equal) {
        continue;
      }
      block.choice = choice;
      block.resultText = resultTextForChoice(block, choice);
    }
    this.renderBlocks();
    this.updatePreview();
    this.resultStatusEl.setText(t(this.language, "resultUpdated"));
  }

  private copyResultToSide(side: "local" | "remote"): void {
    const resultText = this.previewEl.value;
    if (side === "local") {
      this.localText = resultText;
    } else {
      this.remoteText = resultText;
    }
    this.blocks = buildConflictDiffBlocks(this.localText, this.remoteText);
    this.renderEditors();
    this.renderBlocks();
    this.previewEl.value = resultText;
    this.resultStatusEl.setText(t(this.language, "resultUpdated"));
  }

  private updateBlockSide(blockId: number, side: "local" | "remote", text: string): void {
    const block = this.blocks.find((item) => item.id === blockId);
    if (!block) {
      return;
    }
    if (side === "local") {
      block.localLines = splitDiffLines(text);
      block.choice = "local";
    } else {
      block.remoteLines = splitDiffLines(text);
      block.choice = "remote";
    }
    block.equal = block.localLines.join("\n") === block.remoteLines.join("\n");
    block.resultText = resultTextForChoice(block, block.choice);
    this.rebuildSideTextsFromBlocks();
    this.updatePreview();
    this.resultStatusEl.setText(t(this.language, "resultUpdated"));
  }

  private applyBlockToSide(blockId: number, direction: "local-to-remote" | "remote-to-local"): void {
    const block = this.blocks.find((item) => item.id === blockId);
    if (!block) {
      return;
    }
    if (direction === "local-to-remote") {
      block.remoteLines = [...block.localLines];
      block.choice = "local";
    } else {
      block.localLines = [...block.remoteLines];
      block.choice = "remote";
    }
    block.equal = true;
    block.resultText = resultTextForChoice(block, block.choice);
    this.rebuildSideTextsFromBlocks();
    this.renderEditors();
    this.renderBlocks();
    this.updatePreview();
    this.resultStatusEl.setText(t(this.language, "resultUpdated"));
  }

  private rebuildSideTextsFromBlocks(): void {
    this.localText = textFromDiffLines(this.blocks.flatMap((block) => block.localLines));
    this.remoteText = textFromDiffLines(this.blocks.flatMap((block) => block.remoteLines));
  }

  private updatePreview(): void {
    this.previewEl.value = renderConflictSelection(this.blocks);
  }
}

class SyncDifferencesModal extends Modal {
  private resolution: SyncConflictResolution = {
    notes: "merge",
    obsidian: "merge",
    plugins: "merge",
  };

  constructor(
    app: App,
    private readonly language: UiLanguage,
    private readonly differences: SyncDifferenceSummary,
    private readonly onSubmit: (resolution: SyncConflictResolution | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t(this.language, "syncDifferencesTitle"));
    this.contentEl.createEl("p", { text: t(this.language, "syncDifferencesDesc") });
    if (this.differences.hasPluginFiles || hasCategoryDifferences(this.differences.plugins)) {
      this.contentEl.createEl("p", { text: t(this.language, "pluginSyncWarning") });
    }

    this.addCategory("notes", t(this.language, "notesCategory"), this.differences.notes);
    this.addCategory("obsidian", t(this.language, "obsidianCategory"), this.differences.obsidian);
    this.addCategory("plugins", t(this.language, "pluginsCategory"), this.differences.plugins);
    this.addDecisionDetails();

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "cancel"))
        .onClick(() => {
          this.onSubmit(null);
          this.close();
        }))
      .addButton((button) => button
        .setButtonText(t(this.language, "continueSync"))
        .setCta()
        .onClick(() => {
          this.onSubmit({ ...this.resolution });
          this.close();
        }));
  }

  private addCategory(category: keyof SyncConflictResolution, label: string, counts: DifferenceCounts): void {
    const summary = `${counts.localOnly} ${t(this.language, "localOnly")}, ${counts.remoteOnly} ${t(this.language, "remoteOnly")}, ${counts.modified} ${t(this.language, "modified")}`;
    new Setting(this.contentEl)
      .setName(label)
      .setDesc(summary)
      .addDropdown((dropdown) => {
        dropdown.addOption("merge", t(this.language, "mergeBoth"));
        dropdown.addOption("local", t(this.language, "keepLocal"));
        dropdown.addOption("remote", t(this.language, "useRemote"));
        dropdown.setValue(this.resolution[category]);
        dropdown.onChange((value) => {
          this.resolution[category] = value === "merge" || value === "local" ? value : "remote";
        });
      });

    if (counts.samples.length > 0) {
      this.contentEl.createEl("pre", {
        text: counts.samples.join("\n"),
        cls: "secure-git-sync-diff-samples",
      });
    }
  }

  private addDecisionDetails(): void {
    const decisions = [
      ...(this.differences.obsidianDecisions ?? []),
      ...(this.differences.pluginDecisions ?? []),
    ];
    if (decisions.length === 0) {
      return;
    }
    this.contentEl.createEl("h3", { text: t(this.language, "autoDecisionDetails") });
    this.contentEl.createEl("pre", {
      text: decisions.slice(0, 80).join("\n"),
      cls: "secure-git-sync-diff-samples secure-git-sync-decision-details",
    });
  }
}

class LanguageSelectModal extends Modal {
  constructor(app: App, private readonly onSubmit: (language: UiLanguage) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("en", "chooseLanguageTitle"));
    this.contentEl.createEl("p", { text: `${t("zh", "chooseLanguageDesc")} / ${t("en", "chooseLanguageDesc")}` });

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("中文")
        .setCta()
        .onClick(async () => {
          await this.onSubmit("zh");
          this.close();
        }))
      .addButton((button) => button
        .setButtonText("English")
        .onClick(async () => {
          await this.onSubmit("en");
          this.close();
        }));
  }
}

class PasswordSetupModal extends Modal {
  private username = "";
  private password = "";
  private confirm = "";
  private hint = "";

  constructor(app: App, private readonly language: UiLanguage, private readonly onSubmit: (username: string, password: string, hint: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t(this.language, "createAdminPassword"));
    this.contentEl.createEl("p", { text: t(this.language, "passwordRequired") });
    new Setting(this.contentEl)
      .setName(t(this.language, "username"))
      .addText((text) => text.onChange((value) => {
        this.username = value.trim();
      }));
    addPasswordField(this.contentEl, t(this.language, "password"), (value) => {
      this.password = value;
    });
    addPasswordField(this.contentEl, t(this.language, "confirmPassword"), (value) => {
      this.confirm = value;
    });
    new Setting(this.contentEl)
      .setName(t(this.language, "passwordHint"))
      .addText((text) => text.onChange((value) => {
        this.hint = value;
      }));
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "create"))
        .setCta()
        .onClick(async () => {
          if (!this.username) {
            new Notice(t(this.language, "usernameRequired"));
            return;
          }
          if (this.password.length < 8) {
            new Notice(t(this.language, "passwordTooShort"));
            return;
          }
          if (this.password !== this.confirm) {
            new Notice(t(this.language, "passwordsDoNotMatch"));
            return;
          }
          await this.onSubmit(this.username, this.password, this.hint);
          this.close();
        }));
  }
}

class UnlockSessionModal extends Modal {
  private username: string;
  private password = "";
  private duration: string;
  private busy = false;
  private hideDurationSelect: boolean;

  constructor(
    app: App,
    private readonly language: UiLanguage,
    username: string,
    private readonly hint: string,
    private readonly onSubmit: (username: string, password: string, duration: string) => Promise<void>,
    private readonly title?: string,
    options?: { initialDuration?: string; hideDurationSelect?: boolean },
  ) {
    super(app);
    this.username = username;
    this.duration = options?.initialDuration ?? "1440";
    this.hideDurationSelect = options?.hideDurationSelect ?? false;
  }

  onOpen(): void {
    this.titleEl.setText(this.title ?? t(this.language, "unlockPanel"));
    this.contentEl.createEl("p", { text: t(this.language, "panelLockedDesc") });
    if (this.hint) {
      this.contentEl.createEl("p", { text: `${t(this.language, "hint")}: ${this.hint}` });
    }
    new Setting(this.contentEl)
      .setName(t(this.language, "username"))
      .addText((text) => text
        .setValue(this.username)
        .onChange((value) => {
          this.username = value.trim();
        }));
    addPasswordField(this.contentEl, t(this.language, "password"), (value) => {
      this.password = value;
    });
    if (!this.hideDurationSelect) {
      new Setting(this.contentEl)
        .setName(t(this.language, "sessionDuration"))
        .addDropdown((dropdown) => {
          for (const item of UNLOCK_DURATIONS) {
            dropdown.addOption(item.value, t(this.language, item.key as TextKey));
          }
          dropdown.setValue(this.duration);
          dropdown.onChange((value) => {
            this.duration = value;
          });
        });
    }
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "continue"))
        .setCta()
        .onClick(async () => {
          if (this.busy) {
            return;
          }
          this.busy = true;
          button.setDisabled(true);
          button.setButtonText(t(this.language, "running"));
          try {
            if (!this.username) {
              throw new Error(t(this.language, "usernameRequired"));
            }
            await this.onSubmit(this.username, this.password, this.duration);
            this.close();
          } catch (error) {
            new Notice(formatCredentialError(error, this.language));
            this.busy = false;
            button.setDisabled(false);
            button.setButtonText(t(this.language, "continue"));
          }
        }));
  }
}

class ChangePasswordModal extends Modal {
  private oldUsername: string;
  private oldPassword = "";
  private newUsername: string;
  private newPassword = "";
  private confirm = "";
  private hint = "";

  constructor(
    app: App,
    private readonly language: UiLanguage,
    currentUsername: string,
    currentHint: string,
    private readonly onSubmit: (oldUsername: string, oldPassword: string, newUsername: string, newPassword: string, hint: string) => Promise<void>,
  ) {
    super(app);
    this.oldUsername = currentUsername;
    this.newUsername = currentUsername;
    this.hint = currentHint;
  }

  onOpen(): void {
    this.titleEl.setText(t(this.language, "changeAdminPassword"));
    new Setting(this.contentEl)
      .setName(t(this.language, "currentUsername"))
      .addText((text) => text
        .setValue(this.oldUsername)
        .onChange((value) => {
          this.oldUsername = value.trim();
        }));
    addPasswordField(this.contentEl, t(this.language, "currentPassword"), (value) => {
      this.oldPassword = value;
    });
    new Setting(this.contentEl)
      .setName(t(this.language, "newUsername"))
      .addText((text) => text
        .setValue(this.newUsername)
        .onChange((value) => {
          this.newUsername = value.trim();
        }));
    addPasswordField(this.contentEl, t(this.language, "newPassword"), (value) => {
      this.newPassword = value;
    });
    addPasswordField(this.contentEl, t(this.language, "confirmNewPassword"), (value) => {
      this.confirm = value;
    });
    new Setting(this.contentEl)
      .setName(t(this.language, "passwordHint"))
      .addText((text) => text
        .setValue(this.hint)
        .onChange((value) => {
          this.hint = value;
        }));
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "change"))
        .setCta()
        .onClick(async () => {
          try {
            if (!this.newUsername) {
              new Notice(t(this.language, "usernameRequired"));
              return;
            }
            if (this.newPassword.length < 8) {
              new Notice(t(this.language, "passwordTooShort"));
              return;
            }
            if (this.newPassword !== this.confirm) {
              new Notice(t(this.language, "passwordsDoNotMatch"));
              return;
            }
            await this.onSubmit(this.oldUsername, this.oldPassword, this.newUsername, this.newPassword, this.hint);
            this.close();
          } catch (error) {
            new Notice(formatCredentialError(error, this.language));
          }
        }));
  }
}

class RemoteModal extends Modal {
  private remote: RemoteConfig;

  constructor(app: App, private readonly language: UiLanguage, remote: RemoteConfig | null, private readonly onSubmit: (remote: RemoteConfig) => Promise<void>) {
    super(app);
    this.remote = remote ? { ...remote } : {
      id: randomId(),
      name: "origin",
      url: "",
      branch: "main",
    };
  }

  onOpen(): void {
    this.titleEl.setText(t(this.language, "gitRemote"));
    new Setting(this.contentEl)
      .setName(t(this.language, "remoteName"))
      .addText((text) => text
        .setValue(this.remote.name)
        .onChange((value) => {
          this.remote.name = value.trim();
        }));
    new Setting(this.contentEl)
      .setName(t(this.language, "remoteUrl"))
      .addText((text) => text
        .setValue(this.remote.url)
        .onChange((value) => {
          this.remote.url = value.trim();
        }));
    new Setting(this.contentEl)
      .setName(t(this.language, "branch"))
      .addText((text) => text
        .setValue(this.remote.branch)
        .onChange((value) => {
          this.remote.branch = value.trim();
        }));
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "save"))
        .setCta()
        .onClick(async () => {
          if (!this.remote.name || !this.remote.url || !this.remote.branch) {
            new Notice(t(this.language, "remoteFieldsRequired"));
            return;
          }
          await this.onSubmit(this.remote);
          this.close();
        }));
  }
}

class ProviderAccountModal extends Modal {
  private account: ProviderAccount;
  private readonly shouldOpenAuthPage: boolean;

  constructor(
    app: App,
    private readonly language: UiLanguage,
    provider: GitProviderId,
    account: ProviderAccount | null,
    private readonly onSubmit: (account: ProviderAccount) => Promise<void>,
  ) {
    super(app);
    this.shouldOpenAuthPage = account === null;
    const definition = getProviderDefinition(provider);
    this.account = account ? { ...account } : {
      id: randomId(),
      provider,
      label: definition.name,
      token: "",
      apiBaseUrl: definition.defaultApiBaseUrl,
      defaultRemoteUrlType: "ssh",
    };
  }

  onOpen(): void {
    const definition = getProviderDefinition(this.account.provider);
    this.titleEl.setText(`${t(this.language, "authorize")} ${definition.name}`);
    this.contentEl.createEl("p", { text: `${t(this.language, "tokenHelpPrefix")} ${definition.tokenHelpUrl}` });

    if (this.shouldOpenAuthPage) {
      window.setTimeout(() => {
        openExternalUrl(definition.tokenHelpUrl);
      }, 100);
    }

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "openAuthPage"))
        .onClick(() => {
          openExternalUrl(definition.tokenHelpUrl);
        }));

    new Setting(this.contentEl)
      .setName(t(this.language, "label"))
      .addText((text) => text
        .setValue(this.account.label)
        .onChange((value) => {
          this.account.label = value.trim();
        }));

    new Setting(this.contentEl)
      .setName(t(this.language, "apiBaseUrl"))
      .addText((text) => text
        .setValue(this.account.apiBaseUrl)
        .onChange((value) => {
          this.account.apiBaseUrl = value.trim();
        }));

    new Setting(this.contentEl)
      .setName(t(this.language, "token"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.account.token);
        text.onChange((value) => {
          this.account.token = value.trim();
        });
      });

    new Setting(this.contentEl)
      .setName(t(this.language, "remoteUrlType"))
      .addDropdown((dropdown) => dropdown
        .addOption("ssh", "SSH")
        .addOption("https", "HTTPS")
        .setValue(this.account.defaultRemoteUrlType)
        .onChange((value) => {
          this.account.defaultRemoteUrlType = value as "https" | "ssh";
        }));

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "save"))
        .setCta()
        .onClick(async () => {
          if (!this.account.label || !this.account.apiBaseUrl || !this.account.token) {
            new Notice(t(this.language, "accountFieldsRequired"));
            return;
          }
          await this.onSubmit(this.account);
          this.close();
        }));
  }
}

class RepositoryBrowserModal extends Modal {
  private repos: ProviderRepo[] = [];
  private selectedRepoId = "";
  private remoteName = "origin";
  private branch = "main";
  private createName = "";
  private createPrivate = true;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private readonly language: UiLanguage,
    private readonly account: ProviderAccount,
    private readonly onAddRemote: (remote: RemoteConfig) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`${t(this.language, "repositories")} - ${this.account.label}`);
    this.statusEl = this.contentEl.createEl("p", { text: t(this.language, "loadingRepos") });
    void this.loadRepositories();
  }

  private async loadRepositories(): Promise<void> {
    try {
      this.repos = await new GitProviderClient(this.account).listRepositories();
      this.render();
    } catch (error) {
      this.statusEl.setText(formatError(error));
    }
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: t(this.language, "repoBrowserDesc") });

    new Setting(this.contentEl)
      .setName(t(this.language, "existingRepo"))
      .addDropdown((dropdown) => {
        for (const repo of this.repos) {
          dropdown.addOption(repo.id, `${repo.fullName}${repo.private ? ` (${t(this.language, "private")})` : ""}`);
        }
        const firstRepo = this.repos[0];
        this.selectedRepoId ||= firstRepo?.id ?? "";
        dropdown.setValue(this.selectedRepoId);
        dropdown.onChange((value) => {
          this.selectedRepoId = value;
          const repo = this.selectedRepo();
          this.branch = repo?.defaultBranch || this.branch;
          this.remoteName = repo?.name || this.remoteName;
        });
      });

    this.renderRemoteFields();

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "addSelected"))
        .setCta()
        .onClick(async () => {
          const repo = this.selectedRepo();
          if (!repo) {
            new Notice(t(this.language, "selectRepoFirst"));
            return;
          }
          await this.addRepo(repo);
        }));

    this.contentEl.createEl("h3", { text: t(this.language, "createRepo") });

    new Setting(this.contentEl)
      .setName(t(this.language, "repoName"))
      .addText((text) => text.onChange((value) => {
        this.createName = value.trim();
      }));

    new Setting(this.contentEl)
      .setName(t(this.language, "privateRepo"))
      .addToggle((toggle) => toggle
        .setValue(this.createPrivate)
        .onChange((value) => {
          this.createPrivate = value;
        }));

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t(this.language, "createAndAdd"))
        .onClick(async () => {
          if (!this.createName) {
            new Notice(t(this.language, "repoNameRequired"));
            return;
          }
          try {
            const repo = await new GitProviderClient(this.account).createRepository(this.createName, this.createPrivate);
            await this.addRepo(repo);
          } catch (error) {
            new Notice(formatError(error));
          }
        }));
  }

  private renderRemoteFields(): void {
    const repo = this.selectedRepo();
    if (repo) {
      this.remoteName = this.remoteName || repo.name;
      this.branch = this.branch || repo.defaultBranch;
    }

    new Setting(this.contentEl)
      .setName(t(this.language, "remoteName"))
      .addText((text) => text
        .setValue(this.remoteName)
        .onChange((value) => {
          this.remoteName = value.trim();
        }));

    new Setting(this.contentEl)
      .setName(t(this.language, "branch"))
      .addText((text) => text
        .setValue(this.branch)
        .onChange((value) => {
          this.branch = value.trim();
        }));
  }

  private selectedRepo(): ProviderRepo | null {
    return this.repos.find((repo) => repo.id === this.selectedRepoId) ?? this.repos[0] ?? null;
  }

  private async addRepo(repo: ProviderRepo): Promise<void> {
    const remote: RemoteConfig = {
      id: randomId(),
      name: this.remoteName || repo.name,
      url: this.account.defaultRemoteUrlType === "ssh" ? repo.sshUrl : repo.cloneUrl,
      branch: this.branch || repo.defaultBranch || "main",
      providerAccountId: this.account.id,
    };
    await this.onAddRemote(remote);
    new Notice(`${t(this.language, "addedRemote")} ${remote.name}.`);
    this.close();
  }
}

function addPasswordField(containerEl: HTMLElement, name: string, onChange: (value: string) => void): void {
  new Setting(containerEl)
    .setName(name)
    .addText((text) => {
      text.inputEl.type = "password";
      text.onChange(onChange);
    });
}

function openExternalUrl(url: string): void {
  try {
    const electron = require("electron") as { shell?: { openExternal: (target: string) => Promise<void> } };
    if (electron.shell) {
      void electron.shell.openExternal(url);
      return;
    }
  } catch {
    // Fall back to the browser API below.
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function openLocalFolder(folderPath: string): void {
  try {
    const electron = require("electron") as { shell?: { openPath: (target: string) => Promise<string> } };
    if (electron.shell) {
      void electron.shell.openPath(folderPath);
    }
  } catch (error) {
    new Notice(formatError(error));
  }
}

async function pickLocalKeyringFile(defaultPath: string): Promise<string | null> {
  try {
    const electron = require("electron") as { dialog?: ElectronDialog; remote?: { dialog?: ElectronDialog } };
    const dialog = electron.dialog ?? electron.remote?.dialog;
    if (!dialog?.showOpenDialog) {
      return null;
    }
    const result = await dialog.showOpenDialog({
      title: "Select keyring.json",
      defaultPath,
      properties: ["openFile"],
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } catch (error) {
    new Notice(formatError(error));
    return null;
  }
}

async function applyElectronProxy(settings: SecureGitSettings): Promise<void> {
  try {
    const electron = require("electron") as { remote?: { session?: { defaultSession?: ElectronSession } }; session?: { defaultSession?: ElectronSession } };
    const session = electron.session?.defaultSession ?? electron.remote?.session?.defaultSession;
    if (!session?.setProxy) {
      return;
    }
    if (settings.proxyMode === "custom" && settings.proxyUrl.trim()) {
      await session.setProxy({
        proxyRules: settings.proxyUrl.trim(),
        proxyBypassRules: settings.proxyNoProxy.trim(),
      });
      return;
    }
    if (settings.proxyMode === "off") {
      await session.setProxy({ proxyRules: "direct://" });
    } else {
      await session.setProxy({});
    }
  } catch {
    // Git subprocess proxy settings still apply even if Electron proxy cannot be changed.
  }
}

interface ElectronSession {
  setProxy(config: { proxyRules?: string; proxyBypassRules?: string }): Promise<void>;
}

interface ElectronDialog {
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatCredentialError(error: unknown, language: UiLanguage): string {
  const message = formatError(error);
  if (message === "Username or password is incorrect.") {
    return t(language, "credentialIncorrect");
  }
  return message;
}

function isPasswordConfig(value: unknown): value is PasswordConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const config = value as Partial<PasswordConfig>;
  return typeof config.salt === "string"
    && typeof config.verifierIv === "string"
    && typeof config.verifierCiphertext === "string"
    && typeof config.iterations === "number"
    && (config.kdf === undefined || config.kdf === "PBKDF2-SHA-256" || config.kdf === "Argon2id");
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${rest}s`;
}

function hasCategoryDifferences(counts: DifferenceCounts): boolean {
  return counts.localOnly > 0 || counts.remoteOnly > 0 || counts.modified > 0;
}

function categoryRank(category: ConflictFilePair["category"]): number {
  if (category === "notes") {
    return 0;
  }
  if (category === "obsidian") {
    return 1;
  }
  return 2;
}

function categoryLabel(language: UiLanguage, category: ConflictFilePair["category"]): string {
  if (category === "notes") {
    return t(language, "notesCategory");
  }
  return category === "obsidian" ? t(language, "obsidianCategory") : t(language, "pluginsCategory");
}

function buildConflictDiffBlocks(localText: string, remoteText: string): ConflictDiffBlock[] {
  const localLines = splitDiffLines(localText);
  const remoteLines = splitDiffLines(remoteText);
  if (localLines.length * remoteLines.length > 200000) {
    return [{ id: 0, equal: false, localLines, remoteLines, choice: "both", resultText: resultTextForChoice({ localLines, remoteLines }, "both") }];
  }
  const table = buildLcsTable(localLines, remoteLines);
  const blocks: ConflictDiffBlock[] = [];
  let localIndex = 0;
  let remoteIndex = 0;
  let id = 0;

  const pushBlock = (equal: boolean, left: string[], right: string[]) => {
    if (left.length === 0 && right.length === 0) {
      return;
    }
    const previous = blocks[blocks.length - 1];
    if (previous && previous.equal === equal) {
      previous.localLines.push(...left);
      previous.remoteLines.push(...right);
      previous.resultText = resultTextForChoice(previous, previous.choice);
      return;
    }
    const choice = equal ? "local" : left.length > 0 && right.length > 0 ? "both" : left.length > 0 ? "local" : "remote";
    blocks.push({
      id,
      equal,
      localLines: left,
      remoteLines: right,
      choice,
      resultText: resultTextForChoice({ localLines: left, remoteLines: right }, choice),
    });
    id += 1;
  };

  while (localIndex < localLines.length && remoteIndex < remoteLines.length) {
    if (localLines[localIndex] === remoteLines[remoteIndex]) {
      pushBlock(true, [localLines[localIndex]], [remoteLines[remoteIndex]]);
      localIndex += 1;
      remoteIndex += 1;
    } else {
      const leftStart = localIndex;
      const rightStart = remoteIndex;
      while (localIndex < localLines.length && remoteIndex < remoteLines.length && localLines[localIndex] !== remoteLines[remoteIndex]) {
        if (table[localIndex + 1][remoteIndex] >= table[localIndex][remoteIndex + 1]) {
          localIndex += 1;
        } else {
          remoteIndex += 1;
        }
      }
      pushBlock(false, localLines.slice(leftStart, localIndex), remoteLines.slice(rightStart, remoteIndex));
    }
  }
  pushBlock(false, localLines.slice(localIndex), remoteLines.slice(remoteIndex));
  return blocks.length > 0 ? blocks : [{ id: 0, equal: true, localLines: [], remoteLines: [], choice: "local", resultText: "" }];
}

function splitDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function buildLcsTable(left: string[], right: string[]): number[][] {
  const table = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
    }
  }
  return table;
}

function renderInlineDiffSide(container: HTMLElement, localText: string, remoteText: string, side: "local" | "remote", equal: boolean): void {
  container.empty();
  if (equal || localText === remoteText) {
    container.setText(side === "local" ? localText : remoteText);
    return;
  }
  const text = side === "local" ? localText : remoteText;
  const other = side === "local" ? remoteText : localText;
  if (text.length * other.length > 40000) {
    container.setText(text);
    return;
  }
  for (const segment of buildInlineDiffSegments(text, other)) {
    if (segment.changed) {
      container.createSpan({ text: segment.text, cls: "secure-git-sync-inline-change" });
    } else {
      container.appendText(segment.text);
    }
  }
}

function buildInlineDiffSegments(text: string, other: string): Array<{ text: string; changed: boolean }> {
  const left = Array.from(text);
  const right = Array.from(other);
  const table = buildLcsTable(left, right);
  const segments: Array<{ text: string; changed: boolean }> = [];
  let leftIndex = 0;
  let rightIndex = 0;
  let buffer = "";
  let changed = false;

  const flush = () => {
    if (!buffer) {
      return;
    }
    segments.push({ text: buffer, changed });
    buffer = "";
  };
  const append = (char: string, isChanged: boolean) => {
    if (buffer && changed !== isChanged) {
      flush();
    }
    changed = isChanged;
    buffer += char;
  };

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      append(left[leftIndex], false);
      leftIndex += 1;
      rightIndex += 1;
    } else if (table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1]) {
      append(left[leftIndex], true);
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    append(left[leftIndex], true);
    leftIndex += 1;
  }
  flush();
  return segments;
}

function renderConflictSelection(blocks: ConflictDiffBlock[]): string {
  const lines = blocks.flatMap((block) => splitDiffLines(block.resultText));
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function textFromDiffLines(lines: string[]): string {
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function resultTextForChoice(block: Pick<ConflictDiffBlock, "localLines" | "remoteLines">, choice: ConflictBlockChoice): string {
  if (choice === "local") {
    return block.localLines.join("\n");
  }
  if (choice === "remote") {
    return block.remoteLines.join("\n");
  }
  if (choice === "custom") {
    return "";
  }
  return [...block.localLines, ...block.remoteLines].join("\n");
}
