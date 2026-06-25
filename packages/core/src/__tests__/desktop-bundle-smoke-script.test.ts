import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptFixtureDir = path.join(rootDir, "apps/desktop/src-tauri/target/desktop-bundle-smoke-script-test");

describe("desktop bundle smoke script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
  });

  it("verifies a macOS app executable without launching the GUI", () => {
    const appPath = path.join(scriptFixtureDir, "Builder Gear.app");
    writeMacOSAppFixture(appPath, "builder-gear-desktop", true);

    const result = spawnSync(tsxBinary(), [
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "macos",
      "--artifact-root",
      repoRelativePath(scriptFixtureDir)
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("Desktop bundle smoke verified");
    expect(output).toContain("desktop-bundle-smoke-script-test");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("rejects a shell script inside a macOS app bundle", () => {
    const appPath = path.join(scriptFixtureDir, "Builder Gear.app");
    writeMacOSAppFixture(appPath, "builder-gear-desktop", false);

    const result = spawnSync(tsxBinary(), [
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "macos",
      "--artifact-root",
      repoRelativePath(scriptFixtureDir)
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("macOS app bundle executable is too small to be a desktop binary");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("rejects symlinked artifact roots before reading generated artifacts", () => {
    if (process.platform === "win32") {
      return;
    }

    const targetPath = path.join(scriptFixtureDir, "artifact-root");
    const linkPath = path.join(scriptFixtureDir, "artifact-root-link");
    mkdirSync(targetPath, { recursive: true });
    symlinkSync(targetPath, linkPath, "dir");

    const result = spawnSync(tsxBinary(), [
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "macos",
      "--artifact-root",
      repoRelativePath(linkPath)
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("artifact root must not be a symlink");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("rejects unsafe artifact roots", () => {
    const result = spawnSync(tsxBinary(), [
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "macos",
      "--artifact-root",
      "../outside"
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("artifact root must be repository-relative");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("at ");
  });
});

function writeMacOSAppFixture(appPath: string, executableName: string, machOExecutable: boolean): void {
  mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
</dict>
</plist>
`);

  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  if (machOExecutable) {
    writeMachOExecutableFixture(executablePath);
  } else {
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  }
  chmodSync(executablePath, 0o755);
}

function writeMachOExecutableFixture(executablePath: string): void {
  if (process.platform === "darwin") {
    copyFileSync("/bin/echo", executablePath);
    return;
  }

  const fixture = Buffer.alloc(4_096);
  fixture[0] = 0xcf;
  fixture[1] = 0xfa;
  fixture[2] = 0xed;
  fixture[3] = 0xfe;
  writeFileSync(executablePath, fixture);
}

function repoRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function tsxBinary(): string {
  if (process.platform === "win32") {
    return path.join(rootDir, "node_modules/.bin/tsx.cmd");
  }

  return path.join(rootDir, "node_modules/.bin/tsx");
}
