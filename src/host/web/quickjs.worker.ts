import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import hppPrelude from "../../src-tauri/crates/hpp/src/prelude.js?raw";

type QuickJsRequest = {
  id: string;
  mode?: "eval" | "module" | "hpp-install";
  config?: { meta: Record<string, unknown>; settings?: Record<string, unknown>; endpoint?: unknown; media?: unknown };
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

function resolveModuleSource(sources: Record<string, string>, name: string): string {
  const normalized = name.replace(/^\.\//, "");
  const source = sources[name] ?? sources[normalized] ?? sources["./" + normalized];
  if (typeof source !== "string") throw new Error("HPP import is not allowlisted: " + name);
  return source;
}
function unpackTransfer(value: any): any {
  if (!value || typeof value !== "object" || typeof value.t !== "string") throw new Error("Invalid HPP transfer value");
  switch (value.t) {
    case "null": return null;
    case "bool": case "number": case "string": return value.v;
    case "bytes": return new Uint8Array(value.v);
    case "array": return value.v.map(unpackTransfer);
    case "object": return Object.fromEntries(Object.entries(value.v).map(([key, child]) => [key, unpackTransfer(child)]));
    default: throw new Error("Unknown HPP transfer type");
  }
}
function packTransfer(value: any): any {
  if (value === null || value === undefined) return { t: "null" };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "string") return { t: "string", v: value };
  if (typeof value === "number" && Number.isFinite(value)) return { t: "number", v: value };
  if (value instanceof Uint8Array) return { t: "bytes", v: Array.from(value) };
  if (Array.isArray(value)) return { t: "array", v: value.map(packTransfer) };
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return { t: "object", v: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, packTransfer(child)])) };
  }
  throw new Error("Unsupported HPP transfer value");
}
function runHppInstall(quickJsModule: any, request: QuickJsRequest, memoryLimitBytes: number, maxStackSizeBytes: number, deadline: number) {
  const runtime = quickJsModule.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(maxStackSizeBytes);
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  runtime.setModuleLoader((name: string) => {
    return resolveModuleSource(request.modules ?? {}, name);
  });
  const context = runtime.newContext();
  try {
    const sync = context.newFunction("__hppSync", (opHandle: any, rawHandle: any) => {
      const op = context.getString(opHandle);
      const params = unpackTransfer(JSON.parse(context.getString(rawHandle)));
      let value: unknown = null;
      if (op === "env") value = { platform: "web" };
      else if (op === "log") {
        const level = ["debug", "info", "warn", "error"].includes(params.level) ? params.level : "info";
        console[level as "debug" | "info" | "warn" | "error"](String(params.text ?? "").slice(0, 2048));
      } else {
        return context.newString(JSON.stringify({ ok: false, error: { code: "UNSUPPORTED", message: "Web HPP sync operation not implemented: " + op } }));
      }
      return context.newString(JSON.stringify({ ok: true, value: packTransfer(value) }));
    });
    context.setProp(context.global, "__hppSync", sync);
    sync.dispose();
    const send = context.newFunction("__hppSend", () => undefined);
    context.setProp(context.global, "__hppSend", send);
    send.dispose();
    const finish = context.newFunction("__hppFinish", () => undefined);
    context.setProp(context.global, "__hppFinish", finish);
    finish.dispose();

    const preludeSource = "globalThis.__hppApi = " + hppPrelude.trim().replace(/;\\s*$/, "");
    const preludeResult = context.evalCode(preludeSource, "prelude.js", { type: "global" });
    if (preludeResult.error) throw context.dump(preludeResult.error);
    preludeResult.value.dispose();

    const moduleResult = context.evalCode(request.source, "plugin.js", { type: "module" });
    const exportsHandle = context.unwrapResult(moduleResult);
    try {
      const factory = context.getProp(exportsHandle, "default");
      const metaHandle = context.getProp(exportsHandle, "meta");
      const api = context.getProp(context.global, "__hppApi");
      const install = context.getProp(api, "install");
      const config = context.newString(JSON.stringify({
        meta: request.config?.meta ?? {},
        settings: request.config?.settings ?? {},
        endpoint: request.config?.endpoint ?? null,
        media: request.config?.media ?? {},
      }));
      try {
        const installResult = context.callFunction(install, api, [factory, config]);
        const promise = context.unwrapResult(installResult);
        try {
          let state = context.getPromiseState(promise);
          for (let i = 0; i < 256 && state.type === "pending"; i++) {
            runtime.executePendingJobs();
            state = context.getPromiseState(promise);
          }
          if (state.type === "pending") throw new Error("HPP factory install did not settle");
          if (state.type === "rejected") throw new Error(String(context.dump(state.error)));
          return { meta: context.dump(metaHandle), methods: JSON.parse(String(context.dump(state.value))) };
        } finally {
          promise.dispose();
        }
      } finally {
        factory.dispose(); metaHandle.dispose(); api.dispose(); install.dispose(); config.dispose();
      }
    } finally {
      exportsHandle.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

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

    if (request.mode === "hpp-install") {
      const value = runHppInstall(quickJsModule, request, memoryLimitBytes, maxStackSizeBytes, deadline);
      port.postMessage({ id: request.id, ok: true, value });
      return;
    }
    if (request.mode === "module") {
      const sources = request.modules ?? {};
      const runtime = quickJsModule.newRuntime();
      runtime.setMemoryLimit(memoryLimitBytes);
      runtime.setMaxStackSize(maxStackSizeBytes);
      runtime.setInterruptHandler(() => performance.now() >= deadline);
      runtime.setModuleLoader((name) => {
        return resolveModuleSource(sources, name);
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
