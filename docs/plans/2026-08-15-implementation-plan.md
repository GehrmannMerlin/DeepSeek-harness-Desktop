# DeepSeek Harness Desktop — 实施计划

日期：2026-08-15
状态：Approved Design（产品决策已锁定，本文只补工程实现细节）

---

## 0. 环境侦察结论（实测，非猜测）

| 项 | 值 |
|---|---|
| Node | v24.18.0，`D:\Develop\node.js\node.exe` |
| npm / npx | 11.11.0，shim 位于 `D:\Develop\node.js\`（在**系统 Machine PATH**） |
| `@deepseek-ai/dsh` | `0.1.0-rc.6`，npx 缓存 `_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh` |
| `dsh web` 语义 | `dsh --profile web` |
| 默认监听 | host `127.0.0.1`，**port `3080`**（`cordis.patch.yml` 中 `port: !!js ctx.webStartup.port ?? 3080`；全源码无 `13080`） |
| URL 输出 | stdout 单行 `dsh web: http://127.0.0.1:3080`（由 `dsh-web-app` 打印） |
| 启动耗时 | ~4s（缓存命中），stderr 为空 |
| 进程树 | `node.exe(npx-cli.js)` → `cmd.exe /d /s /c dsh web` → `node.exe(dsh/lib/bin.js web)`，3 层，浅 |
| Harness HTTP 签名 | `200` + `<title>DeepSeek Harness</title>` + `window.__DSH_BOOT__` + `lang="zh-CN"` |
| 树清理 | `taskkill /pid <npx-pid> /T /F` 精确清整棵树，无残留，端口关闭 |
| 图标 | 官方 `@deepseek-ai/dsh-web-frontend/dist/favicon.svg`（黑白鲸鱼 logo，viewBox 50×50） |
| 打包后 PATH | `D:\Develop\node.js` 在 Machine PATH，Explorer 启动的安装版应用可解析 `npx.cmd` |

**关键纠正：端口是 `3080`，不是规格文档里写的 `13080`。** URL 检测以 stdout 为准，fallback 用 `http://127.0.0.1:3080`。

---

## 1. 范围（明确排除）

包含：
- Electron 宿主（启动/等待/加载/窗口/托盘/生命周期/异常恢复/打包）
- 单实例、ownership、进程树清理、日志、启动页/错误页

**不包含**（自审项，禁止混入）：
- 自动更新、数据库、登录、React/Vue/Vite/Webpack/Redux/Pinia
- 后端 Server、工作区管理、DeepSeek UI 重构
- 设置页（Node Path/Port/Provider/Model/Theme/Workspace/Agent）
- 捆绑 Node runtime、vendor `@deepseek-ai/dsh`
- 复杂 IPC、Event Bus、DI 容器、Repository/Service 套娃

---

## 2. 架构

```
Electron Main (src/main.js，仅装配)
 ├─ AppLifecycle (lifecycle/app-lifecycle.js)   —— 编排启动/退出/崩溃恢复/单实例
 ├─ HarnessProcessManager (process/)            —— 唯一 spawn/stop/restart/状态机/ownership
 │    └─ ProcessTree (process/process-tree.js)  —— taskkill 定向树清理
 ├─ HarnessHealthChecker (health/)              —— HTTP 轮询 + Harness 签名校验
 ├─ MainWindow (window/)                        —— BrowserWindow 安全配置 + loadURL + hide
 ├─ TrayManager (tray/)                         —— 托盘 + 动态菜单 + 左键显示
 └─ utils: logger / paths / url-detector / npx-resolver / harness-probe
```

数据流：`main.js` 只 `new` 各 Manager 并注入 `lifecycle`；跨模块通过**少量回调/事件**通信，不建 IPC/总线。

---

## 3. 文件与模块职责

### 3.1 `src/process/harness-process-manager.js`
- 状态机：`STOPPED / STARTING / WAITING_FOR_SERVER / RUNNING / STOPPING / FAILED / CRASHED`
- `start()`：`cmd.exe /d /s /c npx @deepseek-ai/dsh web`，`windowsHide:true`，`stdio: pipe`；stdout→url-detector + harness.log；stderr→harness.log；记录 PID
- `stop()`：先 `taskkill /pid /T`（graceful，2s 等待），超时 `taskkill /T /F`
- `restart()`：`stop()` 完成后 `start()`
- `getStatus() / isRunning() / ownsHarness() / getUrl() / getPid()`
- 事件：`status-change`、`url-detected`、`line`、`exit`、`error`
- 唯一 owner：`ownership = 'owned' | 'external'`；只有 `owned` 才允许在退出时清理

### 3.2 `src/process/process-tree.js`
- `killTree(pid, {force})`：`taskkill /pid <pid> /T [/F]`，返回 killed 列表
- `isAlive(pid)`：`process.kill(pid, 0)` + Windows 兜底
- 安全红线：只操作传入 PID 的树，绝不 `taskkill /IM node.exe`

### 3.3 `src/utils/url-detector.js`（纯函数，可测）
- `detectUrl(line)`：正则匹配 `http://127.0.0.1:\d+` / `http://localhost:\d+`（优先 `dsh web:` 前缀）
- `DEFAULT_URL = 'http://127.0.0.1:3080'`
- 输入：stdout 一行；输出：URL 或 null

### 3.4 `src/utils/npx-resolver.js`
- `resolveCommand()` → `{ command: 'cmd.exe', args: ['/d','/s','/c','npx','@deepseek-ai/dsh','web'] }`
- `checkToolchain()`：验证 node/npm/npx 存在（`where`），缺失返回具体中文错误
- 记录实际解析结果到日志（打包后 PATH 验证用）

### 3.5 `src/health/harness-health-checker.js`
- `check(url)`：HTTP GET（1.5s timeout）→ `{ status, isHarness, error }`；`isHarness` 靠 `window.__DSH_BOOT__` 或 `<title>DeepSeek Harness</title>`
- `waitUntilReady(url, {interval=800, timeout=45000})`：轮询直到 `isHarness`
- `probe(port)`：探测默认端口 → `'harness' | 'foreign' | 'free'`（用于复用/占用判断）

### 3.6 `src/window/main-window.js`
- `new BrowserWindow({ webPreferences: { nodeIntegration:false, contextIsolation:true, sandbox:true }, icon })`
- `loadStarting()` → `renderer/starting.html`；`loadHarness(url)` → `loadURL(url)`
- `close` 事件：非退出阶段 `preventDefault()` + `hide()`
- `show() / focus() / toggleVisibility()`
- `will-navigate`/`setWindowOpenHandler`：外部链接 `shell.openExternal`，禁止窗口内打开外站

### 3.7 `src/tray/tray-manager.js`
- `Tray(icon)`，菜单：`打开 / 隐藏窗口`、`Agent：<动态状态>`（禁用项只读）、`重新启动 Agent`、`在浏览器中打开`、`退出`
- 左键单击 → `show/focus`
- `setStatus(state)` 刷新动态状态项；`onRestart` / `onQuit` 回调注入

### 3.8 `src/lifecycle/app-lifecycle.js`
- `requestSingleInstanceLock()`；`second-instance` → restore+show+focus
- 启动编排：`probe(3080)` → `harness`→复用(external) / `free`→spawn(owned)→waitUntilReady / `foreign`→错误页
- 退出编排：`isQuitting=true` → stop owned → 销毁 tray/window → `app.quit()`
- 崩溃恢复：`exit` 非预期 → `CRASHED` → 托盘标 `已停止` + 错误页（带"重启"按钮走托盘重启，不建 IPC）

### 3.9 `src/utils/logger.js` / `paths.js`
- `paths.js`：`userData`、`logsDir`、`assetsDir`（dev/打包兼容）、`rendererDir`
- `logger.js`：`application.log`（app 事件）+ `harness.log`（harness stdout/stderr），时间戳行，创建目录，单例

### 3.10 `src/main.js`
- `app.whenReady()` 内：初始化 logger/paths → new 各 Manager → 注入 lifecycle → 启动流程
- 不直接 spawn / 不做 health check / 不拼 tray menu

---

## 4. 状态机

```
STOPPED → STARTING → WAITING_FOR_SERVER → RUNNING
STARTING → FAILED（spawn/启动失败）
RUNNING  → CRASHED（非预期 exit）
RUNNING  → STOPPING → STOPPED（正常 stop）
FAILED/CRASHED → STARTING（用户手动 restart）
```

UI（启动页/托盘）只读 `getStatus()`，不在多处维护 `isRunning/ready/alive`。

---

## 5. 进程生命周期（谁创建/拥有/停止）

- **创建**：仅 `HarnessProcessManager.start()`
- **拥有**：`ownership === 'owned'` 表示本 Desktop spawn；`'external'` 表示复用了启动前已存在的 Harness
- **停止**：仅 `HarnessProcessManager.stop()`（内部 `process-tree.killTree`）
- **何时不能停止**：`ownership !== 'owned'` 时退出流程不触碰外部 Harness

---

## 6. 退出闭环（真正退出）

```
isQuitting = true
→ 若 owned：stop()（graceful→force），等待 exit
→ 清理进程树
→ destroy tray / window
→ app.quit()
```

---

## 7. Windows 打包（electron-builder）

- `appId: com.deepseek.harness.desktop`，`productName: DeepSeek Harness Desktop`
- `win.target: nsis`，`nsis: oneClick:false, createDesktopShortcut:true, createStartMenuShortcut:true, shortcutName: DeepSeek Harness`
- `icon: assets/icon.ico`；`files: src/** renderer/** assets/** package.json`
- 输出 `dist/DeepSeek Harness Desktop Setup <version>.exe`
- 安装后：桌面快捷方式 + 开始菜单，双击即启动；不依赖源码目录

---

## 8. 图标

- 复制官方 `favicon.svg` → `assets/source/favicon.svg`
- `scripts/generate-icons.js`：sharp（SVG→PNG，替换 fill 为品牌蓝 `#4D6BFE`）+ png-to-ico 生成 `icon.ico`（16/32/48/256）、`icon.png`(256)、`tray.png`(32)
- 来源：官方 `@deepseek-ai/dsh-web-frontend/dist/favicon.svg`，几何形状不改，仅上官方品牌色保证托盘/任务栏可见

---

## 9. 实施步骤（每步可验证）

1. **Skeleton**：npm init、安装 electron/electron-builder/sharp/png-to-ico、`.gitignore`、目录骨架 → `electron .` 能弹出空窗口
2. **Utils**：logger/paths/url-detector/npx-resolver → 单测 url-detector
3. **Process Manager + Process Tree**：spawn/stop/restart/状态机 → 真实 dsh 启停
4. **Health Checker**：check/waitUntilReady/probe → 对真实 dsh 轮询成功
5. **Window**：starting.html + loadURL + close→hide
6. **Tray**：菜单 + 动态状态 + 左键
7. **Lifecycle + 单实例 + ownership**：启动编排 + 退出编排
8. **错误页 + 崩溃处理**：error.html + FAILED/CRASHED 展示
9. **图标**：复制 favicon → 生成 ico/png
10. **electron-builder 打包**：产出 Setup.exe
11. **安装版真机验证**：从桌面快捷方式启动，全套 smoke test
12. **熵减 + 幽灵进程检查 + 最终验收**

---

## 10. 验证清单（关键路径 smoke test）

| Case | 预期 |
|---|---|
| 1 未运行→双击 | 自动启动 dsh→Ready→页面出现 |
| 2 点 × | 窗口消失，托盘在，Harness 在 |
| 3 点托盘 | 窗口重现 |
| 4 托盘"重新启动 Agent" | 停 owned→重启→re-ready |
| 5 托盘"退出" | Electron/托盘/owned Harness 全消失 |
| 6 手工先起 dsh→再起 Desktop | 复用外部 Harness；退出不杀外部 |
| 7 双击两次 | 单 Electron/单托盘/至多一个 owned Harness |
| 8 安装 Setup.exe→桌面快捷方式启动 | 与 dev 模式行为一致 |
