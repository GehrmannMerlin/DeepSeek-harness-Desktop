# DeepSeek Harness Desktop

一个把 DeepSeek Harness（`npx @deepseek-ai/dsh web`）包装成 Windows 桌面应用的 Electron 宿主程序。

它**不修改、不重写** DeepSeek Harness，只在外面套一层桌面外壳：启动 Harness、等待就绪、加载页面、管理窗口/托盘/进程生命周期、打包成安装程序。

## 使用方式

1. 安装 `dist/DeepSeek Harness Desktop Setup <版本>.exe`。
2. 双击桌面上的「DeepSeek Harness」图标。
3. 首次会显示启动页，自动在后台运行 `npx @deepseek-ai/dsh web`，就绪后自动打开 Harness。
4. 点窗口右上角 × 是**缩小到系统托盘**，不是退出。
5. 从托盘菜单可「打开 / 隐藏窗口」「重新启动 Agent」「在浏览器中打开」，以及「退出」。
6. 真正退出请用托盘菜单的「退出」，会一并清理它自己启动的 Harness 进程。

## 开发

```bash
npm install                 # 安装依赖（含 electron）
npm run icons               # 从官方 favicon.svg 生成 ico/png
npm start                   # 开发模式运行
npm run dist                # 打包 Windows 安装程序（NSIS）
```

打包产物在 `dist/`，安装程序为 NSIS 一键安装，含桌面快捷方式与开始菜单快捷方式。

## 环境要求

- Windows
- 本机已安装 Node.js（含 npm/npx），且 `npx` 在系统 PATH 中（本机为 `D:\Develop\node.js`）

## 关键行为

- **端口**：DeepSeek Harness Web 默认监听 `127.0.0.1:3080`（非 13080）。桌面端通过 stdout 解析实际 URL，仅当解析不到时才回退到 3080。
- **复用已有 Harness**：启动时若发现 3080 上已有 Harness，则直接复用（不会启动第二份），且退出时不会关闭它。
- **进程清理**：只清理自己 spawn 的进程树（`taskkill /pid <pid> /T`），绝不 `taskkill /IM node.exe`，避免误杀其它 Node 程序。
- **日志**：位于 `%APPDATA%\deepseek-harness-desktop\logs\`（`application.log` 与 `harness.log`）。

## 目录结构

```
src/
  main.js                          # 装配入口（轻量）
  process/harness-process-manager.js  # 唯一 spawn/stop/restart + 状态机 + ownership
  process/process-tree.js          # taskkill 定向树清理
  health/harness-health-checker.js # HTTP 轮询 + Harness 签名校验
  window/main-window.js            # BrowserWindow + close->hide
  tray/tray-manager.js             # 托盘 + 动态菜单
  lifecycle/app-lifecycle.js       # 启动/退出/崩溃编排
  utils/                           # logger / paths / url-detector / npx-resolver
renderer/                          # 启动页 + 错误页 (HTML/CSS)
assets/                            # icon.ico / icon.png / tray.png / source/favicon.svg
scripts/generate-icons.js          # 图标生成
```
