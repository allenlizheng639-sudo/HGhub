export interface QuickJsLimits {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  moduleUrl?: string;
}
export interface QuickJsResult { value: unknown }
export class QuickJsRuntimeUnavailable extends Error {
  readonly code = "UNSUPPORTED";
  constructor(message: string) { super(message); this.name = "QuickJsRuntimeUnavailable"; }
}

/**
 * Small isolated runtime spike. Every evaluation gets a fresh Worker and a
 * fresh QuickJS evaluation context. This is deliberately not wired into HPP
 * pluginCommand until module semantics and the native bridge are ported.
 */
export async function evaluateQuickJs(source: string, limits: QuickJsLimits = {}): Promise<QuickJsResult> {
  if (typeof Worker === "undefined") throw new QuickJsRuntimeUnavailable("当前浏览器不支持 Web Worker");
  if (typeof source !== "string" || source.length > 2 * 1024 * 1024) {
    throw new TypeError("插件测试代码无效或超过 2 MiB");
  }
  const moduleUrl = limits.moduleUrl || `${import.meta.env.BASE_URL}vendor/quickjs-emscripten.mjs`;
  const resolved = new URL(moduleUrl, window.location.href);
  if (resolved.origin !== window.location.origin) {
    throw new QuickJsRuntimeUnavailable("QuickJS WASM 必须从当前站点同源加载");
  }
  const timeoutMs = Math.max(50, Math.min(limits.timeoutMs ?? 1000, 5000));
  const worker = new Worker(new URL("./quickjs.worker.ts", import.meta.url), { type: "module", name: "hghub-quickjs-spike" });
  const id = crypto.randomUUID();
  return await new Promise<QuickJsResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error); else resolve({ value });
    };
    const timer = window.setTimeout(() => finish(new Error("QuickJS 执行超时，运行 Worker 已终止")), timeoutMs + 1500);
    worker.onerror = event => finish(new Error(event.message || "QuickJS Worker 启动失败"));
    worker.onmessage = event => {
      const message = event.data as { id?: string; ok?: boolean; value?: unknown; error?: { message?: string } };
      if (message?.id !== id) return;
      if (message.ok) finish(undefined, message.value);
      else finish(new Error(message.error?.message || "QuickJS 执行失败"));
    };
    worker.postMessage({
      id, moduleUrl: resolved.href, source, timeoutMs,
      memoryLimitBytes: limits.memoryLimitBytes ?? 64 * 1024 * 1024,
      maxStackSizeBytes: limits.maxStackSizeBytes ?? 1024 * 1024,
    });
  });
}
