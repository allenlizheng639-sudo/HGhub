import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";

type QuickJsRequest = {
  id: string;
  source: string;
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

port.onmessage = async (event) => {
  const request = event.data;
  if (!request || typeof request.id !== "string") return;
  try {
    // Explicit browser single-file variant embeds WASM bytes in this worker bundle.
    // This avoids resolving a separate .wasm URL relative to the app's route.
    quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(variant);
    const quickJsModule = await quickJsModulePromise;
    const deadline = performance.now() + Math.max(50, Math.min(request.timeoutMs, 5000));
    const value = quickJsModule.evalCode(request.source, {
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
