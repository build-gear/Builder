#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseCandidateGitHubEnvironmentRequirements
} from "../packages/core/src/release-check.js";
import {
  readRepoJsonFile,
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: pnpm release:github-setup -- [--repo owner/name] [--apply] [--json]";

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
    const requirements = releaseCandidateGitHubEnvironmentRequirements(policy);
    const report = requirements.map((requirement) => {
      const existsBefore = githubEnvironmentExists(repo, requirement.environment);
      const created = parsed.apply && !existsBefore
        ? createGitHubEnvironment(repo, requirement.environment)
        : false;

      return {
        environment: requirement.environment,
        existsBefore,
        created,
        requiredSecrets: requirement.requiredSecrets,
        secretCommands: requirement.requiredSecrets.map((secretName) => (
          `gh secret set ${secretName} --env ${requirement.environment} --repo ${repo}`
        ))
      };
    });

    if (parsed.json) {
      console.log(JSON.stringify({
        repository: repo,
        applied: parsed.apply,
        environments: report
      }, null, 2));
      return;
    }

    console.log(`GitHub release setup ${parsed.apply ? "applied" : "dry run"} for ${repo}.`);
    for (const environment of report) {
      const action = environment.created
        ? "created"
        : environment.existsBefore
          ? "exists"
          : "would create";
      console.log(`- ${environment.environment}: ${action}`);
      console.log(`  required secret names: ${environment.requiredSecrets.join(", ")}`);
      if (!parsed.apply) {
        console.log(`  apply with: pnpm release:github-setup -- --repo ${repo} --apply`);
      }
      console.log(`  set values with: ${environment.secretCommands[0]} ...`);
    }
  } catch (error) {
    console.error(`github release setup: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): { ok: true; repo?: string; apply: boolean; json: boolean } | { ok: false; exitCode: 0 | 1; message: string } {
  const args = argv.filter((arg) => arg !== "--");
  let repo: string | undefined;
  let apply = false;
  let json = false;

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ok: false, exitCode: 0, message: usage };
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--apply") {
      if (apply) {
        return { ok: false, exitCode: 1, message: `duplicate option: --apply\n${usage}` };
      }
      apply = true;
      continue;
    }

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

  return { ok: true, repo, apply, json };
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

function githubEnvironmentExists(repo: string, environment: string): boolean {
  const result = spawnSync("gh", ["api", `repos/${repo}/environments/${encodeURIComponent(environment)}`, "--silent"], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.status === 0) {
    return true;
  }

  const stderr = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return false;
  }

  throw new Error(`GitHub environment could not be read: ${environment}: ${safeGhOutput(stderr)}`);
}

function createGitHubEnvironment(repo: string, environment: string): boolean {
  const result = spawnSync("gh", [
    "api",
    "--method",
    "PUT",
    `repos/${repo}/environments/${encodeURIComponent(environment)}`,
    "--input",
    "-"
  ], {
    cwd: rootDir,
    encoding: "utf8",
    input: JSON.stringify({ wait_timer: 0 }),
    shell: process.platform === "win32"
  });

  if (result.error) {
    throw new Error(`create GitHub environment failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`create GitHub environment failed for ${environment}: ${safeGhOutput(`${result.stderr ?? ""}${result.stdout ?? ""}`)}`);
  }

  return true;
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
  const trimmed = output.replace(/\s+/g, " ").trim();
  return trimmed || "gh command failed";
}

function safeErrorMessage(error: unknown): string {
  return safeScriptErrorMessage(rootDir, error);
}
