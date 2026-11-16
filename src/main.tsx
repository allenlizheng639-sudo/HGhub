import "./index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store";
import { hostAdapter } from "./host/adapter";

/* 运行期错误统一落到原生 debug.log；普通浏览器环境不具备该能力。 */
function report(kind: string, msg: string) {
  void hostAdapter.invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
