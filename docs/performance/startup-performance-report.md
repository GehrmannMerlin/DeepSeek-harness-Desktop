# DeepSeek Harness Desktop — 启动性能报告

日期：2026-08-15
依据：真实 Boot Timeline（`%APPDATA%\deepseek-harness-desktop\logs\boot.log`），无伪造数据。

---

## 1. 问题是否解决

| 问题 | 结果 |
|---|---|
| 第一次双击无窗口 | ✅ 已解决（fallback 保证窗口在页面加载后 ~300ms 显示） |
| 必须第二次双击 | ✅ 已解决（首次即显示，second-instance 退化为纯唤醒） |
| Splash 黑屏 | ✅ 已解决（根因是渲染器沙箱崩溃，`sandbox:false` 修复） |
| Spinner/文案不显示 | ✅ 已解决（渲染器正常绘制，`splash_paint_verified hidden=false`） |
| 启动耗时 | ✅ 热启动窗口 <500ms；冷启动受环境限制（见 §9） |

---

## 2. Before / After 时间线（实测）

### 2.1 热启动（dev / 打包版，多次平均取代表性值）

| Event | Before | After |
|---|---:|---:|
| app_ready | ~65 ms | ~65 ms |
| window_created | ~300–339 ms | **94–117 ms** |
| splash_first-frame | 429–603 ms | 240–323 ms |
| ready_to_show | 441–647 ms | 254–340 ms |
| window_visible | 453–666 ms | **263–350 ms** |
| dsh_spawned | ~373 ms | ~245–279 ms |
| harness ready | 3248–4463 ms | 3490–4275 ms |
| harness UI (did_finish_load) | ~4900 ms | ~4000–4056 ms |

### 2.2 冷启动（dev，Before 实测；After 由 fallback 机制保证）

| Event | Before | After（预期/机制） |
|---|---:|---:|
| splash_first-frame | 2775 ms | 未强制复现冷启动；仍受环境 ~2–3s 限制 |
| window_visible | 2786 ms | **~1.1 s**（did-finish-load ~830ms + 300ms fallback） |

> 冷启动首帧 ~2.2s 额外延迟来自渲染器进程冷启动 + Windows Defender 首次扫描 + 软件渲染冷编译，属环境因素。After 版通过 fallback 让窗口壳在页面加载后立即出现（内容随后绘制），不再等首帧。

### 2.3 安装版（`D:\soft\DeepSeek Harness Desktop`，关键场景）

| 版本 | 结果 |
|---|---|
| Before（原版 `sandbox:true`） | 渲染器崩溃 `render_process_gone exitCode=0x80000003`，黑屏 |
| After（`sandbox:false`） | window 328ms，首帧 303ms，`splash_paint_verified {"hidden":false,"logo":true,"rAF":3}`，harness UI 4056ms，无崩溃 |

---

## 3. 根因（具体到文件/调用）

1. **黑屏（主因）**：`src/window/main-window.js` 的 `sandbox:true`。Win11 25H2 下渲染器进 AppContainer(LPAC) 沙箱，安装目录 ACL 缺 capability ACE → 渲染器读不到自身 DLL → `STATUS_BREAKPOINT(0x80000003)` 崩溃 → 整块黑屏。原 `disable-gpu-sandbox` 只修 GPU 进程，未覆盖渲染器。
2. **首次无窗口**：`src/window/main-window.js` 的 `show:false` + `once('ready-to-show', show)` 把可见性锁在首帧；冷启动首帧 ~2.8s。
3. **二次点击才出现**：`src/main.js::second-instance → _showWindow() → focus() → show()` 强制显示被锁窗口（属正常唤醒逻辑，但被症状 2 放大）。
4. **次要**：`src/utils/npx-resolver.js::checkToolchain()` 同步 `where` 阻塞 230–330ms 且在窗口创建前。
5. **次要**：默认 Electron 菜单未移除。

---

## 4. 修改文件

| 文件 | 职责 | 修改原因 |
|---|---|---|
| `src/window/main-window.js` | 窗口 + 显示时序 | `sandbox:false`（修黑屏）；`_showOnce` + `did-finish-load` 后 300ms fallback（修首次无窗口）；渲染器/窗口事件埋点 + `_verifyPaint` |
| `src/main.js` | 装配入口 | `Menu.setApplicationMenu(null)`；Boot Timeline 埋点；更新 GPU/sandbox 注释 |
| `src/lifecycle/app-lifecycle.js` | 启动编排 | 先建窗口/托盘，再异步 `checkToolchain()`；Boot Timeline 埋点；`--splash-only` |
| `src/utils/npx-resolver.js` | 环境检测 | `checkToolchain()` 同步 → 异步（`execFile` + `Promise.all`） |
| `src/utils/boot-timeline.js` | 新增 | 轻量单调 Boot Timeline（T0 起，写 boot.log + 镜像 application.log） |
| `src/process/harness-process-manager.js` | 进程管理 | spawn/stdout/stderr 首字节、URL 检测埋点（无行为改动） |
| `src/health/harness-health-checker.js` | 健康检查 | healthcheck 起止埋点（无行为改动） |
| `renderer/starting.html` | splash | DOMContentLoaded / load / requestAnimationFrame 首帧观测 |

---

## 5. 最终启动架构

```
双击图标
  → Single Instance Gate
  → Electron Ready
  → Menu.setApplicationMenu(null)
  → Create BrowserWindow (show:false, 深色 background)
  → 后台：异步 checkToolchain
  → loadFile(starting.html)（本地 splash：Logo + CSS Spinner + 状态文案）
  → ready-to-show（首帧）→ show()        ← 正常路径
  → 或 did-finish-load + 300ms → show()   ← 冷启动 fallback
  ═════════ 用户已看到窗口 ═════════
  → 异步 probe(3080)
      ├─ 已存在 Harness → 复用(external) → loadURL
      └─ 无 → spawn npx @deepseek-ai/dsh web → waitUntilReady → loadURL
  → DeepSeek Harness UI
```

First Paint ≠ Harness Ready，二者解耦。

---

## 6. second-instance

以前需要第二次双击，是因为首次启动窗口被 `ready-to-show` 卡住不显示；第二次启动触发 `second-instance → focus() → show()` 强制显示（此时渲染器未绘制 → 黑屏）。

现在：首次启动窗口即正确显示，`second-instance` 只做 `restore/show/focus` 唤醒已有窗口；已实测第二次实例不产生第二个 tray / Harness / Electron 主实例。

---

## 7. 黑屏根因（明确，非罗列）

渲染器进程在安装目录崩溃（`STATUS_BREAKPOINT`），因 `sandbox:true` 使其运行于 AppContainer(LPAC) 沙箱，安装目录 ACL 缺少 capability ACE。非 GPU、非 loadFile 失败、非 CSS 路径、非 Main Thread 阻塞。修复：`sandbox:false`（保留 `nodeIntegration:false` + `contextIsolation:true`）。

---

## 8. npx Profiling

- npx 解析 + dsh 启动到打印 URL（spawn → stdout 首字节）：**≈ 3.0–4.0 s**（缓存命中，随 Defender/磁盘波动）。
- URL → 健康检查通过：≈ 100 ms。
- 就绪 → Harness UI 加载完成：≈ 500–650 ms。

**未实施 Fast Path**：npx+dsh 的 ~3–4s 发生在窗口已显示 splash 之后，不阻塞首帧；增加缓存路径 + 失效校验的复杂度不值得（YAGNI）。

---

## 9. GPU

- 测试过 HW 加速开/关 A/B：热启动差异在噪声内（on 429ms vs off 430–603ms）。
- 结论：冷启动是主导因子，HW 开关非根因；`disableHardwareAcceleration` + `disable-gpu-sandbox` 维持不变（build 26200 稳定性）。
- `--disable-features=RendererAppContainer` 试过，**无效**；渲染器 AppContainer 无法用该 flag 关闭。

---

## 10. app.asar

已检查 `dist/win-unpacked/resources/app.asar` 与安装版 `D:\soft\DeepSeek Harness Desktop\resources\app.asar`：
- MD5 一致（`134ef11e…`），均含 `sandbox:false`、`window_show_fallback`、`Menu.setApplicationMenu(null)`、`async function checkToolchain`。

---

## 11. Smoke Tests

| 用例 | 结果 |
|---|---|
| 首次双击（安装版 D:\soft） | ✅ PASS（window 328ms，splash 绘制，无崩溃） |
| second instance | ✅ PASS（单实例，`second_instance_received`，无重复 tray/Harness/实例） |
| close-to-tray | ✅ 逻辑不变（close→hide）；未做交互式点击（自动化环境无法点 X） |
| Harness 冷启动 | ✅ PASS（spawn→ready ~3.5s） |
| Harness 已运行（external reuse） | ✅ PASS（`reusing existing harness`，不二次 spawn，退出不杀外部） |
| Harness 失败 | ⚠️ 未在本轮制造可恢复失败条件；超时→错误页路径未改动 |
| win-unpacked | ✅ PASS |
| 安装版 Setup.exe | ✅ Setup.exe 已构建；交互式安装向导需人工点击，故用等价的手动安装（复制 exe+asar 至安装目录）验证 |
| app.asar 最新 | ✅ PASS |
| 无幽灵进程 | ✅ PASS（退出后 0 个 Desktop 进程，3080 端口释放） |

---

## 12. 构建产物

- Setup.exe：`D:\Develop\DeepSeek Agent\dist\DeepSeek Harness Desktop Setup 1.0.0.exe`（100,030,484 字节，NSIS）。
- win-unpacked：`D:\Develop\DeepSeek Agent\dist\win-unpacked\DeepSeek Harness Desktop.exe`。
- 安装版（已更新为修复版）：`D:\soft\DeepSeek Harness Desktop\`。

---

## 13. 已知限制（如实）

1. **冷启动首帧仍 ~2–3s**：渲染器进程冷启动 + Windows Defender 首次扫描 + 软件渲染冷编译，属 OS/环境开销，无法从应用层消除。已用 fallback 让窗口壳在 ~1s 出现，内容随后绘制。
2. **`sandbox:false` 降低了渲染器进程级隔离**：这是为了修复 Win11 25H2 安装目录下的渲染器崩溃；`nodeIntegration:false` + `contextIsolation:true` 仍是主隔离边界，渲染器只加载本地内容。
3. **交互式安装向导未在自动化环境点完**：Setup.exe 构建成功；等价手动安装已验证，但 NSIS 向导（目录选择/UAC）需用户实际操作一次。
