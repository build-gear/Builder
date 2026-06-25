import { redactSensitiveText, truncateText } from "./redaction.js";

export interface UpdaterCandidate {
  version?: unknown;
  date?: unknown;
  downloadAndInstall: () => Promise<void>;
}

export interface UpdaterFlowResult {
  status: string;
  error?: string;
}

export interface RunUpdaterFlowOptions {
  check: () => Promise<UpdaterCandidate | null | undefined>;
  confirmInstall: (message: string) => boolean;
  currentVersion?: string;
  onArtifact?: (payload: UpdaterArtifactPayload) => void;
  onStatus?: (status: string) => void;
}

export type UpdaterArtifactPayload =
  | {
      kind: "update_check";
      available: false;
    }
  | {
      kind: "update_available";
      available: true;
      version: string;
      date: string;
    }
  | {
      kind: "update_installed";
      version: string;
    }
  | {
      kind: "update_rejected";
      available: true;
      reason: "invalid_version" | "not_newer";
      version: string;
      currentVersion?: string;
    }
  | {
      kind: "update_unavailable";
      available: false;
      reason: "not_configured";
    };

export function updaterErrorMessage(value: unknown): string {
  const raw = rawUpdaterErrorMessage(value);
  const compact = redactSensitiveText(raw).replace(/\s+/g, " ").trim();

  return truncateText(compact || "Updater failed", 800);
}

export function updaterMetadataText(value: unknown, fallback = "unknown", maxLength = 120): string {
  const raw = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
  const compact = redactSensitiveText(raw).replace(/\s+/g, " ").trim();

  return truncateText(compact || fallback, maxLength);
}

export async function runUpdaterFlow(options: RunUpdaterFlowOptions): Promise<UpdaterFlowResult> {
  let phase: "checking" | "installing" = "checking";

  try {
    const update = await options.check();

    if (!update) {
      options.onArtifact?.({
        kind: "update_check",
        available: false
      });
      return { status: "No update available" };
    }

    const updateVersion = updaterMetadataText(update.version, "available update");
    const updateDate = updaterMetadataText(update.date, "unknown");
    options.onArtifact?.({
      kind: "update_available",
      available: true,
      version: updateVersion,
      date: updateDate
    });

    const versionGate = validateUpdaterCandidateVersion(update.version, options.currentVersion);
    if (!versionGate.accept) {
      options.onArtifact?.({
        kind: "update_rejected",
        available: true,
        reason: versionGate.reason,
        version: updateVersion,
        currentVersion: options.currentVersion
      });
      return { status: versionGate.reason === "not_newer" ? "Update version is not newer" : "Update version invalid" };
    }

    if (!options.confirmInstall(`Install Builder Gear update ${updateVersion}?`)) {
      return { status: `Update ${updateVersion} available` };
    }

    options.onStatus?.("Installing update");
    phase = "installing";
    await update.downloadAndInstall();
    options.onArtifact?.({
      kind: "update_installed",
      version: updateVersion
    });
    return { status: "Update installed; restart app" };
  } catch (error) {
    if (isUpdaterConfigurationError(error)) {
      options.onArtifact?.({
        kind: "update_unavailable",
        available: false,
        reason: "not_configured"
      });
      return { status: "Updates not configured" };
    }

    return {
      status: phase === "installing" ? "Update install failed" : "Update check failed",
      error: updaterErrorMessage(error)
    };
  }
}

function rawUpdaterErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message || "Updater failed";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isUpdaterConfigurationError(value: unknown): boolean {
  const message = updaterErrorMessage(value).toLowerCase();
  const mentionsUpdater = /\bupdater?\b/.test(message) || message.includes("bundle.updater");

  if (!mentionsUpdater) {
    return false;
  }

  if (message.includes("not configured") || message.includes("configuration") || message.includes("bundle.updater")) {
    return true;
  }

  const missingConfigValue = /\b(missing|required|empty)\b/.test(message);
  const configTarget =
    /\b(endpoint|endpoints|pubkey|public key|pub key|update url|update server)\b/.test(message);

  return missingConfigValue && configTarget;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function validateUpdaterCandidateVersion(
  candidateVersion: unknown,
  currentVersion: string | undefined
): { accept: true } | { accept: false; reason: "invalid_version" | "not_newer" } {
  if (!currentVersion) {
    return { accept: true };
  }

  const parsedCandidate = parseVersion(candidateVersion);
  const parsedCurrent = parseVersion(currentVersion);

  if (!parsedCandidate || !parsedCurrent) {
    return { accept: false, reason: "invalid_version" };
  }

  return compareVersions(parsedCandidate, parsedCurrent) > 0
    ? { accept: true }
    : { accept: false, reason: "not_newer" };
}

function parseVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4]?.split(".") ?? []
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) {
      return diff;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const partComparison = comparePrereleasePart(leftPart, rightPart);
    if (partComparison !== 0) {
      return partComparison;
    }
  }

  return 0;
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}
