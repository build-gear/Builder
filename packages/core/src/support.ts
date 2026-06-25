import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { redactSecretLikeText } from "./auth.js";
import type {
  HealthReport,
  SupportBundle,
  SupportBundlePlatform,
  SupportBundlePrivacy,
  SupportBundleWorkspace
} from "./types.js";

const MAX_SUPPORT_DIAGNOSTIC_DEPTH = 8;
const MAX_SUPPORT_DIAGNOSTIC_ARRAY_ITEMS = 100;
const MAX_SUPPORT_DIAGNOSTIC_OBJECT_KEYS = 100;
const MAX_SUPPORT_DIAGNOSTIC_TEXT_CHARS = 4_000;
const REDACTED_DIAGNOSTIC_FIELD = "[REDACTED_DIAGNOSTIC_FIELD]";
const REDACTED_SECRET_FIELD = "[REDACTED_SECRET_FIELD]";
const REDACTED_PATH_FIELD = "[REDACTED_PATH_FIELD]";
const TRUNCATED_DIAGNOSTIC_SENTINEL = "[truncated]";
const CIRCULAR_DIAGNOSTIC_SENTINEL = "[circular]";

export interface CreateSupportBundleOptions {
  workspacePath: string;
  healthReport: HealthReport;
  appVersion: string;
  generatedAt?: Date;
  platform?: SupportBundlePlatform;
  diagnostics?: unknown;
}

export function createSupportBundle(options: CreateSupportBundleOptions): SupportBundle {
  const workspacePath = path.resolve(options.workspacePath);

  return {
    schemaVersion: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    appVersion: options.appVersion,
    platform: options.platform ?? currentSupportPlatform(),
    workspace: supportWorkspace(workspacePath),
    health: sanitizeSupportHealthReport(options.healthReport, workspacePath),
    diagnostics: sanitizeSupportDiagnostics(options.diagnostics, workspacePath),
    privacy: supportBundlePrivacy()
  };
}

export function sanitizeSupportHealthReport(report: HealthReport, workspacePath: string): HealthReport {
  return {
    ...report,
    checks: report.checks.map((check) => ({
      ...check,
      message: redactSupportBundleText(check.message, workspacePath),
      action: check.action ? redactSupportBundleText(check.action, workspacePath) : undefined
    }))
  };
}

export function redactSupportBundleText(input: string, workspacePath: string): string {
  let output = redactSecretLikeText(input);
  const resolvedWorkspace = path.resolve(workspacePath);
  const pathCandidates = [
    resolvedWorkspace,
    path.normalize(resolvedWorkspace),
    ...macosPrivateVarAliases(resolvedWorkspace),
    ...macosPrivateVarAliases(path.normalize(resolvedWorkspace)),
    homeRelativePath(resolvedWorkspace)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of [...new Set(pathCandidates)].sort((left, right) => right.length - left.length)) {
    output = output.replace(new RegExp(escapeRegExp(candidate), "g"), "[WORKSPACE_PATH]");
  }

  const nameCandidates = [
    path.basename(resolvedWorkspace),
    path.basename(path.normalize(resolvedWorkspace))
  ].filter((candidate) => candidate.trim().length > 0);

  for (const candidate of [...new Set(nameCandidates)].sort((left, right) => right.length - left.length)) {
    output = output.replace(new RegExp(escapeRegExp(candidate), "g"), "[WORKSPACE_NAME]");
  }

  return output
    .replace(/file:\/\/\/?[^"'\s)]+/g, "[LOCAL_FILE_URL]")
    .replace(/\/(?:Users|home|tmp|var|private\/var)\/[^"'\s)]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s"'(])\/[^"'\s)]+/g, "$1[LOCAL_PATH]")
    .replace(/[A-Za-z]:\\[^"'\s)]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s"'(])~\/[^"'\s)]+/g, "$1[LOCAL_PATH]");
}

function macosPrivateVarAliases(value: string): string[] {
  if (value.startsWith("/var/")) {
    return [`/private${value}`];
  }

  if (value.startsWith("/private/var/")) {
    return [value.replace(/^\/private/, "")];
  }

  return [];
}

function sanitizeSupportDiagnostics(
  value: unknown,
  workspacePath: string,
  fieldName?: string,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  const fieldKind = fieldName ? sensitiveDiagnosticFieldKind(fieldName) : undefined;

  if (fieldKind === "secret") {
    return REDACTED_SECRET_FIELD;
  }

  if (fieldKind === "payload") {
    return REDACTED_DIAGNOSTIC_FIELD;
  }

  if (fieldKind === "path") {
    return sanitizeDiagnosticPathField(value, workspacePath);
  }

  if (typeof value === "string") {
    return truncateDiagnosticText(redactSupportBundleText(value, workspacePath));
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (depth >= MAX_SUPPORT_DIAGNOSTIC_DEPTH) {
    return TRUNCATED_DIAGNOSTIC_SENTINEL;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return CIRCULAR_DIAGNOSTIC_SENTINEL;
    }

    seen.add(value);
    const items = value
      .slice(0, MAX_SUPPORT_DIAGNOSTIC_ARRAY_ITEMS)
      .map((item) => sanitizeSupportDiagnostics(item, workspacePath, undefined, depth + 1, seen));

    if (value.length > MAX_SUPPORT_DIAGNOSTIC_ARRAY_ITEMS) {
      items.push(TRUNCATED_DIAGNOSTIC_SENTINEL);
    }

    seen.delete(value);
    return items;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return CIRCULAR_DIAGNOSTIC_SENTINEL;
    }

    seen.add(value);
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);

    for (const [key, item] of entries.slice(0, MAX_SUPPORT_DIAGNOSTIC_OBJECT_KEYS)) {
      output[truncateDiagnosticText(redactSupportBundleText(key, workspacePath))] = sanitizeSupportDiagnostics(
        item,
        workspacePath,
        key,
        depth + 1,
        seen
      );
    }

    if (entries.length > MAX_SUPPORT_DIAGNOSTIC_OBJECT_KEYS) {
      output.__truncated__ = `${entries.length - MAX_SUPPORT_DIAGNOSTIC_OBJECT_KEYS} keys omitted`;
    }

    seen.delete(value);
    return output;
  }

  return truncateDiagnosticText(redactSupportBundleText(String(value), workspacePath));
}

function sensitiveDiagnosticFieldKind(fieldName: string): "secret" | "payload" | "path" | undefined {
  const normalized = fieldName.replace(/[^a-z0-9]/gi, "").toLowerCase();

  if (normalized === "pathredacted" || normalized === "pathfingerprint") {
    return undefined;
  }

  if (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("credential")
  ) {
    return "secret";
  }

  if (
    normalized.includes("prompt") ||
    normalized.includes("payload") ||
    normalized === "stdout" ||
    normalized === "stderr" ||
    normalized.endsWith("stdout") ||
    normalized.endsWith("stderr") ||
    normalized.includes("output") ||
    normalized.includes("body") ||
    normalized.includes("content") ||
    normalized.includes("instruction")
  ) {
    return "payload";
  }

  if (
    normalized === "path" ||
    normalized.endsWith("path") ||
    normalized.endsWith("dir") ||
    normalized.endsWith("directory") ||
    normalized.endsWith("url")
  ) {
    return "path";
  }

  return undefined;
}

function sanitizeDiagnosticPathField(value: unknown, workspacePath: string): unknown {
  if (typeof value === "string") {
    return truncateDiagnosticText(redactSupportBundleText(value, workspacePath));
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const paths = value
      .slice(0, MAX_SUPPORT_DIAGNOSTIC_ARRAY_ITEMS)
      .map((item) => truncateDiagnosticText(redactSupportBundleText(item, workspacePath)));

    if (value.length > MAX_SUPPORT_DIAGNOSTIC_ARRAY_ITEMS) {
      paths.push(TRUNCATED_DIAGNOSTIC_SENTINEL);
    }

    return paths;
  }

  return REDACTED_PATH_FIELD;
}

function truncateDiagnosticText(value: string): string {
  const chars = Array.from(value);

  if (chars.length <= MAX_SUPPORT_DIAGNOSTIC_TEXT_CHARS) {
    return value;
  }

  return `${chars.slice(0, MAX_SUPPORT_DIAGNOSTIC_TEXT_CHARS).join("")}... [truncated]`;
}

function currentSupportPlatform(): SupportBundlePlatform {
  return {
    os: process.platform,
    arch: process.arch,
    node: process.version
  };
}

function supportWorkspace(workspacePath: string): SupportBundleWorkspace {
  return {
    selected: Boolean(workspacePath.trim()),
    pathFingerprint: createHash("sha256").update(workspacePath).digest("hex").slice(0, 16),
    pathRedacted: true
  };
}

function supportBundlePrivacy(): SupportBundlePrivacy {
  return {
    redacted: true,
    includesAuthContents: false,
    includesRawPrompts: false,
    includesWorkspacePaths: false,
    includesRunPayloads: false
  };
}

function homeRelativePath(absolutePath: string): string | undefined {
  const home = os.homedir();

  if (!absolutePath.startsWith(home)) {
    return undefined;
  }

  const relative = path.relative(home, absolutePath);
  return relative ? `~/${relative}` : "~";
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
