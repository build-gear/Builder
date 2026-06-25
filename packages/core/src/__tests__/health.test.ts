import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealthCheck } from "../health.js";

describe("workspace health checks", () => {
  it("reports actionable pass and warning checks without reading auth contents", async () => {
    const root = await mkdir(path.join(os.tmpdir(), "builder-health-"), { recursive: true })
      .then(() => os.tmpdir());
    const workspace = await mkWorkspace(root);
    const codexHome = path.join(workspace, ".codex-home");
    await mkdir(path.join(workspace, "skills", "qa-plan"), { recursive: true });
    await mkdir(path.join(workspace, "ontology"), { recursive: true });
    await mkdir(path.join(workspace, ".builder"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), '{"access_token":"secret-value"}', { mode: 0o600 });
    await writeFile(
      path.join(workspace, "skills", "qa-plan", "skill.yaml"),
      [
        "id: qa-plan",
        "name: QA Plan",
        "version: 0.1.0",
        "instructionsPath: instructions.md",
        "occupations:",
        "  - developer",
        "requiredTools:",
        "  - codex"
      ].join("\n")
    );
    await writeFile(path.join(workspace, "skills", "qa-plan", "instructions.md"), "# QA Plan\n");
    await writeFile(path.join(workspace, "ontology", "builder-gear.json"), JSON.stringify([
      {
        id: "goal-qa",
        type: "Goal",
        label: "QA Goal",
        properties: {},
        relations: []
      }
    ]));
    await writeFile(path.join(workspace, ".builder", "schedules.json"), JSON.stringify([]));

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });
    const serialized = JSON.stringify(report);

    expect(report.generatedAt).toBe("2026-06-24T00:00:00.000Z");
    expect(serialized).toContain("[WORKSPACE_PATH]");
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain(codexHome);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-cli", status: "pass" }),
      expect.objectContaining({ id: "codex-auth", status: "pass" }),
      expect.objectContaining({ id: "workspace", status: "pass" }),
      expect.objectContaining({ id: "skills", status: "pass" }),
      expect.objectContaining({ id: "ontology", status: "pass" }),
      expect.objectContaining({ id: "schedules", status: "pass" }),
      expect.objectContaining({ id: "workspace-backups", status: "pass" })
    ]));
    expect(serialized).not.toContain("secret-value");
  });

  it("redacts health paths by default while allowing explicit unsafe private output", async () => {
    const workspace = await mkWorkspace(os.tmpdir());
    const codexHome = path.join(workspace, ".codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });
    const unsafeReport = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z"),
      unsafeShowPaths: true
    });

    expect(JSON.stringify(report)).not.toContain(workspace);
    expect(JSON.stringify(report)).not.toContain(codexHome);
    expect(JSON.stringify(report)).toContain("[WORKSPACE_PATH]");
    expect(JSON.stringify(unsafeReport)).toContain(workspace);
    expect(JSON.stringify(unsafeReport)).toContain(codexHome);
  });

  it("warns when workspace backups exceed the retention threshold", async () => {
    const workspace = await mkWorkspace(os.tmpdir());
    const codexHome = path.join(workspace, ".codex-home");
    await mkdir(path.join(workspace, "skills", "qa-plan"), { recursive: true });
    await mkdir(path.join(workspace, "ontology"), { recursive: true });
    await mkdir(path.join(workspace, ".builder", "backups"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    await writeFile(
      path.join(workspace, "skills", "qa-plan", "skill.yaml"),
      [
        "id: qa-plan",
        "name: QA Plan",
        "version: 0.1.0",
        "instructionsPath: instructions.md",
        "occupations:",
        "  - developer",
        "requiredTools:",
        "  - codex"
      ].join("\n")
    );
    await writeFile(path.join(workspace, "skills", "qa-plan", "instructions.md"), "# QA Plan\n");
    await writeFile(path.join(workspace, "ontology", "builder-gear.json"), JSON.stringify([
      {
        id: "goal-qa",
        type: "Goal",
        label: "QA Goal",
        properties: {},
        relations: []
      }
    ]));
    await writeFile(path.join(workspace, ".builder", "schedules.json"), JSON.stringify([]));

    for (let index = 0; index < 51; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      await writeFile(
        path.join(workspace, ".builder", "backups", `20260624T00${minute}00Z-${index + 1}-schedules-save-.builder-schedules.json`),
        "backup"
      );
    }

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.status).toBe("warn");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "workspace-backups",
        status: "warn",
        message: expect.stringContaining("51 workspace backups"),
        action: expect.stringContaining("builder backups prune --keep 50")
      })
    ]));
  });

  it("fails missing runtime prerequisites with next actions", async () => {
    const report = await runHealthCheck({
      workspacePath: path.join(os.tmpdir(), "missing-builder-health-workspace"),
      codexBin: path.join(os.tmpdir(), "missing-codex-bin"),
      env: { CODEX_HOME: path.join(os.tmpdir(), "missing-codex-home") },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.status).toBe("fail");
    expect(report.checks.filter((check) => check.status === "fail").map((check) => check.id)).toEqual([
      "codex-cli",
      "codex-auth",
      "workspace"
    ]);
    expect(report.checks.every((check) => check.status !== "fail" || check.action)).toBe(true);
  });

  it("passes health checks for executable cron schedules", async () => {
    const root = await mkdir(path.join(os.tmpdir(), "builder-health-cron-"), { recursive: true })
      .then(() => os.tmpdir());
    const workspace = await mkWorkspace(root);
    const codexHome = path.join(workspace, ".codex-home");

    await mkdir(path.join(workspace, "skills", "cron-build"), { recursive: true });
    await mkdir(path.join(workspace, "ontology"), { recursive: true });
    await mkdir(path.join(workspace, ".builder"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    await writeFile(
      path.join(workspace, "skills", "cron-build", "skill.yaml"),
      [
        "id: cron-build",
        "name: Cron Build",
        "version: 0.1.0",
        "instructionsPath: instructions.md",
        "occupations:",
        "  - developer",
        "requiredTools:",
        "  - codex"
      ].join("\n")
    );
    await writeFile(path.join(workspace, "skills", "cron-build", "instructions.md"), "# Cron Build\n");
    await writeFile(path.join(workspace, "ontology", "builder-gear.json"), JSON.stringify([
      {
        id: "goal-cron-build",
        type: "Goal",
        label: "Cron Build",
        properties: {},
        relations: []
      }
    ]));
    await writeFile(path.join(workspace, ".builder", "schedules.json"), JSON.stringify([
      {
        id: "cron-build",
        name: "Cron Build",
        trigger: { kind: "cron", expression: "0 9 * * 1-5" },
        timezone: "Asia/Seoul",
        missedRunPolicy: "run-on-start",
        enabled: true,
        runRequest: {
          workspacePath: workspace,
          prompt: "Build from cron",
          sandboxMode: "read-only",
          approvalMode: "never"
        }
      }
    ]));

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.status).toBe("pass");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "schedules",
        status: "pass"
      })
    ]));
  });

  it("redacts secret-shaped values from health validation failures", async () => {
    const workspace = await mkWorkspace(os.tmpdir());
    const codexHome = path.join(workspace, ".codex-home");

    await mkdir(path.join(workspace, "skills", "qa-plan"), { recursive: true });
    await mkdir(path.join(workspace, "ontology"), { recursive: true });
    await mkdir(path.join(workspace, ".builder"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    await writeFile(
      path.join(workspace, "skills", "qa-plan", "skill.yaml"),
      [
        "id: qa-plan",
        "name: QA Plan",
        "version: 0.1.0",
        "instructionsPath: instructions.md",
        "occupations:",
        "  - developer",
        "requiredTools:",
        "  - codex"
      ].join("\n")
    );
    await writeFile(path.join(workspace, "skills", "qa-plan", "instructions.md"), "# QA\n");
    await writeFile(path.join(workspace, "ontology", "builder-gear.json"), JSON.stringify([
      { id: "goal", type: "Goal", label: "Goal", properties: {}, relations: [] }
    ]));
    await writeFile(path.join(workspace, ".builder", "schedules.json"), JSON.stringify([
      {
        id: "leaky",
        name: "Leaky",
        trigger: { kind: "interval", everySeconds: 60 },
        timezone: "UTC",
        missedRunPolicy: "run-on-start",
        enabled: true,
        runRequest: {
          workspacePath: workspace,
          prompt: "Run",
          sandboxMode: "OPENAI_API_KEY=sk-1234567890abcdefghijkl",
          approvalMode: "never"
        }
      }
    ]));

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });
    const serialized = JSON.stringify(report);

    expect(serialized).toContain("[REDACTED_KEY]");
    expect(serialized).not.toContain("abcdefghijkl");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "schedules", status: "fail" })
    ]));
  });

  it("fails workspace health when workspace-owned directories are symlinks", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdir(path.join(os.tmpdir(), "builder-health-symlink-"), { recursive: true })
      .then(() => os.tmpdir());
    const workspace = await mkWorkspace(root);
    const outside = path.join(workspace, "..", `outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = path.join(workspace, ".codex-home");
    await mkdir(outside, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    await symlink(outside, path.join(workspace, "ontology"));

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "ontology",
        status: "fail",
        message: expect.stringContaining("ontology directory must not be a symlink")
      })
    ]));
  });

  it("fails workspace health when the workspace root is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-health-root-symlink-"));
    const workspace = path.join(root, "workspace");
    const link = path.join(root, "workspace-link");
    const codexHome = path.join(root, "codex-home");
    await mkdir(workspace, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    await symlink(workspace, link);

    const report = await runHealthCheck({
      workspacePath: link,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "workspace",
        status: "fail",
        message: expect.stringContaining("workspace path must not be a symlink")
      })
    ]));
    expect(report.checks.map((check) => check.id)).not.toContain("skills");
  });

  it("fails auth health when the Codex auth file is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspace = await mkWorkspace(os.tmpdir());
    const codexHome = path.join(workspace, ".codex-home");
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "builder-health-auth-outside-")), "auth.json");
    await mkdir(codexHome, { recursive: true });
    await writeFile(outside, "{}");
    await symlink(outside, path.join(codexHome, "auth.json"));

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex-auth",
        status: "fail",
        message: expect.stringContaining("Auth file must not be a symlink")
      })
    ]));
  });

  it("fails auth health when POSIX auth permissions are too open", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspace = await mkWorkspace(os.tmpdir());
    const codexHome = path.join(workspace, ".codex-home");
    const authPath = path.join(codexHome, "auth.json");
    await mkdir(codexHome, { recursive: true });
    await writeFile(authPath, "{}");
    await chmod(authPath, 0o644);

    const report = await runHealthCheck({
      workspacePath: workspace,
      codexBin: process.execPath,
      env: { CODEX_HOME: codexHome },
      now: () => new Date("2026-06-24T00:00:00.000Z")
    });

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex-auth",
        status: "fail",
        message: expect.stringContaining("Auth file permissions are too open")
      })
    ]));
  });
});

async function mkWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, `builder-health-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}
