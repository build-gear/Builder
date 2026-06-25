import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { AgentRunEvent, AgentRunRequest } from "./types.js";
import { redactLocalPathLikeText, redactSecretLikeText } from "./auth.js";
import { MAX_AGENT_RUN_TIMEOUT_SECONDS, validateAgentRunRequest } from "./validation.js";

const execFileAsync = promisify(execFile);
const MAX_EVENT_TEXT_CHARS = 16_000;
const MAX_BUFFERED_EVENT_TEXT_CHARS = MAX_EVENT_TEXT_CHARS + 4_096;
const MAX_CODEX_JSON_DEPTH = 8;
const MAX_CODEX_JSON_ARRAY_ITEMS = 100;
const MAX_CODEX_JSON_OBJECT_KEYS = 100;
export const MAX_CODEX_RUN_TIMEOUT_MS = MAX_AGENT_RUN_TIMEOUT_SECONDS * 1000;
const CODEX_FORCE_KILL_GRACE_MS = 5000;
const TRUNCATED_EVENT_SUFFIX = "... [truncated]";
const TRUNCATED_JSON_SENTINEL = "[truncated]";
const CODEX_CHILD_ENV_REMOVED_EXACT = new Set([
  "APPLE_ID",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_KEYCHAIN_PASSWORD",
  "APPLE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "WINDOWS_SIGNING_CERTIFICATE",
  "WINDOWS_SIGNING_PASSWORD"
]);
const CODEX_CHILD_ENV_REMOVED_PREFIXES = [
  "BUILDER_GEAR_"
];

export interface CodexInvocation {
  bin: string;
  args: string[];
}

export type SpawnFactory = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }
) => ChildProcessWithoutNullStreams;

export interface RunCodexOptions {
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  now?: () => Date;
  spawnFactory?: SpawnFactory;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export function buildCodexInvocation(request: AgentRunRequest, codexBin = "codex"): CodexInvocation {
  const errors = validateAgentRunRequest(request);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const args = [
    "--ask-for-approval",
    request.approvalMode,
    "exec",
    "--json",
    "--cd",
    request.workspacePath,
    "--sandbox",
    request.sandboxMode
  ];

  if (request.profile) {
    args.push("--profile", request.profile);
  }

  if (request.model) {
    args.push("--model", request.model);
  }

  args.push("-");

  return { bin: codexBin, args };
}

export function parseCodexJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export async function detectCodexCliVersion(codexBin = "codex"): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(codexBin, ["--version"], {
      timeout: 5000,
      env: codexChildEnv(process.env),
      shell: process.platform === "win32"
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function codexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldRemoveCodexChildEnvKey(key)) {
      continue;
    }

    childEnv[key] = value;
  }

  return childEnv;
}

export function shouldRemoveCodexChildEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();

  return CODEX_CHILD_ENV_REMOVED_EXACT.has(normalized) ||
    CODEX_CHILD_ENV_REMOVED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export async function* runCodexExec(
  request: AgentRunRequest,
  options: RunCodexOptions = {}
): AsyncGenerator<AgentRunEvent> {
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const requestedTimeoutMs = options.timeoutMs ?? (
    request.timeoutSeconds === undefined ? undefined : request.timeoutSeconds * 1000
  );
  const timeoutMs = normalizeRunTimeoutMs(requestedTimeoutMs);
  const invocation = buildCodexInvocation(request, options.codexBin);
  const event = (type: AgentRunEvent["type"], payload: unknown): AgentRunEvent => ({
    runId,
    type,
    timestamp: now().toISOString(),
    payload
  });
  const cancelledEvent = (exitCode: number | null = null, signal: NodeJS.Signals | null = null) => event("error", {
    exitCode,
    signal,
    cancelled: true,
    message: "run cancelled"
  });
  const timedOutEvent = (exitCode: number | null = null, signal: NodeJS.Signals | null = null) => event("error", {
    exitCode,
    signal,
    timedOut: true,
    timeoutMs,
    message: `run timed out after ${timeoutMs} ms`
  });

  yield event("queued", {
    workspaceSelected: Boolean(request.workspacePath.trim()),
    pathRedacted: true,
    sandboxMode: request.sandboxMode,
    approvalMode: request.approvalMode,
    timeoutSeconds: request.timeoutSeconds,
    skillIds: request.skillIds ?? [],
    ontologyContextIds: request.ontologyContextIds ?? [],
    scheduleId: request.scheduleId
  });

  const spawnFactory = options.spawnFactory ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFactory(invocation.bin, invocation.args, {
      cwd: request.workspacePath,
      env: codexChildEnv(options.env ?? process.env),
      shell: process.platform === "win32"
    });
  } catch (error) {
    yield event("error", {
      exitCode: null,
      message: safeEventText(`failed to start codex: ${String(error)}`)
    });
    return;
  }

  let childClosed = false;
  let cancelled = false;
  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      childClosed = true;
      resolve({ code, signal });
    });
  });
  const abortSignal = options.abortSignal;
  const onAbort = () => {
    cancelled = true;
    terminateChildWithGrace(child);
  };
  const onTimeout = () => {
    timedOut = true;
    terminateChildWithGrace(child);
  };
  const terminateChildWithGrace = (target: ChildProcessWithoutNullStreams) => {
    if (!childClosed) {
      terminateChild(target, false);
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!childClosed) {
            terminateChild(target, true);
          }
        }, CODEX_FORCE_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }
    }
  };

  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(onTimeout, timeoutMs);
    timeoutTimer.unref?.();
  }

  try {
    try {
      writePromptToChildStdin(child, request.prompt);
    } catch (error) {
      child.kill();
      if (timedOut) {
        yield timedOutEvent();
      } else if (cancelled) {
        yield cancelledEvent();
      } else {
        yield event("error", {
          exitCode: null,
          message: safeEventText(`failed to write prompt to codex stdin: ${String(error)}`)
        });
      }
      return;
    }

    if (cancelled) {
      yield cancelledEvent();
      return;
    }

    const stderr = new BoundedEventTextBuffer();
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk.toString("utf8"));
    });

    for await (const line of boundedTextLines(child.stdout)) {
      const parsed = parseCodexJsonLine(line);

      if (parsed === undefined) {
        yield event("stdout", line);
      } else {
        yield event("codex_event", safeCodexJsonPayload(parsed));
      }
    }

    let exitCode: number | null;
    let signal: NodeJS.Signals | null;
    try {
      ({ code: exitCode, signal } = await exitPromise);
    } catch (error) {
      if (timedOut) {
        yield timedOutEvent();
      } else if (cancelled) {
        yield cancelledEvent();
      } else {
        yield event("error", {
          exitCode: null,
          message: safeEventText(`failed to run codex: ${String(error)}`)
        });
      }
      return;
    }

    const stderrText = stderr.toEventText();
    if (stderrText) {
      yield event("stderr", stderrText);
    }

    if (timedOut) {
      yield timedOutEvent(exitCode, signal);
    } else if (cancelled) {
      yield cancelledEvent(exitCode, signal);
    } else if (exitCode === 0) {
      yield event("done", { exitCode });
    } else {
      yield event("error", { exitCode, message: `codex exited with code ${exitCode ?? "unknown"}` });
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    if (!childClosed) {
      terminateChild(child, true);
    }
  }
}

function terminateChild(target: ChildProcessWithoutNullStreams, force: boolean): void {
  if (process.platform === "win32" && target.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(target.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => undefined);
    return;
  }

  target.kill(force ? "SIGKILL" : undefined);
}

function normalizeRunTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CODEX_RUN_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a whole number between 1 and ${MAX_CODEX_RUN_TIMEOUT_MS}`);
  }

  return timeoutMs;
}

export function safeEventText(value: string): string {
  return safeBufferedEventText(value, false);
}

function safeCodexJsonPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return safeEventText(value);
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (depth >= MAX_CODEX_JSON_DEPTH) {
    return TRUNCATED_JSON_SENTINEL;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_CODEX_JSON_ARRAY_ITEMS)
      .map((item) => safeCodexJsonPayload(item, depth + 1));

    if (value.length > MAX_CODEX_JSON_ARRAY_ITEMS) {
      items.push(TRUNCATED_JSON_SENTINEL);
    }

    return items;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);

    for (const [key, item] of entries.slice(0, MAX_CODEX_JSON_OBJECT_KEYS)) {
      Object.defineProperty(output, safeEventText(key), {
        value: safeCodexJsonPayload(item, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }

    if (entries.length > MAX_CODEX_JSON_OBJECT_KEYS) {
      Object.defineProperty(output, "__truncated__", {
        value: `${entries.length - MAX_CODEX_JSON_OBJECT_KEYS} keys omitted`,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }

    return output;
  }

  return safeEventText(String(value));
}

function safeBufferedEventText(value: string, truncated: boolean): string {
  const redacted = redactLocalPathLikeText(redactSecretLikeText(value));
  const chars = Array.from(redacted);

  if (!truncated && chars.length <= MAX_EVENT_TEXT_CHARS) {
    return redacted;
  }

  return `${chars.slice(0, MAX_EVENT_TEXT_CHARS).join("")}${TRUNCATED_EVENT_SUFFIX}`;
}

class BoundedEventTextBuffer {
  private readonly chunks: string[] = [];
  private charCount = 0;
  private truncated = false;

  append(value: string): void {
    if (!value || this.truncated && this.charCount >= MAX_BUFFERED_EVENT_TEXT_CHARS) {
      return;
    }

    const chars = Array.from(value);
    const remaining = MAX_BUFFERED_EVENT_TEXT_CHARS - this.charCount;

    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    if (chars.length > remaining) {
      this.chunks.push(chars.slice(0, remaining).join(""));
      this.charCount += remaining;
      this.truncated = true;
      return;
    }

    this.chunks.push(value);
    this.charCount += chars.length;
  }

  toEventText(): string | undefined {
    if (this.charCount === 0) {
      return undefined;
    }

    return safeBufferedEventText(this.chunks.join(""), this.truncated);
  }
}

async function* boundedTextLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let line = new BoundedEventTextBuffer();

  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = text.split("\n");

    for (const [index, part] of parts.entries()) {
      line.append(part);

      if (index < parts.length - 1) {
        const eventText = line.toEventText();
        line = new BoundedEventTextBuffer();

        if (eventText !== undefined) {
          yield stripTrailingCarriageReturn(eventText);
        }
      }
    }
  }

  const eventText = line.toEventText();
  if (eventText !== undefined) {
    yield stripTrailingCarriageReturn(eventText);
  }
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function writePromptToChildStdin(child: ChildProcessWithoutNullStreams, prompt: string) {
  child.stdin.on("error", () => {
    // Exit handling reports the failed run. The listener prevents an unhandled
    // stream error if Codex exits before consuming stdin.
  });
  child.stdin.end(prompt, "utf8");
}
