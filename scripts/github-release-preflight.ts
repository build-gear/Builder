#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseCandidateGitHubEnvironmentRequirements,
  validateReleaseCandidateGitHubSecretInventory,
  type GitHubReleaseSecretInventory
} from "../packages/core/src/release-check.js";
import {
  readRepoJsonFile,
  safeExternalCommandOutput,
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: pnpm release:github-preflight -- [--repo owner/name] [--json]";

main();

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exitCode = parsed.exitCode;
    return;
  }

  try {
    const policy = readRepoJsonFile<Record<string, unknown>>(rootDir, "release/distribution-policy.json", "distribution policy");
    const repo = parsed.repo ?? resolveGitHubRepository();
    const inventories = collectReleaseEnvironmentInventories(repo, policy);
    const errors = validateReleaseCandidateGitHubSecretInventory(policy, inventories);
    const report = releaseCandidateGitHubEnvironmentRequirements(policy).map((requirement) => {
      const inventory = inventories.find((candidate) => candidate.environment === requirement.environment);
      const present = new Set(inventory?.secrets ?? []);
      const deploymentBranches = new Set(inventory?.deploymentBranches ?? []);
      const exists = Boolean(inventory);

      return {
        environment: requirement.environment,
        exists,
        requiredSecrets: requirement.requiredSecrets,
        deploymentBranchPolicy: inventory?.deploymentBranchPolicy,
        requiredDeploymentBranches: requirement.deploymentBranches,
        missingDeploymentBranches: exists
          ? requirement.deploymentBranches.filter((branchPattern) => !deploymentBranches.has(branchPattern))
          : [],
        missingSecrets: exists
          ? requirement.requiredSecrets.filter((secretName) => !present.has(secretName))
          : [],
        remediation: {
          setupCommand: `pnpm release:github-setup -- --repo ${repo} --apply`,
          secretCommands: (exists
            ? requirement.requiredSecrets.filter((secretName) => !present.has(secretName))
            : requirement.requiredSecrets
          ).map((secretName) => (
            `gh secret set ${secretName} --env ${requirement.environment} --repo ${repo}`
          )),
          branchPolicyCommands: (exists
            ? requirement.deploymentBranches.filter((branchPattern) => !deploymentBranches.has(branchPattern))
            : requirement.deploymentBranches
          ).map((branchPattern) => (
            `gh api --method POST repos/${repo}/environments/${encodeURIComponent(requirement.environment)}/deployment-branch-policies --field name=${branchPattern} --field type=branch`
          ))
        }
      };
    });

    if (parsed.json) {
      console.log(JSON.stringify({ repository: repo, environments: report }, null, 2));
    }

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`github release preflight: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!parsed.json) {
      const secretCount = report.reduce((total, environment) => total + environment.requiredSecrets.length, 0);
      console.log(`GitHub release preflight passed for ${repo}: ${report.length} environments, ${secretCount} required secret names checked.`);
    }
  } catch (error) {
    console.error(`github release preflight: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): { ok: true; repo?: string; json: boolean } | { ok: false; exitCode: 0 | 1; message: string } {
  const args = argv.filter((arg) => arg !== "--");
  let repo: string | undefined;
  let json = false;

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ok: false, exitCode: 0, message: usage };
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      if (json) {
        return { ok: false, exitCode: 1, message: `duplicate option: --json\n${usage}` };
      }
      json = true;
      continue;
    }

    if (arg === "--repo") {
      if (repo) {
        return { ok: false, exitCode: 1, message: `duplicate option: --repo\n${usage}` };
      }

      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, exitCode: 1, message: `missing value for option: --repo\n${usage}` };
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
        return { ok: false, exitCode: 1, message: `--repo must be owner/name\n${usage}` };
      }

      repo = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { ok: false, exitCode: 1, message: `help must be requested without other arguments\n${usage}` };
    }

    if (arg.startsWith("-")) {
      return { ok: false, exitCode: 1, message: `unknown option: ${arg}\n${usage}` };
    }

    return { ok: false, exitCode: 1, message: `unexpected argument: ${arg}\n${usage}` };
  }

  return { ok: true, repo, json };
}

function resolveGitHubRepository(): string {
  const output = runGh(["repo", "view", "--json", "nameWithOwner"], "read GitHub repository metadata");
  const parsed = JSON.parse(output) as { nameWithOwner?: string };
  const repo = parsed.nameWithOwner?.trim();

  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GitHub repository could not be resolved; pass --repo owner/name");
  }

  return repo;
}

function collectReleaseEnvironmentInventories(repo: string, policy: Record<string, unknown>): GitHubReleaseSecretInventory[] {
  const inventories: GitHubReleaseSecretInventory[] = [];

  for (const requirement of releaseCandidateGitHubEnvironmentRequirements(policy)) {
    const environment = readGitHubEnvironment(repo, requirement.environment);
    if (!environment.exists) {
      continue;
    }

    inventories.push({
      environment: requirement.environment,
      secrets: listGitHubEnvironmentSecrets(repo, requirement.environment),
      deploymentBranchPolicy: environment.deploymentBranchPolicy,
      deploymentBranches: listDeploymentBranchPolicies(repo, requirement.environment)
    });
  }

  return inventories;
}

function readGitHubEnvironment(repo: string, environment: string): {
  exists: true;
  deploymentBranchPolicy: {
    protectedBranches?: boolean;
    customBranchPolicies?: boolean;
  };
} | { exists: false } {
  const result = spawnSync("gh", ["api", `repos/${repo}/environments/${encodeURIComponent(environment)}`], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout ?? "{}") as {
      deployment_branch_policy?: {
        protected_branches?: boolean;
        custom_branch_policies?: boolean;
      };
    };
    return {
      exists: true,
      deploymentBranchPolicy: {
        protectedBranches: parsed.deployment_branch_policy?.protected_branches,
        customBranchPolicies: parsed.deployment_branch_policy?.custom_branch_policies
      }
    };
  }

  const stderr = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return { exists: false };
  }

  throw new Error(`GitHub environment could not be read: ${environment}: ${safeGhOutput(stderr)}`);
}

function listGitHubEnvironmentSecrets(repo: string, environment: string): string[] {
  const output = runGh([
    "secret",
    "list",
    "--env",
    environment,
    "--repo",
    repo,
    "--json",
    "name",
    "--limit",
    "1000"
  ], `list GitHub environment secrets for ${environment}`);
  const parsed = JSON.parse(output) as Array<{ name?: string }>;

  return parsed
    .map((entry) => entry.name?.trim() ?? "")
    .filter((name) => /^[A-Z0-9_]+$/.test(name))
    .sort();
}

function listDeploymentBranchPolicies(repo: string, environment: string): string[] {
  const output = runGh([
    "api",
    `repos/${repo}/environments/${encodeURIComponent(environment)}/deployment-branch-policies`
  ], `list deployment branch policies for ${environment}`);
  const parsed = JSON.parse(output) as { branch_policies?: Array<{ name?: string }> };

  return (parsed.branch_policies ?? [])
    .map((policy) => policy.name?.trim() ?? "")
    .filter(Boolean)
    .sort();
}

function runGh(args: string[], label: string): string {
  const result = spawnSync("gh", args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed: ${safeGhOutput(`${result.stderr ?? ""}${result.stdout ?? ""}`)}`);
  }

  return result.stdout ?? "";
}

function safeGhOutput(output: string): string {
  const trimmed = safeExternalCommandOutput(rootDir, output).replace(/\s+/g, " ").trim();
  return trimmed || "gh command failed";
}

function safeErrorMessage(error: unknown): string {
  return safeScriptErrorMessage(rootDir, error);
}
