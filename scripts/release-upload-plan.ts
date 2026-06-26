#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCheckedJsonFile,
  repoRelativePath as safeRepoRelativePath,
  safeErrorMessage as safeScriptErrorMessage,
  writeGeneratedRepoTextFile
} from "./script-file-safety.js";
import { parseReleaseScriptArgs } from "./release-script-args.js";
import {
  hashReleaseArtifactPath,
  macOSDistributionVerificationCommands,
  releaseCheckCommands,
  resolveReleaseArtifactPath,
  stableUpdaterPlatformKey,
  validateProductionUpdateUrl,
  verifyReleaseManifestArtifacts,
  verifyReleaseProvenanceArtifacts,
  type DistributionChannel,
  type ReleaseArch,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
  type ReleasePlatform,
  type ReleaseProvenance,
  type ReleaseProvenanceFile,
  type StableUpdaterFeed
} from "../packages/core/src/release-check.js";

type ReleaseUploadPlanFileKind = ReleaseProvenanceFile["kind"] | "provenance";

interface ReleaseUploadPlanFile {
  kind: ReleaseUploadPlanFileKind;
  path: string;
  stagedPath: string;
  sha256: string;
  entryCount?: number;
}

interface ReleaseUploadPlanSourceFile {
  kind: ReleaseUploadPlanFileKind;
  path: string;
  sha256: string;
  entryCount?: number;
}

interface ReleaseUploadPlan {
  schemaVersion: 1;
  generatedAt: string;
  productName: string;
  version: string;
  mode: ReleaseManifest["mode"];
  channel?: DistributionChannel;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  git: ReleaseManifest["git"];
  manifestPath: string;
  provenancePath: string;
  stagingRoot: string;
  files: ReleaseUploadPlanFile[];
  stableUpdater?: {
    platformKey: string;
    feed: {
      artifactPath: string;
      stagedPath: string;
      sha256: string;
      endpoints: Array<{
        url: string;
        urlPath: string;
        decodedUploadPath: string;
      }>;
    };
    payload: {
      artifactPath: string;
      stagedPath: string;
      sha256: string;
      url: string;
      urlPath: string;
      decodedUploadPath: string;
      signatureArtifactPath: string;
      signatureStagedPath: string;
      signatureSha256: string;
    };
  };
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadDir = path.join(rootDir, "apps/desktop/src-tauri/target/release-upload");
const defaultPlanPath = "apps/desktop/src-tauri/target/release-upload/builder-gear-release-upload-plan.json";
const parsedArgs = parseReleaseScriptArgs(process.argv.slice(2), {
  usage: "Usage: pnpm release:upload-plan -- [--output <path>] <path/to/builder-gear-release-manifest.json>",
  allowedValueOptions: ["--output"]
});

if (!parsedArgs.ok) {
  console.error(parsedArgs.message);
  process.exitCode = parsedArgs.exitCode;
} else {
  const manifestPath = resolveReleaseArtifactPath(rootDir, parsedArgs.args.manifestArg);
  const outputPath = parsedArgs.args.options.get("--output") ?? defaultPlanPath;

  if (!manifestPath) {
    console.error("release upload plan: release manifest path must be repository-relative");
    process.exitCode = 1;
  } else if (!resolveReleaseArtifactPath(rootDir, outputPath)) {
    console.error("release upload plan: output path must be repository-relative");
    process.exitCode = 1;
  } else {
    try {
      const manifest = readJsonFile<ReleaseManifest>(manifestPath, "release manifest");
      const provenancePath = path.join(path.dirname(manifestPath), "builder-gear-release-provenance.json");
      const provenance = readJsonFile<ReleaseProvenance>(provenancePath, "release provenance");
      const errors = verifyReleaseSet(manifest, provenance, manifestPath, provenancePath);

      if (errors.length > 0) {
        for (const error of errors) {
          console.error(`release upload plan: ${error}`);
        }
        process.exitCode = 1;
      } else {
        const plan = buildUploadPlan(manifest, provenance, manifestPath, provenancePath);
        writeGeneratedRepoTextFile(rootDir, outputPath, `${JSON.stringify(plan, null, 2)}\n`, "release upload plan");
        console.log(`Release upload plan written to ${outputPath}.`);
      }
    } catch (error) {
      console.error(`release upload plan: ${safeErrorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

function verifyReleaseSet(
  manifest: ReleaseManifest,
  provenance: ReleaseProvenance,
  manifestPath: string,
  provenancePath: string
): string[] {
  const platform = validPlatform(manifest.platform) ? manifest.platform : "macos";
  const artifactPaths = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
      .map((artifact) => resolveReleaseArtifactPath(rootDir, artifact.path))
      .filter((artifactPath): artifactPath is string => Boolean(artifactPath))
    : [];
  const expectedGateIds = [
    ...releaseCheckCommands({
      includeBundle: manifest.includeBundle,
      distribution: manifest.mode === "distribution",
      platform,
      channel: validChannel(manifest.channel) ? manifest.channel : undefined
    }).map((command) => command.id),
    ...(manifest.mode === "distribution" && platform === "macos"
      ? macOSDistributionVerificationCommands(artifactPaths).map((command) => command.id)
      : [])
  ];
  const errors = verifyReleaseManifestArtifacts({
    manifest,
    rootDir,
    expectedGateIds,
    requireArtifacts: manifest.includeBundle
  });
  errors.push(...verifyReleaseProvenanceArtifacts({
    provenance,
    manifest,
    rootDir,
    expectedGateIds,
    expectedManifestPath: repoRelativePath(manifestPath)
  }));

  const provenanceRelativePath = repoRelativePath(provenancePath);
  if (provenanceRelativePath === "[REPO_EXTERNAL_PATH]") {
    errors.push("release provenance path escapes repository root");
  }

  return errors;
}

function buildUploadPlan(
  manifest: ReleaseManifest,
  provenance: ReleaseProvenance,
  manifestPath: string,
  provenancePath: string
): ReleaseUploadPlan {
  const files = releaseUploadFiles(provenance, provenancePath);
  verifyStagedUploadFiles(files);

  const plan: ReleaseUploadPlan = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productName: manifest.productName,
    version: manifest.versions.root,
    mode: manifest.mode,
    channel: manifest.channel,
    platform: manifest.platform,
    arch: manifest.arch,
    git: manifest.git,
    manifestPath: repoRelativePath(manifestPath),
    provenancePath: repoRelativePath(provenancePath),
    stagingRoot: repoRelativePath(uploadDir),
    files: files.map((file) => ({
      kind: file.kind,
      path: file.path,
      stagedPath: stagedUploadPath(file.path),
      sha256: file.sha256,
      ...(file.entryCount === undefined ? {} : { entryCount: file.entryCount })
    }))
  };

  if (manifest.mode === "distribution" && manifest.channel === "stable") {
    plan.stableUpdater = buildStableUpdaterPlan(manifest);
  }

  return plan;
}

function releaseUploadFiles(
  provenance: ReleaseProvenance,
  provenancePath: string
): ReleaseUploadPlanSourceFile[] {
  const provenanceRelativePath = repoRelativePath(provenancePath);
  const files: ReleaseUploadPlanSourceFile[] = [
    ...provenance.files,
    {
      kind: "provenance" as const,
      path: provenanceRelativePath,
      sha256: hashReleaseArtifactPath(provenancePath)
    }
  ];
  const byPath = new Map<string, typeof files[number]>();

  for (const file of files) {
    byPath.set(file.path, file);
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function verifyStagedUploadFiles(files: Array<{ path: string; sha256: string }>): void {
  for (const file of files) {
    const stagedPath = path.join(uploadDir, file.path);
    const relativePath = path.relative(uploadDir, stagedPath);

    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`staged upload file path escaped staging directory: ${file.path}`);
    }
    if (!existsSync(stagedPath)) {
      throw new Error(`staged upload file is missing: ${file.path}`);
    }

    const actualSha256 = hashReleaseArtifactPath(stagedPath);
    if (actualSha256 !== file.sha256) {
      throw new Error(`staged upload file sha256 mismatch: ${file.path}`);
    }
  }
}

function buildStableUpdaterPlan(manifest: ReleaseManifest): ReleaseUploadPlan["stableUpdater"] {
  const feedArtifact = stableFeedArtifact(manifest);
  const feedPath = resolveReleaseArtifactPath(rootDir, feedArtifact.path);

  if (!feedPath) {
    throw new Error(`stable updater feed path is unsafe: ${feedArtifact.path}`);
  }

  const feed = readJsonFile<StableUpdaterFeed>(feedPath, "stable updater feed");
  const platformKey = stableUpdaterPlatformKey(manifest.platform, manifest.arch);
  const platform = feed.platforms?.[platformKey];

  if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
    throw new Error(`stable updater feed is missing platform entry: ${platformKey}`);
  }

  const payloadUrlErrors = validateProductionUpdateUrl("stable updater payload URL", platform.url, {
    requireJsonFeed: false
  });
  if (payloadUrlErrors.length > 0) {
    throw new Error(payloadUrlErrors.join("; "));
  }

  const payloadUrl = parseHttpsUrl(platform.url, "stable updater payload URL");
  const payloadArtifact = stablePayloadArtifact(manifest, payloadUrl);
  const signatureArtifact = stablePayloadSignatureArtifact(manifest, payloadArtifact);
  const endpoints = manifest.buildInputs.stableUpdater?.endpoints ?? [];

  return {
    platformKey,
    feed: {
      artifactPath: feedArtifact.path,
      stagedPath: stagedUploadPath(feedArtifact.path),
      sha256: feedArtifact.sha256,
      endpoints: endpoints.map((endpoint) => {
        const url = parseHttpsUrl(endpoint, "stable updater endpoint");
        return {
          url: url.toString(),
          urlPath: url.pathname,
          decodedUploadPath: decodedUrlUploadPath(url)
        };
      })
    },
    payload: {
      artifactPath: payloadArtifact.path,
      stagedPath: stagedUploadPath(payloadArtifact.path),
      sha256: payloadArtifact.sha256,
      url: payloadUrl.toString(),
      urlPath: payloadUrl.pathname,
      decodedUploadPath: decodedUrlUploadPath(payloadUrl),
      signatureArtifactPath: signatureArtifact.path,
      signatureStagedPath: stagedUploadPath(signatureArtifact.path),
      signatureSha256: signatureArtifact.sha256
    }
  };
}

function stableFeedArtifact(manifest: ReleaseManifest): ReleaseManifestArtifact {
  const artifact = manifest.artifacts.find((entry) => entry.path.endsWith("builder-gear-updater-latest.json"));

  if (!artifact) {
    throw new Error("stable release manifest is missing Tauri updater static JSON feed");
  }

  return artifact;
}

function stablePayloadArtifact(manifest: ReleaseManifest, payloadUrl: URL): ReleaseManifestArtifact {
  const payloadName = decodeUrlBasename(payloadUrl, "stable updater payload URL");
  const artifact = manifest.artifacts.find((entry) => path.basename(entry.path) === payloadName);

  if (!artifact) {
    throw new Error(`stable updater payload is not declared in release manifest: ${payloadName}`);
  }

  return artifact;
}

function stablePayloadSignatureArtifact(
  manifest: ReleaseManifest,
  payloadArtifact: ReleaseManifestArtifact
): ReleaseManifestArtifact {
  const signaturePath = `${payloadArtifact.path}.sig`;
  const artifact = manifest.artifacts.find((entry) => entry.path === signaturePath);

  if (!artifact) {
    throw new Error(`stable updater payload signature is not declared in release manifest: ${signaturePath}`);
  }

  return artifact;
}

function decodeUrlBasename(url: URL, label: string): string {
  try {
    return decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    throw new Error(`${label} path must be URI-decodable`);
  }
}

function decodedUrlUploadPath(url: URL): string {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`URL path must be URI-decodable: ${url.toString()}`);
  }

  const uploadPath = decodedPathname.replace(/^\/+/, "");
  if (
    !uploadPath ||
    uploadPath.includes("\0") ||
    uploadPath.includes("\\") ||
    uploadPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`URL path must be a safe upload path: ${url.toString()}`);
  }

  return uploadPath;
}

function stagedUploadPath(uploadFile: string): string {
  return `${repoRelativePath(uploadDir)}/${uploadFile}`;
}

function readJsonFile<T>(filePath: string, label: string): T {
  return readCheckedJsonFile<T>(filePath, label);
}

function repoRelativePath(absolutePath: string): string {
  return safeRepoRelativePath(rootDir, absolutePath);
}

function validPlatform(platform: unknown): platform is ReleasePlatform {
  return platform === "macos" || platform === "windows" || platform === "linux";
}

function validChannel(channel: unknown): channel is DistributionChannel {
  return channel === "internal" || channel === "stable";
}

function parseHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }

  if (url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} must not include credentials, query strings, or fragments`);
  }

  return url;
}

function safeErrorMessage(error: unknown): string {
  return safeScriptErrorMessage(rootDir, error);
}
