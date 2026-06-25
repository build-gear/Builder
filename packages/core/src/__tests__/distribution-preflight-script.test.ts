import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tempRoots: string[] = [];

describe("distribution preflight script", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked distribution policy files before reading the target", () => {
    if (process.platform === "win32") {
      return;
    }

    const fixture = miniRepo();
    const policyPath = path.join(fixture, "release/distribution-policy.json");
    const targetPath = path.join(fixture, "release/secret-policy.json");
    writeFileSync(targetPath, "{\"secret\":\"super-secret-distribution-policy\"}\n");
    rmSync(policyPath);
    symlinkSync(targetPath, policyPath);

    const result = runPreflight(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("distribution policy must not be a symlink");
    expect(output).not.toContain("super-secret-distribution-policy");
    expect(output).not.toContain(fixture);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("rejects oversized distribution policy files before parsing", () => {
    const fixture = miniRepo();
    writeFileSync(path.join(fixture, "release/distribution-policy.json"), "x".repeat(2_097_153));

    const result = runPreflight(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("distribution policy exceeds maximum size of 2097152 bytes");
    expect(output).not.toContain(fixture);
    expect(output).not.toContain("SyntaxError");
    expect(output).not.toContain("at ");
  });
});

function miniRepo(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "builder-distribution-preflight-"));
  tempRoots.push(fixture);

  mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  mkdirSync(path.join(fixture, "packages/core/src"), { recursive: true });
  mkdirSync(path.join(fixture, "release"), { recursive: true });
  mkdirSync(path.join(fixture, "apps/desktop/src-tauri"), { recursive: true });

  copyFileSync(
    path.join(rootDir, "scripts/distribution-preflight.ts"),
    path.join(fixture, "scripts/distribution-preflight.ts")
  );
  copyFileSync(
    path.join(rootDir, "scripts/script-file-safety.ts"),
    path.join(fixture, "scripts/script-file-safety.ts")
  );
  copyFileSync(
    path.join(rootDir, "packages/core/src/release-check.ts"),
    path.join(fixture, "packages/core/src/release-check.ts")
  );
  symlinkSync(path.join(rootDir, "node_modules"), path.join(fixture, "node_modules"), "dir");
  symlinkSync(path.join(rootDir, "packages/core/node_modules"), path.join(fixture, "packages/core/node_modules"), "dir");

  writeFileSync(path.join(fixture, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(path.join(fixture, "release/distribution-policy.json"), "{\"schemaVersion\":1}\n");
  writeFileSync(path.join(fixture, "release/tauri.stable.conf.json"), "{\"plugins\":{\"updater\":{}}}\n");
  writeFileSync(path.join(fixture, "apps/desktop/src-tauri/tauri.conf.json"), "{\"plugins\":{}}\n");

  return fixture;
}

function runPreflight(fixture: string) {
  return spawnTsx(
    [path.join(fixture, "scripts/distribution-preflight.ts"), "--platform", "linux", "--channel", "internal"],
    {
      cwd: fixture,
      encoding: "utf8",
      shell: process.platform === "win32"
    }
  );
}
