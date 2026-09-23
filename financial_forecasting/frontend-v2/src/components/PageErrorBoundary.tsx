import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * Catches a render error in the routed page and shows it, instead of letting
 * React unmount the whole tree.
 *
 * Added 2026-09-21 after one bad field on the Outreach tab produced a blank
 * white page across the entire app, with the only diagnosis in the browser
 * console. React's default for an uncaught render error is to unmount
 * everything, and this app had no boundary anywhere — so any one component's
 * bad afternoon took the nav, the shell and every other page with it.
 *
 * Deliberately scoped to the page, inside AppShell, so the nav survives and you
 * can click somewhere else. The error text is on screen on purpose: this is an
 * internal tool, and "Outreach broke because X" is worth more to the five
 * people who use it than a tidy apology.
 *
 * `key` on the boundary is the route path (see AppShell), so navigating away
 * and back resets it without a reload.
 */
interface Props { children: ReactNode }
interface State { error: Error | null }

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack in the console — it names the component that
    // threw, which the on-screen message cannot do compactly.
    console.error("Page render failed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-2xl px-1 py-10">
        <div className="rounded-2xl border border-border-strong bg-surface px-5 py-5">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <AlertTriangle size={15} className="text-red" />
            This page hit an error
          </div>
          <p className="mt-2 text-[12.5px] text-ink-3">
            The rest of the app still works — use the nav to go elsewhere. If this
            started after a code change, a stale backend is the usual cause: restart
            it so the API matches the frontend.
          </p>
          <pre className="mt-3 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-accent hover:text-accent"
          >
            <RotateCw size={12} /> Try again
          </button>
        </div>
      </div>
    );
  }
}
