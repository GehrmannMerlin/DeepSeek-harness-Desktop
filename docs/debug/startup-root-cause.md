# DeepSeek Harness Desktop — 启动问题根因报告

日期：2026-08-15
状态：证据已完成（含安装版复现 + A/B），本文陈述测量结论与最终根因。

---

## 0. 方法

1. 通读源码，新增轻量 `BootTimeline`（`src/utils/boot-timeline.js`），以 `process_start` 为 T0。
2. 在 main / lifecycle / window / process-manager / health-checker / splash renderer 埋点。
3. 用 `--splash-only`、`DSH_DESKTOP_AUTOSHUTDOWN_MS` 做自动收尾；对 HW 加速、show 时序、sandbox 做 A/B。
4. 实测 dev（`npm start`）、打包版（`dist/win-unpacked/*.exe`）、安装版（`D:\soft\DeepSeek Harness Desktop\*.exe`）。

---

## 1. 三个症状与最终根因（一句话）

| 症状 | 最终根因 | 修复 |
|---|---|---|
| A 第一次双击无窗口 | 窗口可见性被 `ready-to-show`（首帧）锁死，冷启动首帧 ~2.8s | show 后加载 fallback |
| B 第二次双击才出现 | `second-instance → focus() → show()` 强制显示被锁死的窗口 | 由 A 的修复消除 |
| C 窗口黑屏 | **渲染器进程在安装目录崩溃**（STATUS_BREAKPOINT），非 show 时序 | `sandbox:false` |

---

## 2. Symptom A — 第一次双击无窗口

**根因：`show:false` + `once('ready-to-show', show)` 把窗口可见性与渲染器首帧绑定。**

证据（冷启动，dev，HW off）：
- `splash_did_finish_load` 834ms，`splash_first-frame` 2775ms，中间 **1941ms 空白**。
- `window_visible` 2786ms ≈ `ready_to_show` 2776ms，证明显示完全被首帧卡住。

热启动 ready-to-show 441–647ms（窗口随之 453–666ms）；冷启动 2776ms。冷启动额外 ~2.2s 来自渲染器进程冷启动 / Defender 扫描 / 软件渲染冷编译，属环境因素。

## 3. Symptom B — 第二次双击才出现

**根因：second-instance 强制显示被 A 卡住的窗口。**

`main.js::second-instance → lifecycle._showWindow() → window.focus() → show()`，与首帧无关。实测 second-instance 触发该路径（`second_instance_received → window_show_called → window_visible`）。A 修复后，首次点击即正确显示，second-instance 退化为纯唤醒。

## 4. Symptom C — 黑屏（真实根因：渲染器沙箱崩溃）

**根因：Windows 11 25H2 下，`sandbox:true` 的渲染器进程在安装目录崩溃，STATUS_BREAKPOINT（0x80000003）。**

决定性证据（文件 MD5 完全相同，仅安装位置不同）：

| 位置 | 结果 |
|---|---|
| `D:\Develop\...\dist\win-unpacked` | 正常：splash 首帧 ~300ms，`splash_paint_verified {"hidden":false,...,"rAF":N}` |
| `D:\soft\DeepSeek Harness Desktop`（安装目录） | 崩溃：`render_process_gone reason=crashed exitCode=-2147483645`（=0x80000003），无首帧、无 paint |

两者 ACL 差异：`D:\soft` 带有 `S-1-15-3-…`（AppContainer capability SID）与 `NT AUTHORITY\RESTRICTED`；`dist\win-unpacked` 为普通 `Users FullControl`。即 Electron 43 在 Win11 25H2 把渲染器放入 AppContainer(LPAC) 沙箱，安装目录 ACL 缺少匹配 capability ACE 时，渲染器读不到自身 DLL 而崩溃 → 整块黑屏。

这也是用户原始“黑屏”的真实成因：原版 `sandbox:true` + 安装于 `D:\soft`。原 `disable-gpu-sandbox` 只修了 GPU 进程，未覆盖渲染器。

**验证**：`sandbox:false` 后，`D:\soft` 安装版正常绘制（首帧 303ms，`splash_paint_verified {"hidden":false,"logo":true,"rAF":3}`，harness UI 4056ms，无崩溃）。`--disable-features=RendererAppContainer` 试过无效。

**安全说明**：保留 `nodeIntegration:false` + `contextIsolation:true` 作为主隔离边界；渲染器只加载本地内容（file:// splash + localhost harness），无 preload、无远程导航。`sandbox:false` 是正确性修复，非性能优化。

## 5. 一个重要的反面结论：show 立即显示不可行

`show:true`（或 `show:false` + 立即 `show()`）会让渲染器卡在 `document.hidden=true`，rAF 不触发、不产帧 → 黑屏（HW 开/关均复现）。因此**不能**用“立即显示”解耦首帧；只能用 `show:false` + `ready-to-show`，外加**页面加载后**的 fallback（实测该 fallback 显示后 `document.hidden=false`，安全）。

## 6. 次要问题

- `checkToolchain()` 同步 `where node/npm/npx` 阻塞 230–330ms 且在 `_createWindow()` 之前 → 改为异步并后置。
- 默认 File/Edit/View/Window 菜单 → `Menu.setApplicationMenu(null)`。

## 7. npx / DSH Profiling

| 阶段 | 实测 |
|---|---:|
| spawn → 首个 stdout 字节（npx 解析 + dsh 启动到打印 URL） | ≈ 3.0–4.0 s |
| URL → 健康检查通过 | ≈ 100 ms |
| 就绪 → Harness UI 加载完成 | ≈ 500–650 ms |

npx+dsh 占 ~3–4s，但发生在窗口已显示 splash 之后（正确架构下不阻塞首帧），不实施 npx Fast Path（YAGNI）。

## 8. 修复清单（已实施）

1. `sandbox:false`（主因 C 修复）。
2. `show:false` + `ready-to-show` + `did-finish-load` 后 300ms fallback（A 修复）。
3. `checkToolchain()` 异步化并后置（次要）。
4. `Menu.setApplicationMenu(null)`（次要）。
5. 保留 `disable-gpu-sandbox` + `disableHardwareAcceleration`、单实例、托盘、ownership、进程树清理不变。
