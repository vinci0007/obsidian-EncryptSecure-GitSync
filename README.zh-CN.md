# 🔐 Secure Git Sync

Secure Git Sync 是一个 Obsidian 桌面端插件，提供带密码确认的 Git 同步、可选的远程笔记加密快照，以及局域网内设备直连同步。

[English README](README.md)

## 🧭 插件介绍

Secure Git Sync 面向已经使用 Git 备份或多端同步 Obsidian vault、但希望更好控制隐私和本地工作流的用户。

插件可以：

- 复用当前 vault 已有的 `.git` 仓库，并导入其中已经配置好的远程仓库。
- 通过界面添加常见 Git 托管平台或通用 SSH/HTTPS 远程仓库。
- 保持本地 vault 文件为普通 Markdown，可直接阅读和编辑。
- 开启加密后，把远程笔记保存为加密对象和加密 manifest。
- 在同一局域网内不经过 Git，直接与另一台设备同步 vault 内容。

## ✅ 功能汇总

- Push、Pull、Sync 前进行密码确认。
- 新配置默认开启远程笔记加密。
- 本地 vault 文件和本地 Git 工作区保持明文。
- 可导入现有 `.git/config` 中的远程仓库，不重写已有 URL。
- 支持 GitHub、GitLab、Gitee、AtomGit、通用 SSH 远程仓库和通用 HTTPS 远程仓库。
- 支持一个 vault 配置多个远程仓库，也支持一个本地 remote 拥有多个 push URL。
- 提供 pull、push、sync、status、冲突查看和冲突解决界面。
- 可选同步 Obsidian 设置。
- 可选同步插件运行时文件，同时排除插件本地状态。
- 支持同 Wi-Fi/局域网设备发现、手动刷新和选择目标设备同步。
- 增量本地变更索引保存在 `.secure-git-sync/index/`。
- 大体积本地缓存从 `data.json` 移出，保存到 `.secure-git-sync/local-cache.json`。
- 加密同步使用同一次远端会话贯穿 pull 和 push，减少重复 fetch 和 manifest 解析。
- 同步后远端一致性校验改为可选，默认不再每次全量校验。
- 批量读取 Git 对象，并用有限并发处理大量笔记。
- 支持分片加密 manifest，并兼容旧版完整 manifest。
- 构建和发布产物统一生成到 `release/`。

## 🌟 插件特别之处

Secure Git Sync 不是托管同步服务，而是一个本地优先的 Obsidian 插件。它使用你自己选择的 Git 远程仓库和本地设备。

核心区别是把“本地可用性”和“远程隐私”分开：

- 本地仍然是普通 Markdown 文件，Obsidian 可以直接读取和编辑。
- 远程可以只保存加密后的笔记对象和加密 manifest。
- Git 只作为远程传输层。
- 局域网同步用于可信本地网络中的设备直连复制。

插件也尽量兼容已有 Git 工作流。如果 vault 已经有 `.git/config`，可以直接导入并复用，不需要插件重新创建远程仓库配置。

## 🛡️ 加密模型

开启加密 Git 同步后，远程仓库使用如下结构：

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

插件使用随机 256-bit vault key 加密笔记内容。管理员密码用于包装这个 vault key。新的 keyring 使用 Argon2id，旧版 PBKDF2-SHA-256 keyring 仍然可以解锁和迁移。

每个笔记对象使用 AES-256-GCM 加密。vault 相对路径会作为附加认证数据，因此密文会绑定到对应路径。

## 📡 局域网同步

局域网同步面向同一 Wi-Fi 或本地网络中的可信设备。

- 默认关闭。
- 不使用 Git。
- 默认不加密传输内容。
- 自动发现附近设备，也支持手动刷新。
- 同步前需要选择目标设备。
- 双向复制更新的文件和缺失文件。
- 暂不传播删除操作，避免误删扩散。

局域网同步会启动本地 HTTP 监听和 UDP 发现监听，所以系统防火墙可能会询问是否允许 Obsidian 在本地网络通信。

## 🏗️ 插件架构

插件主要由以下模块组成：

- `src/main.ts`：Obsidian 插件入口、命令、设置页、弹窗、操作面板、解锁流程、进度显示和局域网控制。
- `src/git.ts`：Git 编排、加密 push/pull/sync、明文兼容、冲突处理、远程导入、manifest 管理和性能缓存。
- `src/lan.ts`：局域网发现、peer HTTP 服务、设备 manifest 对比和直接文件传输。
- `src/crypto.ts`：密码校验、密钥包装、密钥迁移、AES-GCM 加解密和 hash 工具。
- `src/providers.ts`：Git 托管平台 API 集成，用于浏览和创建仓库。
- `src/types.ts`：设置、远程仓库、平台账号、密码配置、同步状态、缓存类型和局域网设置。
- `release/build-release.mjs`：构建和打包脚本。

同步引擎会调用 Git 子进程，但会通过命令白名单和路径校验限制执行范围。Git 只会在 vault 内或插件内部临时/缓存工作区中运行。

## ⚙️ 运行流程

加密同步现在优先使用同一次远端会话：

1. fetch 选中的远程分支到内部 Git 工作区。
2. 读取加密 manifest，优先读取分片 manifest，失败时回退到旧版完整 manifest。
3. 使用本地变更索引和缓存，避免不必要的全量笔记 hash。
4. 对变更笔记使用有限并发进行 hash 和加密。
5. 尽量批量读取变更的远程 blob。
6. 应用 pull 侧变化，并准备 push 侧加密对象。
7. 写入新的 manifest、分片索引和分片。
8. 必要时创建 Git commit 并推送新的加密快照。

高成本检查现在更加可控：

- 未开启同步前确认差异时，会跳过同步前差异检查。
- 同步后远端一致性校验默认关闭，可在需要时手动执行。
- UI 会记录各阶段耗时，方便定位慢的环节。

## 📦 同步范围

加密模式下，笔记以远程加密对象形式保存。选定的 Obsidian 配置仍可继续以明文同步。

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

## 🧪 构建与发布

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

## ![Buy Me a Coffee](assets/buy-me-a-coffee.png) Buy Me a Coffee（目前暂未开放）

如果 Secure Git Sync 对你的 Obsidian 工作流有帮助，下面的支持入口会先预留给后续使用：

- [WeChat Pay](assets/wechat-pay-placeholder.svg)
- [Alipay](assets/alipay-placeholder.svg)

感谢你帮助这个插件持续维护、测试和改进。

## 🤖 自动化

GitHub Actions 发布自动化位于 `.github/workflows/release.yml`。它可以手动触发，也可以通过推送 `x.x.x` 版本标签（例如 `0.2.1`）触发，或者在 `main` 分支插件版本变动后自动触发。Action 会构建发布包，并在 `<manifest.version>` 对应 release 不存在时发布 GitHub Release。
