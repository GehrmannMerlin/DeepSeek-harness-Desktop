# 启动性能修复计划

日期：2026-08-15
依据：`docs/debug/startup-root-cause.md`（真实 Boot Timeline 证据）
状态：待执行

---

## 目标

用户双击桌面图标后**立即看到窗口**（窗口壳与本地 splash），后台异步启动 Harness，绝不因首帧/Harness 阻塞窗口显示。First Paint ≠ Harness Ready。

验收（对应 task 第 47–48 节）：
- 双击 → Window visible：热启动尽量 < 500 ms，冷启动尽量 < 1 s。
- Window visible → splash 内容：热启动尽量 < 300 ms（冷启动受 OS/渲染器冷缓存限制，如实记录）。
- 不需要第二次双击；second-instance 只负责唤醒已有窗口。
- Harness 启动慢时 UI 保持 responsive。

---

## 任务 1 — 窗口创建即显示，解耦首帧

- 文件：`src/window/main-window.js`
- 当前：构造 `BrowserWindow({ show: false, … })`；`once('ready-to-show', () => this.win.show())`。窗口可见性 100% 依赖首帧。
- 为什么阻塞：冷启动首帧 ~2.8 s（`startup-root-cause.md` §2），期间窗口不可见。
- 改为：`show: true`（`backgroundColor:'#0f1115'` 已与 splash 背景一致，避免闪白）；删除 `ready-to-show` 里的 `show()`，保留 `ready_to_show` 标记（诊断用，证明首帧何时发生）。
- 验证：冷/热启动 boot.log 中 `window_created` 后立即出现 `window_visible visible=true`，且 `window_visible` 时刻早于 `ready_to_show`。

## 任务 2 — `checkToolchain()` 异步化并后置

- 文件：`src/utils/npx-resolver.js`、`src/lifecycle/app-lifecycle.js`
- 当前：`checkToolchain()` 用 `execFileSync('where', …)` 串行 3 次同步子进程，阻塞 230–330 ms，且在 `_createWindow()` 之前。
- 为什么阻塞：推后窗口创建 230–330 ms。
- 改为：`checkToolchain()` 改为返回 Promise（`execFile` 异步），并发检查三个工具；`app-lifecycle.start()` 先 `_createWindow()` + `loadStarting()` + `_createTray()`，再 `await checkToolchain()`，缺失则 `_showError()`，否则继续 `_boot()`。
- 验证：boot.log 中 `window_created` 出现在 `toolchain_check_finished` 之前；`window_created` 时刻相对 `app_ready` 明显缩短。

## 任务 3 — 移除默认菜单

- 文件：`src/main.js`
- 当前：未设置菜单，Electron 显示默认 File/Edit/View/Window。
- 改为：`app.whenReady()` 内、创建窗口前调用 `Menu.setApplicationMenu(null)`（从 `electron` 引入 `Menu`）。
- 验证：运行后窗口无 File/Edit/View/Window 菜单（人工/截图确认）。

## 任务 4 — 保持/收口 second-instance（不改行为，仅确认无回归）

- 文件：`src/main.js`、`src/lifecycle/app-lifecycle.js`
- 现状已正确：第二实例只 `_showWindow()`（restore/show/focus），不 createWindow/spawn/bootstrap。已存在的 `window==null` 场景：`_showWindow()` 有 `if (this.window)` 守卫。
- 本轮：不加新逻辑，仅在验证阶段确认“第二次双击只唤醒、不重启 Harness”。
- 验证：second-instance 后无第二个 tray / 无第二个 Harness / 无第二个 Electron 主实例。

## 任务 5 — 保持安全边界与生命周期（约束，不改动）

- 维持 `nodeIntegration:false` / `contextIsolation:true` / `sandbox:true`。
- 维持 `disableHardwareAcceleration()` + `disable-gpu-sandbox`（`startup-root-cause.md` §7 结论）。
- 维持 Harness ownership、托盘、close-to-tray、进程树清理、单实例锁。

## 任务 6 — 诊断入口保留（轻量）

- 文件：`src/lifecycle/app-lifecycle.js`（已有 `--splash-only` / `DSH_DESKTOP_SPLASH_ONLY`）
- 保留 `--splash-only`（Minimal Splash Mode，用于区分渲染器与 Harness 问题）。
- 清理：`src/main.js` 中 `DSH_DESKTOP_HW_ACCEL` A/B 开关属于诊断遗留，本计划结论为“维持 HW 加速关闭”，故**还原为无条件 `disableHardwareAcceleration()`**，删除该临时开关。

---

## 不实施（自审排除）

- 不实施 npx Fast Path（`startup-root-cause.md` §6：npx ~3.9 s 发生在窗口已显示之后，不阻塞首帧，YAGNI）。
- 不引入 React/Vue/Vite/Tailwind/数据库/设置页/自动更新。
- 不 `disableHardwareAcceleration()` 之外再改 GPU（不 A/B GPU 开关，见 §7）。
- 不修改 `@deepseek-ai/dsh` 本体。
- 不 `setTimeout`/`sleep`/延长 timeout/重复 spawn/删单实例锁（伪修复）。

---

## 验证顺序

1. `node --check` 改动文件。
2. 局部：`node test/url-detector.test.js`（未改 url-detector，回归确认）。
3. dev：`DSH_DESKTOP_AUTOSHUTDOWN_MS` 冷/热启动，读 boot.log 对比 Before/After。
4. dev：`--splash-only` 验证 Minimal Splash。
5. 构建：`npx electron-builder --dir --config.electronDist=node_modules/electron/dist`（本地 electron 跳过下载）。
6. `dist/win-unpacked/*.exe`：冷/热启动、second-instance、close-to-tray、Harness 冷/已运行/失败。
7. `npm run dist` 出 Setup.exe，安装后仅通过桌面快捷方式启动验证首次双击。
8. 校验 `app.asar` 含最新代码。
