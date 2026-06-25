#!/usr/bin/env node
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import {
  buildCodexInvocation,
  createSupportBundle,
  createScheduleRunRequest,
  discoverSkillManifests,
  getDueSchedules,
  prepareBuilderWorkspace,
  listWorkspaceBackups,
  pruneWorkspaceBackups,
  readRegularTextFile,
  redactLocalPathLikeText,
  redactSecretLikeText,
  isNotFoundError,
  MAX_CODEX_RUN_TIMEOUT_MS,
  resolveExistingWorkspaceRoot,
  restoreWorkspaceBackup,
  runCodexExec,
  runHealthCheck,
  sanitizeSupportHealthReport,
  scheduleRunClaimTtlMs,
  SqliteScheduleStore,
  validateScheduleSpec,
  validateOntologyEntity,
  workspaceChildDirForRead,
  type AgentRunRequest,
  type AgentRunEvent,
  type ApprovalMode,
  type InvalidStoredScheduleRow,
  type SandboxMode,
  type ScheduleSpec,
  type WorkspaceBackupSummary
} from "@builder/core";

const CLI_VERSION = "0.1.0";
const program = new Command();
const invocationCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();

program
  .configureOutput({
    outputError: (message, write) => write(safeCliErrorMessage(message))
  })
  .exitOverride()
  .name("builder")
  .description("CLI-first agent builder for professional workflows")
  .version(CLI_VERSION);

program
  .command("init")
  .description("Create a starter Builder Gear workspace without overwriting existing files")
  .option("-w, --workspace <path>", "workspace path", invocationCwd)
  .option("--json", "print machine-readable output")
  .action(async (options: { workspace: string; json?: boolean }) => {
    const result = await prepareBuilderWorkspace(resolveFromInvocationCwd(options.workspace));

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Initialized Builder Gear workspace at ${result.workspacePath}`);
    for (const file of result.files) {
      console.log(`${file.status.toUpperCase()}\t${file.path}`);
    }
  });

program
  .command("doctor")
  .description("Check Codex, auth, and workspace readiness without reading auth contents")
  .option("-w, --workspace <path>", "workspace path", invocationCwd)
  .option("--json", "print machine-readable output")
  .option("--support", "print a redacted support bundle for troubleshooting")
  .action(async (options: { workspace: string; json?: boolean; support?: boolean }) => {
    const workspacePath = resolveFromInvocationCwd(options.workspace);
    const result = await runHealthCheck({
      workspacePath,
      codexBin: process.env.BUILDER_GEAR_CODEX_BIN,
      env: process.env
    });

    if (options.support) {
      console.log(JSON.stringify(createSupportBundle({
        workspacePath,
        healthReport: result,
        appVersion: CLI_VERSION
      }), null, 2));

      if (result.status === "fail") {
        process.exitCode = 1;
      }
      return;
    }

    const displayResult = sanitizeSupportHealthReport(result, workspacePath);

    if (options.json) {
      console.log(JSON.stringify(displayResult, null, 2));
      return;
    }

    console.log(`Builder Gear health: ${displayResult.status}`);
    for (const check of displayResult.checks) {
      console.log(`${check.status.toUpperCase()}\t${check.title}\t${check.message}`);
      if (check.action) {
        console.log(`ACTION\t${check.action}`);
      }
    }

    if (result.status === "fail") {
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .description("Run Codex through the Builder Gear event contract")
  .requiredOption("-w, --workspace <path>", "workspace path")
  .option("-p, --prompt <prompt>", "prompt text")
  .option("--prompt-file <path>", "read prompt from a file")
  .option("-m, --model <model>", "Codex model")
  .option("--profile <profile>", "Codex config profile")
  .option("--sandbox <mode>", "Codex sandbox mode", "workspace-write")
  .option("--approval <mode>", "Codex approval mode", "never")
  .option("--skill <id...>", "skill ids to attach to the run")
  .option("--context <id...>", "ontology context ids to attach to the run")
  .option("--timeout-seconds <seconds>", "fail and stop Codex if the run exceeds this many seconds")
  .option("--dry-run", "print the Codex invocation without executing it")
  .option("--json", "print machine-readable output")
  .option("--unsafe-show-paths", "include local filesystem paths in dry-run output")
  .action(async (options: RunOptions) => {
    const prompt = await readPrompt(options);
    const timeoutMs = parseOptionalTimeoutSeconds(options.timeoutSeconds, "run timeout");
    const timeoutSeconds = timeoutMs === undefined ? undefined : timeoutMs / 1000;
    const workspacePath = await resolveExistingWorkspaceRoot(resolveFromInvocationCwd(options.workspace));
    const request: AgentRunRequest = {
      workspacePath,
      prompt,
      model: options.model,
      profile: options.profile,
      sandboxMode: options.sandbox as SandboxMode,
      approvalMode: options.approval as ApprovalMode,
      timeoutSeconds,
      skillIds: options.skill ?? [],
      ontologyContextIds: options.context ?? []
    };

    if (options.dryRun) {
      const invocation = buildCodexInvocation(request, configuredCodexBin());
      const outputInvocation = options.unsafeShowPaths
        ? invocation
        : redactedDryRunInvocation(invocation);

      console.log(JSON.stringify({
        ...outputInvocation,
        redacted: !options.unsafeShowPaths,
        timeoutSeconds: request.timeoutSeconds,
        skillIds: request.skillIds ?? [],
        ontologyContextIds: request.ontologyContextIds ?? []
      }, null, 2));
      return;
    }

    const signals = installCliAbortController();
    let failed = false;

    try {
      failed = await printRunEvents(runCodexExec(request, {
        codexBin: configuredCodexBin(),
        env: process.env,
        abortSignal: signals.signal,
        timeoutMs
      }));
    } finally {
      signals.dispose();
    }

    const interruptedExitCode = signals.exitCode();
    if (interruptedExitCode !== undefined) {
      process.exitCode = interruptedExitCode;
    } else if (failed) {
      process.exitCode = 1;
    }
  });

const skills = program.command("skills").description("Manage local skill manifests");

skills
  .command("list")
  .description("List skill.yaml manifests below a root directory")
  .option("-r, --root <path>", "skills root", path.join(invocationCwd, "skills"))
  .option("--json", "print machine-readable output")
  .action(async (options: { root: string; json?: boolean }) => {
    const loaded = await discoverSkillManifests(path.resolve(invocationCwd, options.root));
    const rows = loaded.map((skill) => ({
      id: skill.manifest.id,
      name: skill.manifest.name,
      version: skill.manifest.version,
      occupations: skill.manifest.occupations,
      requiredTools: skill.manifest.requiredTools,
      manifestPath: skill.manifestPath
    }));

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.log("No skills found.");
      return;
    }

    for (const row of rows) {
      console.log(`${row.id}\t${row.name}\t${row.version}\t${row.manifestPath}`);
    }
  });

const ontology = program.command("ontology").description("Validate ontology entities");

ontology
  .command("validate")
  .description("Validate an ontology entity JSON file")
  .argument("<file>", "JSON file containing one ontology entity")
  .action(async (file: string) => {
    const source = await readRegularTextFile(resolveFromInvocationCwd(file), "ontology file");
    const parsed = JSON.parse(source) as unknown;
    const entities = Array.isArray(parsed) ? parsed : [parsed];
    const errors = entities.flatMap((entity, index) => {
      const result = validateOntologyEntity(entity);
      return result.valid ? [] : result.errors.map((error) => `entity[${index}]: ${error}`);
    });

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
      return;
    }

    console.log(`Ontology ${entities.length === 1 ? "entity is" : "entities are"} valid.`);
  });

const backups = program.command("backups").description("Inspect and restore workspace recovery backups");

backups
  .command("list")
  .description("List workspace backups without reading backup file contents")
  .option("-w, --workspace <path>", "workspace path", invocationCwd)
  .option("--json", "print machine-readable output")
  .action(async (options: { workspace: string; json?: boolean }) => {
    const rows = await listWorkspaceBackups(resolveFromInvocationCwd(options.workspace));

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.log("No workspace backups found.");
      return;
    }

    for (const row of rows) {
      console.log(`${row.name}\t${row.kind}\t${row.relativePath}\t${row.sizeBytes} bytes`);
    }
  });

backups
  .command("restore")
  .description("Preview a workspace backup restore; pass --confirm to replace the target")
  .argument("<name>", "backup name from `builder backups list`")
  .option("-w, --workspace <path>", "workspace path", invocationCwd)
  .option("--confirm", "restore the backup instead of only previewing the target")
  .option("--json", "print machine-readable output")
  .action(async (name: string, options: { workspace: string; confirm?: boolean; json?: boolean }) => {
    const workspace = resolveFromInvocationCwd(options.workspace);

    if (!options.confirm) {
      const result = await previewWorkspaceBackupRestore(workspace, name);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Dry run: would restore ${result.restored.name} to ${result.targetRelativePath}.`);
      console.log("Pass --confirm to restore this backup and save a pre-restore backup first.");
      return;
    }

    const result = {
      dryRun: false,
      ...(await restoreWorkspaceBackup(workspace, name))
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Restored ${result.restored.name} to ${result.targetRelativePath}`);
    if (result.preRestoreBackup) {
      console.log(`Saved pre-restore backup ${result.preRestoreBackup.name}`);
    }
  });

backups
  .command("prune")
  .description("Prune old workspace backups; dry-run by default, pass --confirm to delete")
  .option("-w, --workspace <path>", "workspace path", invocationCwd)
  .option("--keep <count>", "number of newest backups to keep", "50")
  .option("--confirm", "delete prune candidates instead of only previewing them")
  .option("--json", "print machine-readable output")
  .action(async (options: { workspace: string; keep: string; confirm?: boolean; json?: boolean }) => {
    const keep = Number(options.keep);
    if (!Number.isInteger(keep) || keep < 0) {
      throw new Error("backups prune requires --keep to be a non-negative integer");
    }

    const result = await pruneWorkspaceBackups(resolveFromInvocationCwd(options.workspace), {
      keep,
      dryRun: !options.confirm
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.dryRun) {
      console.log(`Dry run: ${result.candidates.length} backup${result.candidates.length === 1 ? "" : "s"} would be pruned; ${result.retained.length} retained.`);
      console.log("Pass --confirm to delete prune candidates.");
    } else {
      console.log(`Pruned ${result.pruned.length} backup${result.pruned.length === 1 ? "" : "s"}; ${result.retained.length} retained.`);
    }
  });

const schedules = program.command("schedules").description("Persist and inspect local schedules");

schedules
  .command("add")
  .description("Add a schedule from a JSON file; pass --confirm to update an existing id")
  .argument("<file>", "JSON ScheduleSpec file")
  .option("--db <path>", "SQLite database path")
  .option("--confirm", "update an existing schedule with the same id")
  .option("--json", "print machine-readable output")
  .action(async (file: string, options: DbOptions & { confirm?: boolean; json?: boolean }) => {
    const spec = await readScheduleSpecFile(file, invocationCwd);
    const store = await openScheduleStore(options.db);
    try {
      const existing = store.get(spec.id);

      if (existing && !options.confirm) {
        const result = { id: spec.id, created: false, updated: false, dryRun: true };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Dry run: would update schedule ${spec.id}.`);
          console.log("Pass --confirm to update this schedule.");
        }
        return;
      }

      store.upsert(spec);
      const result = { id: spec.id, created: !existing, updated: Boolean(existing), dryRun: false };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(existing ? `Updated schedule ${spec.id}.` : `Saved schedule ${spec.id}.`);
    } finally {
      store.close();
    }
  });

schedules
  .command("list")
  .description("List persisted schedules")
  .option("--db <path>", "SQLite database path")
  .option("--json", "print machine-readable output")
  .action(async (options: DbOptions & { json?: boolean }) => {
    const store = await openScheduleStore(options.db);
    try {
      const { schedules: rows, invalidRows } = store.listWithDiagnostics();
      reportInvalidStoredScheduleRows(invalidRows);

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No schedules found.");
        return;
      }

      for (const row of rows) {
        console.log(`${row.spec.id}\t${row.spec.name}\t${row.spec.enabled ? "enabled" : "disabled"}`);
      }
    } finally {
      store.close();
    }
  });

schedules
  .command("due")
  .description("List schedules due at process start")
  .option("--db <path>", "SQLite database path")
  .option("--json", "print machine-readable output")
  .action(async (options: DbOptions & { json?: boolean }) => {
    const store = await openScheduleStore(options.db);
    try {
      const { schedules: rows, invalidRows } = store.listWithDiagnostics();
      reportInvalidStoredScheduleRows(invalidRows);
      const due = getDueSchedules(rows).map((stored) => ({
        ...stored,
        runRequest: createScheduleRunRequest(stored.spec)
      }));

      if (options.json) {
        console.log(JSON.stringify(due, null, 2));
        return;
      }

      if (due.length === 0) {
        console.log("No schedules due.");
        return;
      }

      for (const row of due) {
        console.log(`${row.spec.id}\t${row.spec.name}`);
      }
    } finally {
      store.close();
    }
  });

schedules
  .command("import")
  .description("Import workspace .builder/schedules.json into the SQLite schedule queue")
  .option("-w, --workspace <path>", "workspace path", invocationCwd)
  .option("--db <path>", "SQLite database path")
  .option("--replace", "remove SQLite schedules that are not present in schedules.json")
  .option("--confirm", "delete stale schedules when used with --replace")
  .option("--json", "print machine-readable output")
  .action(async (options: ImportSchedulesOptions) => {
    if (options.confirm && !options.replace) {
      throw new Error("schedules import --confirm requires --replace");
    }

    const specs = await readWorkspaceSchedules(options.workspace);
    const store = await openScheduleStore(options.db);

    try {
      const importedIds = new Set(specs.map((spec) => spec.id));
      for (const spec of specs) {
        store.upsert(spec);
      }

      const staleIds: string[] = [];
      if (options.replace) {
        const { schedules: rows, invalidRows } = store.listWithDiagnostics();
        reportInvalidStoredScheduleRows(invalidRows);
        for (const stored of rows) {
          if (!importedIds.has(stored.spec.id)) {
            staleIds.push(stored.spec.id);
          }
        }
      }

      let removed = 0;
      if (options.replace && options.confirm) {
        for (const id of staleIds) {
          store.remove(id);
          removed += 1;
        }
      }

      const result = {
        imported: specs.length,
        removed,
        dryRun: Boolean(options.replace && !options.confirm),
        stale: staleIds.length
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Imported ${specs.length} schedule${specs.length === 1 ? "" : "s"}.`);
        if (options.replace) {
          if (options.confirm) {
            console.log(`Removed ${removed} stale schedule${removed === 1 ? "" : "s"}.`);
          } else {
            console.log(`Dry run: ${staleIds.length} stale schedule${staleIds.length === 1 ? "" : "s"} would be removed.`);
            console.log("Pass --confirm with --replace to delete stale schedules.");
          }
        }
      }
    } finally {
      store.close();
    }
  });

schedules
  .command("run-due")
  .description("Run schedules due now once through Codex")
  .option("--db <path>", "SQLite database path")
  .option("--run-timeout-seconds <seconds>", "fail each scheduled Codex run after this many seconds")
  .action(async (options: RunDueCommandOptions) => {
    const timeoutMs = parseOptionalTimeoutSeconds(options.runTimeoutSeconds, "scheduled run timeout");
    const store = await openScheduleStore(options.db);
    const signals = installCliAbortController();

    try {
      const result = await runDueSchedulesOnce(store, {
        runtimeStartedAt: new Date(),
        emit: (line) => console.log(line),
        abortSignal: signals.signal,
        timeoutMs
      });
      const interruptedExitCode = signals.exitCode();

      if (interruptedExitCode !== undefined) {
        process.exitCode = interruptedExitCode;
      } else if (result.failedCount > 0) {
        process.exitCode = 1;
      }
    } finally {
      signals.dispose();
      store.close();
    }
  });

schedules
  .command("daemon")
  .description("Run due schedules while the Builder daemon is active")
  .option("--db <path>", "SQLite database path")
  .option("--interval-seconds <seconds>", "poll interval in seconds", "60")
  .option("--run-timeout-seconds <seconds>", "fail each scheduled Codex run after this many seconds")
  .option("--once", "run one scheduler tick and exit")
  .action(async (options: DaemonOptions) => {
    const intervalSeconds = Number(options.intervalSeconds);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
      throw new Error("daemon requires --interval-seconds to be a whole number greater than 0");
    }
    const timeoutMs = parseOptionalTimeoutSeconds(options.runTimeoutSeconds, "scheduled run timeout");

    const runtimeStartedAt = new Date();
    const sleeper = createInterruptibleSleep();
    const abortController = new AbortController();
    let stopping = false;
    let store: SqliteScheduleStore | undefined;

    const stop = () => {
      stopping = true;
      abortController.abort();
      sleeper.interrupt();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      store = await openScheduleStore(options.db);
      if (!stopping) {
        do {
          const result = await runDueSchedulesOnce(store, {
            runtimeStartedAt,
            emit: (line) => console.log(line),
            abortSignal: abortController.signal,
            timeoutMs
          });

          if (result.failedCount > 0) {
            process.exitCode = 1;
          }

          if (options.once || stopping) {
            break;
          }

          await sleeper.sleep(intervalSeconds * 1000);
        } while (!stopping);
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      store?.close();
    }
  });

schedules
  .command("remove")
  .description("Preview removing a persisted schedule; pass --confirm to delete it")
  .argument("<id>", "schedule id")
  .option("--db <path>", "SQLite database path")
  .option("--confirm", "delete the schedule instead of only previewing it")
  .option("--json", "print machine-readable output")
  .action(async (id: string, options: DbOptions & { confirm?: boolean; json?: boolean }) => {
    const store = await openScheduleStore(options.db);
    try {
      const stored = store.get(id);

      if (!stored) {
        throw new Error(`schedule not found: ${id}`);
      }

      if (!options.confirm) {
        const result = { dryRun: true, id, removed: false };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Dry run: would remove schedule ${id}.`);
          console.log("Pass --confirm to delete this schedule.");
        }
        return;
      }

      store.remove(id);

      const result = { dryRun: false, id, removed: true };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Removed schedule ${id}.`);
      }
    } finally {
      store.close();
    }
  });

interface RunOptions {
  workspace: string;
  prompt?: string;
  promptFile?: string;
  model?: string;
  profile?: string;
  sandbox: string;
  approval: string;
  skill?: string[];
  context?: string[];
  timeoutSeconds?: string;
  dryRun?: boolean;
  json?: boolean;
  unsafeShowPaths?: boolean;
}

interface DbOptions {
  db?: string;
}

interface ImportSchedulesOptions extends DbOptions {
  workspace: string;
  replace?: boolean;
  confirm?: boolean;
  json?: boolean;
}

interface DaemonOptions extends DbOptions {
  intervalSeconds: string;
  runTimeoutSeconds?: string;
  once?: boolean;
}

interface RunDueCommandOptions extends DbOptions {
  runTimeoutSeconds?: string;
}

interface RunDueOptions {
  runtimeStartedAt: Date;
  emit: (line: string) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

interface RunDueResult {
  dueCount: number;
  successCount: number;
  failedCount: number;
  cancelledCount: number;
}

interface RestoreWorkspaceBackupPreview {
  dryRun: true;
  restored: WorkspaceBackupSummary;
  targetRelativePath: string;
}

async function readPrompt(options: RunOptions): Promise<string> {
  if (options.promptFile) {
    return readRegularTextFile(resolveFromInvocationCwd(options.promptFile), "prompt file");
  }

  if (options.prompt) {
    return options.prompt;
  }

  throw new Error("run requires --prompt or --prompt-file");
}

async function openScheduleStore(dbPath?: string): Promise<SqliteScheduleStore> {
  const resolved = resolveFromInvocationCwd(dbPath ?? path.join(invocationCwd, ".builder", "schedules.sqlite"));
  await ensureScheduleDatabaseDirectory(path.dirname(resolved));
  return new SqliteScheduleStore(resolved);
}

async function ensureScheduleDatabaseDirectory(directoryPath: string): Promise<void> {
  const missingDirectories: string[] = [];
  let currentPath = path.resolve(directoryPath);

  while (true) {
    try {
      const metadata = await lstat(currentPath);

      if (metadata.isSymbolicLink()) {
        throw new Error(`SQLite schedule database directory must not be a symlink: ${currentPath}`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`SQLite schedule database path exists but is not a directory: ${currentPath}`);
      }
      break;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      missingDirectories.push(currentPath);
      const parent = path.dirname(currentPath);
      if (parent === currentPath) {
        throw error;
      }
      currentPath = parent;
    }
  }

  await mkdir(directoryPath, { recursive: true });

  for (const createdPath of missingDirectories.reverse()) {
    const metadata = await lstat(createdPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`SQLite schedule database directory must not be a symlink: ${createdPath}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`SQLite schedule database path exists but is not a directory: ${createdPath}`);
    }
  }
}

async function readScheduleSpecFile(file: string, basePath: string): Promise<ScheduleSpec> {
  const spec = normalizeScheduleWorkspacePath(
    JSON.parse(await readRegularTextFile(resolveFromInvocationCwd(file), "schedule file")) as ScheduleSpec,
    basePath
  );
  validateScheduleSpec(spec);
  return spec;
}

async function printRunEvents(events: AsyncIterable<AgentRunEvent>): Promise<boolean> {
  let failed = false;

  for await (const event of events) {
    console.log(JSON.stringify(event));
    if (event.type === "error") {
      failed = true;
    }
  }

  return failed;
}

function resolveFromInvocationCwd(targetPath: string): string {
  return path.resolve(invocationCwd, targetPath);
}

function configuredCodexBin(): string | undefined {
  return process.env.BUILDER_GEAR_CODEX_BIN?.trim() || undefined;
}

function parseOptionalTimeoutSeconds(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);
  const maxSeconds = Math.floor(MAX_CODEX_RUN_TIMEOUT_MS / 1000);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > maxSeconds) {
    throw new Error(`${label} must be a whole number between 1 and ${maxSeconds} seconds`);
  }

  return seconds * 1000;
}

function redactedDryRunInvocation(invocation: ReturnType<typeof buildCodexInvocation>): ReturnType<typeof buildCodexInvocation> {
  return {
    bin: redactLocalPathLikeText(invocation.bin),
    args: invocation.args.map((arg) => redactLocalPathLikeText(arg))
  };
}

async function previewWorkspaceBackupRestore(workspacePath: string, backupName: string): Promise<RestoreWorkspaceBackupPreview> {
  const rows = await listWorkspaceBackups(workspacePath);
  const restored = rows.find((backup) => backup.name === backupName);

  if (!restored) {
    throw new Error(`workspace backup not found: ${backupName}`);
  }

  if (!restored.targetRelativePath) {
    throw new Error(`workspace backup cannot be restored by the CLI: ${backupName}`);
  }

  return {
    dryRun: true,
    restored,
    targetRelativePath: restored.targetRelativePath
  };
}

async function readWorkspaceSchedules(workspacePath: string): Promise<ScheduleSpec[]> {
  const resolvedWorkspace = await resolveExistingWorkspaceRoot(resolveFromInvocationCwd(workspacePath));
  const schedulePath = path.join(resolvedWorkspace, ".builder", "schedules.json");
  await workspaceChildDirForRead(resolvedWorkspace, ".builder", "builder");
  const source = await readRegularTextFile(schedulePath, "schedules file");
  const parsed = JSON.parse(source) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`${schedulePath} must contain a schedule array`);
  }

  return parsed.map((item, index) => {
    try {
      const spec = normalizeScheduleWorkspacePath(item as ScheduleSpec, resolvedWorkspace);
      validateScheduleSpec(spec);
      return spec;
    } catch (error) {
      throw new Error(`${schedulePath} schedule[${index}]: ${errorMessage(error)}`);
    }
  });
}

async function runDueSchedulesOnce(store: SqliteScheduleStore, options: RunDueOptions): Promise<RunDueResult> {
  const { schedules, invalidRows } = store.listWithDiagnostics();
  const due = getDueSchedules(schedules, new Date(), options.runtimeStartedAt);
  let successCount = 0;
  let failedCount = invalidRows.length;
  let cancelledCount = 0;

  invalidRows.forEach((row, index) => {
    options.emit(JSON.stringify(invalidStoredScheduleRowEvent(row, index)));
  });

  for (const stored of due) {
    if (options.abortSignal?.aborted) {
      break;
    }

    const claimStartedAt = new Date();
    const claimTimeoutMs = scheduleRunClaimTtlMs(stored.spec, options.timeoutMs);
    if (!store.tryClaimRun(
      stored.spec.id,
      claimStartedAt.toISOString(),
      claimTimeoutMs,
      new Date(claimStartedAt.getTime() - claimTimeoutMs).toISOString()
    )) {
      continue;
    }

    let succeeded = false;
    let cancelled = false;
    let request: AgentRunRequest;
    try {
      request = await scheduledRunRequestForCli(stored.spec);
    } catch (error) {
      options.emit(JSON.stringify(schedulePreparationFailedEvent(stored.spec, error)));
      failedCount += 1;
      store.clearRunClaim(stored.spec.id);
      continue;
    }

    try {
      for await (const event of runCodexExec(request, {
        codexBin: configuredCodexBin(),
        env: process.env,
        abortSignal: options.abortSignal,
        timeoutMs: options.timeoutMs
      })) {
        options.emit(JSON.stringify(event));
        if (event.type === "done") {
          succeeded = true;
        }
        if (event.type === "error") {
          cancelled = isCancelledRunEvent(event);
          succeeded = false;
        }
      }

      if (succeeded) {
        store.markRun(stored.spec.id, new Date().toISOString());
        successCount += 1;
      } else if (cancelled) {
        cancelledCount += 1;
        store.clearRunClaim(stored.spec.id);
      } else {
        failedCount += 1;
        store.clearRunClaim(stored.spec.id);
      }
    } catch (error) {
      store.clearRunClaim(stored.spec.id);
      throw error;
    }

    if (options.abortSignal?.aborted) {
      break;
    }
  }

  return {
    dueCount: due.length,
    successCount,
    failedCount,
    cancelledCount
  };
}

function invalidStoredScheduleRowEvent(row: InvalidStoredScheduleRow, index: number): AgentRunEvent {
  return {
    runId: `schedule-store-${Date.now()}-${index}`,
    type: "error",
    timestamp: new Date().toISOString(),
    payload: {
      scheduleId: safeCliErrorMessage(row.id),
      exitCode: null,
      message: safeCliErrorMessage(row.message)
    }
  };
}

function schedulePreparationFailedEvent(spec: ScheduleSpec, error: unknown): AgentRunEvent {
  return {
    runId: `schedule-${spec.id}-${Date.now()}`,
    type: "error",
    timestamp: new Date().toISOString(),
    payload: {
      scheduleId: spec.id,
      exitCode: null,
      message: safeCliErrorMessage(error)
    }
  };
}

async function scheduledRunRequestForCli(spec: ScheduleSpec): Promise<AgentRunRequest> {
  const request = createScheduleRunRequest(spec);

  return {
    ...request,
    workspacePath: await resolveExistingWorkspaceRoot(path.resolve(invocationCwd, request.workspacePath))
  };
}

function normalizeScheduleWorkspacePath(spec: ScheduleSpec, basePath: string): ScheduleSpec {
  if (!spec.runRequest || typeof spec.runRequest.workspacePath !== "string") {
    return spec;
  }

  return {
    ...spec,
    runRequest: {
      ...spec.runRequest,
      workspacePath: resolveScheduleWorkspacePath(spec.runRequest.workspacePath, basePath)
    }
  };
}

function resolveScheduleWorkspacePath(workspacePath: string, basePath: string): string {
  if (!workspacePath.trim()) {
    return workspacePath;
  }

  return path.isAbsolute(workspacePath)
    ? path.resolve(workspacePath)
    : path.resolve(basePath, workspacePath);
}

function isCancelledRunEvent(event: AgentRunEvent): boolean {
  return Boolean(
    event.payload &&
      typeof event.payload === "object" &&
      "cancelled" in event.payload &&
      (event.payload as { cancelled?: unknown }).cancelled === true
  );
}

function installCliAbortController(): {
  signal: AbortSignal;
  exitCode: () => number | undefined;
  dispose: () => void;
} {
  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;

  const interrupt = (signal: NodeJS.Signals) => {
    interruptedBy ??= signal;
    controller.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    exitCode: () => signalExitCode(interruptedBy),
    dispose: () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  };
}

function signalExitCode(signal: NodeJS.Signals | undefined): number | undefined {
  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  return undefined;
}

function createInterruptibleSleep() {
  let wake: (() => void) | undefined;

  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);

        function done() {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }

        wake = done;
      });
    },
    interrupt() {
      wake?.();
    }
  };
}

function reportInvalidStoredScheduleRows(rows: InvalidStoredScheduleRow[]): void {
  for (const row of rows) {
    console.error(safeCliErrorMessage(`Invalid stored schedule ${row.id}: ${row.message}`));
  }

  if (rows.length > 0) {
    process.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const argv = process.argv[2] === "--" ? process.argv.filter((_, index) => index !== 2) : process.argv;

program.parseAsync(argv).catch((error: unknown) => {
  if (!isCommanderDisplayError(error)) {
    console.error(safeCliErrorMessage(error));
  }
  process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
});

function safeCliErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactLocalPathLikeText(redactSecretLikeText(raw));
  const truncated = Array.from(redacted).slice(0, 2000).join("");

  return truncated.length === redacted.length ? truncated : `${truncated}...`;
}

function isCommanderDisplayError(error: unknown): boolean {
  return error instanceof CommanderError && error.code.startsWith("commander.");
}
