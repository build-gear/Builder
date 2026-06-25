import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { redactSensitiveText, truncateText } from "./redaction.js";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error?: Error;
  details?: string;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      error,
      details: safeErrorDetails(error)
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Builder Gear render failure", {
      message: errorDisplayMessage(error),
      componentStack: safeErrorDetails(info.componentStack) ?? "Component stack unavailable"
    });
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const message = errorDisplayMessage(this.state.error);

    return (
      <main className="app-shell recovery-shell">
        <section className="recovery-panel" role="alert">
          <div className="recovery-icon" aria-hidden="true">
            <AlertTriangle size={22} />
          </div>
          <div className="recovery-copy">
            <span>Runtime recovery</span>
            <h1>Builder Gear hit a UI fault.</h1>
            <p>{message}</p>
          </div>
          <div className="recovery-actions">
            <button type="button" onClick={reloadApp}>
              <RotateCcw size={16} />
              Reload
            </button>
            <button type="button" className="danger" onClick={resetLocalStateAndReload}>
              <Trash2 size={16} />
              Reset local state
            </button>
          </div>
          {this.state.details ? <pre>{this.state.details}</pre> : null}
        </section>
      </main>
    );
  }
}

export function errorDisplayMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";

  if (raw.trim()) {
    return safeInlineErrorText(raw);
  }

  return "An unexpected rendering error stopped the current workspace view.";
}

export function safeErrorDetails(error: unknown): string | undefined {
  const raw = error instanceof Error
    ? (error.stack || error.message)
    : typeof error === "string"
      ? error
      : undefined;

  if (!raw?.trim()) {
    return undefined;
  }

  const redacted = redactSensitiveText(raw);
  const lines = redacted.split("\n").slice(0, 20).join("\n");

  return truncateText(lines, 1600);
}

function safeInlineErrorText(value: string): string {
  const redacted = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return truncateText(redacted, 240);
}

function reloadApp() {
  window.location.reload();
}

function resetLocalStateAndReload() {
  if (!confirmResetLocalState(window.confirm.bind(window))) {
    return;
  }

  resetBuilderGearLocalState();
  reloadApp();
}

export function confirmResetLocalState(confirm: (message: string) => boolean): boolean {
  return confirm("Reset Builder Gear local state? Saved layout and browser recovery data will be removed.");
}

export function resetBuilderGearLocalState(storage?: Pick<Storage, "length" | "key" | "removeItem">): void {
  let target = storage;

  if (!target) {
    try {
      target = window.localStorage;
    } catch {
      return;
    }
  }

  const keys: string[] = [];
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key?.startsWith("builder-gear.")) {
        keys.push(key);
      }
    }
  } catch {
    return;
  }

  for (const key of keys) {
    try {
      target.removeItem(key);
    } catch {
      // Recovery must continue even when storage is partially unavailable.
    }
  }
}
