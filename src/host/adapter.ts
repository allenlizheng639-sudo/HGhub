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
  async invoke<T>(command: string): Promise<T> {
    const error = new Error(
      `当前 Web 版本尚未实现主机能力“${command}”。请等待 Web 服务端与插件沙箱接入。`,
    ) as Error & { code: string };
    error.name = "HostCapabilityUnavailable";
    error.code = "HOST_CAPABILITY_UNAVAILABLE";
    throw error;
  }
}

export const hostAdapter: HostAdapter = isTauri()
  ? new TauriHostAdapter()
  : new WebHostAdapter();

export const isWebHost = hostAdapter.kind === "web";
