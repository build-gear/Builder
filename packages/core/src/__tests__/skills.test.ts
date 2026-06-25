import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillManifests, loadSkillManifest } from "../skills.js";

describe("skills", () => {
  it("loads skill.yaml manifests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-skill-"));
    await writeFile(path.join(root, "instructions.md"), "Run the workflow.");
    await writeFile(
      path.join(root, "skill.yaml"),
      [
        "id: research-brief",
        "name: Research Brief",
        "version: 0.1.0",
        "occupations:",
        "  - analyst",
        "instructionsPath: instructions.md",
        "requiredTools:",
        "  - codex"
      ].join("\n")
    );

    const loaded = await loadSkillManifest(path.join(root, "skill.yaml"));

    expect(loaded.manifest.id).toBe("research-brief");
    expect(loaded.instructionsAbsolutePath).toBe(path.join(root, "instructions.md"));
  });

  it("discovers manifests recursively", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-skills-"));
    const skillDir = path.join(root, "writer");
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, "instructions.md"), "Draft copy.");
    await writeFile(
      path.join(skillDir, "skill.yaml"),
      "id: copywriter\nname: Copywriter\nversion: 0.1.0\ninstructionsPath: instructions.md\n"
    );

    const skills = await discoverSkillManifests(root);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.manifest.id).toBe("copywriter");
  });

  it("rejects symlinked skill entries during discovery", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-skills-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-skills-outside-"));
    await writeFile(
      path.join(outside, "skill.yaml"),
      "id: outside\nname: Outside\nversion: 0.1.0\ninstructionsPath: instructions.md\n"
    );
    await symlink(outside, path.join(root, "outside"));

    await expect(discoverSkillManifests(root)).rejects.toThrow("skill path must not be a symlink");
  });

  it("rejects symlinked instruction parents during manifest loading", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-skill-instruction-parent-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-skill-instruction-outside-"));
    await writeFile(path.join(outside, "instructions.md"), "outside instructions");
    await symlink(outside, path.join(root, "nested"));
    await writeFile(
      path.join(root, "skill.yaml"),
      "id: qa-plan\nname: QA Plan\nversion: 0.1.0\ninstructionsPath: nested/instructions.md\n"
    );

    await expect(loadSkillManifest(path.join(root, "skill.yaml"))).rejects.toThrow(/skill instructions path must stay inside/);
  });

  it("rejects path-unsafe skill manifests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-skill-unsafe-"));
    const manifestPath = path.join(root, "skill.yaml");

    await writeFile(
      manifestPath,
      [
        "id: ../escape",
        "name: Unsafe Skill",
        "version: 0.1.0",
        "instructionsPath: ../outside.md"
      ].join("\n")
    );

    await expect(loadSkillManifest(manifestPath)).rejects.toThrow(/skill id contains unsupported path characters/);

    for (const instructionsPath of [
      ".",
      "../outside.md",
      "nested/../outside.md",
      "./instructions.md",
      "nested/./instructions.md",
      "/tmp/outside.md",
      "\\Users\\example\\outside.md",
      "C:\\Users\\example\\outside.md",
      "C:/Users/example/outside.md"
    ]) {
      await writeFile(
        manifestPath,
        [
          "id: escape",
          "name: Unsafe Skill",
          "version: 0.1.0",
          `instructionsPath: ${JSON.stringify(instructionsPath)}`
        ].join("\n")
      );

      await expect(loadSkillManifest(manifestPath)).rejects.toThrow(/instructionsPath must stay inside the skill directory/);
    }
  });
});
