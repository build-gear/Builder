import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptFixtureDir = path.join(rootDir, "apps/desktop/src-tauri/target/release-verify-script-test");

describe("release manifest verification script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
  });

  it("rejects symlinked release manifests before reading the target", () => {
    if (process.platform === "win32") {
      return;
    }

    mkdirSync(scriptFixtureDir, { recursive: true });
    const targetPath = path.join(scriptFixtureDir, "secret-target.json");
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(targetPath, "{\"secret\":\"super-secret-release-target\"}\n");
    symlinkSync(targetPath, manifestPath);

    const result = spawnSync(tsxBinary(), ["scripts/verify-release-manifest.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release manifest must not be a symlink");
    expect(output).not.toContain("super-secret-release-target");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("rejects oversized release manifests before parsing", () => {
    mkdirSync(scriptFixtureDir, { recursive: true });
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(manifestPath, "x".repeat(2_097_153));

    const result = spawnSync(tsxBinary(), ["scripts/verify-release-manifest.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release manifest exceeds maximum size of 2097152 bytes");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("SyntaxError");
    expect(output).not.toContain("at ");
  });

  it("rejects extra manifest arguments", () => {
    const result = spawnSync(tsxBinary(), [
      "scripts/verify-release-manifest.ts",
      "apps/desktop/src-tauri/target/a.json",
      "apps/desktop/src-tauri/target/b.json"
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("expected exactly one release manifest path");
    expect(output).toContain("Usage: pnpm release:verify -- [--artifact-root <path>] <path/to/builder-gear-release-manifest.json>");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("rejects unsafe artifact roots before reading manifests", () => {
    const result = spawnSync(tsxBinary(), [
      "scripts/verify-release-manifest.ts",
      "--artifact-root",
      "../outside",
      "builder-gear-release-manifest.json"
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("artifact root must be repository-relative");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("at ");
  });
});

function repoRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function tsxBinary(): string {
  if (process.platform === "win32") {
    return path.join(rootDir, "node_modules/.bin/tsx.cmd");
  }

  return path.join(rootDir, "node_modules/.bin/tsx");
}
