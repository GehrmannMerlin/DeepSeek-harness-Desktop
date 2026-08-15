# DeepSeek Harness Desktop

<div align="center">

**把 DeepSeek Harness（`npx @deepseek-ai/dsh web`）封装成 Windows 桌面应用的 Electron 宿主程序。**

一键启动、系统托盘常驻、进程生命周期管理、打包成安装程序 —— 不需要命令行，双击图标即可使用。

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/GehrmannMerlin/DeepSeek-harness-Desktop)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](#)
[![Electron](https://img.shields.io/badge/electron-%5E43.4.0-47848F)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933)](#)

</div>

---

## ✨ 这是什么？

**DeepSeek Harness Desktop** 是一个 Windows 桌面宿主程序。它**不修改、不重写** DeepSeek Harness 本身，只在外面套一层 Electron 桌面外壳：

- 启动时自动在后台运行 `npx @deepseek-ai/dsh web`
- 等待 Harness 就绪后，自动在窗口中加载页面
- 管理窗口 / 系统托盘 / 进程生命周期
- 打包成 NSIS 一键安装程序

你只需要双击桌面图标，剩下的交给它。

---

## 🚀 特性

- 🚀 **一键启动**：双击图标，自动拉起 Harness，无需打开命令行手动执行 `npx`。
- 📋 **系统托盘常驻**：点窗口右上角 `×` 不是退出，而是最小化到托盘；托盘菜单提供「打开 / 隐藏窗口」「重新启动 Agent」「在浏览器中打开」「退出」。
- 🔁 **单实例锁**：重复双击只会唤醒已有窗口，不会启动第二份 Harness 或第二个托盘图标。
- ♻️ **复用已运行的 Harness**：若 `127.0.0.1:3080` 上已经有一个 Harness，直接复用，退出时**不会**误杀它。
- 🧹 **精准进程清理**：只清理自己 `spawn` 出来的进程树（`taskkill /pid <pid> /T`），绝不 `taskkill /IM node.exe`，避免误杀其它 Node 程序。
- 🔍 **智能就绪检测**：通过 HTTP 签名（`<title>DeepSeek Harness</title>` + `window.__DSH_BOOT__`）判断端口上跑的到底是不是真正的 Harness，而不是「端口开了就算数」。
- 🖥️ **启动页 + 错误页**：本地 splash 页面实时显示启动状态；环境缺失 / 端口被占用 / 启动超时都有清晰的中文错误提示。
- ⚡ **启动优化**：热启动窗口可见 < 500ms；冷启动也通过 fallback 保证窗口壳在 ~1s 出现（内容随后绘制）。
- 📊 **启动时间线诊断**：内置轻量 Boot Timeline，精确记录从进程启动到窗口可见、Harness 就绪的每个毫秒级节点。
- 🔒 **默认安全配置**：`nodeIntegration:false` + `contextIsolation:true`，渲染器只加载本地内容（`file://` splash + `localhost` Harness）。

---

## 📦 安装

1. 下载最新安装包 `DeepSeek Harness Desktop Setup <版本>.exe`（见 [Releases](../../releases)）。
2. 双击运行安装向导（NSIS，可选安装目录）。
3. 安装完成后，桌面与开始菜单会生成「DeepSeek Harness」快捷方式。

> **前置要求**：本机已安装 [Node.js](https://nodejs.org/)（含 `npm` / `npx`），且 `npx` 在系统 PATH 中。
> 程序本身不捆绑 Node 运行时，运行时会调用系统里的 `npx`。

---

## 🎯 使用方式

| 操作 | 行为 |
|---|---|
| 双击桌面图标 | 显示启动页，后台拉起 Harness，就绪后自动打开 |
| 点窗口右上角 `×` | 缩小到系统托盘（**不是退出**） |
| 左键单击 / 双击托盘图标 | 显示窗口 |
| 托盘 →「重新启动 Agent」 | 停止并重新拉起 Harness |
| 托盘 →「在浏览器中打开」 | 用系统默认浏览器打开当前 Harness 地址 |
| 托盘 →「退出」 | 真正退出，并清理自己启动的 Harness 进程 |

---

## ⚙️ 工作原理与关键行为

- **端口**：DeepSeek Harness Web 默认监听 `127.0.0.1:3080`（**不是** `13080`）。桌面端从 stdout 解析实际 URL，仅当解析不到时才回退到 `3080`。
- **启动时序**：先显示窗口（本地 splash），再在后台异步检查环境并拉起 Harness —— `First Paint ≠ Harness Ready`，窗口显示不等待 Harness 就绪。
- **URL 检测**：解析 dsh 输出的 `dsh web: http://127.0.0.1:3080` 这一行，兼容 `127.0.0.1` / `localhost`。
- **复用 vs 独占**：启动时探测 `3080`，区分三种状态 —— 真 Harness（复用）、被别的程序占用（报错）、空闲（拉起新进程）。只有自己 spawn 的进程会在退出时被清理。
- **进程清理**：`taskkill /pid <pid> /T`（定向整树清理），先优雅停止，1.5s 后仍在则强杀，最多等 6s。
- **日志**：位于 `%APPDATA%\deepseek-harness-desktop\logs\`，包含 `application.log`（应用日志）、`harness.log`（Harness stdout/stderr）、`boot.log`（启动时间线）。

---

## 🏗️ 架构

```
Electron Main (src/main.js，仅装配)
 ├─ AppLifecycle (lifecycle/)                 —— 编排启动/退出/崩溃恢复/单实例
 ├─ HarnessProcessManager (process/)          —— 唯一 spawn/stop/restart + 状态机 + ownership
 │    └─ ProcessTree (process/process-tree.js) —— taskkill 定向树清理
 ├─ HarnessHealthChecker (health/)            —— HTTP 轮询 + Harness 签名校验
 ├─ MainWindow (window/)                      —— BrowserWindow 安全配置 + 页面切换 + hide-on-close
 ├─ TrayManager (tray/)                       —— 托盘 + 动态菜单
 └─ utils/                                    —— logger / paths / url-detector / npx-resolver / boot-timeline
```

设计原则：`main.js` 只做装配，各 Manager 各司其职；跨模块通过少量回调 / 事件通信，不引入 IPC 总线、DI 容器或状态库。

完整启动流程：

```
双击图标
  → 单实例锁（重复启动仅唤醒已有窗口）
  → Electron Ready → 移除默认菜单
  → 创建 BrowserWindow (show:false, 深色背景)
  → 后台：异步 checkToolchain（node/npm/npx 是否存在）
  → loadFile(starting.html)（本地 splash）
  → ready-to-show（首帧）→ show()        ← 正常路径
  → 或 did-finish-load + 300ms → show()   ← 冷启动 fallback
  ═════════ 用户已看到窗口 ═════════
  → 异步 probe(3080)
      ├─ 已有 Harness → 复用(external) → loadURL
      └─ 无 → spawn npx @deepseek-ai/dsh web → waitUntilReady → loadURL
  → DeepSeek Harness UI
```

---

## 📁 目录结构

```
├── src/                                 # 主进程源码
│   ├── main.js                          # 装配入口（轻量）
│   ├── process/
│   │   ├── harness-process-manager.js   # 唯一 spawn/stop/restart + 状态机 + ownership
│   │   └── process-tree.js              # taskkill 定向树清理
│   ├── health/
│   │   └── harness-health-checker.js    # HTTP 轮询 + Harness 签名校验
│   ├── window/
│   │   └── main-window.js               # BrowserWindow + 显示时序 + hide-on-close
│   ├── tray/
│   │   └── tray-manager.js              # 系统托盘 + 动态菜单
│   ├── lifecycle/
│   │   └── app-lifecycle.js             # 启动/退出/崩溃恢复编排
│   └── utils/                           # logger / paths / url-detector / npx-resolver / boot-timeline
├── renderer/                            # 启动页 + 错误页 (HTML/CSS)
├── assets/                              # icon.ico / icon.png / tray.png / source/favicon.svg
├── scripts/generate-icons.js            # 图标生成
├── docs/                                # 设计文档、调试报告、性能报告
├── test/                                # 单元测试
├── electron-builder.yml                 # 打包配置（NSIS）
└── package.json
```

---

## 🖥️ 环境要求

| 依赖 | 要求 |
|---|---|
| 操作系统 | Windows |
| Node.js | ≥ 18（本机实测 v24.18.0），含 `npm` / `npx`，且在系统 PATH 中 |
| 网络 | 首次运行需通过 `npx` 拉取 `@deepseek-ai/dsh` |

---

## 🧰 开发

```bash
npm install                 # 安装依赖（含 electron）
npm run icons               # 从官方 favicon.svg 生成 ico/png
npm start                   # 开发模式运行
npm run dist                # 打包 Windows 安装程序（NSIS）
```

打包产物在 `dist/`，安装程序为 NSIS 一键安装，含桌面与开始菜单快捷方式。

---

## 🔍 故障排查（FAQ）

| 现象 | 原因 | 解决 |
|---|---|---|
| 首次启动提示「未找到必要的运行环境」 | 缺少 Node.js / npm / npx，或不在 PATH | 安装 Node.js 并确认 `npx` 在系统 PATH 中 |
| 提示「端口 3080 已被其他程序占用」 | 3080 上跑的进程不是 Harness | 关闭占用该端口的程序，或托盘「重新启动 Agent」 |
| 提示「启动超时」 | Harness 未在 45s 内就绪 | 检查网络（首次需拉取 dsh），再点「重新启动 Agent」 |
| 提示「启动后意外退出」 | dsh 进程启动后崩溃 | 查看 `%APPDATA%\deepseek-harness-desktop\logs\harness.log` |
| 找不到日志 | 日志在用户目录下 | 打开 `%APPDATA%\deepseek-harness-desktop\logs\` |

---

## 📝 更新日志（Changelog）

> **更新规范**：每次发布新版本时，在下方**最顶部**新增一个 `## [x.y.z] - YYYY-MM-DD` 区块，用下面三个小节记录改动：
> - `✨ 新增功能` —— 本次新增的能力 / 特性
> - `🐛 修复 Bug` —— 本次修复的问题
> - `🔧 其他` —— 性能优化、依赖升级、文档等
>
> 版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)（`主.次.修订`），格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。日常开发可先把改动写进顶部的 `[Unreleased]` 区块，发布时再归并到具体版本号。

## [Unreleased]

### ✨ 新增功能

### 🐛 修复 Bug

### 🔧 其他

---

## [1.0.0] - 2026-08-16

首个发布版本。

### ✨ 新增功能

- Electron 桌面宿主：自动启动 `npx @deepseek-ai/dsh web`、等待就绪、加载页面。
- 系统托盘：动态菜单（打开 / 隐藏窗口、Agent 状态、重新启动 Agent、在浏览器打开、退出）。
- 启动页（splash）+ 错误页，启动状态实时更新，环境缺失 / 端口占用 / 超时均有清晰中文提示。
- 单实例锁：重复双击仅唤醒已有窗口，不重复启动。
- 复用已运行的 Harness（external ownership，退出不误杀）。
- 启动时间线诊断（Boot Timeline，写入 `boot.log` 并镜像到 `application.log`）。
- NSIS 一键安装包（含桌面 / 开始菜单快捷方式）。
- 图标自动生成脚本（从官方 favicon.svg 生成 ico/png）。

### 🐛 修复 Bug

- 修复 Windows 11 25H2 下安装目录渲染器崩溃导致的**整块黑屏**：`sandbox:false`（保留 `nodeIntegration:false` + `contextIsolation:true` 作为主隔离边界）。
- 修复**首次双击图标无窗口**：窗口可见性不再被首帧锁死，新增页面加载完成后 300ms fallback。
- 修复**需要第二次双击才出现窗口**：随上一条修复消除，二次启动退化为纯唤醒。
- 修复 `checkToolchain()` 同步阻塞主进程 230–330ms 的问题：改为异步并后置到窗口创建之后。
- 移除默认的 File/Edit/View/Window 菜单。

### 🔧 其他

- 冷启动首帧仍受环境因素影响约 2–3s（渲染器冷启动 + Windows Defender 首次扫描 + 软件渲染冷编译），已用 fallback 让窗口壳提前出现，内容随后绘制。
- 补充调试与性能报告文档（`docs/debug/`、`docs/performance/`）。

---

## 🛡️ 安全说明

- 渲染器进程始终 `nodeIntegration:false` + `contextIsolation:true`，无 preload，无远程导航。
- 渲染器只加载本地内容（`file://` splash + `localhost` Harness）；外部链接一律交给系统默认浏览器。
- 进程清理仅针对自己 `spawn` 的进程树，绝不 `taskkill /IM node.exe`。

> 注：为修复 Win11 25H2 安装目录下的渲染器崩溃，渲染器启用了 `sandbox:false`（正确性修复，非性能优化）。上述 `nodeIntegration:false` + `contextIsolation:true` 仍是主要隔离边界，详见 `docs/debug/startup-root-cause.md`。

---

## 📄 许可证

[MIT](LICENSE) © GehrmannMerlin

本项目只是 DeepSeek Harness 的桌面宿主，DeepSeek Harness 及其图标版权归其各自所有者所有。
