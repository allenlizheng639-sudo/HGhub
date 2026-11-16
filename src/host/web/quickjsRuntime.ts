export interface QuickJsLimits {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
}
export interface QuickJsResult { value: unknown }
export interface QuickJsModuleResult { exports: unknown }
export class QuickJsRuntimeUnavailable extends Error {
  readonly code = "UNSUPPORTED";
  constructor(message: string) { super(message); this.name = "QuickJsRuntimeUnavailable"; }
}

interface WorkerReply {
  id?: string;
  ok?: boolean;
  value?: unknown;
  error?: { message?: string };
}
function runWorker<T>(payload: Record<string, unknown>, limits: QuickJsLimits): Promise<T> {
  if (typeof Worker === "undefined") throw new QuickJsRuntimeUnavailable("当前浏览器不支持 Web Worker");
  const timeoutMs = Math.max(50, Math.min(limits.timeoutMs ?? 1000, 5000));
  const worker = new Worker(new URL("./quickjs.worker.ts", import.meta.url), { type: "module", name: "hghub-quickjs" });
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error); else resolve(value as T);
    };
    const timer = window.setTimeout(() => finish(new Error("QuickJS 执行超时，运行 Worker 已终止")), timeoutMs + 1500);
    worker.onerror = event => finish(new Error(event.message || "QuickJS Worker 启动失败"));
    worker.onmessage = event => {
      const message = event.data as WorkerReply;
      if (message?.id !== id) return;
      if (message.ok) finish(undefined, message.value as T);
      else finish(new Error(message.error?.message || "QuickJS 执行失败"));
    };
    worker.postMessage({
      id, timeoutMs,
      memoryLimitBytes: limits.memoryLimitBytes ?? 64 * 1024 * 1024,
      maxStackSizeBytes: limits.maxStackSizeBytes ?? 1024 * 1024,
      ...payload,
    });
  });
}

/**
 * Isolated QuickJS execution primitives. HPP module imports are supplied as
 * an explicit allowlist; arbitrary remote or browser-host imports are denied.
 * This is not yet the production HPP host bridge.
 */
export async function evaluateQuickJs(source: string, limits: QuickJsLimits = {}): Promise<QuickJsResult> {
  if (typeof source !== "string" || source.length > 2 * 1024 * 1024) {
    throw new TypeError("插件测试代码无效或超过 2 MiB");
  }
  return { value: await runWorker<unknown>({ mode: "eval", source }, limits) };
}

export async function evaluateHppModule(
  source: string,
  modules: Record<string, string> = {},
  limits: QuickJsLimits = {},
): Promise<QuickJsModuleResult> {
  if (typeof source !== "string" || source.length > 2 * 1024 * 1024) {
    throw new TypeError("HPP 模块无效或超过 2 MiB");
  }
  const entries = Object.entries(modules);
  if (entries.length > 64 || entries.some(([name, code]) =>
    !name || name.length > 256 || typeof code !== "string" || code.length > 2 * 1024 * 1024
  )) {
    throw new TypeError("HPP 模块依赖超出允许范围");
  }
  return { exports: await runWorker<unknown>({ mode: "module", source, modules }, limits) };
}
