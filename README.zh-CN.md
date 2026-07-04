# Secure Git Sync

Secure Git Sync 是一个 Obsidian 桌面端插件，用于在推送、拉取和同步 Git 仓库前进行密码确认，并可选择只对远端笔记快照加密。

[English README](README.md)

## 中文描述

Secure Git Sync 让本地 Obsidian 仓库保持可读，同时把远端 Git 仓库中的笔记内容保存为加密快照。插件直接使用当前库目录的 `.git` 仓库，支持常见 Git 托管平台和自建 Git 远端，并在 push、pull、sync 前要求输入主管理员密码。

## 功能亮点

- 在 Obsidian 左侧 ribbon 面板中执行 Push、Pull、Sync 和 Status。
- 支持 GitHub、GitLab、Gitee、AtomGit，以及通用/自建 Git 远端。
- 可配置多个远端，但仍共用当前库的单个 `.git` 仓库。
- 可选的笔记远端加密模式。
- 本地库文件和本地 Git 历史保持明文。
- 新 keyring 默认使用 Argon2id 包装密钥，旧 PBKDF2 keyring 仍可解锁并迁移。
- 使用 AES-256-GCM 加密笔记对象和加密 manifest。
- `.obsidian/` 设置以明文同步，插件本地状态和开发文件不参与同步。
- 冲突副本、插件状态、临时烟测目录和依赖目录不参与同步或源码跟踪。
- 内置中英文界面文本，默认文档语言为英文。

## 加密模型

开启加密后，远端仓库使用如下布局：

```text
.obsidian/                    # 明文 Obsidian 设置
.secure-git-sync/
  manifest.enc                # 加密的路径到对象映射
  keyring.json                # 可选的密码包裹 vault key
  objects/
    ab/<object-id>.enc        # 加密笔记对象
```

插件使用随机 256-bit vault key 加密笔记数据。新 keyring 使用 Argon2id 从主管理员密码派生包装密钥。旧 PBKDF2-SHA-256 keyring 仍能解锁，并会在成功解锁后重包为 Argon2id。

远端笔记对象使用 AES-256-GCM 加密，库相对路径作为附加认证数据，因此密文会绑定到对应路径。

## 同步范围

源码仓库只跟踪开发文件。根目录的 `main.js` 属于本地构建产物，已被 Git 忽略，不应提交。发布产物统一生成到 `release/` 目录。

运行时插件文件为：

- `manifest.json`
- `main.js`
- `styles.css`

当插件在不同库之间同步插件文件时，只同步运行时产物，不同步 `data.json`、依赖目录、源码、release 目录或构建配置。

冲突副本文件不会参与笔记同步、`.obsidian` 同步、插件同步或 Git 暂存。插件自己的冲突管理目录保持为本地目录。

## 开发

```bash
npm install
npm run build
```

`npm run build` 会在根目录生成用于本地测试的 `main.js` bundle，该文件已被 Git 忽略。

## 发布

构建本地发布包：

```bash
npm run release
```

生成内容：

```text
release/secure-git-sync-<version>/
  manifest.json
  main.js
  styles.css
release/secure-git-sync-<version>.zip
release/secure-git-sync-<version>.sha256
```

GitHub Actions 发布自动化位于 `.github/workflows/release.yml`。它可手动触发，也可由 `x.x.x` 版本标签（例如 `0.1.2`）触发，或在 `main` 分支插件版本变动后自动触发。Action 会构建发布包，并在 `<manifest.version>` 对应 release 不存在时发布 GitHub Release。

## 安装

只复制运行时文件到：

```text
<vault>/.obsidian/plugins/secure-git-sync/
```

然后在 Obsidian 中启用插件。
