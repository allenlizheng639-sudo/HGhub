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
