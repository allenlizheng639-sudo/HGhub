import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";

/**
 * Host boundary for capabilities that are not available in a normal browser.
 *
 * The browser implementation intentionally fails closed until the authenticated
 * Worker + isolated plugin runtime are implemented. It must never silently
 * pretend that native storage, file picking, or plugin execution succeeded.
 */
export interface HostAdapter {
  readonly kind: "tauri" | "web";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

class TauriHostAdapter implements HostAdapter {
  readonly kind = "tauri" as const;
  invoke<T>(command: string, args: Record<string, unknown> = {}) {
    return tauriInvoke<T>(command, args);
  }
}

class WebHostAdapter implements HostAdapter {
  readonly kind = "web" as const;
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    // These two capabilities have safe browser-native equivalents and do not
    // require access to the privileged plugin host.
    if (command === "debug_log") {
      console.debug("[HGhub]", typeof args.msg === "string" ? args.msg.slice(0, 2048) : "");
      return undefined as T;
    }
    if (command === "open_url") {
      if (typeof args.url !== "string") throw new Error("外部链接无效");
      let target: URL;
      try { target = new URL(args.url); } catch { throw new Error("外部链接无效"); }
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error("只允许打开 HTTP 或 HTTPS 链接");
      }
      const opened = window.open(target.href, "_blank", "noopener,noreferrer");
      if (!opened) throw new Error("浏览器阻止了新窗口，请允许打开外部链接");
      return undefined as T;
    }
    const error = new Error(
      `当前 Web 版本尚未实现主机能力“${command}”。请等待 Web 服务端与插件沙箱接入。`,
    ) as Error & { code: string };
    error.name = "HostCapabilityUnavailable";
    error.code = "UNSUPPORTED";
    throw error;
  }
}

export const hostAdapter: HostAdapter = isTauri()
  ? new TauriHostAdapter()
  : new WebHostAdapter();

export const isWebHost = hostAdapter.kind === "web";
