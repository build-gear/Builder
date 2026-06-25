import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listWorkspaceBackups, pruneWorkspaceBackups, restoreWorkspaceBackup } from "../workspace-backups.js";

describe("workspace backups", () => {
  it("lists and restores schedule backups while preserving a pre-restore copy", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-backups-"));
    const backupName = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
    await mkdir(path.join(workspace, ".builder", "backups"), { recursive: true });
    await writeFile(path.join(workspace, ".builder", "schedules.json"), "current schedules");
    await writeFile(path.join(workspace, ".builder", "backups", backupName), "previous schedules");

    const backups = await listWorkspaceBackups(workspace);
    expect(backups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: backupName,
        kind: "schedules-save",
        relativePath: `.builder/backups/${backupName}`,
        targetRelativePath: ".builder/schedules.json",
        directory: false
      })
    ]));
    expect(JSON.stringify(backups)).not.toContain("previous schedules");

    const result = await restoreWorkspaceBackup(workspace, backupName);

    expect(result.targetRelativePath).toBe(".builder/schedules.json");
    expect(result.preRestoreBackup?.kind).toBe("restore-preimage");
    await expect(readFile(path.join(workspace, ".builder", "schedules.json"), "utf8")).resolves.toBe("previous schedules");
    await expect(readFile(path.join(workspace, result.preRestoreBackup!.relativePath), "utf8")).resolves.toBe("current schedules");
  });

  it("restores skill directory backups without following symlinks", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-skill-backups-"));
    const backupName = "20260624T010000Z-2-skill-save-skills-qa-plan";
    const skillDir = path.join(workspace, "skills", "qa-plan");
    const backupDir = path.join(workspace, ".builder", "backups", backupName);
    await mkdir(skillDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(skillDir, "skill.yaml"), "id: qa-plan\nname: QA Plan\nversion: 0.1.0\ninstructionsPath: instructions.md\n");
    await writeFile(path.join(skillDir, "instructions.md"), "current instructions");
    await writeFile(path.join(backupDir, "skill.yaml"), "id: qa-plan\nname: QA Plan\nversion: 0.1.0\ninstructionsPath: instructions.md\n");
    await writeFile(path.join(backupDir, "instructions.md"), "previous instructions");

    const result = await restoreWorkspaceBackup(workspace, backupName);

    expect(result.targetRelativePath).toBe("skills/qa-plan");
    await expect(readFile(path.join(skillDir, "instructions.md"), "utf8")).resolves.toBe("previous instructions");
    await expect(readFile(path.join(workspace, result.preRestoreBackup!.relativePath, "instructions.md"), "utf8")).resolves.toBe("current instructions");
  });

  it("rejects symlinks inside directory backups before restore", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-skill-backups-inner-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-skill-backups-outside-"));
    const backupName = "20260624T010000Z-2-skill-save-skills-qa-plan";
    const skillDir = path.join(workspace, "skills", "qa-plan");
    const backupDir = path.join(workspace, ".builder", "backups", backupName);
    await mkdir(skillDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(skillDir, "instructions.md"), "current instructions");
    await writeFile(path.join(backupDir, "skill.yaml"), "id: qa-plan\nname: QA Plan\nversion: 0.1.0\ninstructionsPath: instructions.md\n");
    await writeFile(path.join(outside, "instructions.md"), "outside instructions");
    await symlink(path.join(outside, "instructions.md"), path.join(backupDir, "instructions.md"));

    await expect(restoreWorkspaceBackup(workspace, backupName)).rejects.toThrow("workspace backup entry must not be a symlink");
    await expect(readFile(path.join(skillDir, "instructions.md"), "utf8")).resolves.toBe("current instructions");
  });

  it("rejects symlinked backup entries", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-backups-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-backups-outside-"));
    await mkdir(path.join(workspace, ".builder", "backups"), { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, ".builder", "backups", "20260624T010000Z-3-schedules-save-.builder-schedules.json"));

    await expect(listWorkspaceBackups(workspace)).rejects.toThrow("workspace backup must not be a symlink");
  });

  it("prunes old backups only when dry-run is disabled", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "builder-backups-prune-"));
    const backupsDir = path.join(workspace, ".builder", "backups");
    await mkdir(backupsDir, { recursive: true });
    const newest = "20260624T030000Z-3-schedules-save-.builder-schedules.json";
    const middle = "20260624T020000Z-2-schedules-save-.builder-schedules.json";
    const oldest = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
    await writeFile(path.join(backupsDir, newest), "newest");
    await writeFile(path.join(backupsDir, middle), "middle");
    await writeFile(path.join(backupsDir, oldest), "oldest");

    const dryRun = await pruneWorkspaceBackups(workspace, { keep: 1 });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.candidates.map((backup) => backup.name)).toEqual([middle, oldest]);
    expect(existsSync(path.join(backupsDir, middle))).toBe(true);
    expect(existsSync(path.join(backupsDir, oldest))).toBe(true);

    const pruned = await pruneWorkspaceBackups(workspace, { keep: 1, dryRun: false });
    expect(pruned.pruned.map((backup) => backup.name)).toEqual([middle, oldest]);
    expect(existsSync(path.join(backupsDir, newest))).toBe(true);
    expect(existsSync(path.join(backupsDir, middle))).toBe(false);
    expect(existsSync(path.join(backupsDir, oldest))).toBe(false);
  });
});
