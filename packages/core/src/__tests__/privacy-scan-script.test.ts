import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tempRoots: string[] = [];

describe("privacy scan script", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unreadable repository files without leaking absolute paths or stacks", () => {
    if (process.platform === "win32") {
      return;
    }

    const fixture = miniRepo();
    const unreadablePath = path.join(fixture, "src/unreadable.txt");
    writeFileSync(unreadablePath, "private data that should not be printed\n");
    chmodSync(unreadablePath, 0o000);

    const result = runPrivacyScan(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    chmodSync(unreadablePath, 0o600);

    expect(result.status).toBe(1);
    expect(output).toContain("privacy scan: src/unreadable.txt: could not be scanned:");
    expect(output).not.toContain("private data that should not be printed");
    expect(output).not.toContain(fixture);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("reports secret patterns by file and label without printing secret values", () => {
    const fixture = miniRepo();
    const secret = ["sk", "proj", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].join("-");
    writeFileSync(path.join(fixture, "src/leak.ts"), `export const key = "${secret}";\n`);

    const result = runPrivacyScan(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("privacy scan: src/leak.ts:1: OpenAI-style secret key");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(fixture);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });
});

function miniRepo(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "builder-privacy-scan-"));
  tempRoots.push(fixture);

  mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  mkdirSync(path.join(fixture, "packages/core/src"), { recursive: true });
  mkdirSync(path.join(fixture, "src"), { recursive: true });

  copyFileSync(path.join(rootDir, "scripts/privacy-scan.ts"), path.join(fixture, "scripts/privacy-scan.ts"));
  copyFileSync(path.join(rootDir, "scripts/script-file-safety.ts"), path.join(fixture, "scripts/script-file-safety.ts"));
  copyFileSync(path.join(rootDir, "packages/core/src/release-check.ts"), path.join(fixture, "packages/core/src/release-check.ts"));
  symlinkSync(path.join(rootDir, "node_modules"), path.join(fixture, "node_modules"), "dir");
  symlinkSync(path.join(rootDir, "packages/core/node_modules"), path.join(fixture, "packages/core/node_modules"), "dir");

  writeFileSync(path.join(fixture, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(path.join(fixture, "src/index.ts"), "export const ok = true;\n");

  return fixture;
}

function runPrivacyScan(fixture: string) {
  return spawnSync(tsxBinary(), [path.join(fixture, "scripts/privacy-scan.ts")], {
    cwd: fixture,
    encoding: "utf8"
  });
}

function tsxBinary(): string {
  if (process.platform === "win32") {
    return path.join(rootDir, "node_modules/.bin/tsx.cmd");
  }

  return path.join(rootDir, "node_modules/.bin/tsx");
}
