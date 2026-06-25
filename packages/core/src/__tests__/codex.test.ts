import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildCodexInvocation, codexChildEnv, parseCodexJsonLine, runCodexExec, safeEventText } from "../codex.js";
import type { AgentRunEvent, AgentRunRequest } from "../types.js";

const request: AgentRunRequest = {
  workspacePath: "/workspace",
  prompt: "Build a thing",
  sandboxMode: "workspace-write",
  approvalMode: "never",
  skillIds: ["research"],
  ontologyContextIds: ["goal-1"]
};

function createMockChild(): ChildProcessWithoutNullStreams & {
  mockStdout: PassThrough;
  mockStderr: PassThrough;
  stdinChunks: string[];
  killed: boolean;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const mockStdout = new PassThrough();
  const mockStderr = new PassThrough();
  const mockStdin = new PassThrough();
  const stdinChunks: string[] = [];
  let killed = false;
  mockStdin.on("data", (chunk: Buffer) => {
    stdinChunks.push(chunk.toString("utf8"));
  });
  child.stdout = mockStdout;
  child.stderr = mockStderr;
  child.stdin = mockStdin as never;
  child.kill = (() => {
    killed = true;
    mockStderr.end();
    mockStdout.end();
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  }) as never;
  Object.assign(child, {
    mockStdout,
    mockStderr,
    stdinChunks
  });
  Object.defineProperty(child, "killed", {
    configurable: true,
    get: () => killed
  });
  return child as ChildProcessWithoutNullStreams & {
    mockStdout: PassThrough;
    mockStderr: PassThrough;
    stdinChunks: string[];
    killed: boolean;
  };
}

describe("codex adapter", () => {
  it("builds an explicit CLI-first codex exec invocation", () => {
    const invocation = buildCodexInvocation(request, "codex");

    expect(invocation.args).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--cd",
      "/workspace",
      "--sandbox",
      "workspace-write",
      "-"
    ]);
    expect(invocation.args).not.toContain(request.prompt);
  });

  it("parses JSONL lines and ignores non-JSON lines", () => {
    expect(parseCodexJsonLine('{"type":"started"}')).toEqual({ type: "started" });
    expect(parseCodexJsonLine("plain text")).toBeUndefined();
  });

  it("removes Builder Gear release and signing env from Codex child processes", async () => {
    expect(codexChildEnv({
      APPLE_CERTIFICATE: "base64-certificate-secret",
      APPLE_KEYCHAIN_PASSWORD: "keychain-secret",
      APPLE_PASSWORD: "super-secret-password",
      BUILDER_GEAR_CODEX_BIN: "/tmp/mock-codex",
      BUILDER_GEAR_UPDATER_PUBKEY: "public-key",
      CODEX_HOME: "/tmp/codex-home",
      PATH: "/usr/bin"
    })).toEqual({
      CODEX_HOME: "/tmp/codex-home",
      PATH: "/usr/bin"
    });

    let childEnv: NodeJS.ProcessEnv | undefined;
    const events: AgentRunEvent[] = [];
    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      env: {
        APPLE_CERTIFICATE: "base64-certificate-secret",
        APPLE_KEYCHAIN_PASSWORD: "keychain-secret",
        APPLE_PASSWORD: "super-secret-password",
        BUILDER_GEAR_CODEX_BIN: "/tmp/mock-codex",
        BUILDER_GEAR_UPDATER_PUBKEY: "public-key",
        CODEX_HOME: "/tmp/codex-home",
        PATH: "/usr/bin"
      },
      spawnFactory: (_command, _args, options) => {
        childEnv = options.env;
        const child = createMockChild();
        queueMicrotask(() => {
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("done");
    expect(childEnv).toMatchObject({
      CODEX_HOME: "/tmp/codex-home",
      PATH: "/usr/bin"
    });
    expect(childEnv).not.toHaveProperty("APPLE_CERTIFICATE");
    expect(childEnv).not.toHaveProperty("APPLE_KEYCHAIN_PASSWORD");
    expect(childEnv).not.toHaveProperty("APPLE_PASSWORD");
    expect(childEnv).not.toHaveProperty("BUILDER_GEAR_CODEX_BIN");
    expect(childEnv).not.toHaveProperty("BUILDER_GEAR_UPDATER_PUBKEY");
  });

  it("converts a mocked codex JSONL process into run events", async () => {
    const events: AgentRunEvent[] = [];
    let mockChild: ReturnType<typeof createMockChild> | undefined;

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        mockChild = child;
        queueMicrotask(() => {
          child.mockStdout.write('{"type":"started"}\n');
          child.mockStdout.write("plain output\n");
          child.mockStderr.write("OPENAI_API_KEY=sk-1234567890abcdefghijkl\n");
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["queued", "codex_event", "stdout", "stderr", "done"]);
    expect(events[0]?.payload).toMatchObject({ workspaceSelected: true, pathRedacted: true });
    expect(events[0]?.payload).not.toHaveProperty("workspacePath");
    expect(events[1]?.payload).toEqual({ type: "started" });
    expect(JSON.stringify(events)).toContain("[REDACTED_KEY]");
    expect(JSON.stringify(events)).not.toContain(request.workspacePath);
    expect(mockChild?.stdinChunks.join("")).toBe(request.prompt);
  });

  it("redacts nested codex JSON event payloads before emitting them", async () => {
    const events: AgentRunEvent[] = [];
    const codexPayload = {
      type: "message",
      message: {
        text: "OPENAI_API_KEY=sk-1234567890abcdefghijkl at /Users/example/private/source.ts",
        parts: [
          "file:///Users/example/private/prompt.txt",
          "C:\\Users\\example\\AppData\\Local\\Builder\\auth.json"
        ],
        nested: {
          session_token: "secret-session-token"
        }
      },
      "/Users/example/private/key.txt": "sk-1234567890abcdefghijkl"
    };

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        queueMicrotask(() => {
          child.mockStdout.write(`${JSON.stringify(codexPayload)}\n`);
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    const codexEvent = events.find((event) => event.type === "codex_event");
    const serialized = JSON.stringify(codexEvent?.payload);

    expect(codexEvent?.payload).toMatchObject({
      type: "message",
      message: {
        text: "OPENAI_API_KEY=[REDACTED_KEY] at [LOCAL_PATH]",
        parts: ["[LOCAL_FILE_URL]", "[LOCAL_PATH]"],
        nested: {
          session_token: "[REDACTED_TOKEN]"
        }
      },
      "[LOCAL_PATH]": "[REDACTED_OPENAI_KEY]"
    });
    expect(serialized).not.toContain("abcdefghijkl");
    expect(serialized).not.toContain("secret-session-token");
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("C:\\Users\\example");
  });

  it("caps oversized codex JSON event arrays, objects, and depth", async () => {
    const events: AgentRunEvent[] = [];
    let deep: unknown = "leaf";

    for (let index = 0; index < 12; index += 1) {
      deep = { child: deep };
    }

    const codexPayload = {
      type: "oversized",
      items: Array.from({ length: 105 }, (_, index) => `item-${index}`),
      object: Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`key-${index}`, index])),
      deep
    };

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        queueMicrotask(() => {
          child.mockStdout.write(`${JSON.stringify(codexPayload)}\n`);
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    const codexEvent = events.find((event) => event.type === "codex_event");
    const payload = codexEvent?.payload as {
      items: unknown[];
      object: Record<string, unknown>;
    };

    expect(payload.items).toHaveLength(101);
    expect(payload.items.at(-1)).toBe("[truncated]");
    expect(payload.object.__truncated__).toBe("5 keys omitted");
    expect(JSON.stringify(codexEvent?.payload)).toContain("[truncated]");
  });

  it("redacts secrets and local paths split across stderr chunks before emitting stderr", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        queueMicrotask(() => {
          child.mockStderr.write("OPENAI_API_KEY=sk-1234567890");
          child.mockStderr.write("abcdefghijkl at /Users/example/private");
          child.mockStderr.write("/source.ts and file:///Users/example/private/prompt.txt\n");
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    const stderr = events.find((event) => event.type === "stderr");
    expect(stderr?.payload).toContain("[REDACTED_KEY]");
    expect(stderr?.payload).toContain("[LOCAL_PATH]");
    expect(stderr?.payload).toContain("[LOCAL_FILE_URL]");
    expect(JSON.stringify(events)).not.toContain("abcdefghijkl");
    expect(JSON.stringify(events)).not.toContain("/Users/example");
  });

  it("redacts local paths from stdin write failures before emitting errors", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        child.stdin.end = (() => {
          throw new Error("write failed at /Volumes/ClientDrive/private-project OPENAI_API_KEY=sk-1234567890abcdefghijkl");
        }) as never;
        return child;
      }
    })) {
      events.push(event);
    }

    const error = events.find((event) => event.type === "error");
    const serialized = JSON.stringify(error);
    expect(serialized).toContain("[LOCAL_PATH]");
    expect(serialized).toContain("[REDACTED_KEY]");
    expect(serialized).not.toContain("/Volumes/ClientDrive");
    expect(serialized).not.toContain("abcdefghijkl");
  });

  it("redacts secrets and local paths split across stdout chunks before emitting stdout", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        queueMicrotask(() => {
          child.mockStdout.write("OPENAI_API_KEY=sk-1234567890");
          child.mockStdout.write("abcdefghijkl at C:\\Users\\example\\AppData\\Local");
          child.mockStdout.write("\\Builder\\auth.json and ~/.codex/auth.json\n");
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    const stdout = events.find((event) => event.type === "stdout");
    expect(stdout?.payload).toContain("[REDACTED_KEY]");
    expect(stdout?.payload).toContain("[LOCAL_PATH]");
    expect(JSON.stringify(events)).not.toContain("abcdefghijkl");
    expect(JSON.stringify(events)).not.toContain("C:\\Users\\example");
    expect(JSON.stringify(events)).not.toContain("~/.codex");
  });

  it("caps stdout lines even when Codex emits no newline", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        queueMicrotask(() => {
          for (let index = 0; index < 64; index += 1) {
            child.mockStdout.write(`${index}:${"x".repeat(1000)}`);
          }
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    const stdout = events.find((event) => event.type === "stdout");
    expect(typeof stdout?.payload).toBe("string");
    const payload = stdout?.payload as string;
    expect(payload.length).toBeLessThanOrEqual(16_000 + "... [truncated]".length);
    expect(payload).toContain("[truncated]");
  });

  it("caps aggregated stderr before emitting the final stderr event", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        const child = createMockChild();
        queueMicrotask(() => {
          child.mockStderr.write("OPENAI_API_KEY=sk-1234567890abcdefghijkl\n");
          for (let index = 0; index < 64; index += 1) {
            child.mockStderr.write(`${index}:${"x".repeat(1000)}\n`);
          }
          child.mockStderr.end();
          child.mockStdout.end();
          child.emit("close", 0);
        });
        return child;
      }
    })) {
      events.push(event);
    }

    const stderr = events.find((event) => event.type === "stderr");
    expect(typeof stderr?.payload).toBe("string");
    const payload = stderr?.payload as string;
    expect(payload.length).toBeLessThanOrEqual(16_000 + "... [truncated]".length);
    expect(payload).toContain("[truncated]");
    expect(payload).toContain("[REDACTED_KEY]");
    expect(payload).not.toContain("abcdefghijkl");
  });

  it("emits a redacted error event when codex cannot start", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => {
        throw new Error("spawn failed OPENAI_API_KEY=sk-1234567890abcdefghijkl");
      }
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["queued", "error"]);
    expect(JSON.stringify(events)).toContain("[REDACTED_KEY]");
    expect(JSON.stringify(events)).not.toContain("abcdefghijkl");
  });

  it("kills the codex child and emits a cancelled event when aborted", async () => {
    const events: AgentRunEvent[] = [];
    const controller = new AbortController();
    let mockChild: ReturnType<typeof createMockChild> | undefined;

    for await (const event of runCodexExec(request, {
      runId: "run-1",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      abortSignal: controller.signal,
      spawnFactory: () => {
        const child = createMockChild();
        mockChild = child;
        return child;
      }
    })) {
      events.push(event);
      if (event.type === "queued") {
        controller.abort();
      }
    }

    expect(mockChild?.killed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["queued", "error"]);
    expect(events.at(-1)?.payload).toMatchObject({
      cancelled: true,
      message: "run cancelled"
    });
    expect(mockChild?.stdinChunks.join("")).toBe(request.prompt);
  });

  it("kills the codex child and emits a timed-out event when the timeout elapses", async () => {
    const events: AgentRunEvent[] = [];
    let mockChild: ReturnType<typeof createMockChild> | undefined;

    for await (const event of runCodexExec(request, {
      runId: "run-timeout",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      timeoutMs: 5,
      spawnFactory: () => {
        const child = createMockChild();
        mockChild = child;
        return child;
      }
    })) {
      events.push(event);
    }

    expect(mockChild?.killed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["queued", "error"]);
    expect(events.at(-1)?.payload).toMatchObject({
      timedOut: true,
      timeoutMs: 5,
      message: "run timed out after 5 ms"
    });
    expect(events.at(-1)?.payload).not.toMatchObject({ cancelled: true });
    expect(mockChild?.stdinChunks.join("")).toBe(request.prompt);
  });

  it("uses request timeoutSeconds when no runtime timeout option is supplied", async () => {
    const events: AgentRunEvent[] = [];

    for await (const event of runCodexExec({
      ...request,
      timeoutSeconds: 1
    }, {
      runId: "run-request-timeout",
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      spawnFactory: () => createMockChild()
    })) {
      events.push(event);
    }

    expect(events[0]?.payload).toMatchObject({ timeoutSeconds: 1 });
    expect(events.at(-1)?.payload).toMatchObject({
      timedOut: true,
      timeoutMs: 1000
    });
  });

  it("redacts and truncates oversized event text before display", () => {
    const oversized = `${"x".repeat(17_000)} OPENAI_API_KEY=sk-1234567890abcdefghijkl at /Users/example/private/source.ts`;
    const safe = safeEventText(oversized);

    expect(safe.length).toBeLessThan(17_000);
    expect(safe).toContain("[truncated]");
    expect(safe).not.toContain("abcdefghijkl");
    expect(safe).not.toContain("/Users/example");
  });
});
