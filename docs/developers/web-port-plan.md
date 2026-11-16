# HGhubX Web 迁移实施计划

> 状态：阶段 A 前端边界改造进行中。此文档不是已完成的 Web 版，也不代表 Pages 或 Worker 已部署。

## 目标

在不改动 `main` 的前提下，将现有 React 前端迁移为可在 iPhone Safari 使用的 Web 应用；尽量保留 HPP 插件协议、来源管理、搜索/分类、详情、直播/图文和媒体播放能力。

## 已核实的架构事实

- 前端入口为 `src/main.tsx`，应用由 `AppProvider` 与 `HostProvider` 启动。
- `src/plugins/client.ts` 将所有插件命令直接交给 Tauri `invoke("hpp_manage")`，并在首次请求前调用 `host.media.configure`。
- `src/store.tsx` 也直接调用 Tauri 命令（`app_boot`、`security_set`）。
- 插件执行不是普通浏览器 JavaScript 调用：`src-tauri/crates/hpp/src/runtime.rs` 使用 rquickjs，设置 64 MiB 内存上限、1 MiB 栈上限、执行时间中断和取消令牌。
- `src-tauri/crates/hpp/src/media.rs` 建立本机 loopback HTTP 媒体代理，负责资源归属、请求头、变换、HLS 资源登记、会话取消和资源生命周期。
- 因此，仅将 Vite 的 `dist` 发布到 GitHub Pages 会得到无法正常启动插件宿主的前端；仅提供一个 Worker `/health` 路由也不能提供插件执行或播放能力。

## Web 版目标架构

1. **静态前端（GitHub Pages）**：复用 React UI；增加 Web Host 适配层，替代 Tauri IPC；本地偏好与轻量数据使用 IndexedDB。
2. **插件运行时**：优先评估将 QuickJS 编译为 WASM，并在独立 Worker/隔离执行上下文中运行；保留内存、栈、执行时限、取消、插件 API allow-list 和版本隔离。禁止直接对不可信插件源码使用页面上下文的 `eval` 或 `new Function`。
3. **网络服务（Cloudflare Worker）**：只承担受控请求转发、会话签发、限流、CORS、配额和必要的媒体资源路由；不能接受任意 URL 的开放代理。对目标域名、DNS 解析结果、重定向目标、协议、端口、响应体大小和请求速率做服务端校验，阻断内网/环回/链路本地地址。
4. **媒体播放**：浏览器端使用原生 Safari HLS 能力优先，必要时使用 hls.js；代理需支持 Range、HLS playlist/segment/key、请求头、AES 资源变换、字幕、会话过期与取消。媒体会话 URL 不应暴露上游凭据或密钥。
5. **持久化**：插件包、设置、登录态和片库需要明确区分本地与服务端数据；敏感登录态不写入 URL 或公开仓库。

## 实施顺序与验收门槛

### 阶段 A：宿主边界
- 列出所有 Tauri IPC 命令及其调用页面。
- 定义统一 `HostAdapter` 接口与 Web/Tauri 两个实现。
- Web 模式下不得静默吞掉缺失能力；所有不支持命令返回标准 `UNSUPPORTED` 错误。
- 验收：Web 构建可通过类型检查；启动、设置、插件列表错误态可解释；原生 Tauri 构建不回归。

### 阶段 B：插件运行时
- 评估并实现 QuickJS WASM 构建；验证模块导入、Promise、ArrayBuffer、RSA/AES、取消和内存/时间限制。
- 为 Web 网络、Cookie、存储、加密和日志实现受控 native bridge。
- 验收：使用仓库 fixtures 运行插件协议测试；不加载任意远程脚本到主页面。

### 阶段 C：后端与媒体
- 实现有认证的 Worker API；为每个用户/浏览器会话签发短期凭证。
- 实现安全的上游网络适配和媒体资源会话；禁止开放代理和任意内网访问。
- 验收：请求头/Cookie 隔离、重定向与 SSRF 测试、Range/HLS/取消/过期测试全部通过。

### 阶段 D：界面与 Safari
- 接入插件导入、启用、设置、搜索、分类、详情、登录、片库和播放。
- 验收：iPhone Safari 真机测试至少覆盖 MP4、HLS、线路切换、续播、后台/前台、全屏和网络中断恢复。

### 阶段 E：部署
- 只有 A-D 的必要验收通过后，才启用 GitHub Pages 部署。
- Worker 单独部署并设置允许的 Pages Origin；密钥只存 Cloudflare Secrets，不写入 Git。
- Pages 地址、Worker 健康检查、实际插件请求与实际播放均验证后，才宣布可用。

## 当前阻塞

本仓库的 Tauri IPC 和 Rust/QuickJS 宿主没有可直接复用的浏览器实现。Cloudflare Worker 的默认 Hello World 也不是后端。下一项实际工程工作是阶段 A：梳理并抽象前端 IPC 边界；在完成该适配前，不应发布一个会误导用户的“可用”Pages 地址。

## Implementation log

### First HostAdapter pass (2026-11-16)

- Added `src/host/adapter.ts` with an explicit Tauri adapter and a fail-closed browser adapter.
- Routed plugin IPC, application startup/security settings, external-link opening, desktop exit, and orientation requests through the adapter.
- Added a branch-scoped frontend build workflow at `.github/workflows/web-port-build.yml`.
- The browser adapter intentionally reports `HOST_CAPABILITY_UNAVAILABLE`; this is a migration boundary, not a functioning Web backend.
- No Web plugin execution, persistent plugin storage, authenticated command API, media proxy, or Pages deployment is implemented yet.
- Build status: not verified in this environment. The new GitHub Actions workflow has been committed, but no run result has been observed yet.

Next: finish the remaining Tauri-only import/command audit and native regression check. The QuickJS WASM candidate and the native bridge operation inventory are documented in [web-runtime-spike.md](./web-runtime-spike.md); implement that spike as an isolated test harness before connecting it to the application. The browser host API, Worker, media proxy, and Pages deployment remain blocked until their security and compatibility tests pass.

### Host boundary follow-up (2026-11-16)

- Routed startup diagnostics through `HostAdapter`; browser mode no longer attempts the native debug-log command.
- Browser mode now skips native `app_boot` security initialization and reports that server-side security settings are not yet available rather than calling a missing native command.
- Android back-button listener loading is now lazy and guarded by `hostAdapter.kind === "tauri"`; Safari no longer imports or initializes the Tauri app listener. The browser back action also no longer attempts to exit a native app.
- Web host now implements safe browser-native `open_url` (HTTP/HTTPS only, new window detached from opener) and bounded console diagnostics; unsupported native commands report the protocol-level `UNSUPPORTED` code.
- Added an isolated QuickJS worker spike (`src/host/web/quickjsRuntime.ts` + `quickjs.worker.ts`): fresh Worker per evaluation, same-origin runtime-module restriction, bounded source size, 64 MiB memory / 1 MiB stack defaults, deadline interrupt, and parent-side Worker termination watchdog. This is not yet connected to HPP and requires a same-origin `vendor/quickjs-emscripten.mjs` wrapper built from a pinned WASM package.
- GitHub Actions run for commit `404de3252c1369a13994378be068137c5bb1ef81`: **success** (`pnpm install --frozen-lockfile` and `pnpm build`).
- This is still a frontend compatibility milestone only. The full IPC call-site audit, native build regression check, Web plugin runtime, Worker API, media proxy, and Safari playback validation remain outstanding.

### Frontend build verification

- GitHub Actions run for commit `2f1dd82038346cb0b430f1b9716da1709f7b204e`: **success**.
- `pnpm install --frozen-lockfile` and `pnpm build` both completed successfully.
- This verifies TypeScript compilation and the existing Vite production bundle only; it does not verify browser host features, plugin execution, or media playback.
- The first CI attempt exposed two missed `invoke` call sites and two existing implicit-event typing errors. Those were corrected, and the latest run is green.
