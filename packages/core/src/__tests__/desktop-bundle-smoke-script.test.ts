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
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptFixtureDir = path.join(rootDir, "apps/desktop/src-tauri/target/desktop-bundle-smoke-script-test");

describe("desktop bundle smoke script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
  });

  it("verifies a macOS app executable without launching the GUI", () => {
    const appPath = path.join(scriptFixtureDir, "Builder Gear.app");
    writeMacOSAppFixture(appPath, "builder-gear-desktop", true);

    const result = spawnTsx([
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

    const result = spawnTsx([
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

  it("verifies Windows MSI and NSIS package headers", () => {
    writeWindowsDistributionArtifacts(scriptFixtureDir);

    const result = spawnTsx([
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "windows",
      "--distribution",
      "--artifact-root",
      repoRelativePath(scriptFixtureDir)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("Desktop bundle smoke verified");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("rejects Windows packages with invalid executable headers", () => {
    writeWindowsDistributionArtifacts(scriptFixtureDir, { invalidExe: true });

    const result = spawnTsx([
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "windows",
      "--distribution",
      "--artifact-root",
      repoRelativePath(scriptFixtureDir)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("Windows NSIS artifact does not have a PE executable header");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("verifies Linux AppImage deb and rpm package headers", () => {
    writeLinuxDistributionArtifacts(scriptFixtureDir);

    const result = spawnTsx([
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "linux",
      "--distribution",
      "--artifact-root",
      repoRelativePath(scriptFixtureDir)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("Desktop bundle smoke verified");
    expect(output).not.toContain(rootDir);
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

    const result = spawnTsx([
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
    const result = spawnTsx([
      "scripts/desktop-bundle-smoke.ts",
      "--platform",
      "macos",
      "--artifact-root",
      "../outside"
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

function writeWindowsDistributionArtifacts(root: string, options: { invalidExe?: boolean } = {}): void {
  mkdirSync(path.join(root, "msi"), { recursive: true });
  mkdirSync(path.join(root, "nsis"), { recursive: true });
  writeFileSync(
    path.join(root, "msi", "Builder Gear_0.1.0_x64_en-US.msi"),
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00])
  );
  writeFileSync(
    path.join(root, "nsis", "Builder Gear_0.1.0_x64-setup.exe"),
    options.invalidExe ? Buffer.from("not-a-pe-file") : Buffer.from([0x4d, 0x5a, 0x90, 0x00])
  );
}

function writeLinuxDistributionArtifacts(root: string): void {
  mkdirSync(path.join(root, "appimage"), { recursive: true });
  mkdirSync(path.join(root, "deb"), { recursive: true });
  mkdirSync(path.join(root, "rpm"), { recursive: true });

  const appImagePath = path.join(root, "appimage", "Builder Gear_0.1.0_amd64.AppImage");
  writeFileSync(appImagePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));
  chmodSync(appImagePath, 0o755);
  writeFileSync(path.join(root, "deb", "builder-gear_0.1.0_amd64.deb"), Buffer.from("!<arch>\nfixture"));
  writeFileSync(path.join(root, "rpm", "builder-gear-0.1.0-1.x86_64.rpm"), Buffer.from([0xed, 0xab, 0xee, 0xdb, 0x03]));
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
