import { readdir } from "node:fs/promises";
import path from "node:path";
import { detectCodexCliVersion } from "./codex.js";
import {
  readOptionalRegularTextFile,
  readRegularTextFile,
  resolveOptionalWorkspaceRootForRead,
  workspaceChildDirForRead
} from "./fs-safety.js";
import { discoverSkillManifests } from "./skills.js";
import { inspectCodexAuth, redactSecretLikeText, type CodexAuthInspection } from "./auth.js";
import { validateOntologyEntity } from "./ontology.js";
import { validateScheduleSpec } from "./scheduler.js";
import { redactSupportBundleText } from "./support.js";
import type { HealthCheck, HealthCheckStatus, HealthReport, ScheduleSpec } from "./types.js";
import { listWorkspaceBackups } from "./workspace-backups.js";

const BACKUP_WARN_COUNT = 50;
const BACKUP_WARN_SIZE_BYTES = 1_073_741_824;

export interface RunHealthCheckOptions {
  workspacePath: string;
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  unsafeShowPaths?: boolean;
}

export async function runHealthCheck(options: RunHealthCheckOptions): Promise<HealthReport> {
  const requestedWorkspacePath = path.resolve(options.workspacePath);
  const now = options.now ?? (() => new Date());
  const [codexVersion, auth, workspaceResult] = await Promise.all([
    detectCodexCliVersion(options.codexBin),
    inspectCodexAuth(options.env),
    inspectWorkspaceRoot(requestedWorkspacePath)
  ]);
  const checks: HealthCheck[] = [
    codexVersion
      ? pass("codex-cli", "Codex CLI", `Codex CLI detected: ${codexVersion}`)
      : fail("codex-cli", "Codex CLI", "Codex CLI was not found on PATH", "Install Codex CLI or set PATH before running Builder Gear."),
    codexAuthCheck(auth),
    workspaceResult.check
  ];

  if (workspaceResult.workspacePath) {
    checks.push(...await workspaceChecks(workspaceResult.workspacePath));
  }

  const report = {
    generatedAt: now().toISOString(),
    status: summarizeStatus(checks),
    checks
  };

  return options.unsafeShowPaths
    ? report
    : redactHealthReport(report, workspaceResult.workspacePath ?? requestedWorkspacePath);
}

export function redactHealthReport(report: HealthReport, workspacePath: string): HealthReport {
  return {
    ...report,
    checks: report.checks.map((check) => ({
      ...check,
      message: redactSupportBundleText(check.message, workspacePath),
      action: check.action ? redactSupportBundleText(check.action, workspacePath) : undefined
    }))
  };
}

async function inspectWorkspaceRoot(requestedWorkspacePath: string): Promise<{
  check: HealthCheck;
  workspacePath?: string;
}> {
  try {
    const workspacePath = await resolveOptionalWorkspaceRootForRead(requestedWorkspacePath);

    if (!workspacePath) {
      return {
        check: fail(
          "workspace",
          "Workspace",
          `Workspace is missing: ${requestedWorkspacePath}`,
          "Select or create a valid Builder Gear workspace."
        )
      };
    }

    return {
      workspacePath,
      check: pass("workspace", "Workspace", `Workspace exists at ${workspacePath}`)
    };
  } catch (error) {
    return {
      check: fail(
        "workspace",
        "Workspace",
        errorMessage(error),
        "Select a real workspace directory, not a symlink or file path."
      )
    };
  }
}

function pass(id: string, title: string, message: string): HealthCheck {
  return { id, title, status: "pass", message };
}

function warn(id: string, title: string, message: string, action?: string): HealthCheck {
  return { id, title, status: "warn", message, action };
}

function fail(id: string, title: string, message: string, action?: string): HealthCheck {
  return { id, title, status: "fail", message, action };
}

function codexAuthCheck(auth: CodexAuthInspection): HealthCheck {
  if (!auth.exists) {
    return fail(
      "codex-auth",
      "Codex Auth",
      `Auth file is missing at ${auth.authPath}`,
      "Run Codex login. Builder Gear only checks auth metadata and will not read its contents."
    );
  }

  if (auth.isSymlink) {
    return fail(
      "codex-auth",
      "Codex Auth",
      `Auth file must not be a symlink at ${auth.authPath}`,
      "Remove the symlink and run Codex login so the auth file is user-owned."
    );
  }

  if (auth.isFile === false) {
    return fail(
      "codex-auth",
      "Codex Auth",
      `Auth path is not a regular file at ${auth.authPath}`,
      "Run Codex login so auth.json is recreated as a regular user-owned file."
    );
  }

  if (!auth.readable) {
    return fail(
      "codex-auth",
      "Codex Auth",
      `Auth file is not readable at ${auth.authPath}`,
      "Keep the auth file user-owned and readable by the current user."
    );
  }

  if (auth.permissionsSecure === false) {
    return fail(
      "codex-auth",
      "Codex Auth",
      `Auth file permissions are too open at ${auth.authPath}${auth.mode ? ` (${auth.mode})` : ""}`,
      "Restrict the auth file to the current user, for example with chmod 600."
    );
  }

  return pass("codex-auth", "Codex Auth", `Auth file is present at ${auth.authPath}`);
}

function summarizeStatus(checks: HealthCheck[]): HealthCheckStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }

  return "pass";
}

async function workspaceChecks(workspacePath: string): Promise<HealthCheck[]> {
  return [
    await skillCatalogCheck(workspacePath),
    await ontologyCatalogCheck(workspacePath),
    await scheduleCatalogCheck(workspacePath),
    await backupInventoryCheck(workspacePath)
  ];
}

async function skillCatalogCheck(workspacePath: string): Promise<HealthCheck> {
  try {
    const skills = await discoverSkillManifests(path.join(workspacePath, "skills"));

    if (skills.length === 0) {
      return warn(
        "skills",
        "Skills",
        "No skills were found in the workspace",
        "Create at least one skills/<skill-id>/skill.yaml file before shipping a workspace."
      );
    }

    return pass("skills", "Skills", `${skills.length} skill manifest${skills.length === 1 ? "" : "s"} loaded`);
  } catch (error) {
    return fail("skills", "Skills", errorMessage(error), "Fix invalid skill.yaml files before running agents.");
  }
}

async function ontologyCatalogCheck(workspacePath: string): Promise<HealthCheck> {
  try {
    const ontologyDir = await workspaceChildDirForRead(workspacePath, "ontology", "ontology");
    const files = ontologyDir ? await jsonFiles(ontologyDir) : [];

    if (files.length === 0) {
      return warn(
        "ontology",
        "Ontology",
        "No ontology JSON files were found",
        "Add ontology entities so runs can attach structured context."
      );
    }

    let entityCount = 0;
    for (const file of files) {
      const source = await readRegularTextFile(file, "ontology file");
      const parsed = JSON.parse(source) as unknown;
      const entities = Array.isArray(parsed) ? parsed : [parsed];

      for (const [index, entity] of entities.entries()) {
        const result = validateOntologyEntity(entity);
        if (!result.valid) {
          throw new Error(`${file} entity[${index}]: ${result.errors.join("; ")}`);
        }
      }

      entityCount += entities.length;
    }

    return pass("ontology", "Ontology", `${entityCount} ontology entit${entityCount === 1 ? "y" : "ies"} loaded`);
  } catch (error) {
    return fail("ontology", "Ontology", errorMessage(error), "Fix ontology JSON before attaching context.");
  }
}

async function scheduleCatalogCheck(workspacePath: string): Promise<HealthCheck> {
  const schedulePath = path.join(workspacePath, ".builder", "schedules.json");

  try {
    const builderDir = await workspaceChildDirForRead(workspacePath, ".builder", "builder");
    const source = builderDir ? await readOptionalRegularTextFile(schedulePath, "schedules file") : undefined;

    if (!source) {
      return warn(
        "schedules",
        "Schedules",
        "No .builder/schedules.json file was found",
        "Create schedules from the desktop app or CLI when recurring runs are needed."
      );
    }

    const parsed = JSON.parse(source) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error("schedules.json must contain an array");
    }

    for (const [index, schedule] of parsed.entries()) {
      try {
        validateScheduleSpec(schedule as ScheduleSpec);
      } catch (error) {
        throw new Error(`schedule[${index}]: ${errorMessage(error)}`);
      }
    }

    const enabledCount = (parsed as ScheduleSpec[]).filter((schedule) => schedule.enabled).length;
    return pass("schedules", "Schedules", `${parsed.length} schedule${parsed.length === 1 ? "" : "s"} loaded; ${enabledCount} enabled`);
  } catch (error) {
    return fail("schedules", "Schedules", errorMessage(error), "Fix .builder/schedules.json before enabling scheduler runs.");
  }
}

async function backupInventoryCheck(workspacePath: string): Promise<HealthCheck> {
  try {
    const backups = await listWorkspaceBackups(workspacePath);
    const totalSizeBytes = backups.reduce((total, backup) => total + backup.sizeBytes, 0);
    const message = `${backups.length} workspace backup${backups.length === 1 ? "" : "s"}; ${formatBytes(totalSizeBytes)} total`;

    if (backups.length > BACKUP_WARN_COUNT || totalSizeBytes > BACKUP_WARN_SIZE_BYTES) {
      return warn(
        "workspace-backups",
        "Workspace Backups",
        message,
        `Review old backups and run builder backups prune --keep ${BACKUP_WARN_COUNT} after confirming restore needs.`
      );
    }

    return pass("workspace-backups", "Workspace Backups", message);
  } catch (error) {
    return fail(
      "workspace-backups",
      "Workspace Backups",
      errorMessage(error),
      "Inspect .builder/backups for unsupported or symlinked backup entries before pruning."
    );
  }
}

async function jsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`ontology path must not be a symlink: ${filePath}`);
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(filePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function errorMessage(error: unknown): string {
  return redactSecretLikeText(error instanceof Error ? error.message : String(error));
}
