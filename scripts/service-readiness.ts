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

  return {
    id: "github-release-environment",
    title: "GitHub Release Environment",
    status: "fail",
    message: "GitHub release environment preflight failed",
    action: `Use a GitHub token with repository admin access to run pnpm release:github-setup -- --repo ${args.repo} --apply, set required secret values by name, then rerun pnpm release:github-preflight -- --repo ${args.repo}.`,
    detail: safeCommandOutput(result)
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
    env: process.env
  });
}

function pnpmBinary(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
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
