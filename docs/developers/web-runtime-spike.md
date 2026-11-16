# Web 插件运行时技术验证

日期：2026-11-16

## 结论

Web 版优先采用 `quickjs-emscripten`（QuickJS 编译为 WebAssembly）作为 HPP 插件解释器候选，而不是把插件源码交给页面主线程的 `eval` / `new Function` 执行。该库提供浏览器与 Web Worker 支持、宿主函数桥接、模块加载控制、内存限制、栈限制和中断回调；项目仍需自行实现 HPP prelude/native bridge，不能把库本身视为完整的 HGhub Web 宿主。

参考：
- https://github.com/justjake/quickjs-emscripten
- https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/README.md
- https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md

## 与现有原生实现的对应关系

| 原生 HPP runtime | Web 侧候选实现 |
|---|---|
| 每个插件运行上下文 | 每个插件独立 QuickJS runtime/context；高风险来源可进一步独立 Worker/WASM module |
| 64 MiB runtime memory limit | `setMemoryLimit(64 * 1024 * 1024)`，并做设备内存压力测试 |
| 1 MiB max stack | `setMaxStackSize(1024 * 1024)` |
| 约 1 秒执行中断 | `setInterruptHandler` 配合 Worker 级 watchdog；超时后 terminate Worker 并销毁 runtime |
| Promise hooks / pending jobs | 明确调度 `executePendingJobs`；桥接 Promise settle 和取消 |
| native bridge | 只注入 HPP 明确允许的 host 函数；网络、存储、Cookie、加密、日志由宿主实现 |
| module loader | 禁止任意文件/网络模块导入，只允许插件包内经校验的模块 |

## 已核查的 HPP bridge 范围

读取当前分支的 `prelude.js`、`native.rs` 和 `network.rs` 后，Web runtime 不能只实现一个 `fetch` 函数。现有宿主接口至少包含以下同步能力：

- 编码：`codec.utf8Encode`、`codec.decodeText`、`codec.base64Encode/Decode`、`codec.hexEncode/Decode`
- 加密：`crypto.randomUUID`、`crypto.randomBytes`、`crypto.digest`、`crypto.hmac`、`crypto.rsaEncrypt`、`crypto.aesEncrypt/Decrypt`
- URL：`url.parse`、`url.set`、`url.queryParse`、`url.queryEncode`
- HTML：`html.parse`、`html.node`（当前原生端基于 dom_query 的文档/节点句柄管理）
- 环境与日志：`env`、`log`

异步 HPP API 还覆盖网络请求、Cookie、插件存储、定时器/休眠、页面 DOM 查询、内容详情/搜索/分类/直播/解析/片库等操作。具体网络请求和存储由插件作用域隔离；Cookie jar 绑定 provider，而不是浏览器全局 Cookie。

因此 Web 版必须把 HPP prelude 的同步 native bridge 与异步 request/response 消息通道一起移植。仅把 Rust 的网络请求换成浏览器 `fetch`，会丢失 provider Cookie 隔离、重定向/目标校验、请求速率、取消和媒体资源会话语义。

## 已提交的隔离执行 spike（2026-11-16）

新增：
- `src/host/web/quickjsRuntime.ts`：每次评估启动独立 Worker，输入长度限制 2 MiB，执行超时后终止 Worker；默认内存限制 64 MiB、栈限制 1 MiB。
- `src/host/web/quickjs.worker.ts`：通过锁定依赖 `quickjs-emscripten@0.32.0` 在独立 Worker 中初始化 QuickJS WASM；不把插件源码放进页面主线程，也不向 QuickJS 暴露 DOM、fetch 或宿主桥接函数。

**依赖集成进展：** 已将 `quickjs-emscripten@0.32.0` 固定到 `package.json`，并通过 GitHub Actions 生成并提交 `pnpm-lock.yaml`。该包的浏览器构建使用内嵌 WASM 的浏览器 ESM 变体，Vite 会将运行时代码打包进 Worker，不依赖第三方 CDN 或手工维护的 vendor wrapper。npm 包说明和 QuickJS API：
- https://www.npmjs.com/package/quickjs-emscripten
- https://www.npmjs.com/package/@jitl/quickjs-singlefile-browser-release-sync
- https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md

当前已接入真实的 `getQuickJS().evalCode()`，并设置内存、栈和中断限制。**仍然只是独立脚本 smoke-test 入口**：尚未在 Safari 真机执行；尚未实现 HPP ES module factory、prelude、Promise/native bridge、插件生命周期或宿主请求代理。不能据此认为现有 HGhub 插件已能运行。

## 必须验证的兼容性风险

1. 现有插件依赖的 JS 语言特性、模块格式、全局对象与 QuickJS WASM 版本是否一致。
2. HPP prelude 是否能在该库的 context API 中逐项复刻，尤其是 Promise hooks、ArrayBuffer/Uint8Array、错误对象与 JSON/二进制传输。
3. 当前 Rust runtime 的中断回调与取消令牌语义，不能仅用 UI 侧超时 Promise 代替；超时后必须能终止正在运行的恶意/死循环代码。
4. 每个插件独立运行时的内存上限、WASM 实例数量和 iPhone Safari 内存占用。
5. Worker 中插件 runtime 与 UI 之间的消息协议、Transferable 二进制数据、取消、请求 ID、deadline 和错误码。
6. HPP 网络请求与资源变换 API 不能直接暴露浏览器任意网络能力；必须经后续受控 Worker API 与媒体会话代理。

## 下一步实现顺序

1. 已增加独立 runtime Worker 并固定 QuickJS WASM 依赖；尚未接入生产 UI。
2. 用固定 fixture 验证同步函数、Promise、模块导入白名单、Uint8Array、RSA/AES 与取消。
3. 加入 64 MiB/1 MiB/1 秒资源限制测试，并验证死循环会导致 Worker 被可靠终止。
4. 对比原生 HPP fixture 测试结果；全部通过后才将 runtime 接入 `pluginCommand` 的 Web host。
5. 在完成上述测试前，Web adapter 继续 fail-closed，不执行不可信插件代码。

## 当前状态

QuickJS WASM 依赖已加入且前端生产构建通过；独立 Worker 的简单脚本执行入口已实现。HPP 插件兼容层、浏览器运行时行为测试和 iPhone Safari 内存/执行测试尚未完成，因此当前仍不是可用的 Web 插件运行时。
