import { redactSensitiveText, truncateText } from "./redaction.js";

type RuntimeErrorListener = (event: Event) => void;

interface RuntimeErrorEventTarget {
  addEventListener(type: "error" | "unhandledrejection", listener: RuntimeErrorListener): void;
  removeEventListener(type: "error" | "unhandledrejection", listener: RuntimeErrorListener): void;
}

export function installGlobalRuntimeErrorHandlers(
  target: RuntimeErrorEventTarget,
  onRuntimeError: (message: string) => void
): () => void {
  const onError: RuntimeErrorListener = (event) => {
    const errorEvent = event as ErrorEvent;
    onRuntimeError(runtimeErrorMessage(errorEvent.error ?? errorEvent.message ?? "Unhandled runtime error"));
  };
  const onUnhandledRejection: RuntimeErrorListener = (event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    onRuntimeError(runtimeErrorMessage(rejectionEvent.reason ?? "Unhandled promise rejection"));
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function runtimeErrorMessage(value: unknown): string {
  const raw = rawRuntimeErrorText(value);
  const redacted = redactSensitiveText(raw);
  const lines = redacted.split("\n").slice(0, 8).join("\n");

  return truncateText(lines, 800);
}

function rawRuntimeErrorText(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message || "Unhandled runtime error";
  }

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message;
  }

  return "Unhandled runtime error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
