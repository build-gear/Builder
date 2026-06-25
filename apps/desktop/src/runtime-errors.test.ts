import { describe, expect, it } from "vitest";
import { installGlobalRuntimeErrorHandlers, runtimeErrorMessage } from "./runtime-errors.js";

class FakeRuntimeTarget {
  listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: "error" | "unhandledrejection", listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: "error" | "unhandledrejection", listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }

  emit(type: "error" | "unhandledrejection", event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("runtime error handling", () => {
  it("redacts secrets and local paths from runtime error messages", () => {
    const error = new Error("Renderer failed OPENAI_API_KEY=sk-1234567890abcdefghijkl");
    error.stack = [
      "Error: Renderer failed OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      "    at render (/Users/example/private/App.tsx:12:3)",
      "    at load (file:///Users/example/private/source.ts:1:1)",
      "    at windows (C:\\Users\\example\\AppData\\Local\\Builder\\source.ts:1:1)",
      "    at session (sess-abcdefghijklmnopqrstuvwxyz123456)"
    ].join("\n");

    const message = runtimeErrorMessage(error);

    expect(message).toContain("[REDACTED_KEY]");
    expect(message).toContain("[REDACTED_SESSION]");
    expect(message).toContain("[LOCAL_PATH]");
    expect(message).toContain("[LOCAL_FILE_URL]");
    expect(message).not.toContain("/Users/example");
    expect(message).not.toContain("C:\\Users\\example");
    expect(message).not.toContain("abcdefghijkl");
  });

  it("captures browser error and unhandled rejection events until cleanup", () => {
    const target = new FakeRuntimeTarget();
    const messages: string[] = [];
    const cleanup = installGlobalRuntimeErrorHandlers(target, (message) => messages.push(message));

    target.emit("error", {
      error: new Error("Render loop failed")
    } as unknown as Event);
    target.emit("unhandledrejection", {
      reason: "Promise failed CODEX_API_KEY=sk-1234567890abcdefghijkl"
    } as unknown as Event);

    cleanup();
    target.emit("error", {
      error: new Error("Ignored after cleanup")
    } as unknown as Event);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("Render loop failed");
    expect(messages[1]).toContain("CODEX_API_KEY=[REDACTED_KEY]");
    expect(messages.join("\n")).not.toContain("abcdefghijkl");
  });
});
