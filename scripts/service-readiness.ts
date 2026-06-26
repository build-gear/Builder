#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  repoRelativePath,
  resolveRepoPath,
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";

type ReadinessStatus = "pass" | "warn" | "fail";
type ReadinessCheckStatus = ReadinessStatus | "skip";

interface ReadinessCheck {
  id: string;
  title: string;
  status: ReadinessCheckStatus;
  message: string;
  action?: string;
  detail?: string;
}

interface ParsedArgs {
  artifactRootPath: string;
  manifestPath: string;
  stableManifestPath?: string;
  repo?: string;
  skipGitHub: boolean;
  skipUpdater: boolean;
  verifyDownloads: boolean;
  json: boolean;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = "apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json";
const usage = [
  "Usage: pnpm service:readiness -- [--artifact-root <path>] [--manifest <path>] [--stable-manifest <path>] [--repo owner/name] [--skip-github] [--skip-updater] [--verify-downloads] [--json]",
  "",
  "Runs a go/no-go readiness audit over the latest local release evidence, hosted GitHub release environment, and stable updater feed.",
  "Artifact root must be repository-relative; manifest paths must be artifact-root-relative. Secret values are never read or printed."
].join("\n");

main();

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exitCode = parsed.exitCode;
    return;
  }

  const checks = runReadinessAudit(parsed.args);
  const status = aggregateStatus(checks);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    checks
  };

  if (parsed.args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Service readiness audit: ${status}`);
    for (const check of checks) {
      console.log(`- [${check.status}] ${check.title}: ${check.message}`);
      if (check.action) {
        console.log(`  action: ${check.action}`);
      }
      if (check.detail) {
        console.log(`  detail: ${check.detail}`);
      }
    }
  }

  process.exitCode = status === "fail" ? 1 : 0;
}

function parseArgs(argv: string[]): { ok: true; args: ParsedArgs } | { ok: false; exitCode: 0 | 1; message: string } {
  const args = argv.filter((arg) => arg !== "--");
  const parsed: ParsedArgs = {
    artifactRootPath: ".",
    manifestPath: defaultManifestPath,
    skipGitHub: false,
    skipUpdater: false,
    verifyDownloads: false,
    json: false
  };

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ok: false, exitCode: 0, message: usage };
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--json") {
      if (parsed.json) {
        return { ok: false, exitCode: 1, message: `duplicate option: --json\n${usage}` };
      }
      parsed.json = true;
      continue;
    }

    if (arg === "--skip-github") {
      if (parsed.skipGitHub) {
        return { ok: false, exitCode: 1, message: `duplicate option: --skip-github\n${usage}` };
      }
      parsed.skipGitHub = true;
      continue;
    }

    if (arg === "--skip-updater") {
      if (parsed.skipUpdater) {
        return { ok: false, exitCode: 1, message: `duplicate option: --skip-updater\n${usage}` };
      }
      parsed.skipUpdater = true;
      continue;
    }

    if (arg === "--verify-downloads") {
      if (parsed.verifyDownloads) {
        return { ok: false, exitCode: 1, message: `duplicate option: --verify-downloads\n${usage}` };
      }
      parsed.verifyDownloads = true;
      continue;
    }

    if (arg === "--artifact-root" || arg === "--manifest" || arg === "--stable-manifest" || arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, exitCode: 1, message: `missing value for option: ${arg}\n${usage}` };
      }

      if (arg === "--artifact-root") {
        if (parsed.artifactRootPath !== ".") {
          return { ok: false, exitCode: 1, message: `duplicate option: --artifact-root\n${usage}` };
        }
        parsed.artifactRootPath = value;
      } else if (arg === "--manifest") {
        if (parsed.manifestPath !== defaultManifestPath) {
          return { ok: false, exitCode: 1, message: `duplicate option: --manifest\n${usage}` };
        }
        parsed.manifestPath = value;
      } else if (arg === "--stable-manifest") {
        if (parsed.stableManifestPath) {
          return { ok: false, exitCode: 1, message: `duplicate option: --stable-manifest\n${usage}` };
        }
        parsed.stableManifestPath = value;
      } else {
        if (parsed.repo) {
          return { ok: false, exitCode: 1, message: `duplicate option: --repo\n${usage}` };
        }
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
          return { ok: false, exitCode: 1, message: `--repo must be owner/name\n${usage}` };
        }
        parsed.repo = value;
      }

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

  if (parsed.verifyDownloads && parsed.skipUpdater) {
    return { ok: false, exitCode: 1, message: `--verify-downloads cannot be used with --skip-updater\n${usage}` };
  }

  return { ok: true, args: parsed };
}

function runReadinessAudit(args: ParsedArgs): ReadinessCheck[] {
  return [
    verifyLocalReleaseManifest(args),
    verifyHostedCiStatus(args),
    verifyGitHubReleaseEnvironment(args),
    verifyStableUpdaterFeed(args)
  ];
}

function verifyLocalReleaseManifest(args: ParsedArgs): ReadinessCheck {
  const artifactRoot = resolveArtifactRoot(args.artifactRootPath);
  const manifest = artifactRoot.ok
    ? checkArtifactFile(artifactRoot.absolutePath, args.manifestPath, "release manifest")
    : artifactRoot;
  if (!manifest.ok) {
    return {
      id: "local-release-manifest",
      title: "Local Release Manifest",
      status: "fail",
      message: manifest.message,
      action: `Run pnpm release:check:fast, then rerun pnpm service:readiness -- --manifest ${args.manifestPath}`
    };
  }

  const result = runPnpm([
    "release:verify",
    "--",
    "--artifact-root",
    args.artifactRootPath,
    args.manifestPath
  ]);
  if (result.status === 0) {
    return {
      id: "local-release-manifest",
      title: "Local Release Manifest",
      status: "pass",
      message: `Verified ${manifest.relativePath}`
    };
  }

  return {
    id: "local-release-manifest",
    title: "Local Release Manifest",
    status: "fail",
    message: "Release manifest verification failed",
    action: "Regenerate release evidence with pnpm release:check:fast or the signed distribution gate.",
    detail: safeCommandOutput(result)
  };
}

function verifyHostedCiStatus(args: ParsedArgs): ReadinessCheck {
  if (args.skipGitHub) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "skip",
      message: "Skipped by --skip-github",
      action: "Run again with --repo OWNER/REPO before dispatching or promoting a release candidate."
    };
  }

  if (!args.repo) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Repository not provided",
      action: "Pass --repo OWNER/REPO so the audit can verify the current commit has a successful hosted CI run."
    };
  }

  const head = runGit(["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Could not resolve current git commit",
      action: "Run from a git checkout and make sure HEAD is available before release promotion.",
      detail: safeCommandOutput(head)
    };
  }

  const headSha = (head.stdout ?? "").trim();
  if (!/^[a-f0-9]{40}$/i.test(headSha)) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Current git commit SHA is invalid",
      action: "Run from a complete git checkout before release promotion.",
      detail: safeCommandOutput(head)
    };
  }

  const status = runGit(["status", "--porcelain=v1"]);
  if (status.status !== 0) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Could not inspect git worktree state",
      action: "Run from a readable git checkout before release promotion.",
      detail: safeCommandOutput(status)
    };
  }

  if ((status.stdout ?? "").trim()) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Git worktree has uncommitted changes",
      action: "Commit, push, and wait for hosted CI to pass so the audited build matches the tested commit.",
      detail: safeCommandOutput(status)
    };
  }

  const runsResult = runGh([
    "run",
    "list",
    "--repo",
    args.repo,
    "--commit",
    headSha,
    "--workflow",
    "CI",
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,headSha,url,createdAt"
  ]);
  if (runsResult.status !== 0) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Could not inspect hosted CI runs",
      action: "Authenticate gh with Actions read access, then rerun the readiness audit.",
      detail: safeCommandOutput(runsResult)
    };
  }

  let runs: GitHubRunListEntry[];
  try {
    runs = parseGitHubRunList(runsResult.stdout ?? "");
  } catch (error) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: "Hosted CI response could not be parsed",
      action: "Rerun the readiness audit after confirming gh can return JSON for workflow runs.",
      detail: safeScriptErrorMessage(rootDir, error)
    };
  }

  const matchingRuns = runs.filter((run) => run.headSha?.toLowerCase() === headSha.toLowerCase());
  const successfulRun = matchingRuns.find((run) => run.status === "completed" && run.conclusion === "success");
  if (successfulRun) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "pass",
      message: `CI passed for ${headSha.slice(0, 12)} in run ${successfulRun.databaseId ?? "unknown"}`,
      detail: successfulRun.url
    };
  }

  const runningRun = matchingRuns.find((run) => run.status !== "completed");
  if (runningRun) {
    return {
      id: "hosted-ci",
      title: "Hosted CI",
      status: "fail",
      message: `CI is still ${runningRun.status} for ${headSha.slice(0, 12)}`,
      action: "Wait for the hosted CI run to complete successfully before promoting the build.",
      detail: runningRun.url
    };
  }

  const failedRun = matchingRuns.find((run) => run.status === "completed");
  return {
    id: "hosted-ci",
    title: "Hosted CI",
    status: "fail",
    message: failedRun
      ? `CI completed with ${failedRun.conclusion ?? "unknown"} for ${headSha.slice(0, 12)}`
      : `No CI run found for ${headSha.slice(0, 12)}`,
    action: "Push the current commit and wait for the CI workflow to pass before release promotion.",
    detail: failedRun?.url
  };
}

function verifyGitHubReleaseEnvironment(args: ParsedArgs): ReadinessCheck {
  if (args.skipGitHub) {
    return {
      id: "github-release-environment",
      title: "GitHub Release Environment",
      status: "skip",
      message: "Skipped by --skip-github",
      action: "Run again with --repo OWNER/REPO before dispatching a hosted release candidate."
    };
  }

  if (!args.repo) {
    return {
      id: "github-release-environment",
      title: "GitHub Release Environment",
      status: "fail",
      message: "Repository not provided",
      action: "Pass --repo OWNER/REPO so the audit can check release environments and secret names."
    };
  }

  const result = runPnpm(["release:github-preflight", "--", "--repo", args.repo, "--json"]);
  if (result.status === 0) {
    return {
      id: "github-release-environment",
      title: "GitHub Release Environment",
      status: "pass",
      message: `Release environments and required secret names are configured for ${args.repo}`
    };
  }

  const failure = summarizeGitHubReleasePreflightFailure(args.repo, result);
  return {
    id: "github-release-environment",
    title: "GitHub Release Environment",
    status: "fail",
    message: failure.message,
    action: failure.action,
    detail: failure.detail
  };
}

function summarizeGitHubReleasePreflightFailure(
  repo: string,
  result: { stdout?: string | null; stderr?: string | null; error?: Error | undefined }
): { message: string; action: string; detail: string } {
  const fallback = {
    message: "GitHub release environment preflight failed",
    action: `Use a GitHub token with repository admin access to run pnpm release:github-setup -- --repo ${repo} --apply, set required secret values by name, then rerun pnpm release:github-preflight -- --repo ${repo}.`,
    detail: safeCommandOutput(result)
  };
  const report = parseGitHubReleasePreflightReport(result.stdout ?? "");
  if (!report) {
    return fallback;
  }

  const environments = report.environments ?? [];
  const missingEnvironments = environments
    .filter((environment) => environment.exists === false)
    .map((environment) => environment.environment)
    .filter(isNonEmptyString);
  const missingSecrets = environments.flatMap((environment) => (
    (environment.missingSecrets ?? []).map((secretName) => `${environment.environment ?? "unknown"}/${secretName}`)
  ));
  const missingBranches = environments.flatMap((environment) => (
    (environment.missingDeploymentBranches ?? []).map((branchPattern) => `${environment.environment ?? "unknown"}/${branchPattern}`)
  ));
  const invalidPolicyEnvironments = environments
    .filter((environment) => (
      environment.exists === true &&
      (
        environment.deploymentBranchPolicy?.customBranchPolicies !== true ||
        environment.deploymentBranchPolicy?.protectedBranches !== false
      )
    ))
    .map((environment) => environment.environment)
    .filter(isNonEmptyString);

  const issueParts = [
    missingEnvironments.length ? `${missingEnvironments.length} missing environment(s)` : "",
    missingSecrets.length ? `${missingSecrets.length} missing secret name(s)` : "",
    invalidPolicyEnvironments.length ? `${invalidPolicyEnvironments.length} environment(s) with invalid branch policy mode` : "",
    missingBranches.length ? `${missingBranches.length} missing deployment branch policy/policies` : ""
  ].filter(Boolean);
  const setupCommands = uniqueStrings(environments
    .map((environment) => environment.remediation?.setupCommand)
    .filter(isNonEmptyString));
  const secretCommands = uniqueStrings(environments.flatMap((environment) => environment.remediation?.secretCommands ?? []));
  const branchPolicyCommands = uniqueStrings(environments.flatMap((environment) => environment.remediation?.branchPolicyCommands ?? []));
  const setupCommand = setupCommands[0] ?? `pnpm release:github-setup -- --repo ${repo} --apply`;
  const actions = [
    (missingEnvironments.length || invalidPolicyEnvironments.length || missingBranches.length)
      ? `Run ${setupCommand} with repository admin rights to create/update environments and deployment branch policies.`
      : "",
    secretCommands.length
      ? `Set required secret values by name, for example: ${previewList(secretCommands, 3)}.`
      : "",
    branchPolicyCommands.length && !missingEnvironments.length
      ? `If branch policies still differ after setup, apply: ${previewList(branchPolicyCommands, 2)}.`
      : "",
    `Rerun pnpm release:github-preflight -- --repo ${repo}.`
  ].filter(Boolean);
  const detailParts = [
    missingEnvironments.length ? `missing environments: ${missingEnvironments.join(", ")}` : "",
    missingSecrets.length ? `missing secrets: ${previewList(missingSecrets, 8)}` : "",
    invalidPolicyEnvironments.length ? `invalid branch policy mode: ${invalidPolicyEnvironments.join(", ")}` : "",
    missingBranches.length ? `missing deployment branches: ${previewList(missingBranches, 8)}` : ""
  ].filter(Boolean);

  return {
    message: issueParts.length
      ? `GitHub release environment preflight failed: ${issueParts.join(", ")}`
      : fallback.message,
    action: actions.join(" "),
    detail: detailParts.length ? detailParts.join("; ") : fallback.detail
  };
}

function verifyStableUpdaterFeed(args: ParsedArgs): ReadinessCheck {
  if (args.skipUpdater) {
    return {
      id: "stable-updater-feed",
      title: "Stable Updater Feed",
      status: "skip",
      message: "Skipped by --skip-updater",
      action: "Run again with --stable-manifest after publishing stable artifacts to the updater host."
    };
  }

  if (!args.stableManifestPath) {
    return {
      id: "stable-updater-feed",
      title: "Stable Updater Feed",
      status: "fail",
      message: "Stable manifest not provided",
      action: "Run pnpm release:check:stable for the target platform, publish staged artifacts, then pass --stable-manifest <path>."
    };
  }

  const artifactRoot = resolveArtifactRoot(args.artifactRootPath);
  const manifest = artifactRoot.ok
    ? checkArtifactFile(artifactRoot.absolutePath, args.stableManifestPath, "stable release manifest")
    : artifactRoot;
  if (!manifest.ok) {
    return {
      id: "stable-updater-feed",
      title: "Stable Updater Feed",
      status: "fail",
      message: manifest.message,
      action: "Run pnpm release:check:stable and publish the generated stable artifact set before verifying the updater feed."
    };
  }

  const result = runPnpm([
    "release:verify-updater",
    "--",
    "--artifact-root",
    args.artifactRootPath,
    args.stableManifestPath,
    ...(args.verifyDownloads ? ["--verify-downloads"] : [])
  ]);
  if (result.status === 0) {
    return {
      id: "stable-updater-feed",
      title: "Stable Updater Feed",
      status: "pass",
      message: args.verifyDownloads
        ? "Hosted updater feed and payload downloads match the stable manifest"
        : "Hosted updater feed matches the stable manifest"
    };
  }

  return {
    id: "stable-updater-feed",
    title: "Stable Updater Feed",
    status: "fail",
    message: "Stable updater verification failed",
    action: "Publish the staged stable feed and payloads to the configured HTTPS updater endpoint, then rerun the updater verifier.",
    detail: safeCommandOutput(result)
  };
}

function resolveArtifactRoot(relativePath: string): { ok: true; absolutePath: string; relativePath: string } | { ok: false; message: string } {
  let absolutePath: string;

  try {
    absolutePath = relativePath === "." ? rootDir : resolveRepoPath(rootDir, relativePath);
  } catch (error) {
    return { ok: false, message: `artifact root path is invalid: ${safeScriptErrorMessage(rootDir, error)}` };
  }

  const safeRelativePath = repoRelativePath(rootDir, absolutePath);
  if (!existsSync(absolutePath)) {
    return { ok: false, message: `artifact root is missing: ${safeRelativePath}` };
  }

  try {
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      return { ok: false, message: `artifact root must not be a symlink: ${safeRelativePath}` };
    }
    if (!metadata.isDirectory()) {
      return { ok: false, message: `artifact root must be a directory: ${safeRelativePath}` };
    }
  } catch (error) {
    return { ok: false, message: `artifact root could not be inspected: ${safeRelativePath}: ${safeScriptErrorMessage(rootDir, error)}` };
  }

  return { ok: true, absolutePath, relativePath: safeRelativePath };
}

function checkArtifactFile(artifactRootDir: string, relativePath: string, label: string): { ok: true; absolutePath: string; relativePath: string } | { ok: false; message: string } {
  let absolutePath: string;

  try {
    absolutePath = resolveArtifactPath(artifactRootDir, relativePath);
  } catch (error) {
    return { ok: false, message: `${label} path is invalid: ${safeScriptErrorMessage(rootDir, error)}` };
  }

  const safeRelativePath = repoRelativePath(rootDir, absolutePath);
  if (!existsSync(absolutePath)) {
    return { ok: false, message: `${label} is missing: ${safeRelativePath}` };
  }

  try {
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      return { ok: false, message: `${label} must not be a symlink: ${safeRelativePath}` };
    }
    if (!metadata.isFile()) {
      return { ok: false, message: `${label} must be a regular file: ${safeRelativePath}` };
    }
  } catch (error) {
    return { ok: false, message: `${label} could not be inspected: ${safeRelativePath}: ${safeScriptErrorMessage(rootDir, error)}` };
  }

  return { ok: true, absolutePath, relativePath: path.relative(artifactRootDir, absolutePath).split(path.sep).join("/") };
}

function resolveArtifactPath(artifactRootDir: string, relativePath: string): string {
  if (!relativePath.trim() || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("artifact path must be relative");
  }

  const root = path.resolve(artifactRootDir);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("artifact path must stay inside the artifact root");
  }

  return resolved;
}

function runPnpm(args: string[]) {
  return spawnSync(pnpmBinary(), args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32"
  });
}

function runGit(args: string[]) {
  return spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}

function runGh(args: string[]) {
  return spawnSync("gh", args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}

function pnpmBinary(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

interface GitHubRunListEntry {
  databaseId?: number;
  status?: string;
  conclusion?: string;
  headSha?: string;
  url?: string;
}

interface GitHubReleasePreflightReport {
  environments?: GitHubReleasePreflightEnvironment[];
}

interface GitHubReleasePreflightEnvironment {
  environment?: string;
  exists?: boolean;
  missingSecrets?: string[];
  missingDeploymentBranches?: string[];
  deploymentBranchPolicy?: {
    protectedBranches?: boolean;
    customBranchPolicies?: boolean;
  };
  remediation?: {
    setupCommand?: string;
    secretCommands?: string[];
    branchPolicyCommands?: string[];
  };
}

function parseGitHubRunList(text: string): GitHubRunListEntry[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected an array of workflow runs");
  }

  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("workflow run entry must be an object");
    }

    const record = entry as Record<string, unknown>;
    return {
      databaseId: typeof record.databaseId === "number" ? record.databaseId : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
      conclusion: typeof record.conclusion === "string" ? record.conclusion : undefined,
      headSha: typeof record.headSha === "string" ? record.headSha : undefined,
      url: typeof record.url === "string" ? record.url : undefined
    };
  });
}

function parseGitHubReleasePreflightReport(text: string): GitHubReleasePreflightReport | undefined {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.environments)) {
      return undefined;
    }

    return {
      environments: record.environments
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => ({
          environment: typeof entry.environment === "string" ? entry.environment : undefined,
          exists: typeof entry.exists === "boolean" ? entry.exists : undefined,
          missingSecrets: stringArray(entry.missingSecrets),
          missingDeploymentBranches: stringArray(entry.missingDeploymentBranches),
          deploymentBranchPolicy: parseDeploymentBranchPolicy(entry.deploymentBranchPolicy),
          remediation: parseGitHubReleaseRemediation(entry.remediation)
        }))
    };
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }

  return undefined;
}

function parseDeploymentBranchPolicy(value: unknown): GitHubReleasePreflightEnvironment["deploymentBranchPolicy"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    protectedBranches: typeof record.protectedBranches === "boolean" ? record.protectedBranches : undefined,
    customBranchPolicies: typeof record.customBranchPolicies === "boolean" ? record.customBranchPolicies : undefined
  };
}

function parseGitHubReleaseRemediation(value: unknown): GitHubReleasePreflightEnvironment["remediation"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    setupCommand: typeof record.setupCommand === "string" ? record.setupCommand : undefined,
    secretCommands: stringArray(record.secretCommands),
    branchPolicyCommands: stringArray(record.branchPolicyCommands)
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(isNonEmptyString)
    : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function previewList(values: string[], limit: number): string {
  const preview = values.slice(0, limit).join("; ");
  return values.length > limit ? `${preview}; ... (${values.length} total)` : preview;
}

function aggregateStatus(checks: ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.status === "warn" || check.status === "skip")) {
    return "warn";
  }

  return "pass";
}

function safeCommandOutput(result: { stdout?: string | null; stderr?: string | null; error?: Error | undefined }): string {
  const raw = result.error?.message ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const rootRedacted = raw.replaceAll(rootDir, "[REPO_ROOT]");
  const envRedacted = redactEnvironmentValues(rootRedacted);
  const compact = envRedacted.replace(/\s+/g, " ").trim();

  return compact.length > 1000 ? `${compact.slice(0, 1000)}...` : compact;
}

function redactEnvironmentValues(text: string): string {
  let redacted = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) {
      continue;
    }
    if (!/(SECRET|TOKEN|PASSWORD|PRIVATE|CERTIFICATE|KEY|APPLE|TAURI|UPDATER)/i.test(key)) {
      continue;
    }
    redacted = redacted.split(value).join("[REDACTED_ENV_VALUE]");
  }

  return redacted
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]");
}
