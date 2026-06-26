import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const helperUrl = pathToFileURL(path.join(rootDir, "scripts/script-file-safety.ts")).href;
const tempRoots: string[] = [];

describe("script file safety helpers", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked repository reads without reading the target", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = tempRoot("builder-script-read-");
    const target = path.join(root, "secret-target.txt");
    const link = path.join(root, "input.txt");
    writeFileSync(target, "super-secret-target");
    symlinkSync(target, link);

    const result = runHelperScript(`
      import { readRepoTextFile } from ${JSON.stringify(helperUrl)};
      try {
        readRepoTextFile(${JSON.stringify(root)}, "input.txt", "input file");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("input file must not be a symlink");
    expect(output).not.toContain("super-secret-target");
  });

  it("rejects oversized repository JSON reads before parsing", () => {
    const root = tempRoot("builder-script-large-json-");
    writeFileSync(path.join(root, "config.json"), "x".repeat(2_097_153));

    const result = runHelperScript(`
      import { readRepoJsonFile } from ${JSON.stringify(helperUrl)};
      try {
        readRepoJsonFile(${JSON.stringify(root)}, "config.json", "release config");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release config exceeds maximum size of 2097152 bytes");
    expect(output).not.toContain("Unexpected token");
  });

  it("rejects symlinked generated outputs without overwriting the target", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = tempRoot("builder-script-write-");
    mkdirSync(path.join(root, "release"));
    const target = path.join(root, "outside-target.txt");
    const outputPath = path.join(root, "release", "SBOM.cdx.json");
    writeFileSync(target, "existing target");
    symlinkSync(target, outputPath);

    const result = runHelperScript(`
      import { writeGeneratedRepoTextFile } from ${JSON.stringify(helperUrl)};
      try {
        writeGeneratedRepoTextFile(${JSON.stringify(root)}, "release/SBOM.cdx.json", "new content", "SBOM");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("SBOM must not be a symlink");
    expect(readFileSync(target, "utf8")).toBe("existing target");
  });

  it("rejects symlinked generated output parent directories", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = tempRoot("builder-script-parent-");
    const outside = tempRoot("builder-script-parent-outside-");
    mkdirSync(path.join(root, "target"));
    symlinkSync(outside, path.join(root, "target", "release-readiness"), "dir");

    const result = runHelperScript(`
      import { writeGeneratedRepoTextFile } from ${JSON.stringify(helperUrl)};
      try {
        writeGeneratedRepoTextFile(
          ${JSON.stringify(root)},
          "target/release-readiness/builder-gear-release-manifest.json",
          "{}",
          "release manifest"
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release manifest parent must not contain symlinks");
    expect(existsSync(path.join(outside, "builder-gear-release-manifest.json"))).toBe(false);
  });

  it("writes generated binary files through the same symlink checks", () => {
    const root = tempRoot("builder-script-binary-");
    mkdirSync(path.join(root, "icons"));

    const result = runHelperScript(`
      import { writeGeneratedRepoBinaryFile } from ${JSON.stringify(helperUrl)};
      writeGeneratedRepoBinaryFile(${JSON.stringify(root)}, "icons/icon.png", Uint8Array.from([0, 1, 2, 255]), "PNG icon");
    `);

    expect(result.status).toBe(0);
    expect([...readFileSync(path.join(root, "icons", "icon.png"))]).toEqual([0, 1, 2, 255]);
  });

  it("rejects symlinked generated directories before cleanup", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = tempRoot("builder-script-dir-");
    const outside = tempRoot("builder-script-outside-");
    mkdirSync(path.join(root, "icons"));
    symlinkSync(outside, path.join(root, "icons", "builder-gear.iconset"), "dir");

    const result = runHelperScript(`
      import { prepareGeneratedRepoDirectory } from ${JSON.stringify(helperUrl)};
      try {
        prepareGeneratedRepoDirectory(${JSON.stringify(root)}, "icons/builder-gear.iconset", "temporary iconset directory");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("temporary iconset directory must not be a symlink");
    expect(existsSync(outside)).toBe(true);
  });

  it("quotes generated shell command arguments that would otherwise glob", () => {
    const result = runHelperScript(`
      import { shellQuoteArg } from ${JSON.stringify(helperUrl)};
      console.log([
        shellQuoteArg("name=main"),
        shellQuoteArg("name=release/*"),
        shellQuoteArg("owner/repo"),
        shellQuoteArg("value'with-quote")
      ].join("\\n"));
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "name=main",
      "'name=release/*'",
      "owner/repo",
      "'value'\\''with-quote'"
    ]);
  });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function runHelperScript(source: string) {
  const root = tempRoot("builder-script-helper-");
  const scriptPath = path.join(root, "run.ts");
  writeFileSync(scriptPath, source);

  return spawnTsx([scriptPath], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}
