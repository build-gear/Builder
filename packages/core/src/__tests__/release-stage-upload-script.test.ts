import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashReleaseArtifactPath,
  macOSDistributionVerificationCommands,
  releaseCheckCommands,
  stableUpdaterPlatformKey,
  type ReleaseInventory,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
  type ReleaseProvenance
} from "../release-check.js";
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptFixtureDir = path.join(rootDir, "apps/desktop/src-tauri/target/release-script-test");
const stableFixtureRelativeDir = "apps/desktop/src-tauri/target/release/bundle/macos/release-upload-plan-script-test";
const stableFixtureDir = path.join(rootDir, stableFixtureRelativeDir);
const uploadDir = path.join(rootDir, "apps/desktop/src-tauri/target/release-upload");
const uploadPlanPath = path.join(stableFixtureDir, "builder-gear-release-upload-plan.json");
const defaultUploadPlanRelativePath = "apps/desktop/src-tauri/target/release-upload/builder-gear-release-upload-plan.json";
const defaultUploadPlanPath = path.join(rootDir, defaultUploadPlanRelativePath);

describe("release upload staging script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
    rmSync(stableFixtureDir, { recursive: true, force: true });
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it("stages exactly the verified provenance files and removes stale upload contents", () => {
    const manifestPath = writeMinimalReleaseSet();
    const provenancePath = path.join(scriptFixtureDir, "builder-gear-release-provenance.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as ReleaseProvenance;
    const stalePath = path.join(uploadDir, "stale-release-file.txt");
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(stalePath, "stale");

    const result = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Release upload staged 8 files");
    expect(existsSync(stalePath)).toBe(false);

    const expectedFiles = [
      ...new Set([
        ...provenance.files.map((file) => file.path),
        repoRelativePath(provenancePath)
      ])
    ].sort((left, right) => left.localeCompare(right));

    expect(listStagedFiles()).toEqual(expectedFiles);
    for (const filePath of expectedFiles) {
      expect(hashReleaseArtifactPath(path.join(uploadDir, filePath))).toBe(
        hashReleaseArtifactPath(path.join(rootDir, filePath))
      );
    }
  });

  it("reports staging failures without leaking absolute paths or stack traces", () => {
    if (process.platform === "win32") {
      return;
    }

    const manifestPath = writeMinimalReleaseSet();
    rmSync(uploadDir, { recursive: true, force: true });
    mkdirSync(path.dirname(uploadDir), { recursive: true });
    symlinkSync(scriptFixtureDir, uploadDir, "dir");

    const result = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release upload staging:");
    expect(output).toContain("release upload staging path must not contain symlinks");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("rejects symlinked release manifests before reading the target", () => {
    if (process.platform === "win32") {
      return;
    }

    rmSync(scriptFixtureDir, { recursive: true, force: true });
    mkdirSync(scriptFixtureDir, { recursive: true });
    const targetPath = path.join(scriptFixtureDir, "secret-target.json");
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(targetPath, "{\"secret\":\"super-secret-release-target\"}\n");
    symlinkSync(targetPath, manifestPath);

    const result = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
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
    rmSync(scriptFixtureDir, { recursive: true, force: true });
    mkdirSync(scriptFixtureDir, { recursive: true });
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(manifestPath, "x".repeat(2_097_153));

    const result = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
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

  it("rejects unknown options before reading release files", () => {
    const result = spawnTsx(["scripts/stage-release-upload.ts", "--dry-run", "missing.json"], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("unknown option: --dry-run");
    expect(output).toContain("Usage: pnpm release:stage-upload -- <path/to/builder-gear-release-manifest.json>");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("at ");
  });

  it("writes a stable updater upload plan from verified staged files", () => {
    const manifestPath = writeStableReleaseSet();
    const stageResult = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });

    expect(stageResult.status).toBe(0);

    const result = spawnTsx([
      "scripts/release-upload-plan.ts",
      "--output",
      repoRelativePath(uploadPlanPath),
      repoRelativePath(manifestPath)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain(`Release upload plan written to ${repoRelativePath(uploadPlanPath)}.`);
    expect(output).not.toContain(rootDir);

    const plan = JSON.parse(readFileSync(uploadPlanPath, "utf8")) as {
      schemaVersion: number;
      stagingRoot: string;
      files: Array<{ kind: string; path: string; stagedPath: string; sha256: string }>;
      stableUpdater?: {
        platformKey: string;
        feed: {
          endpoints: Array<{ url: string; urlPath: string; decodedUploadPath: string }>;
        };
        payload: {
          artifactPath: string;
          decodedUploadPath: string;
          signatureArtifactPath: string;
        };
      };
    };

    expect(plan.schemaVersion).toBe(1);
    expect(plan.stagingRoot).toBe("apps/desktop/src-tauri/target/release-upload");
    expect(plan.files.some((file) => file.kind === "provenance")).toBe(true);
    expect(plan.files.every((file) => file.stagedPath.startsWith(`${plan.stagingRoot}/`))).toBe(true);
    expect(plan.stableUpdater?.platformKey).toBe("darwin-aarch64");
    expect(plan.stableUpdater?.feed.endpoints).toEqual([
      {
        url: "https://updates.buildergear.app/builder-gear-updater-latest.json",
        urlPath: "/builder-gear-updater-latest.json",
        decodedUploadPath: "builder-gear-updater-latest.json"
      }
    ]);
    expect(plan.stableUpdater?.payload).toMatchObject({
      artifactPath: `${stableFixtureRelativeDir}/Builder Gear.app.tar.gz`,
      decodedUploadPath: "Builder Gear.app.tar.gz",
      signatureArtifactPath: `${stableFixtureRelativeDir}/Builder Gear.app.tar.gz.sig`
    });

    const checkResult = spawnTsx([
      "scripts/release-upload-plan.ts",
      "--check",
      "--output",
      repoRelativePath(uploadPlanPath),
      repoRelativePath(manifestPath)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });

    expect(checkResult.status).toBe(0);
    expect(`${checkResult.stdout}\n${checkResult.stderr}`).toContain(`Release upload plan verified: ${repoRelativePath(uploadPlanPath)}.`);
  });

  it("verifies an upload plan from an isolated artifact root", () => {
    const manifestPath = writeStableReleaseSet();
    const stageResult = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const planResult = spawnTsx(["scripts/release-upload-plan.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const artifactRoot = path.join(scriptFixtureDir, "artifact-root");

    expect(stageResult.status).toBe(0);
    expect(planResult.status).toBe(0);
    copyPreserved(stableFixtureDir, path.join(artifactRoot, stableFixtureRelativeDir));
    for (const filePath of listStagedFiles()) {
      copyPreserved(path.join(uploadDir, filePath), path.join(artifactRoot, filePath));
    }
    copyPreserved(uploadDir, path.join(artifactRoot, "apps/desktop/src-tauri/target/release-upload"));

    const result = spawnTsx([
      "scripts/release-upload-plan.ts",
      "--artifact-root",
      repoRelativePath(artifactRoot),
      "--check",
      repoRelativePath(manifestPath)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain(`Release upload plan verified: ${defaultUploadPlanRelativePath}.`);
    expect(output).not.toContain(rootDir);
  });

  it("rejects upload plans that no longer match the verified release set", () => {
    const manifestPath = writeStableReleaseSet();
    const stageResult = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const planResult = spawnTsx(["scripts/release-upload-plan.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });

    expect(stageResult.status).toBe(0);
    expect(planResult.status).toBe(0);

    const plan = JSON.parse(readFileSync(defaultUploadPlanPath, "utf8")) as {
      stableUpdater: {
        payload: {
          decodedUploadPath: string;
        };
      };
    };
    plan.stableUpdater.payload.decodedUploadPath = "tampered-payload.tar.gz";
    writeJson(defaultUploadPlanPath, plan);

    const result = spawnTsx([
      "scripts/release-upload-plan.ts",
      "--check",
      repoRelativePath(manifestPath)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release upload plan does not match verified release set");
    expect(output).not.toContain(rootDir);
    expect(output).not.toMatch(/\n\s+at\s+\S/);
  });

  it("fails before writing an upload plan when staged files are missing", () => {
    const manifestPath = writeStableReleaseSet();

    const result = spawnTsx([
      "scripts/release-upload-plan.ts",
      "--output",
      repoRelativePath(uploadPlanPath),
      repoRelativePath(manifestPath)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("staged upload file is missing:");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("Error:");
    expect(output).not.toMatch(/\n\s+at\s+\S/);
    expect(existsSync(uploadPlanPath)).toBe(false);
  });

  it("rejects stable updater payload URLs that are not declared release artifacts", () => {
    const manifestPath = writeStableReleaseSet({
      payloadUrl: "https://updates.buildergear.app/Missing%20Payload.app.tar.gz"
    });
    const stageResult = spawnTsx(["scripts/stage-release-upload.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });

    expect(stageResult.status).toBe(0);

    const result = spawnTsx([
      "scripts/release-upload-plan.ts",
      "--output",
      repoRelativePath(uploadPlanPath),
      repoRelativePath(manifestPath)
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("stable updater payload is not declared in release manifest: Missing Payload.app.tar.gz");
    expect(output).not.toContain(rootDir);
    expect(output).not.toMatch(/\n\s+at\s+\S/);
    expect(existsSync(uploadPlanPath)).toBe(false);
  });
});

function writeMinimalReleaseSet(): string {
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
      path: repoRelativePath(inventoryPath),
      sha256: hashReleaseArtifactPath(inventoryPath),
      entryCount: inventoryEntries.length
    }
  };
  writeJson(manifestPath, manifest);

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
      { kind: "manifest", path: repoRelativePath(manifestPath), sha256: hashReleaseArtifactPath(manifestPath) },
      { kind: "inventory", path: manifest.inventory.path, sha256: manifest.inventory.sha256, entryCount: inventoryEntries.length },
      { kind: "sbom", path: "release/SBOM.cdx.json", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/SBOM.cdx.json")) },
      { kind: "notices", path: "release/THIRD_PARTY_NOTICES.md", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/THIRD_PARTY_NOTICES.md")) },
      { kind: "policy", path: ".github/dependabot.yml", sha256: hashReleaseArtifactPath(path.join(rootDir, ".github/dependabot.yml")) },
      { kind: "policy", path: "release/distribution-policy.json", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/distribution-policy.json")) },
      { kind: "policy", path: "release/license-policy.json", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/license-policy.json")) }
    ]
  };
  writeJson(provenancePath, provenance);

  return manifestPath;
}

function writeStableReleaseSet(options: { payloadUrl?: string } = {}): string {
  rmSync(stableFixtureDir, { recursive: true, force: true });
  mkdirSync(stableFixtureDir, { recursive: true });

  const appPath = path.join(stableFixtureDir, "Builder Gear.app");
  const appInfoPath = path.join(appPath, "Contents/Info.plist");
  const dmgPath = path.join(stableFixtureDir, "Builder Gear_0.1.0_aarch64.dmg");
  const payloadPath = path.join(stableFixtureDir, "Builder Gear.app.tar.gz");
  const signaturePath = path.join(stableFixtureDir, "Builder Gear.app.tar.gz.sig");
  const feedPath = path.join(stableFixtureDir, "builder-gear-updater-latest.json");
  const manifestPath = path.join(stableFixtureDir, "builder-gear-release-manifest.json");
  const inventoryPath = path.join(stableFixtureDir, "builder-gear-release-inventory.json");
  const provenancePath = path.join(stableFixtureDir, "builder-gear-release-provenance.json");
  const generatedAt = "2026-06-24T00:00:00.000Z";

  mkdirSync(path.dirname(appInfoPath), { recursive: true });
  writeFileSync(appInfoPath, "Builder Gear test app bundle\n");
  writeFileSync(dmgPath, "test dmg\n");
  writeFileSync(payloadPath, "test updater payload\n");
  writeFileSync(signaturePath, "test updater signature\n");
  writeJson(feedPath, {
    version: "0.1.0",
    notes: "Builder Gear 0.1.0",
    pub_date: generatedAt,
    platforms: {
      [stableUpdaterPlatformKey("macos", "aarch64")]: {
        signature: "test updater signature",
        url: options.payloadUrl ?? "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
      }
    }
  });

  const artifacts: ReleaseManifestArtifact[] = [
    appPath,
    dmgPath,
    payloadPath,
    signaturePath,
    feedPath
  ].map((filePath) => ({
    path: repoRelativePath(filePath),
    sha256: hashReleaseArtifactPath(filePath)
  }));
  const artifactPaths = artifacts.map((artifact) => path.join(rootDir, artifact.path));
  const gateIds = [
    ...releaseCheckCommands({
      includeBundle: true,
      distribution: true,
      platform: "macos",
      channel: "stable"
    }).map((command) => command.id),
    ...macOSDistributionVerificationCommands(artifactPaths).map((command) => command.id)
  ];
  const inventoryEntries: ReleaseInventory["entries"] = [
    ...releaseInventoryEntries(),
    ...artifacts.map((artifact) => ({
      kind: "artifact" as const,
      path: artifact.path,
      sha256: artifact.sha256
    }))
  ];
  const inventory: ReleaseInventory = {
    schemaVersion: 1,
    generatedAt,
    productName: "Builder Gear",
    version: "0.1.0",
    platform: "macos",
    mode: "distribution",
    channel: "stable",
    gateIds,
    entries: inventoryEntries
  };
  writeJson(inventoryPath, inventory);

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    generatedAt,
    mode: "distribution",
    channel: "stable",
    platform: "macos",
    arch: "aarch64",
    includeBundle: true,
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
      commit: "a".repeat(40),
      dirty: false
    },
    gateIds,
    buildInputs: {
      tauriConfigSha256: hashReleaseArtifactPath(path.join(rootDir, "apps/desktop/src-tauri/tauri.conf.json")),
      stableUpdater: {
        pubkeySha256: "b".repeat(64),
        endpoints: [
          "https://updates.buildergear.app/builder-gear-updater-latest.json"
        ]
      }
    },
    artifacts,
    inventory: {
      path: repoRelativePath(inventoryPath),
      sha256: hashReleaseArtifactPath(inventoryPath),
      entryCount: inventoryEntries.length
    }
  };
  writeJson(manifestPath, manifest);

  const provenance: ReleaseProvenance = {
    schemaVersion: 1,
    generatedAt,
    productName: manifest.productName,
    version: manifest.versions.root,
    mode: manifest.mode,
    channel: manifest.channel,
    platform: manifest.platform,
    git: manifest.git,
    gateIds,
    files: [
      { kind: "manifest", path: repoRelativePath(manifestPath), sha256: hashReleaseArtifactPath(manifestPath) },
      { kind: "inventory", path: manifest.inventory.path, sha256: manifest.inventory.sha256, entryCount: inventoryEntries.length },
      { kind: "sbom", path: "release/SBOM.cdx.json", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/SBOM.cdx.json")) },
      { kind: "notices", path: "release/THIRD_PARTY_NOTICES.md", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/THIRD_PARTY_NOTICES.md")) },
      { kind: "policy", path: ".github/dependabot.yml", sha256: hashReleaseArtifactPath(path.join(rootDir, ".github/dependabot.yml")) },
      { kind: "policy", path: "release/distribution-policy.json", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/distribution-policy.json")) },
      { kind: "policy", path: "release/license-policy.json", sha256: hashReleaseArtifactPath(path.join(rootDir, "release/license-policy.json")) },
      ...artifacts.map((artifact) => ({
        kind: "artifact" as const,
        path: artifact.path,
        sha256: artifact.sha256
      }))
    ]
  };
  writeJson(provenancePath, provenance);

  return manifestPath;
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

function copyPreserved(sourcePath: string, destinationPath: string): void {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, {
    dereference: false,
    force: true,
    recursive: true,
    verbatimSymlinks: true
  });
}

function repoRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function listStagedFiles(): string[] {
  const files: string[] = [];

  walk(uploadDir);

  return files.sort((left, right) => left.localeCompare(right));

  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      const stats = lstatSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
        continue;
      }
      files.push(path.relative(uploadDir, entryPath).split(path.sep).join("/"));
    }
  }
}
