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
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tempRoots: string[] = [];
const repository = "build-gear/Builder";
const fakeSecretValue = "super-secret-gh-release-value";
const fakeGitHubToken = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
const fakeOpenAiKey = `sk-${"abcdefghijklmnopqrstuvwxyz123456"}`;

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
        configured: boolean;
        requiredSecrets: string[];
        deploymentBranches: string[];
        secretCommands: string[];
        branchPolicyCommands: string[];
        branchPoliciesCreated: string[];
      }>;
    };

    expect(report.repository).toBe(repository);
    expect(report.applied).toBe(false);
    expect(report.environments).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        existsBefore: false,
        created: false,
        configured: false,
        requiredSecrets: requirement.requiredSecrets,
        deploymentBranches: requirement.deploymentBranches,
        secretCommands: requirement.requiredSecrets.map((secretName) => (
          `gh secret set ${secretName} --env ${requirement.environment} --repo ${repository}`
        )),
        branchPolicyCommands: requirement.deploymentBranches.map((branchPattern) => (
          `gh api --method POST repos/${repository}/environments/${encodeURIComponent(requirement.environment)}/deployment-branch-policies --field name=${branchPattern} --field type=branch`
        )),
        branchPoliciesCreated: []
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
      environments: Array<{ environment: string; existsBefore: boolean; created: boolean; configured: boolean; branchPoliciesCreated: string[] }>;
    };
    expect(report.applied).toBe(true);
    expect(report.environments.map(({ environment, existsBefore, created, configured, branchPoliciesCreated }) => ({
      environment,
      existsBefore,
      created,
      configured,
      branchPoliciesCreated
    }))).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        existsBefore: false,
        created: true,
        configured: true,
        branchPoliciesCreated: requirement.deploymentBranches
      }))
    );

    const putCalls = readMockGhLog(mock).filter((entry) => entry.args.includes("PUT"));
    expect(putCalls).toHaveLength(2);
    expect(putCalls.map((entry) => entry.args.find((arg) => arg.startsWith("repos/")))).toEqual([
      `repos/${repository}/environments/internal-release`,
      `repos/${repository}/environments/production`
    ]);
    expect(putCalls.map((entry) => JSON.parse(entry.stdin) as unknown)).toEqual([
      {
        wait_timer: 0,
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true
        }
      },
      {
        wait_timer: 0,
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true
        }
      }
    ]);
    const postCalls = readMockGhLog(mock).filter((entry) => entry.args.includes("POST"));
    expect(postCalls).toHaveLength(4);
  });

  it("reports apply permission failures as structured JSON without hiding later environments", () => {
    const mock = installMockGh({
      existingEnvironments: [],
      secretInventory: completeSecretInventory(),
      forbidEnvironmentMutation: true
    });

    const result = runGitHubSetup(["--repo", repository, "--apply", "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain(fakeSecretValue);
    expect(output).not.toContain(fakeGitHubToken);
    expect(output).not.toContain(fakeOpenAiKey);

    const report = JSON.parse(result.stdout) as {
      applied: boolean;
      environments: Array<{
        environment: string;
        existsBefore: boolean;
        created: boolean;
        configured: boolean;
        branchPoliciesCreated: string[];
        error?: string;
      }>;
    };

    expect(report.applied).toBe(true);
    expect(report.environments).toHaveLength(2);
    expect(report.environments.map((environment) => ({
      environment: environment.environment,
      existsBefore: environment.existsBefore,
      created: environment.created,
      configured: environment.configured,
      branchPoliciesCreated: environment.branchPoliciesCreated,
      hasAdminError: environment.error?.includes("Must have admin rights to Repository")
    }))).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        existsBefore: false,
        created: false,
        configured: false,
        branchPoliciesCreated: [],
        hasAdminError: true
      }))
    );

    const putCalls = readMockGhLog(mock).filter((entry) => entry.args.includes("PUT"));
    expect(putCalls).toHaveLength(2);
    expect(readMockGhLog(mock).filter((entry) => entry.args.includes("POST"))).toEqual([]);
  });

  it("redacts secret-shaped GitHub CLI failures during preflight", () => {
    const mock = installMockGh({
      existingEnvironments: ["internal-release", "production"],
      secretInventory: completeSecretInventory(),
      failSecretListFor: "production"
    });

    const result = runGitHubPreflight(["--repo", repository, "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("[REDACTED_TOKEN]");
    expect(output).toContain("[REDACTED_KEY]");
    expect(output).not.toContain(fakeSecretValue);
    expect(output).not.toContain(fakeGitHubToken);
    expect(output).not.toContain(fakeOpenAiKey);
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
      environments: Array<{
        environment: string;
        exists: boolean;
        missingSecrets: string[];
        deploymentBranchPolicy?: { protectedBranches?: boolean; customBranchPolicies?: boolean };
        requiredDeploymentBranches: string[];
        missingDeploymentBranches: string[];
      }>;
    };
    expect(report.repository).toBe(repository);
    expect(report.environments).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        exists: true,
        requiredSecrets: requirement.requiredSecrets,
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true
        },
        requiredDeploymentBranches: requirement.deploymentBranches,
        missingDeploymentBranches: [],
        missingSecrets: [],
        remediation: {
          setupCommand: `pnpm release:github-setup -- --repo ${repository} --apply`,
          secretCommands: [],
          branchPolicyCommands: []
        }
      }))
    );
    expect(readMockGhLog(mock).filter((entry) => entry.args.slice(0, 2).join(" ") === "secret list")).toHaveLength(2);
  });

  it("fails preflight when deployment branch policies are missing", () => {
    const mock = installMockGh({
      existingEnvironments: ["internal-release", "production"],
      deploymentBranchPolicies: {
        "internal-release": ["main"],
        production: []
      },
      secretInventory: completeSecretInventory()
    });

    const result = runGitHubPreflight(["--repo", repository, "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("github release preflight: GitHub release environment internal-release is missing deployment branch policy: release/*");
    expect(output).toContain("github release preflight: GitHub release environment production is missing deployment branch policy: main");
    expect(output).toContain("\"missingDeploymentBranches\": [");
    expect(output).toContain(`gh api --method POST repos/${repository}/environments/internal-release/deployment-branch-policies --field name=release/* --field type=branch`);
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
    expect(output).toContain(`gh secret set TAURI_SIGNING_PRIVATE_KEY --env production --repo ${repository}`);
    expect(output).not.toContain(fakeSecretValue);
  });

  it("reports missing environments separately from missing secrets", () => {
    const mock = installMockGh({
      existingEnvironments: [],
      secretInventory: completeSecretInventory()
    });

    const result = runGitHubPreflight(["--repo", repository, "--json"], mock);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("github release preflight: GitHub release environment is missing: internal-release");
    expect(output).toContain("github release preflight: GitHub release environment is missing: production");

    const report = JSON.parse(result.stdout) as {
      environments: Array<{ environment: string; exists: boolean; missingSecrets: string[]; missingDeploymentBranches: string[] }>;
    };
    expect(report.environments).toEqual(
      releaseRequirements().map((requirement) => ({
        environment: requirement.environment,
        exists: false,
        requiredSecrets: requirement.requiredSecrets,
        requiredDeploymentBranches: requirement.deploymentBranches,
        missingDeploymentBranches: [],
        missingSecrets: [],
        remediation: {
          setupCommand: `pnpm release:github-setup -- --repo ${repository} --apply`,
          secretCommands: requirement.requiredSecrets.map((secretName) => (
            `gh secret set ${secretName} --env ${requirement.environment} --repo ${repository}`
          )),
          branchPolicyCommands: requirement.deploymentBranches.map((branchPattern) => (
            `gh api --method POST repos/${repository}/environments/${encodeURIComponent(requirement.environment)}/deployment-branch-policies --field name=${branchPattern} --field type=branch`
          ))
        }
      }))
    );
    expect(readMockGhLog(mock).filter((entry) => entry.args.slice(0, 2).join(" ") === "secret list")).toHaveLength(0);
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
  deploymentBranchPolicies?: Record<string, string[]>;
  forbidEnvironmentMutation?: boolean;
  failSecretListFor?: string;
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
  writeFileSync(statePath, `${JSON.stringify({
    ...options,
    deploymentBranchPolicyConfig: Object.fromEntries(options.existingEnvironments.map((environment) => [
      environment,
      {
        protected_branches: false,
        custom_branch_policies: true
      }
    ])),
    deploymentBranchPolicies: options.deploymentBranchPolicies ?? Object.fromEntries(options.existingEnvironments.map((environment) => [
      environment,
      ["main", "release/*"]
    ]))
  })}\n`);
  writeFileSync(mockScriptPath, mockGhSource());

  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "gh.cmd"), `@echo off\r\nnode "%~dp0\\mock-gh.cjs" %*\r\n`);
  } else {
    const ghPath = path.join(binDir, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(mockScriptPath)});\n`);
    chmodSync(ghPath, 0o755);
  }

  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const mockPath = `${binDir}${path.delimiter}${inheritedPath}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: mockPath,
    BUILDER_GEAR_FAKE_SECRET_VALUE: fakeSecretValue,
    BUILDER_GEAR_MOCK_GH_LOG: logPath,
    BUILDER_GEAR_MOCK_GH_STATE: statePath
  };
  if (process.platform === "win32") {
    env.Path = mockPath;
  }

  return {
    env,
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
const fakeGhToken = "ghp_" + "abcdefghijklmnop" + "qrstuvwxyz123456";
const fakeOpenAiKey = "sk-" + "abcdefghijklmnop" + "qrstuvwxyz123456";
const stdin = args.includes("PUT") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(logPath, JSON.stringify({ args, stdin }) + "\\n");

function apiPathParts() {
  const apiPath = args.find((arg) => arg.startsWith("repos/"));
  const match = apiPath && /^repos\\/[^/]+\\/[^/]+\\/environments\\/([^/]+)(?:\\/(.+))?$/.exec(apiPath);
  return match ? { environment: decodeURIComponent(match[1]), suffix: match[2] || "" } : undefined;
}

if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: state.repoView || "build-gear/Builder" }));
  process.exit(0);
}

if (args[0] === "api") {
  const parts = apiPathParts();
  if (!parts?.environment) {
    process.stderr.write("unsupported gh api path\\n");
    process.exit(2);
  }
  const environment = parts.environment;

  if (args.includes("PUT")) {
    if (state.forbidEnvironmentMutation) {
      process.stderr.write('gh: Must have admin rights to Repository with token ' + fakeGhToken + ' and key ' + fakeOpenAiKey + '. (HTTP 403) {"message":"Must have admin rights to Repository.","status":"403"}\\n');
      process.exit(1);
    }
    const input = JSON.parse(stdin || "{}");
    state.existingEnvironments = Array.from(new Set([...(state.existingEnvironments || []), environment]));
    state.deploymentBranchPolicyConfig = {
      ...(state.deploymentBranchPolicyConfig || {}),
      [environment]: input.deployment_branch_policy || {}
    };
    state.deploymentBranchPolicies = {
      ...(state.deploymentBranchPolicies || {}),
      [environment]: (state.deploymentBranchPolicies || {})[environment] || []
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write("{}");
    process.exit(0);
  }

  if (!(state.existingEnvironments || []).includes(environment)) {
    process.stderr.write("HTTP 404 Not Found\\n");
    process.exit(1);
  }

  if (parts.suffix === "deployment-branch-policies") {
    if (args.includes("POST")) {
      const nameArg = args.find((arg) => arg.startsWith("name="));
      const name = nameArg && nameArg.slice("name=".length);
      if (!name) {
        process.stderr.write("missing branch policy name\\n");
        process.exit(2);
      }
      const current = new Set(((state.deploymentBranchPolicies || {})[environment] || []));
      current.add(name);
      state.deploymentBranchPolicies = {
        ...(state.deploymentBranchPolicies || {}),
        [environment]: Array.from(current)
      };
      fs.writeFileSync(statePath, JSON.stringify(state));
      process.stdout.write(JSON.stringify({ name }));
      process.exit(0);
    }

    const policies = ((state.deploymentBranchPolicies || {})[environment] || []).map((name, index) => ({
      id: index + 1,
      name
    }));
    process.stdout.write(JSON.stringify({ total_count: policies.length, branch_policies: policies }));
    process.exit(0);
  }

  if (!parts.suffix) {
    const config = (state.deploymentBranchPolicyConfig || {})[environment] || {};
    process.stdout.write(JSON.stringify({ deployment_branch_policy: config }));
    process.exit(0);
  }

  process.stderr.write("unsupported gh api path\\n");
  process.exit(2);
}

if (args[0] === "secret" && args[1] === "list") {
  const environment = args[args.indexOf("--env") + 1];
  if (!(state.existingEnvironments || []).includes(environment)) {
    process.stderr.write("HTTP 404 Not Found\\n");
    process.exit(1);
  }
  if (state.failSecretListFor === environment) {
    process.stderr.write("secret list failed with token " + fakeGhToken + ", key " + fakeOpenAiKey + ", value " + process.env.BUILDER_GEAR_FAKE_SECRET_VALUE + "\\n");
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
  return spawnTsx(["scripts/github-release-setup.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: mock.env
  });
}

function runGitHubPreflight(args: string[], mock: MockGh) {
  return spawnTsx(["scripts/github-release-preflight.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
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
