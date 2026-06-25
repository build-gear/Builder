import { describe, expect, it, vi } from "vitest";
import {
  AppErrorBoundary,
  confirmResetLocalState,
  errorDisplayMessage,
  resetBuilderGearLocalState,
  safeErrorDetails
} from "./ErrorBoundary.js";

describe("AppErrorBoundary", () => {
  it("derives a recoverable render-error state", () => {
    const error = new Error("Layout profile is invalid");
    const state = AppErrorBoundary.getDerivedStateFromError(error);

    expect(state.error).toBe(error);
    expect(state.details).toContain("Layout profile is invalid");
  });

  it("redacts local paths and secret-shaped values from recovery details", () => {
    const error = new Error("Renderer failed OPENAI_API_KEY=sk-1234567890abcdefghijkl");
    error.stack = [
      "Error: Renderer failed OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      "    at render (/Users/example/Desktop/builder-gear/Builder/apps/desktop/src/App.tsx:12:3)",
      "    at read (file:///Users/example/Desktop/private/source.ts:1:1)",
      "    at windows (C:\\Users\\example\\AppData\\Local\\Builder\\source.ts:1:1)",
      "    at session (sess-abcdefghijklmnopqrstuvwxyz123456)"
    ].join("\n");

    const details = safeErrorDetails(error) ?? "";

    expect(details).toContain("[REDACTED_KEY]");
    expect(details).toContain("[REDACTED_SESSION]");
    expect(details).toContain("[LOCAL_PATH]");
    expect(details).toContain("[LOCAL_FILE_URL]");
    expect(details).not.toContain("/Users/example");
    expect(details).not.toContain("C:\\Users\\example");
    expect(details).not.toContain("abcdefghijkl");
    expect(details).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("redacts recovery display messages before rendering", () => {
    const message = errorDisplayMessage(
      new Error("Renderer failed CODEX_API_KEY=sk-1234567890abcdefghijkl at /Users/example/private/App.tsx")
    );

    expect(message).toContain("[REDACTED_KEY]");
    expect(message).toContain("[LOCAL_PATH]");
    expect(message).not.toContain("abcdefghijkl");
    expect(message).not.toContain("/Users/example");
  });

  it("redacts render failure console details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boundary = new AppErrorBoundary({ children: null });
    const error = new Error("Render failed OPENAI_API_KEY=sk-1234567890abcdefghijkl");

    boundary.componentDidCatch(error, {
      componentStack: "    at Workspace (/Users/example/private/App.tsx:10:2)"
    });

    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).toContain("[REDACTED_KEY]");
    expect(serialized).toContain("[LOCAL_PATH]");
    expect(serialized).not.toContain("abcdefghijkl");
    expect(serialized).not.toContain("/Users/example");
    spy.mockRestore();
  });

  it("formats unknown render failures without leaking empty values", () => {
    expect(errorDisplayMessage(new Error("Storage is unavailable"))).toBe("Storage is unavailable");
    expect(errorDisplayMessage("Renderer crashed")).toBe("Renderer crashed");
    expect(errorDisplayMessage(undefined)).toBe(
      "An unexpected rendering error stopped the current workspace view."
    );
  });

  it("resets only Builder Gear local state keys", () => {
    const removed: string[] = [];
    const storage = {
      length: 3,
      key: (index: number) => ["builder-gear.events.v1", "other-app", "builder-gear.layout.v1"][index] ?? null,
      removeItem: (key: string) => {
        removed.push(key);
      }
    };

    resetBuilderGearLocalState(storage);

    expect(removed).toEqual(["builder-gear.events.v1", "builder-gear.layout.v1"]);
  });

  it("requires confirmation before resetting local state", () => {
    const messages: string[] = [];

    expect(confirmResetLocalState((message) => {
      messages.push(message);
      return false;
    })).toBe(false);
    expect(confirmResetLocalState((message) => {
      messages.push(message);
      return true;
    })).toBe(true);
    expect(messages).toEqual([
      "Reset Builder Gear local state? Saved layout and browser recovery data will be removed.",
      "Reset Builder Gear local state? Saved layout and browser recovery data will be removed."
    ]);
  });

  it("does not throw when recovery storage access fails", () => {
    const blockedEnumeration: Pick<Storage, "length" | "key" | "removeItem"> = {
      get length(): number {
        throw new Error("storage blocked");
      },
      key: () => null,
      removeItem: () => {
        throw new Error("remove blocked");
      }
    };
    const blockedRemoval = {
      length: 1,
      key: () => "builder-gear.events.v1",
      removeItem: () => {
        throw new Error("remove blocked");
      }
    };

    expect(() => resetBuilderGearLocalState(blockedEnumeration)).not.toThrow();
    expect(() => resetBuilderGearLocalState(blockedRemoval)).not.toThrow();
  });
});
