import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";

type QuickJsRequest = {
  id: string;
  mode?: "eval" | "module";
  source: string;
  modules?: Record<string, string>;
  timeoutMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
};
type WorkerPort = {
  onmessage: ((event: MessageEvent<QuickJsRequest>) => void) | null;
  postMessage(value: unknown): void;
};
const port = self as unknown as WorkerPort;
let quickJsModulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;

function bounded(value: number, fallback: number, min: number, max: number) {
  return Math.max(min, Math.min(Number.isFinite(value) ? value : fallback, max));
}

port.onmessage = async (event) => {
  const request = event.data;
  if (!request || typeof request.id !== "string") return;
  try {
    quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(variant);
    const quickJsModule = await quickJsModulePromise;
    const deadline = performance.now() + bounded(request.timeoutMs, 1000, 50, 5000);
    const memoryLimitBytes = bounded(request.memoryLimitBytes, 64 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
    const maxStackSizeBytes = bounded(request.maxStackSizeBytes, 1024 * 1024, 64 * 1024, 1024 * 1024);

    if (request.mode === "module") {
      const sources = request.modules ?? {};
      const runtime = quickJsModule.newRuntime();
      runtime.setMemoryLimit(memoryLimitBytes);
      runtime.setMaxStackSize(maxStackSizeBytes);
      runtime.setInterruptHandler(() => performance.now() >= deadline);
      runtime.setModuleLoader((name) => {
        if (!Object.prototype.hasOwnProperty.call(sources, name) || typeof sources[name] !== "string") {
          throw new Error(`HPP import is not allowlisted: ${name}`);
        }
        return sources[name];
      });
      const context = runtime.newContext();
      try {
        const result = context.evalCode(request.source, "plugin.js", { type: "module" });
        const exportsHandle = context.unwrapResult(result);
        try {
          port.postMessage({ id: request.id, ok: true, value: context.dump(exportsHandle) });
        } finally {
          exportsHandle.dispose();
        }
      } finally {
        context.dispose();
        runtime.dispose();
      }
      return;
    }

    const value = quickJsModule.evalCode(request.source, {
      memoryLimitBytes,
      maxStackSizeBytes,
      shouldInterrupt: () => performance.now() >= deadline,
    });
    port.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    const e = error as { name?: string; message?: string };
    port.postMessage({ id: request.id, ok: false, error: { name: e?.name || "Error", message: e?.message || String(error) } });
  }
};
