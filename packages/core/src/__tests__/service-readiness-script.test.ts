import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const tempRoots: string[] = [];
const repository = "build-gear/Builder";
const fakeSecretValue = "service-readiness-secret-value";
const fakeGitHubToken = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
const fakeOpenAiKey = `sk-${"abcdefghijklmnopqrstuvwxyz123456"}`;
const fakeBearerToken = `Bearer ${"abcdefghijklmnopqrstuvwxyz123456"}`;

describe("service readiness script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
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
        id: "release-upload-plan",
        status: "skip"
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
    expect(report.checks[1]).toEqual(expect.objectContaining({
      id: "release-upload-plan",
      status: "skip"
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

  it("summarizes GitHub release preflight remediation without leaking secret values", () => {
    const manifestPath = repoRelativePath(writeMinimalReleaseSet());
    const mock = installMockReadinessToolchain();

    const result = runServiceReadiness([
      "--manifest",
      manifestPath,
      "--repo",
      repository,
      "--skip-updater",
      "--json"
    ], mock.env);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain(fakeSecretValue);
    expect(output).not.toContain(rootDir);

    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ id: string; status: string; message: string; action?: string; detail?: string }>;
    };
    const githubCheck = report.checks.find((check) => check.id === "github-release-environment");

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "hosted-ci")).toEqual(expect.objectContaining({
      status: "pass"
    }));
    expect(githubCheck).toEqual(expect.objectContaining({
      status: "fail",
      message: "GitHub release environment preflight failed: 1 missing environment(s), 1 missing secret name(s), 1 missing deployment branch policy/policies"
    }));
    expect(githubCheck?.action).toContain(`pnpm release:github-setup -- --repo ${repository} --apply`);
    expect(githubCheck?.action).toContain(`gh secret set APPLE_ID --env internal-release --repo ${repository}`);
    expect(githubCheck?.action).toContain(`gh secret set TAURI_SIGNING_PRIVATE_KEY --env production --repo ${repository}`);
    expect(githubCheck?.detail).toContain("missing environments: internal-release");
    expect(githubCheck?.detail).toContain("missing secrets: production/TAURI_SIGNING_PRIVATE_KEY");
    expect(githubCheck?.detail).toContain("missing deployment branches: production/release/*");
  });

  it("verifies the release upload plan during stable readiness audits", () => {
    const manifestPath = repoRelativePath(writeMinimalReleaseSet());
    const mock = installMockReadinessToolchain();

    const result = runServiceReadiness([
      "--manifest",
      manifestPath,
      "--stable-manifest",
      manifestPath,
      "--skip-github",
      "--json"
    ], mock.env);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(rootDir);

    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ id: string; status: string; message: string }>;
    };

    expect(report.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "release-upload-plan")).toEqual(expect.objectContaining({
      status: "pass",
      message: `Verified upload plan for ${manifestPath}`
    }));
    expect(report.checks.find((check) => check.id === "stable-updater-feed")).toEqual(expect.objectContaining({
      status: "pass"
    }));
  });

  it("fails stable readiness audits when the release upload plan is stale", () => {
    const manifestPath = repoRelativePath(writeMinimalReleaseSet());
    const mock = installMockReadinessToolchain();

    const result = runServiceReadiness([
      "--manifest",
      manifestPath,
      "--stable-manifest",
      manifestPath,
      "--skip-github",
      "--json"
    ], {
      ...mock.env,
      BUILDER_GEAR_UPLOAD_PLAN_FAIL: "1"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain(rootDir);

    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ id: string; status: string; message: string; detail?: string }>;
    };
    const uploadPlanCheck = report.checks.find((check) => check.id === "release-upload-plan");

    expect(report.status).toBe("fail");
    expect(uploadPlanCheck).toEqual(expect.objectContaining({
      status: "fail",
      message: "Release upload plan verification failed"
    }));
    expect(uploadPlanCheck?.detail).toContain("release upload plan does not match verified release set");
    expect(uploadPlanCheck?.detail).toContain("[REDACTED_TOKEN]");
    expect(uploadPlanCheck?.detail).toContain("[REDACTED_KEY]");
    expect(uploadPlanCheck?.detail).toContain("Bearer [REDACTED_TOKEN]");
    expect(uploadPlanCheck?.detail).toContain("[REDACTED_PRIVATE_KEY]");
    expect(output).not.toContain(fakeSecretValue);
    expect(output).not.toContain(fakeGitHubToken);
    expect(output).not.toContain(fakeOpenAiKey);
    expect(output).not.toContain(fakeBearerToken);
    expect(output).not.toContain("private-key-material");
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

function runServiceReadiness(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnTsx(["scripts/service-readiness.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    env
  });
}

function installMockReadinessToolchain(): { env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(tmpdir(), "builder-service-readiness-"));
  tempRoots.push(root);
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });

  const preflightReport = {
    repository,
    environments: [
      {
        environment: "internal-release",
        exists: false,
        requiredSecrets: ["APPLE_ID"],
        requiredDeploymentBranches: ["main", "release/*"],
        missingDeploymentBranches: [],
        missingSecrets: [],
        remediation: {
          setupCommand: `pnpm release:github-setup -- --repo ${repository} --apply`,
          secretCommands: [`gh secret set APPLE_ID --env internal-release --repo ${repository}`],
          branchPolicyCommands: [
            expectedBranchPolicyCommand("internal-release", "main"),
            expectedBranchPolicyCommand("internal-release", "release/*")
          ]
        }
      },
      {
        environment: "production",
        exists: true,
        requiredSecrets: ["TAURI_SIGNING_PRIVATE_KEY"],
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true
        },
        requiredDeploymentBranches: ["main", "release/*"],
        missingDeploymentBranches: ["release/*"],
        missingSecrets: ["TAURI_SIGNING_PRIVATE_KEY"],
        remediation: {
          setupCommand: `pnpm release:github-setup -- --repo ${repository} --apply`,
          secretCommands: [`gh secret set TAURI_SIGNING_PRIVATE_KEY --env production --repo ${repository}`],
          branchPolicyCommands: [
            expectedBranchPolicyCommand("production", "release/*")
          ]
        }
      }
    ]
  };

  writeNodeTool(binDir, "git", `
const args = process.argv.slice(2);
if (args[0] === "rev-parse" && args[1] === "HEAD") {
  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");
  process.exit(0);
}
if (args[0] === "status") {
  process.stdout.write("");
  process.exit(0);
}
process.stderr.write("unsupported git args: " + args.join(" ") + "\\n");
process.exit(2);
`);
  writeNodeTool(binDir, "gh", `
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "list") {
  const commit = args[args.indexOf("--commit") + 1];
  process.stdout.write(JSON.stringify([{ databaseId: 101, status: "completed", conclusion: "success", headSha: commit, url: "https://example.test/ci/101" }]));
  process.exit(0);
}
process.stderr.write("unsupported gh args: " + args.join(" ") + "\\n");
process.exit(2);
`);
  writeNodeTool(binDir, "pnpm", `
const args = process.argv.slice(2);
const fakeGhToken = "ghp_" + "abcdefghijklmnop" + "qrstuvwxyz123456";
const fakeOpenAiKey = "sk-" + "abcdefghijklmnop" + "qrstuvwxyz123456";
const fakeBearerToken = "Bearer " + "abcdefghijklmnop" + "qrstuvwxyz123456";
const fakePrivateKey = "-----BEGIN " + "PRIVATE KEY-----\\nprivate-key-material\\n-----END " + "PRIVATE KEY-----";
if (args[0] === "release:verify") {
  process.stdout.write("release manifest verified\\n");
  process.exit(0);
}
if (args[0] === "release:upload-plan") {
  if (process.env.BUILDER_GEAR_UPLOAD_PLAN_FAIL === "1") {
    process.stderr.write("release upload plan: release upload plan does not match verified release set: apps/desktop/src-tauri/target/release-upload/builder-gear-release-upload-plan.json token=" + fakeGhToken + " key=" + fakeOpenAiKey + " bearer=" + fakeBearerToken + " private=" + fakePrivateKey + " env=" + process.env.BUILDER_GEAR_FAKE_SECRET_VALUE + "\\n");
    process.exit(1);
  }
  process.stdout.write("Release upload plan verified: apps/desktop/src-tauri/target/release-upload/builder-gear-release-upload-plan.json.\\n");
  process.exit(0);
}
if (args[0] === "release:github-preflight") {
  process.stdout.write("> builder-gear@0.1.0 release:github-preflight /repo\\n");
  process.stdout.write("> tsx scripts/github-release-preflight.ts -- --repo build-gear/Builder --json\\n\\n");
  process.stdout.write(process.env.BUILDER_GEAR_PREFLIGHT_REPORT || "{}");
  process.stderr.write("github release preflight: GitHub release environment is missing: internal-release\\n");
  process.stderr.write("github release preflight: GitHub release environment production is missing secret: TAURI_SIGNING_PRIVATE_KEY\\n");
  process.stderr.write("github release preflight: GitHub release environment production is missing deployment branch policy: release/*\\n");
  process.exit(1);
}
if (args[0] === "release:verify-updater") {
  process.stdout.write("stable updater feed verified\\n");
  process.exit(0);
}
process.stderr.write("unsupported pnpm args: " + args.join(" ") + "\\n");
process.exit(2);
`);

  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const mockPath = `${binDir}${path.delimiter}${inheritedPath}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: mockPath,
    BUILDER_GEAR_FAKE_SECRET_VALUE: fakeSecretValue,
    BUILDER_GEAR_PREFLIGHT_REPORT: JSON.stringify(preflightReport)
  };
  if (process.platform === "win32") {
    env.Path = mockPath;
  }

  return { env };
}

function writeNodeTool(binDir: string, name: string, source: string): void {
  const scriptPath = path.join(binDir, `${name}.cjs`);
  writeFileSync(scriptPath, source);

  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0\\${name}.cjs" %*\r\n`);
    return;
  }

  const toolPath = path.join(binDir, name);
  writeFileSync(toolPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)});\n`);
  chmodSync(toolPath, 0o755);
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

function expectedBranchPolicyCommand(environment: string, branchPattern: string): string {
  const fieldArg = branchPattern === "release/*" ? "'name=release/*'" : `name=${branchPattern}`;

  return `gh api --method POST repos/${repository}/environments/${encodeURIComponent(environment)}/deployment-branch-policies --field ${fieldArg} --field type=branch`;
}
