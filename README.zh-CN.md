# 🔐 Secure Git Sync

Secure Git Sync 是一个 Obsidian 桌面端插件，用于在 Git 同步前进行密码确认，并支持把远程笔记快照保存为加密对象。本地 vault 仍然保持普通 Markdown 和普通 Obsidian 文件，远程仓库可以保存 AES-256-GCM 加密后的笔记内容。

[English README](README.md)

## 🧭 插件介绍

Secure Git Sync 面向已经使用 Git 备份和多端同步笔记、但希望远程仓库更安全的 Obsidian 用户。插件可以直接复用当前 vault 里的 `.git` 仓库，导入已有远程仓库配置，也可以通过界面添加新的 Git 远程仓库。

基本使用流程：

- 输入主管理员密码解锁插件。
- 选择一个远程仓库。
- 在 Obsidian 侧边栏面板中执行 pull、push、sync 或 status。
- 本地文件保持明文可读。
- 开启加密后，远程笔记内容以加密快照形式保存。

## ✨ 功能汇总

- Push、Pull、Sync 前进行密码确认。
- 新配置默认开启远程笔记加密。
- 本地 vault 文件和本地 Git 工作区保持明文。
- 可导入现有 `.git/config` 中的远程仓库，并且不重写已有 URL。
- 支持 GitHub、GitLab、Gitee、AtomGit、通用 SSH 远程仓库和通用 HTTPS 远程仓库。
- 支持一个 vault 配置多个远程仓库，也支持一个本地 remote 拥有多个 push URL。
- 提供 pull、push、sync、status、冲突查看和冲突解决界面。
- 可选同步 Obsidian 设置。
- 可选同步插件运行时文件，同时排除插件本地状态。
- 新 keyring 使用 Argon2id 包装主管理员密码。
- 兼容旧版 PBKDF2 keyring。
- 使用 AES-256-GCM 加密笔记对象和 manifest。
- 使用本地增量缓存，避免重复 hash 未变化文件。
- 使用有限并发处理 hash 和加密，适配大 vault。
- 支持分片加密 manifest，并兼容旧版完整 manifest。
- 内部 Git 缓存位于 `.secure-git-sync/git-cache`。
- 构建和发布产物统一生成到 `release/`。

## 🌟 插件特别之处

Secure Git Sync 不是托管同步服务，而是一个本地优先的 Obsidian 插件。它使用你自己选择的 Git 远程仓库。

它的核心区别是把“本地可用性”和“远程隐私”分开：

- 本地仍然是普通 Markdown 文件，Obsidian 可以直接读取和编辑。
- 远程可以只保存加密后的笔记对象和加密 manifest。
- Git 只作为传输层，你可以使用 GitHub、GitLab、Gitee、GitCode、SSH 或自建 Git 仓库。

插件也尽量兼容已有 Git 工作流。如果 vault 已经有 `.git/config`，可以直接导入并复用，不需要插件重新创建远程仓库配置。

## 🛡️ 加密模型

开启加密同步后，远程仓库使用如下结构：

```text
.obsidian/                         # 选定的 Obsidian 设置，明文
.secure-git-sync/
  manifest.enc                     # 兼容旧版的完整加密 manifest
  manifest-index.enc               # 加密 manifest 分片索引
  manifest-shards/
    00.enc                         # 加密 manifest 分片
    ...
  keyring.json                     # 可选的密码包装 vault key
  objects/
    ab/<object-id>.enc             # 加密笔记对象
```

插件使用随机 256-bit vault key 加密笔记内容。主管理员密码用于包装这个 vault key。新 keyring 使用 Argon2id，旧 PBKDF2-SHA-256 keyring 仍可解锁并迁移。

每个笔记对象使用 AES-256-GCM 加密。vault 相对路径会作为附加认证数据，因此密文会绑定到对应路径。

## 🏗️ 插件架构

插件主要由以下模块组成：

- `src/main.ts`：Obsidian 插件入口、命令、设置页、弹窗、操作面板、解锁流程和进度展示。
- `src/git.ts`：Git 编排、加密 push/pull、明文兼容、冲突处理、远程导入、文件扫描、manifest 管理和性能缓存。
- `src/crypto.ts`：密码校验、密钥包装、密钥迁移、AES-GCM 加密解密和 hash 工具。
- `src/providers.ts`：Git 托管平台 API 集成，用于浏览和创建仓库。
- `src/types.ts`：设置、远程仓库、平台账号、密码配置、同步状态和缓存类型。
- `release/build-release.mjs`：构建和打包脚本。

同步引擎会调用 Git 子进程，但会通过命令白名单和路径校验限制执行范围。Git 只会在 vault 内或插件内部临时/缓存工作区中运行。

## ⚙️ 运行流程

加密 push：

1. 确认当前 vault 有 Git 仓库，并确认选中的远程仓库可用。
2. 在内部 Git 工作区 fetch 远程分支。
3. 读取加密 manifest，优先读取分片 manifest，失败时回退到旧版完整 manifest。
4. 扫描笔记路径。
5. 对 size 和 mtime 未变化的文件复用本地缓存，不重新读取和 hash。
6. 对变化的笔记使用有限并发进行 hash 和加密。
7. 复用未变化的远程加密对象。
8. 写入新的 manifest、分片索引和分片。
9. 在内部工作区创建 Git commit，并推送到选中的远程分支。

加密 pull：

1. fetch 选中的远程分支。
2. 读取并解密 manifest。
3. 使用本地缓存辅助比较本地 hash 和远程 manifest。
4. 只解密远程发生变化的笔记。
5. 按冲突策略合并或应用文件。
6. 无法安全自动合并时生成冲突副本。
7. 更新本地笔记索引和缓存。

明文兼容：

- 关闭加密时，插件仍可执行普通 Git push/pull。
- 如果远程已经包含加密 manifest，插件可以自动检测并切换到加密处理。

## 📦 同步范围

加密模式下，笔记以远程加密对象形式保存。选定的 Obsidian 配置可以继续以明文同步。

插件会排除高频变化或不适合同步的运行状态：

- `.git/`
- `.secure-git-sync/`
- `.secure-git-sync-conflicts/`
- `.secure-git-sync-trash/`
- 冲突副本文件
- 插件依赖和缓存目录
- 插件本地状态文件，例如 `data.json`、`cache.json`、`workspace.json`
- Secure Git Sync 自身的本地 `data.json`

插件运行时同步只包含 Obsidian 运行所需文件：

- `manifest.json`
- `main.js`
- `styles.css`

## 🚀 安装

将构建后的运行时文件放入 Obsidian 插件目录：

```text
<vault>/.obsidian/plugins/secure-git-sync/
```

运行时文件：

```text
manifest.json
main.js
styles.css
```

然后在 Obsidian 的第三方插件设置中启用 `Secure Git Sync`。

## 🧰 构建与发布

安装依赖：

```bash
npm install
```

构建本地插件目录：

```bash
npm run build
```

生成完整发布包：

```bash
npm run release
```

发布产物：

```text
release/secure-git-sync-<version>/
  manifest.json
  main.js
  styles.css
release/secure-git-sync-<version>.zip
release/secure-git-sync-<version>.sha256
```

仓库根目录不应生成或提交 `main.js`。构建和发布产物统一保存在 `release/`。

## ![Buy Me a Coffee](assets/buy-me-a-coffee.png) 目前暂未开放

如果 Secure Git Sync 对你的 Obsidian 工作流有帮助，可以通过下面的方式支持后续开发：

- [微信支付](assets/wechat-pay-placeholder.svg)
- [支付宝](assets/alipay-placeholder.svg)

感谢你帮助这个插件持续维护、测试和改进。

## 🤖 自动化

GitHub Actions 发布自动化位于 `.github/workflows/release.yml`。它可以手动触发，也可以通过推送 `x.x.x` 版本标签（例如 `0.2.0`）触发，或者在 `main` 分支插件版本变动后自动触发。Action 会构建发布包，并在 `<manifest.version>` 对应 release 不存在时发布 GitHub Release。
