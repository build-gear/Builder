import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashReleaseArtifactPath,
  releaseCheckCommands,
  type ReleaseInventory,
  type ReleaseManifest,
  type ReleaseProvenance
} from "../release-check.js";
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptFixtureDir = path.join(rootDir, "apps/desktop/src-tauri/target/service-readiness-script-test");

describe("service readiness script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
  });

  it("verifies local release evidence while marking explicitly skipped external gates", () => {
    const manifestPath = repoRelativePath(writeMinimalReleaseSet());

    const result = runServiceReadiness([
      "--manifest",
      manifestPath,
      "--skip-github",
      "--skip-updater",
      "--json"
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(rootDir);

    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ id: string; status: string; message: string }>;
    };

    expect(report.status).toBe("warn");
    expect(report.checks).toEqual([
      expect.objectContaining({
        id: "local-release-manifest",
        status: "pass",
        message: `Verified ${manifestPath}`
      }),
      expect.objectContaining({
        id: "hosted-ci",
        status: "skip"
      }),
      expect.objectContaining({
        id: "github-release-environment",
        status: "skip"
      }),
      expect.objectContaining({
        id: "stable-updater-feed",
        status: "skip"
      })
    ]);
  });

  it("verifies release evidence from an isolated artifact root", () => {
    writeMinimalReleaseSet({ artifactRootRelativeEvidence: true });

    const result = runServiceReadiness([
      "--artifact-root",
      repoRelativePath(scriptFixtureDir),
      "--manifest",
      "builder-gear-release-manifest.json",
      "--skip-github",
      "--skip-updater",
      "--json"
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(rootDir);

    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ id: string; status: string; message: string }>;
    };
    expect(report.status).toBe("warn");
    expect(report.checks[0]).toEqual(expect.objectContaining({
      id: "local-release-manifest",
      status: "pass",
      message: "Verified builder-gear-release-manifest.json"
    }));
  });

  it("fails closed when release evidence and external readiness inputs are missing", () => {
    const result = runServiceReadiness([
      "--manifest",
      "apps/desktop/src-tauri/target/service-readiness-script-test/missing-manifest.json",
      "--json"
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("\"status\": \"fail\"");
    expect(output).toContain("release manifest is missing: apps/desktop/src-tauri/target/service-readiness-script-test/missing-manifest.json");
    expect(output).toContain("Repository not provided");
    expect(output).toContain("Stable manifest not provided");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("rejects contradictory options before running checks", () => {
    const result = runServiceReadiness(["--skip-updater", "--verify-downloads"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("--verify-downloads cannot be used with --skip-updater");
    expect(output).toContain("Usage: pnpm service:readiness");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });
});

function runServiceReadiness(args: string[]) {
  return spawnTsx(["scripts/service-readiness.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}

function writeMinimalReleaseSet(options: { artifactRootRelativeEvidence?: boolean } = {}): string {
  rmSync(scriptFixtureDir, { recursive: true, force: true });
  mkdirSync(scriptFixtureDir, { recursive: true });

  const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
  const inventoryPath = path.join(scriptFixtureDir, "builder-gear-release-inventory.json");
  const provenancePath = path.join(scriptFixtureDir, "builder-gear-release-provenance.json");
  const gateIds = releaseCheckCommands({ includeBundle: false }).map((command) => command.id);
  const inventoryEntries = releaseInventoryEntries();
  const inventory: ReleaseInventory = {
    schemaVersion: 1,
    generatedAt: "2026-06-24T00:00:00.000Z",
    productName: "Builder Gear",
    version: "0.1.0",
    platform: "macos",
    mode: "debug",
    gateIds,
    entries: inventoryEntries
  };
  writeJson(inventoryPath, inventory);

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    generatedAt: "2026-06-24T00:00:00.000Z",
    mode: "debug",
    platform: "macos",
    arch: "aarch64",
    includeBundle: false,
    versions: {
      root: "0.1.0",
      core: "0.1.0",
      cli: "0.1.0",
      desktop: "0.1.0",
      tauri: "0.1.0",
      cargo: "0.1.0"
    },
    packageManager: "pnpm@10.26.1",
    productName: "Builder Gear",
    identifier: "com.buildergear.desktop",
    git: {
      commit: null,
      dirty: true
    },
    gateIds,
    buildInputs: {
      tauriConfigSha256: hashReleaseArtifactPath(path.join(rootDir, "apps/desktop/src-tauri/tauri.conf.json"))
    },
    artifacts: [],
    inventory: {
      path: releaseEvidencePath(inventoryPath, options),
      sha256: hashReleaseArtifactPath(inventoryPath),
      entryCount: inventoryEntries.length
    }
  };
  writeJson(manifestPath, manifest);

  const policyFiles = [
    ".github/dependabot.yml",
    "release/distribution-policy.json",
    "release/license-policy.json",
    "release/SBOM.cdx.json",
    "release/THIRD_PARTY_NOTICES.md"
  ];

  if (options.artifactRootRelativeEvidence) {
    for (const filePath of policyFiles) {
      const outputPath = path.join(scriptFixtureDir, filePath);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      copyFileSync(path.join(rootDir, filePath), outputPath);
    }
  }

  const provenance: ReleaseProvenance = {
    schemaVersion: 1,
    generatedAt: "2026-06-24T00:00:00.000Z",
    productName: manifest.productName,
    version: manifest.versions.root,
    mode: manifest.mode,
    platform: manifest.platform,
    git: manifest.git,
    gateIds,
    files: [
      { kind: "manifest", path: releaseEvidencePath(manifestPath, options), sha256: hashReleaseArtifactPath(manifestPath) },
      { kind: "inventory", path: manifest.inventory.path, sha256: manifest.inventory.sha256, entryCount: inventoryEntries.length },
      ...policyFiles.map((filePath) => ({
        kind: provenanceKind(filePath),
        path: filePath,
        sha256: hashReleaseArtifactPath(path.join(
          options.artifactRootRelativeEvidence ? scriptFixtureDir : rootDir,
          filePath
        ))
      }))
    ]
  };
  writeJson(provenancePath, provenance);

  return manifestPath;
}

function releaseEvidencePath(absolutePath: string, options: { artifactRootRelativeEvidence?: boolean }): string {
  return options.artifactRootRelativeEvidence
    ? path.relative(scriptFixtureDir, absolutePath).split(path.sep).join("/")
    : repoRelativePath(absolutePath);
}

function provenanceKind(filePath: string): ReleaseProvenance["files"][number]["kind"] {
  if (filePath.endsWith("SBOM.cdx.json")) {
    return "sbom";
  }
  if (filePath.endsWith("THIRD_PARTY_NOTICES.md")) {
    return "notices";
  }

  return "policy";
}

function releaseInventoryEntries(): ReleaseInventory["entries"] {
  const entries: Array<Omit<ReleaseInventory["entries"][number], "sha256">> = [
    { kind: "source", path: "package.json" },
    { kind: "lockfile", path: "pnpm-lock.yaml" },
    { kind: "lockfile", path: "apps/desktop/src-tauri/Cargo.lock" },
    { kind: "source", path: "apps/desktop/src-tauri/tauri.conf.json" },
    { kind: "policy", path: ".github/dependabot.yml" },
    { kind: "workflow", path: ".github/workflows/ci.yml" },
    { kind: "workflow", path: ".github/workflows/release-candidate.yml" },
    { kind: "workflow", path: ".github/workflows/verify-stable-updater.yml" },
    { kind: "policy", path: "release/distribution-policy.json" },
    { kind: "policy", path: "release/license-policy.json" },
    { kind: "policy", path: "release/SBOM.cdx.json" },
    { kind: "policy", path: "release/THIRD_PARTY_NOTICES.md" }
  ];

  return entries.map((entry) => ({
    ...entry,
    sha256: hashReleaseArtifactPath(path.join(rootDir, entry.path))
  }));
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function repoRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}
