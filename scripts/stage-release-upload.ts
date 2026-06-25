#!/usr/bin/env tsx
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCheckedJsonFile,
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";
import { parseReleaseScriptArgs } from "./release-script-args.js";
import {
  hashReleaseArtifactPath,
  macOSDistributionVerificationCommands,
  releaseCheckCommands,
  resolveReleaseArtifactPath,
  verifyReleaseManifestArtifacts,
  verifyReleaseProvenanceArtifacts,
  type DistributionChannel,
  type ReleaseManifest,
  type ReleasePlatform,
  type ReleaseProvenance
} from "../packages/core/src/release-check.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadDir = path.join(rootDir, "apps/desktop/src-tauri/target/release-upload");
const parsedArgs = parseReleaseScriptArgs(process.argv.slice(2), {
  usage: "Usage: pnpm release:stage-upload -- <path/to/builder-gear-release-manifest.json>"
});

if (!parsedArgs.ok) {
  console.error(parsedArgs.message);
  process.exitCode = parsedArgs.exitCode;
} else {
  const manifestPath = resolveReleaseArtifactPath(rootDir, parsedArgs.args.manifestArg);

  if (!manifestPath) {
    console.error("release upload staging: release manifest path must be repository-relative");
    process.exitCode = 1;
  } else {
    const manifest = readJsonFile<ReleaseManifest>(manifestPath, "release manifest");

    if (!manifest) {
      process.exitCode = 1;
    } else {
      const provenancePath = path.join(path.dirname(manifestPath), "builder-gear-release-provenance.json");
      const provenance = readJsonFile<ReleaseProvenance>(provenancePath, "release provenance");

      if (!provenance) {
        process.exitCode = 1;
      } else {
        const errors = verifyReleaseSet(manifest, provenance, manifestPath, provenancePath);

        if (errors.length > 0) {
          for (const error of errors) {
            console.error(`release upload staging: ${error}`);
          }
          process.exitCode = 1;
        } else {
          const uploadFiles = releaseUploadFiles(provenance, provenancePath);
          try {
            stageUploadFiles(uploadFiles);
            console.log(`Release upload staged ${uploadFiles.length} files into ${repoRelativePath(uploadDir)}.`);
          } catch (error) {
            console.error(`release upload staging: ${safeErrorMessage(error)}`);
            process.exitCode = 1;
          }
        }
      }
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

function releaseUploadFiles(provenance: ReleaseProvenance, provenancePath: string): string[] {
  return [
    ...new Set([
      ...provenance.files.map((file) => file.path),
      repoRelativePath(provenancePath)
    ])
  ].sort((left, right) => left.localeCompare(right));
}

function stageUploadFiles(uploadFiles: string[]) {
  ensureSafeUploadDirectory();
  rmSync(uploadDir, { recursive: true, force: true });
  mkdirSync(uploadDir, { recursive: true });

  for (const uploadFile of uploadFiles) {
    const sourcePath = resolveReleaseArtifactPath(rootDir, uploadFile);

    if (!sourcePath) {
      throw new Error(`verified upload path became unsafe: ${uploadFile}`);
    }

    const destinationPath = resolveUploadDestinationPath(uploadFile);
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, {
      dereference: false,
      force: true,
      recursive: true,
      verbatimSymlinks: true
    });

    const sourceSha256 = hashReleaseArtifactPath(sourcePath);
    const destinationSha256 = hashReleaseArtifactPath(destinationPath);
    if (sourceSha256 !== destinationSha256) {
      throw new Error(`staged upload hash mismatch: ${uploadFile}`);
    }
  }
}

function ensureSafeUploadDirectory() {
  const relativeUploadDir = path.relative(rootDir, uploadDir);
  if (!relativeUploadDir || relativeUploadDir.startsWith("..") || path.isAbsolute(relativeUploadDir)) {
    throw new Error("release upload staging directory must stay inside the repository");
  }

  let currentPath = rootDir;
  for (const segment of relativeUploadDir.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    if (!existsSync(currentPath)) {
      continue;
    }

    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`release upload staging path must not contain symlinks: ${repoRelativePath(currentPath)}`);
    }

    if (currentPath !== uploadDir && !stats.isDirectory()) {
      throw new Error(`release upload staging parent is not a directory: ${repoRelativePath(currentPath)}`);
    }
  }
}

function resolveUploadDestinationPath(uploadFile: string): string {
  const destinationPath = path.resolve(uploadDir, uploadFile);
  const relativePath = path.relative(uploadDir, destinationPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`verified upload path escaped staging directory: ${uploadFile}`);
  }

  return destinationPath;
}

function readJsonFile<T>(filePath: string, label: string): T | undefined {
  try {
    return readCheckedJsonFile<T>(filePath, label);
  } catch (error) {
    console.error(`release upload staging: ${label} could not be read: ${repoRelativePath(filePath)}: ${safeErrorMessage(error)}`);
    return undefined;
  }
}

function repoRelativePath(absolutePath: string): string {
  const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : "[REPO_EXTERNAL_PATH]";
}

function validPlatform(platform: unknown): platform is ReleasePlatform {
  return platform === "macos" || platform === "windows" || platform === "linux";
}

function validChannel(channel: unknown): channel is DistributionChannel {
  return channel === "internal" || channel === "stable";
}

function safeErrorMessage(error: unknown): string {
  return safeScriptErrorMessage(rootDir, error);
}
