import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { clearLocalData } from "./local";
const queryClient = new QueryClient();

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

/* Last-resort backstop (audit 2026-11-17): if anything in the tree
   throws during render, the app used to white-screen with no way back.
   This catches it and offers a reload, plus clearing the local data
   (likes, analysis, deletions) and reloading — the local data is the
   usual suspect when stored state goes bad. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "48px 24px", fontFamily: "system-ui, sans-serif", textAlign: "center", color: "#111" }}>
          <p style={{ fontSize: 17, fontWeight: 600 }}>页面遇到问题，打不开了。</p>
          <p style={{ fontSize: 14, color: "#666", marginTop: 8 }}>可以先重新加载试试；如果还是打不开，清除本页的本地数据再重载（喜欢和删除记录会丢失）。</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 20 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ padding: "10px 20px", borderRadius: 999, border: "1px solid #ddd", background: "#fff", fontSize: 15 }}
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                clearLocalData();
                window.location.reload();
              }}
              style={{ padding: "10px 20px", borderRadius: 999, border: "1px solid #ddd", background: "#111", color: "#fff", fontSize: 15 }}
            >
              清除本地数据并重载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
