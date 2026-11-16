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
- `src/host/web/quickjs.worker.ts`：只允许从当前站点同源地址加载 QuickJS 模块，在 WASM QuickJS 中执行源码；不把插件源码放进页面主线程，也不向 QuickJS 暴露 DOM、fetch 或宿主桥接函数。

**部署前置条件：** 当前代码默认从 `<BASE_URL>/vendor/quickjs-emscripten.mjs` 加载一个同源 ESM wrapper。该 wrapper 需要由锁定版本的 QuickJS 包构建，导出 `getQuickJS()`；建议基于 `quickjs-emscripten@0.32.0` 的 RELEASE_SYNC 变体，构建时将 WASM 单文件变体一起打包，避免运行时依赖第三方 CDN。相关包与版本见 npm 官方说明：
- https://www.npmjs.com/package/quickjs-emscripten
- https://www.npmjs.com/package/@jitl/quickjs-singlefile-browser-release-sync

目前该 vendored wrapper 尚未加入仓库，因此 spike 不能在真实页面中启动；也没有把它接入 HPP 插件系统。它目前只覆盖“在隔离 Worker 内用 QuickJS 执行简单脚本”的验证入口，尚不支持 HPP ES module factory、prelude、Promise/native bridge 或插件生命周期。需要先固定并纳入 WASM 依赖，再通过 CI 和 Safari 真机测试验证。

## 必须验证的兼容性风险

1. 现有插件依赖的 JS 语言特性、模块格式、全局对象与 QuickJS WASM 版本是否一致。
2. HPP prelude 是否能在该库的 context API 中逐项复刻，尤其是 Promise hooks、ArrayBuffer/Uint8Array、错误对象与 JSON/二进制传输。
3. 当前 Rust runtime 的中断回调与取消令牌语义，不能仅用 UI 侧超时 Promise 代替；超时后必须能终止正在运行的恶意/死循环代码。
4. 每个插件独立运行时的内存上限、WASM 实例数量和 iPhone Safari 内存占用。
5. Worker 中插件 runtime 与 UI 之间的消息协议、Transferable 二进制数据、取消、请求 ID、deadline 和错误码。
6. HPP 网络请求与资源变换 API 不能直接暴露浏览器任意网络能力；必须经后续受控 Worker API 与媒体会话代理。

## 下一步实现顺序

1. 增加独立的 runtime spike package / Worker，不接入生产 UI。
2. 用固定 fixture 验证同步函数、Promise、模块导入白名单、Uint8Array、RSA/AES 与取消。
3. 加入 64 MiB/1 MiB/1 秒资源限制测试，并验证死循环会导致 Worker 被可靠终止。
4. 对比原生 HPP fixture 测试结果；全部通过后才将 runtime 接入 `pluginCommand` 的 Web host。
5. 在完成上述测试前，Web adapter 继续 fail-closed，不执行不可信插件代码。

## 当前状态

这是技术选型和验证清单，不是已经实现的 Web 插件运行时。仓库尚未添加 QuickJS WASM 依赖，也没有完成插件执行或 iPhone Safari 内存测试。
