import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { releaseCandidateGitHubEnvironmentRequirements } from "../release-check.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tempRoots: string[] = [];
const repository = "build-gear/Builder";
const fakeSecretValue = "super-secret-gh-release-value";

describe("GitHub release setup and preflight scripts", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans release environments without applying changes or leaking secret values", () => {
    const mock = installMockGh({
      existingEnvironments: [],
      secretInventory: completeSecretInventory()
    });

    const result = runGitHubSetup(["--repo", repository, "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(fakeSecretValue);

    const report = JSON.parse(result.stdout) as {
      repository: string;
      applied: boolean;
      environments: Array<{
        environment: string;
        existsBefore: boolean;
        created: boolean;
        requiredSecrets: string[];
        secretCommands: string[];
      }>;
    };

    expect(report.repository).toBe(repository);
    expect(report.applied).toBe(false);
    expect(report.environments).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        existsBefore: false,
        created: false,
        requiredSecrets: requirement.requiredSecrets,
        secretCommands: requirement.requiredSecrets.map((secretName) => (
          `gh secret set ${secretName} --env ${requirement.environment} --repo ${repository}`
        ))
      }))
    );
    expect(readMockGhLog(mock).filter((entry) => entry.args.includes("PUT"))).toEqual([]);
  });

  it("creates missing release environments only when apply is requested", () => {
    const mock = installMockGh({
      existingEnvironments: [],
      secretInventory: completeSecretInventory()
    });

    const result = runGitHubSetup(["--repo", repository, "--apply", "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(fakeSecretValue);

    const report = JSON.parse(result.stdout) as {
      applied: boolean;
      environments: Array<{ environment: string; existsBefore: boolean; created: boolean }>;
    };
    expect(report.applied).toBe(true);
    expect(report.environments.map(({ environment, existsBefore, created }) => ({
      environment,
      existsBefore,
      created
    }))).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        existsBefore: false,
        created: true
      }))
    );

    const putCalls = readMockGhLog(mock).filter((entry) => entry.args.includes("PUT"));
    expect(putCalls).toHaveLength(2);
    expect(putCalls.map((entry) => entry.args.find((arg) => arg.startsWith("repos/")))).toEqual([
      `repos/${repository}/environments/internal-release`,
      `repos/${repository}/environments/production`
    ]);
    expect(putCalls.map((entry) => JSON.parse(entry.stdin) as unknown)).toEqual([
      { wait_timer: 0 },
      { wait_timer: 0 }
    ]);
  });

  it("passes preflight when every required environment secret name exists", () => {
    const mock = installMockGh({
      existingEnvironments: ["internal-release", "production"],
      secretInventory: completeSecretInventory()
    });

    const result = runGitHubPreflight(["--repo", repository, "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(fakeSecretValue);

    const report = JSON.parse(result.stdout) as {
      repository: string;
      environments: Array<{ environment: string; missingSecrets: string[] }>;
    };
    expect(report.repository).toBe(repository);
    expect(report.environments).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        requiredSecrets: requirement.requiredSecrets,
        missingSecrets: []
      }))
    );
    expect(readMockGhLog(mock).filter((entry) => entry.args.slice(0, 2).join(" ") === "secret list")).toHaveLength(2);
  });

  it("fails preflight with missing secret names only", () => {
    const inventory = completeSecretInventory();
    if (!inventory.production) {
      throw new Error("production release secret inventory fixture is missing");
    }
    inventory.production = inventory.production.filter((secretName) => secretName !== "TAURI_SIGNING_PRIVATE_KEY");
    const mock = installMockGh({
      existingEnvironments: ["internal-release", "production"],
      secretInventory: inventory
    });

    const result = runGitHubPreflight(["--repo", repository, "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("github release preflight: GitHub release environment production is missing secret: TAURI_SIGNING_PRIVATE_KEY");
    expect(output).toContain("\"missingSecrets\": [");
    expect(output).toContain("\"TAURI_SIGNING_PRIVATE_KEY\"");
    expect(output).not.toContain(fakeSecretValue);
  });

  it("resolves the current repository through gh when --repo is omitted", () => {
    const mock = installMockGh({
      existingEnvironments: [],
      repoView: repository,
      secretInventory: completeSecretInventory()
    });

    const result = runGitHubSetup(["--json"], mock);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      repository,
      applied: false
    });
    expect(readMockGhLog(mock)[0]?.args).toEqual(["repo", "view", "--json", "nameWithOwner"]);
  });
});

interface MockGhOptions {
  existingEnvironments: string[];
  repoView?: string;
  secretInventory: Record<string, string[]>;
}

interface MockGh {
  env: NodeJS.ProcessEnv;
  logPath: string;
}

interface MockGhLogEntry {
  args: string[];
  stdin: string;
}

function installMockGh(options: MockGhOptions): MockGh {
  const root = mkdtempSync(path.join(tmpdir(), "builder-gh-release-script-"));
  tempRoots.push(root);
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });

  const logPath = path.join(root, "gh.log");
  const statePath = path.join(root, "state.json");
  const mockScriptPath = path.join(binDir, "mock-gh.cjs");
  writeFileSync(statePath, `${JSON.stringify(options)}\n`);
  writeFileSync(mockScriptPath, mockGhSource());

  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "gh.cmd"), `@echo off\r\nnode "%~dp0\\mock-gh.cjs" %*\r\n`);
  } else {
    const ghPath = path.join(binDir, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(mockScriptPath)});\n`);
    chmodSync(ghPath, 0o755);
  }

  return {
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      BUILDER_GEAR_FAKE_SECRET_VALUE: fakeSecretValue,
      BUILDER_GEAR_MOCK_GH_LOG: logPath,
      BUILDER_GEAR_MOCK_GH_STATE: statePath
    },
    logPath
  };
}

function mockGhSource(): string {
  return `
const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.BUILDER_GEAR_MOCK_GH_LOG;
const statePath = process.env.BUILDER_GEAR_MOCK_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const stdin = args.includes("PUT") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(logPath, JSON.stringify({ args, stdin }) + "\\n");

function apiEnvironmentName() {
  const apiPath = args.find((arg) => arg.startsWith("repos/"));
  const match = apiPath && /^repos\\/[^/]+\\/[^/]+\\/environments\\/(.+)$/.exec(apiPath);
  return match ? decodeURIComponent(match[1]) : undefined;
}

if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: state.repoView || "build-gear/Builder" }));
  process.exit(0);
}

if (args[0] === "api") {
  const environment = apiEnvironmentName();
  if (!environment) {
    process.stderr.write("unsupported gh api path\\n");
    process.exit(2);
  }

  if (args.includes("PUT")) {
    state.existingEnvironments = Array.from(new Set([...(state.existingEnvironments || []), environment]));
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write("{}");
    process.exit(0);
  }

  if ((state.existingEnvironments || []).includes(environment)) {
    process.exit(0);
  }

  process.stderr.write("HTTP 404 Not Found\\n");
  process.exit(1);
}

if (args[0] === "secret" && args[1] === "list") {
  const environment = args[args.indexOf("--env") + 1];
  if (!(state.existingEnvironments || []).includes(environment)) {
    process.stderr.write("HTTP 404 Not Found\\n");
    process.exit(1);
  }

  const secrets = ((state.secretInventory || {})[environment] || []).map((name) => ({ name }));
  process.stdout.write(JSON.stringify(secrets));
  process.exit(0);
}

process.stderr.write("unsupported gh args: " + args.join(" ") + "\\n");
process.exit(2);
`;
}

function runGitHubSetup(args: string[], mock: MockGh) {
  return spawnSync(tsxBinary(), ["scripts/github-release-setup.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    env: mock.env
  });
}

function runGitHubPreflight(args: string[], mock: MockGh) {
  return spawnSync(tsxBinary(), ["scripts/github-release-preflight.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    env: mock.env
  });
}

function readMockGhLog(mock: MockGh): MockGhLogEntry[] {
  if (!existsSync(mock.logPath)) {
    return [];
  }

  return readFileSync(mock.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MockGhLogEntry);
}

function releaseRequirements() {
  return releaseCandidateGitHubEnvironmentRequirements(distributionPolicy());
}

function completeSecretInventory(): Record<string, string[]> {
  return Object.fromEntries(
    releaseRequirements().map((requirement) => [requirement.environment, requirement.requiredSecrets])
  );
}

function distributionPolicy(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(rootDir, "release/distribution-policy.json"), "utf8")) as Record<string, unknown>;
}

function tsxBinary(): string {
  if (process.platform === "win32") {
    return path.join(rootDir, "node_modules/.bin/tsx.cmd");
  }

  return path.join(rootDir, "node_modules/.bin/tsx");
}
