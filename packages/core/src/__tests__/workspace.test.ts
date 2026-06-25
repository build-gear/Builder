import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillManifests } from "../skills.js";
import { validateOntologyEntity } from "../ontology.js";
import { prepareBuilderWorkspace } from "../workspace.js";

describe("workspace bootstrap", () => {
  it("creates a starter Builder Gear workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-"));
    const workspace = path.join(root, "workspace");

    const result = await prepareBuilderWorkspace(workspace);
    const skills = await discoverSkillManifests(path.join(workspace, "skills"));
    const ontology = JSON.parse(await readFile(path.join(workspace, "ontology", "builder-gear.json"), "utf8")) as unknown[];

    await expect(realpath(result.workspacePath)).resolves.toBe(await realpath(workspace));
    expect(result.files.map((file) => file.status)).toEqual(["created", "created", "created", "created"]);
    expect(skills.map((skill) => skill.manifest.id)).toEqual(["build-plan"]);
    expect(ontology.every((entity) => validateOntologyEntity(entity).valid)).toBe(true);
    await expect(stat(path.join(workspace, ".builder", "schedules.json"))).resolves.toBeTruthy();
  });

  it("does not overwrite existing starter files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-"));
    const workspace = path.join(root, "workspace");
    const instructionsPath = path.join(workspace, "skills", "build-plan", "instructions.md");
    await prepareBuilderWorkspace(workspace);
    await writeFile(instructionsPath, "# Custom instructions\n");

    const result = await prepareBuilderWorkspace(workspace);

    expect(result.files.find((file) => file.path === "skills/build-plan/instructions.md")?.status).toBe("existing");
    await expect(readFile(instructionsPath, "utf8")).resolves.toBe("# Custom instructions\n");
  });

  it("rejects a workspace path that points at a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-"));
    const workspace = path.join(root, "workspace-file");
    await writeFile(workspace, "not a directory");

    await expect(prepareBuilderWorkspace(workspace)).rejects.toThrow("workspace path exists but is not a directory");
  });

  it("rejects a workspace root that is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-root-symlink-"));
    const target = path.join(root, "target-workspace");
    const link = path.join(root, "workspace-link");
    await mkdir(target, { recursive: true });
    await symlink(target, link);

    await expect(prepareBuilderWorkspace(link)).rejects.toThrow("workspace path must not be a symlink");
    await expect(stat(path.join(target, "skills")).catch(() => undefined)).resolves.toBeUndefined();
  });

  it("rejects symlinked workspace child directories before writing starter files", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-symlink-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(workspace, "skills"));

    await expect(prepareBuilderWorkspace(workspace)).rejects.toThrow("skills directory must not be a symlink");
    await expect(stat(path.join(outside, "build-plan")).catch(() => undefined)).resolves.toBeUndefined();
  });

  it("rejects symlinked starter files instead of treating them as existing", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-starter-symlink-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const starterPath = path.join(workspace, "skills", "build-plan", "instructions.md");
    const outsideFile = path.join(outside, "instructions.md");
    await mkdir(path.dirname(starterPath), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(outsideFile, "# Outside\n");
    await symlink(outsideFile, starterPath);

    await expect(prepareBuilderWorkspace(workspace)).rejects.toThrow("starter file must not be a symlink");
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("# Outside\n");
  });

  it("rejects starter paths that already exist as directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-workspace-starter-dir-"));
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, ".builder", "schedules.json"), { recursive: true });

    await expect(prepareBuilderWorkspace(workspace)).rejects.toThrow("starter path exists but is not a file");
  });
});
