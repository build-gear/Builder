import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_REGULAR_TEXT_FILE_BYTES } from "@builder/core";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

describe("builder CLI", () => {
  it("prints the CLI package version", () => {
    const result = runBuilder(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("initializes a starter workspace without overwriting existing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-init-"));
    const workspace = path.join(root, "workspace");

    const first = runBuilder(["init", "--workspace", workspace, "--json"]);
    expect(first.status).toBe(0);
    const firstResult = JSON.parse(first.stdout) as { files: Array<{ path: string; status: string }> };

    expect(firstResult.files.map((file) => file.status)).toEqual(["created", "created", "created", "created"]);
    expect(existsSync(path.join(workspace, "skills", "build-plan", "skill.yaml"))).toBe(true);
    expect(existsSync(path.join(workspace, "ontology", "builder-gear.json"))).toBe(true);
    expect(existsSync(path.join(workspace, ".builder", "schedules.json"))).toBe(true);

    const instructionsPath = path.join(workspace, "skills", "build-plan", "instructions.md");
    await writeFile(instructionsPath, "# Custom instructions\n");
    const second = runBuilder(["init", "--workspace", workspace, "--json"]);
    const secondResult = JSON.parse(second.stdout) as { files: Array<{ path: string; status: string }> };

    expect(second.status).toBe(0);
    expect(secondResult.files.every((file) => file.status === "existing")).toBe(true);
    await expect(readFile(instructionsPath, "utf8")).resolves.toBe("# Custom instructions\n");
  });

  it("keeps prompt text and local paths out of run dry-run argv output by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-"));
    const prompt = "Do not leak this prompt";
    const codexBin = path.join(root, "mock-codex");
    const result = runBuilder([
      "run",
      "--workspace",
      root,
      "--prompt",
      prompt,
      "--skill",
      "build-plan",
      "--context",
      "goal-first-run",
      "--profile",
      path.join(root, "codex-profile"),
      "--model",
      `file://${path.join(root, "model.txt")}`,
      "--timeout-seconds",
      "1200",
      "--dry-run",
      "--json"
    ], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const output = JSON.parse(result.stdout) as {
      bin: string;
      args: string[];
      redacted: boolean;
      timeoutSeconds: number;
      skillIds: string[];
      ontologyContextIds: string[];
    };

    expect(result.status).toBe(0);
    expect(output.redacted).toBe(true);
    expect(output.bin).toBe("[LOCAL_PATH]");
    expect(output.args.at(-1)).toBe("-");
    expect(JSON.stringify(output)).not.toContain(prompt);
    expect(JSON.stringify(output)).not.toContain(root);
    expect(JSON.stringify(output)).not.toContain(codexBin);
    expect(output.args[output.args.indexOf("--cd") + 1]).toBe("[LOCAL_PATH]");
    expect(output.args[output.args.indexOf("--profile") + 1]).toBe("[LOCAL_PATH]");
    expect(output.args[output.args.indexOf("--model") + 1]).toBe("[LOCAL_FILE_URL]");
    expect(output.timeoutSeconds).toBe(1200);
    expect(output.skillIds).toEqual(["build-plan"]);
    expect(output.ontologyContextIds).toEqual(["goal-first-run"]);
  });

  it("prints exact dry-run invocation paths only when explicitly requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-unsafe-dry-run-"));
    const codexBin = path.join(root, "mock-codex");
    const result = runBuilder([
      "run",
      "--workspace",
      root,
      "--prompt",
      "Do not execute",
      "--dry-run",
      "--unsafe-show-paths"
    ], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const canonicalRoot = await realpath(root);
    const output = JSON.parse(result.stdout) as {
      bin: string;
      args: string[];
      redacted: boolean;
    };

    expect(result.status).toBe(0);
    expect(output.redacted).toBe(false);
    expect(output.bin).toBe(codexBin);
    expect(output.args[output.args.indexOf("--cd") + 1]).toBe(canonicalRoot);
    expect(JSON.stringify(output)).not.toContain("Do not execute");
  });

  it("rejects oversized prompt files before spawning Codex", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-large-prompt-"));
    const promptPath = path.join(root, "prompt.txt");
    const { codexBin, argsPath } = await createMockCodex(root);
    await writeFile(promptPath, "x".repeat(MAX_REGULAR_TEXT_FILE_BYTES + 1));

    const result = runBuilder(["run", "--workspace", root, "--prompt-file", promptPath], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`prompt file exceeds maximum size of ${MAX_REGULAR_TEXT_FILE_BYTES} bytes`);
    expect(existsSync(argsPath)).toBe(false);
  });

  it("returns a failing exit code when Codex exits non-zero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-failure-"));
    const { codexBin } = await createMockCodex(root, { exitCode: 7 });

    const result = runBuilder(["run", "--workspace", root, "--prompt", "Trigger failure"], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(result.status).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["queued", "codex_event", "stdout", "error"]);
    expect(events.at(-1)?.payload.exitCode).toBe(7);
  });

  it("times out a hanging run without treating it as a user cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-timeout-"));
    const { codexBin, stdinPath } = await createMockCodex(root, { hangAfterStdin: true });

    const result = runBuilder(["run", "--workspace", root, "--prompt", "Trigger timeout", "--timeout-seconds", "1"], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(result.status).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["queued", "codex_event", "stdout", "error"]);
    expect(events.at(-1)?.payload).toMatchObject({
      timedOut: true,
      timeoutMs: 1000
    });
    expect(events.at(-1)?.payload).not.toHaveProperty("cancelled");
    await expect(readFile(stdinPath, "utf8")).resolves.toBe("Trigger timeout");
  });

  it("cancels an active CLI run on termination", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-cancel-"));
    const { codexBin, argsPath } = await createMockCodex(root, { hangAfterStdin: true });
    const child = runBuilderProcess(["run", "--workspace", root, "--prompt", "Long run"], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const resultPromise = waitForExit(child, 5_000);

    await waitUntil(() => existsSync(argsPath), 5_000);
    child.kill("SIGTERM");
    const result = await resultPromise;
    const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(143);
    expect(result.signal).toBeNull();
    expect(events.some((event) => event.type === "error" && event.payload.cancelled === true)).toBe(true);
  });

  it("rejects symlinked run workspaces before spawning Codex", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-workspace-symlink-"));
    const target = path.join(root, "target-workspace");
    const link = path.join(root, "workspace-link");
    const { codexBin, argsPath } = await createMockCodex(root);
    await mkdir(target, { recursive: true });
    await symlink(target, link);

    const result = runBuilder(["run", "--workspace", link, "--prompt", "Do not run"], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace path must not be a symlink");
    expect(result.stderr).toContain("[LOCAL_PATH]");
    expect(result.stderr).not.toContain(link);
    expect(existsSync(argsPath)).toBe(false);
  });

  it("rejects unsafe run reference ids before spawning Codex", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-unsafe-id-"));
    const { codexBin, argsPath } = await createMockCodex(root);

    const result = runBuilder([
      "run",
      "--workspace",
      root,
      "--prompt",
      "Do not run",
      "--skill",
      "bad/skill"
    ], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("skillIds[0] contains unsupported id characters");
    expect(existsSync(argsPath)).toBe(false);
  });

  it("runs doctor through the CLI without printing auth contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-doctor-"));
    const workspace = path.join(root, "workspace");
    const codexHome = path.join(root, "codex-home");
    const { codexBin } = await createMockCodex(root);
    const secret = "sess-testsecretvalue1234567890";

    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ session_token: secret }), { mode: 0o600 });

    const init = runBuilder(["init", "--workspace", workspace, "--json"]);
    expect(init.status).toBe(0);

    const result = runBuilder(["doctor", "--workspace", workspace, "--json"], {
      BUILDER_GEAR_CODEX_BIN: codexBin,
      CODEX_HOME: codexHome
    });
    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ id: string; status: string; message: string }>;
    };

    expect(result.status).toBe(0);
    expect(report.status).toBe("pass");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-cli", status: "pass" }),
      expect.objectContaining({ id: "codex-auth", status: "pass" }),
      expect.objectContaining({ id: "workspace", status: "pass" }),
      expect.objectContaining({ id: "skills", status: "pass" }),
      expect.objectContaining({ id: "ontology", status: "pass" }),
      expect.objectContaining({ id: "schedules", status: "pass" })
    ]));
    expect(result.stdout).toContain("[WORKSPACE_PATH]");
    expect(result.stdout).toContain("[LOCAL_PATH]");
    expect(result.stdout).not.toContain(workspace);
    expect(result.stdout).not.toContain(codexHome);
    expect(result.stdout).not.toContain(secret);
  });

  it("prints a redacted support bundle from doctor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-support-"));
    const workspace = path.join(root, "workspace");
    const codexHome = path.join(root, "codex-home");
    const { codexBin } = await createMockCodex(root);
    const secret = "sess-testsecretvalue1234567890";

    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ session_token: secret }), { mode: 0o600 });

    const init = runBuilder(["init", "--workspace", workspace, "--json"]);
    expect(init.status).toBe(0);

    const result = runBuilder(["doctor", "--workspace", workspace, "--support"], {
      BUILDER_GEAR_CODEX_BIN: codexBin,
      CODEX_HOME: codexHome
    });
    const bundle = JSON.parse(result.stdout) as {
      schemaVersion: number;
      appVersion: string;
      health: { status: string; checks: Array<{ message: string }> };
      privacy: {
        redacted: boolean;
        includesAuthContents: boolean;
        includesRawPrompts: boolean;
        includesWorkspacePaths: boolean;
        includesRunPayloads: boolean;
      };
    };

    expect(result.status).toBe(0);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.appVersion).toBe("0.1.0");
    expect(bundle.health.status).toBe("pass");
    expect(bundle.privacy).toEqual({
      redacted: true,
      includesAuthContents: false,
      includesRawPrompts: false,
      includesWorkspacePaths: false,
      includesRunPayloads: false
    });
    expect(result.stdout).not.toContain(workspace);
    expect(result.stdout).not.toContain(codexHome);
    expect(result.stdout).not.toContain(secret);
  });

  it("previews and restores workspace backups through the CLI only after confirmation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-cli-backups-"));
    const backupName = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
    await mkdir(path.join(workspace, ".builder", "backups"), { recursive: true });
    await writeFile(path.join(workspace, ".builder", "schedules.json"), "current schedule content");
    await writeFile(path.join(workspace, ".builder", "backups", backupName), "previous schedule content");

    const list = runBuilder(["backups", "list", "--workspace", workspace, "--json"]);
    const backups = JSON.parse(list.stdout) as Array<{ name: string; kind: string; targetRelativePath?: string }>;

    expect(list.status).toBe(0);
    expect(backups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: backupName,
        kind: "schedules-save",
        targetRelativePath: ".builder/schedules.json"
      })
    ]));
    expect(list.stdout).not.toContain("previous schedule content");

    const preview = runBuilder(["backups", "restore", backupName, "--workspace", workspace, "--json"]);
    const previewResult = JSON.parse(preview.stdout) as {
      dryRun: boolean;
      targetRelativePath: string;
    };

    expect(preview.status).toBe(0);
    expect(previewResult.dryRun).toBe(true);
    expect(previewResult.targetRelativePath).toBe(".builder/schedules.json");
    await expect(readFile(path.join(workspace, ".builder", "schedules.json"), "utf8")).resolves.toBe("current schedule content");

    const restored = runBuilder(["backups", "restore", backupName, "--workspace", workspace, "--confirm", "--json"]);
    const result = JSON.parse(restored.stdout) as {
      dryRun: boolean;
      targetRelativePath: string;
      preRestoreBackup?: { relativePath: string; kind: string };
    };

    expect(restored.status).toBe(0);
    expect(result.dryRun).toBe(false);
    expect(result.targetRelativePath).toBe(".builder/schedules.json");
    expect(result.preRestoreBackup?.kind).toBe("restore-preimage");
    await expect(readFile(path.join(workspace, ".builder", "schedules.json"), "utf8")).resolves.toBe("previous schedule content");
    await expect(readFile(path.join(workspace, result.preRestoreBackup!.relativePath), "utf8")).resolves.toBe("current schedule content");
  });

  it("prunes old workspace backups only after confirmation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-cli-backups-prune-"));
    const backupsDir = path.join(workspace, ".builder", "backups");
    await mkdir(backupsDir, { recursive: true });
    const newest = "20260624T030000Z-3-schedules-save-.builder-schedules.json";
    const middle = "20260624T020000Z-2-schedules-save-.builder-schedules.json";
    const oldest = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
    await writeFile(path.join(backupsDir, newest), "newest");
    await writeFile(path.join(backupsDir, middle), "middle");
    await writeFile(path.join(backupsDir, oldest), "oldest");

    const dryRun = runBuilder(["backups", "prune", "--workspace", workspace, "--keep", "1", "--json"]);
    const dryRunResult = JSON.parse(dryRun.stdout) as { dryRun: boolean; candidates: Array<{ name: string }> };

    expect(dryRun.status).toBe(0);
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.candidates.map((backup) => backup.name)).toEqual([middle, oldest]);
    expect(existsSync(path.join(backupsDir, middle))).toBe(true);
    expect(existsSync(path.join(backupsDir, oldest))).toBe(true);

    const confirmed = runBuilder(["backups", "prune", "--workspace", workspace, "--keep", "1", "--confirm", "--json"]);
    const confirmedResult = JSON.parse(confirmed.stdout) as { dryRun: boolean; pruned: Array<{ name: string }> };

    expect(confirmed.status).toBe(0);
    expect(confirmedResult.dryRun).toBe(false);
    expect(confirmedResult.pruned.map((backup) => backup.name)).toEqual([middle, oldest]);
    expect(existsSync(path.join(backupsDir, newest))).toBe(true);
    expect(existsSync(path.join(backupsDir, middle))).toBe(false);
    expect(existsSync(path.join(backupsDir, oldest))).toBe(false);
  });

  it("rejects invalid schedule JSON before SQLite persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-schedule-"));
    const schedulePath = path.join(root, "schedule.json");
    const dbPath = path.join(root, "schedules.sqlite");
    await writeFile(schedulePath, JSON.stringify({
      id: "bad-schedule",
      name: "Bad Schedule",
      trigger: { kind: "interval", everySeconds: 60 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: root,
        prompt: "",
        sandboxMode: "invalid",
        approvalMode: "never"
      }
    }));

    const result = runBuilder(["schedules", "add", schedulePath, "--db", dbPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("runRequest is invalid: prompt is required");
    expect(result.stderr).toContain("unsupported sandboxMode");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("previews schedule add updates and requires confirmation to replace an existing id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-schedule-add-"));
    const schedulePath = path.join(root, "schedule.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const schedule = {
      id: "daily-plan",
      name: "Daily Plan",
      trigger: { kind: "interval", everySeconds: 60 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: root,
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    };

    await writeFile(schedulePath, JSON.stringify(schedule));
    const created = runBuilder(["schedules", "add", schedulePath, "--db", dbPath, "--json"]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ id: "daily-plan", created: true, updated: false, dryRun: false });

    await writeFile(schedulePath, JSON.stringify({ ...schedule, name: "Daily Plan Updated" }));
    const preview = runBuilder(["schedules", "add", schedulePath, "--db", dbPath, "--json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({ id: "daily-plan", created: false, updated: false, dryRun: true });
    expect(JSON.parse(runBuilder(["schedules", "list", "--db", dbPath, "--json"]).stdout)[0].spec.name).toBe("Daily Plan");

    const updated = runBuilder(["schedules", "add", schedulePath, "--db", dbPath, "--confirm", "--json"]);
    expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout)).toEqual({ id: "daily-plan", created: false, updated: true, dryRun: false });
    expect(JSON.parse(runBuilder(["schedules", "list", "--db", dbPath, "--json"]).stdout)[0].spec.name).toBe("Daily Plan Updated");
  });

  it("redacts secret-shaped values from CLI validation errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-redaction-"));
    const secret = "OPENAI_API_KEY=sk-1234567890abcdefghijkl";

    const result = runBuilder([
      "run",
      "--workspace",
      root,
      "--prompt",
      "Check validation",
      "--sandbox",
      secret,
      "--dry-run"
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY=[REDACTED_KEY]");
    expect(result.stderr).not.toContain("abcdefghijkl");
  });

  it("redacts parser-level Commander errors before printing stderr", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-parser-redaction-"));
    const secretOption = "--OPENAI_API_KEY=sk-1234567890abcdefghijkl";

    const result = runBuilder([
      "run",
      "--workspace",
      root,
      "--prompt",
      "Do not execute",
      secretOption
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option");
    expect(result.stderr).toContain("OPENAI_API_KEY=[REDACTED_KEY]");
    expect(result.stderr).not.toContain("abcdefghijkl");
    expect(result.stderr).not.toContain(secretOption);
  });

  it("imports workspace schedules then runs due schedules through Codex", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const { codexBin, stdinPath, argsPath } = await createMockCodex(root);

    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([{
      id: "daily-plan",
      name: "Daily Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: ".",
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never",
        skillIds: ["build-plan"],
        ontologyContextIds: ["goal-first-run"]
      }
    }]));

    const imported = runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath, "--json"]);
    expect(imported.status).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({ imported: 1, removed: 0, dryRun: false, stale: 0 });
    const list = runBuilder(["schedules", "list", "--db", dbPath, "--json"]);
    const canonicalRoot = await realpath(root);
    expect(JSON.parse(list.stdout)[0].spec.runRequest.workspacePath).toBe(canonicalRoot);

    const run = runBuilder(["schedules", "run-due", "--db", dbPath], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(run.status).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["queued", "codex_event", "stdout", "done"]);
    expect(events[0]?.payload.scheduleId).toBe("daily-plan");
    expect(events[0]?.payload.workspaceSelected).toBe(true);
    expect(events[0]?.payload.pathRedacted).toBe(true);
    expect(events[0]?.payload).not.toHaveProperty("workspacePath");
    expect(run.stdout).not.toContain(root);
    expect(run.stdout).not.toContain(canonicalRoot);
    expect(run.stdout).not.toContain("Scheduled prompt");
    await expect(readFile(stdinPath, "utf8")).resolves.toBe("Scheduled prompt");
    const args = await readFile(argsPath, "utf8");
    expect(args).toContain("-\n");
    expect(args).toContain(`${canonicalRoot}\n`);

    const due = runBuilder(["schedules", "due", "--db", dbPath, "--json"]);
    expect(JSON.parse(due.stdout)).toEqual([]);
  });

  it("keeps failed due schedules pending and returns a failing exit code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-failure-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const { codexBin } = await createMockCodex(root, { exitCode: 9 });

    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([{
      id: "failing-plan",
      name: "Failing Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: ".",
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));

    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);

    const run = runBuilder(["schedules", "run-due", "--db", dbPath], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(run.status).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["queued", "codex_event", "stdout", "error"]);
    expect(events.at(-1)?.payload.exitCode).toBe(9);

    const due = runBuilder(["schedules", "due", "--db", dbPath, "--json"]);
    expect(JSON.parse(due.stdout)[0].spec.id).toBe("failing-plan");
  });

  it("keeps timed-out due schedules pending and returns a failing exit code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-timeout-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const { codexBin } = await createMockCodex(root, { hangAfterStdin: true });

    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([{
      id: "timed-out-plan",
      name: "Timed Out Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: ".",
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));

    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);

    const run = runBuilder(["schedules", "run-due", "--db", dbPath, "--run-timeout-seconds", "1"], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(run.status).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["queued", "codex_event", "stdout", "error"]);
    expect(events.at(-1)?.payload).toMatchObject({
      timedOut: true,
      timeoutMs: 1000
    });

    const due = runBuilder(["schedules", "due", "--db", dbPath, "--json"]);
    expect(JSON.parse(due.stdout)[0].spec.id).toBe("timed-out-plan");
  });

  it("rejects invalid scheduled run timeouts before opening the SQLite queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-timeout-invalid-"));
    const dbPath = path.join(root, "schedules.sqlite");

    const result = runBuilder(["schedules", "run-due", "--db", dbPath, "--run-timeout-seconds", "0"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("scheduled run timeout must be a whole number");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("keeps the scheduler running when one due schedule cannot prepare its workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-missing-workspace-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const missingWorkspace = path.join(root, "missing-workspace");
    const { codexBin, stdinPath } = await createMockCodex(root);

    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([
      {
        id: "a-missing-workspace",
        name: "Missing Workspace",
        trigger: { kind: "interval", everySeconds: 86400 },
        timezone: "UTC",
        missedRunPolicy: "run-on-start",
        enabled: true,
        runRequest: {
          workspacePath: missingWorkspace,
          prompt: "Should not run",
          sandboxMode: "read-only",
          approvalMode: "never"
        }
      },
      {
        id: "z-valid-plan",
        name: "Valid Plan",
        trigger: { kind: "interval", everySeconds: 86400 },
        timezone: "UTC",
        missedRunPolicy: "run-on-start",
        enabled: true,
        runRequest: {
          workspacePath: ".",
          prompt: "Scheduled prompt",
          sandboxMode: "read-only",
          approvalMode: "never"
        }
      }
    ]));

    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);

    const run = runBuilder(["schedules", "run-due", "--db", dbPath], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(run.status).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["error", "queued", "codex_event", "stdout", "done"]);
    expect(events[0]?.payload.scheduleId).toBe("a-missing-workspace");
    expect(events[0]?.payload.message).toContain("[LOCAL_PATH]");
    expect(run.stdout).not.toContain(missingWorkspace);
    expect(events[1]?.payload.scheduleId).toBe("z-valid-plan");
    await expect(readFile(stdinPath, "utf8")).resolves.toBe("Scheduled prompt");

    const due = JSON.parse(runBuilder(["schedules", "due", "--db", dbPath, "--json"]).stdout) as Array<{ spec: { id: string } }>;
    expect(due.map((row) => row.spec.id)).toEqual(["a-missing-workspace"]);
  });

  it("keeps the scheduler running when the SQLite queue contains a corrupt row", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-corrupt-row-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const { codexBin, stdinPath } = await createMockCodex(root);

    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([{
      id: "z-valid-plan",
      name: "Valid Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: ".",
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));

    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);
    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, null)")
      .run("a-corrupt-row", "{ not json");
    db.close();

    const run = runBuilder(["schedules", "run-due", "--db", dbPath], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const events = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(run.status).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["error", "queued", "codex_event", "stdout", "done"]);
    expect(events[0]?.payload.scheduleId).toBe("a-corrupt-row");
    expect(events[0]?.payload.message).toContain("stored schedule a-corrupt-row is invalid");
    expect(events[1]?.payload.scheduleId).toBe("z-valid-plan");
    await expect(readFile(stdinPath, "utf8")).resolves.toBe("Scheduled prompt");

    const due = runBuilder(["schedules", "due", "--db", dbPath, "--json"]);
    expect(due.status).toBe(1);
    expect(JSON.parse(due.stdout)).toEqual([]);
    expect(due.stderr).toContain("Invalid stored schedule a-corrupt-row");
  });

  it("cancels an active run-due Codex process on termination without marking it complete", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-run-due-cancel-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const { codexBin, argsPath } = await createMockCodex(root, { hangAfterStdin: true });

    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([{
      id: "long-running-plan",
      name: "Long Running Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: root,
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));

    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);
    const child = runBuilderProcess(["schedules", "run-due", "--db", dbPath, "--run-timeout-seconds", "3"], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    const resultPromise = waitForExit(child, 5_000);

    await waitUntil(() => existsSync(argsPath), 5_000);
    const activeDb = new Database(dbPath);
    const activeRow = activeDb
      .prepare("select running_timeout_ms from schedules where id = ?")
      .get("long-running-plan") as { running_timeout_ms: number };
    activeDb.close();
    expect(activeRow.running_timeout_ms).toBe(3000);
    expect(JSON.parse(runBuilder(["schedules", "due", "--db", dbPath, "--json"]).stdout)).toEqual([]);
    const duplicateRun = runBuilder(["schedules", "run-due", "--db", dbPath], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });
    expect(duplicateRun.status).toBe(0);
    expect(duplicateRun.stdout.trim()).toBe("");

    child.kill("SIGTERM");
    const result = await resultPromise;
    const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(143);
    expect(result.signal).toBeNull();
    expect(events.some((event) => event.type === "error" && event.payload.cancelled === true)).toBe(true);
    expect(JSON.parse(runBuilder(["schedules", "due", "--db", dbPath, "--json"]).stdout)[0].spec.id).toBe("long-running-plan");
  });

  it("previews stale SQLite schedule replacement and deletes only after confirmation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-import-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    await mkdir(path.dirname(schedulePath), { recursive: true });

    await writeFile(schedulePath, JSON.stringify([{
      id: "daily-plan",
      name: "Daily Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: root,
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));
    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);

    await writeFile(schedulePath, "[]");
    const preview = runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath, "--replace", "--json"]);

    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({ imported: 0, removed: 0, dryRun: true, stale: 1 });
    expect(JSON.parse(runBuilder(["schedules", "list", "--db", dbPath, "--json"]).stdout)).toHaveLength(1);

    const replaced = runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath, "--replace", "--confirm", "--json"]);
    expect(replaced.status).toBe(0);
    expect(JSON.parse(replaced.stdout)).toEqual({ imported: 0, removed: 1, dryRun: false, stale: 1 });
    const list = runBuilder(["schedules", "list", "--db", dbPath, "--json"]);
    expect(JSON.parse(list.stdout)).toEqual([]);
  });

  it("previews schedule removal and deletes only after confirmation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-remove-schedule-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    await mkdir(path.dirname(schedulePath), { recursive: true });

    await writeFile(schedulePath, JSON.stringify([{
      id: "daily-plan",
      name: "Daily Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: root,
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));
    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);

    const preview = runBuilder(["schedules", "remove", "daily-plan", "--db", dbPath, "--json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({ dryRun: true, id: "daily-plan", removed: false });
    expect(JSON.parse(runBuilder(["schedules", "list", "--db", dbPath, "--json"]).stdout)).toHaveLength(1);

    const removed = runBuilder(["schedules", "remove", "daily-plan", "--db", dbPath, "--confirm", "--json"]);
    expect(removed.status).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ dryRun: false, id: "daily-plan", removed: true });
    expect(JSON.parse(runBuilder(["schedules", "list", "--db", dbPath, "--json"]).stdout)).toEqual([]);
  });

  it("rejects symlinked workspace schedules during import", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-schedule-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-cli-schedule-outside-"));
    const builderDir = path.join(root, ".builder");
    const dbPath = path.join(root, "schedules.sqlite");
    await mkdir(builderDir, { recursive: true });
    await writeFile(path.join(outside, "schedules.json"), "[]\n");
    await symlink(path.join(outside, "schedules.json"), path.join(builderDir, "schedules.json"));

    const result = runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schedules file must not be a symlink");
  });

  it("rejects symlinked SQLite schedule databases", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-db-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-cli-db-outside-"));
    const outsideDb = path.join(outside, "schedules.sqlite");
    const dbLink = path.join(root, "schedules.sqlite");
    await writeFile(outsideDb, "");
    await symlink(outsideDb, dbLink);

    const result = runBuilder(["schedules", "list", "--db", dbLink]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SQLite schedule database must not be a symlink");
  });

  it("rejects symlinked SQLite schedule database parent directories", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-db-parent-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-cli-db-parent-outside-"));
    const dbParentLink = path.join(root, "db-parent-link");
    const dbPath = path.join(dbParentLink, "nested", "schedules.sqlite");
    await symlink(outside, dbParentLink);

    const result = runBuilder(["schedules", "list", "--db", dbPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SQLite schedule database directory must not be a symlink");
    expect(result.stderr).toContain("[LOCAL_PATH]");
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain(outside);
    expect(existsSync(path.join(outside, "nested", "schedules.sqlite"))).toBe(false);
  });

  it("lets the schedule daemon exit promptly when a termination signal interrupts its poll sleep", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-daemon-signal-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const child = runBuilderProcess([
      "schedules",
      "daemon",
      "--db",
      dbPath,
      "--interval-seconds",
      "60"
    ]);

    const resultPromise = waitForExit(child, 3_000);
    await delay(300);
    child.kill("SIGTERM");
    const result = await resultPromise;

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeLessThan(2_500);
    expect(result.stderr).toBe("");
  });

  it("cancels an active scheduled Codex run on daemon termination without marking it complete", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-cli-daemon-cancel-run-"));
    const schedulePath = path.join(root, ".builder", "schedules.json");
    const dbPath = path.join(root, "schedules.sqlite");
    const { codexBin, argsPath } = await createMockCodex(root, { hangAfterStdin: true });
    await mkdir(path.dirname(schedulePath), { recursive: true });
    await writeFile(schedulePath, JSON.stringify([{
      id: "long-running-plan",
      name: "Long Running Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: root,
        prompt: "Scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));

    expect(runBuilder(["schedules", "import", "--workspace", root, "--db", dbPath]).status).toBe(0);
    const child = runBuilderProcess([
      "schedules",
      "daemon",
      "--db",
      dbPath,
      "--interval-seconds",
      "60"
    ], {
      BUILDER_GEAR_CODEX_BIN: codexBin
    });

    await waitUntil(() => existsSync(argsPath), 5_000);
    const resultPromise = waitForExit(child, 5_000);
    child.kill("SIGTERM");
    const result = await resultPromise;
    const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(events.some((event) => event.type === "error" && event.payload.cancelled === true)).toBe(true);
    expect(JSON.parse(runBuilder(["schedules", "due", "--db", dbPath, "--json"]).stdout)[0].spec.id).toBe("long-running-plan");
  });
});

function runBuilder(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    tsxBuilderArgs(args),
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        INIT_CWD: packageRoot
      }
    }
  );
}

function runBuilderProcess(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    tsxBuilderArgs(args),
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        ...env,
        INIT_CWD: packageRoot
      }
    }
  );
}

function tsxBuilderArgs(args: string[]): string[] {
  return [tsxCliPath(), "--conditions", "development", "src/index.ts", "--", ...args];
}

function tsxCliPath(): string {
  return path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.cjs");
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  const startedAt = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    elapsedMs: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      resolve({
        code: null,
        signal: null,
        timedOut: true,
        elapsedMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await delay(50);
  }

  throw new Error("timed out waiting for condition");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMockCodex(root: string, options: { exitCode?: number; hangAfterStdin?: boolean } = {}) {
  const scriptPath = path.join(root, "mock-codex.js");
  const argsPath = path.join(root, "mock-codex-args.txt");
  const stdinPath = path.join(root, "mock-codex-stdin.txt");
  const codexBin = path.join(root, process.platform === "win32" ? "mock-codex.cmd" : "mock-codex");
  const exitCode = options.exitCode ?? 0;
  const script = `
const fs = require("node:fs");
const argsPath = ${JSON.stringify(argsPath)};
const stdinPath = ${JSON.stringify(stdinPath)};
const exitCode = ${JSON.stringify(exitCode)};
const hangAfterStdin = ${JSON.stringify(options.hangAfterStdin ?? false)};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.40.0");
  process.exit(0);
}
fs.writeFileSync(argsPath, args.join("\\n") + "\\n");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(stdinPath, stdin);
  console.log(JSON.stringify({ type: "started", message: "mock stream" }));
  console.log("plain output");
  if (hangAfterStdin) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = exitCode;
});
`;
  await writeFile(scriptPath, script);

  if (process.platform === "win32") {
    await writeFile(codexBin, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    await writeFile(codexBin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`);
    await chmod(codexBin, 0o755);
  }

  return { codexBin, argsPath, stdinPath };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
