type Request = { id: string; moduleUrl: string; source: string; timeoutMs: number; memoryLimitBytes: number; maxStackSizeBytes: number };
type WorkerPort = { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(value: unknown): void };
const port = self as unknown as WorkerPort;

port.onmessage = async (event) => {
  const request = event.data;
  if (!request || typeof request.id !== "string") return;
  try {
    const url = new URL(request.moduleUrl, self.location.href);
    if (url.origin !== self.location.origin || url.protocol !== self.location.protocol) {
      throw new Error("QuickJS 模块必须从当前站点同源加载");
    }
    // The module is a pinned, same-origin build asset. Plugin source never runs
    // in this worker's JavaScript realm; it is evaluated by QuickJS WASM.
    const quickJsModule = await import(/* @vite-ignore */ url.href) as {
      getQuickJS: () => Promise<{ evalCode: (source: string, options: {
        memoryLimitBytes: number;
        maxStackSizeBytes: number;
        shouldInterrupt: () => boolean;
      }) => unknown }>;
    };
    const quickjs = await quickJsModule.getQuickJS();
    const deadline = performance.now() + Math.max(50, Math.min(request.timeoutMs, 5000));
    const value = quickjs.evalCode(request.source, {
      memoryLimitBytes: Math.max(1024 * 1024, Math.min(request.memoryLimitBytes, 64 * 1024 * 1024)),
      maxStackSizeBytes: Math.max(64 * 1024, Math.min(request.maxStackSizeBytes, 1024 * 1024)),
      shouldInterrupt: () => performance.now() >= deadline,
    });
    port.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    const e = error as { name?: string; message?: string };
    port.postMessage({ id: request.id, ok: false, error: { name: e?.name || "Error", message: e?.message || String(error) } });
  }
};
