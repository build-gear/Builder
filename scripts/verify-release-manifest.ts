#!/usr/bin/env tsx
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseCheckCommands,
  macOSDistributionVerificationCommands,
  resolveReleaseArtifactPath,
  verifyMacOSAppBundle,
  verifyReleaseManifestArtifacts,
  verifyReleaseProvenanceArtifacts,
  type DistributionChannel,
  type ReleaseManifest,
  type ReleaseProvenance,
  type ReleasePlatform
} from "../packages/core/src/release-check.js";
import { parseReleaseScriptArgs } from "./release-script-args.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RELEASE_JSON_FILE_BYTES = 2_097_152;
const parsedArgs = parseReleaseScriptArgs(process.argv.slice(2), {
  usage: "Usage: pnpm release:verify -- [--artifact-root <path>] <path/to/builder-gear-release-manifest.json>",
  allowedValueOptions: ["--artifact-root"]
});

if (!parsedArgs.ok) {
  console.error(parsedArgs.message);
  process.exitCode = parsedArgs.exitCode;
} else {
  const artifactRootDir = resolveArtifactRoot(parsedArgs.args.options.get("--artifact-root") ?? ".");

  if (!artifactRootDir) {
    process.exitCode = 1;
  } else {
    const manifestPath = resolveReleaseArtifactPath(artifactRootDir, parsedArgs.args.manifestArg);

    if (!manifestPath) {
      console.error("release artifact verification: release manifest path must be artifact-root-relative");
      process.exitCode = 1;
    } else {
      const manifest = readReleaseManifest(manifestPath, artifactRootDir);

      if (!manifest) {
        process.exitCode = 1;
      } else {
        const platform = validPlatform(manifest.platform) ? manifest.platform : "macos";
        const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
        const artifactPaths = manifestArtifacts
          .map((artifact) => resolveReleaseArtifactPath(artifactRootDir, artifact.path))
          .filter((artifactPath): artifactPath is string => Boolean(artifactPath));
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
          rootDir: artifactRootDir,
          sourceRootDir: rootDir,
          expectedGateIds,
          requireArtifacts: manifest.includeBundle
        });
        errors.push(...verifyManifestArtifactMetadata(manifest, artifactRootDir));
        errors.push(...verifyReleaseProvenance(manifestPath, manifest, expectedGateIds, artifactRootDir));

        if (errors.length > 0) {
          for (const error of errors) {
            console.error(`release artifact verification: ${error}`);
          }
          process.exitCode = 1;
        } else {
          console.log(`Release manifest verified: ${rootRelativePath(artifactRootDir, manifestPath)}`);
        }
      }
    }
  }
}

function resolveArtifactRoot(artifactRootArg: string): string | undefined {
  const artifactRoot = resolveReleaseArtifactPath(rootDir, artifactRootArg);

  if (!artifactRoot) {
    console.error("release artifact verification: artifact root must be repository-relative");
    return undefined;
  }

  try {
    const metadata = lstatSync(artifactRoot);
    if (metadata.isSymbolicLink()) {
      console.error("release artifact verification: artifact root must not be a symlink");
      return undefined;
    }
    if (!metadata.isDirectory()) {
      console.error("release artifact verification: artifact root must be a directory");
      return undefined;
    }
  } catch (error) {
    console.error(`release artifact verification: artifact root could not be read: ${repoRelativePath(artifactRoot)}: ${safeErrorMessage(error)}`);
    return undefined;
  }

  return artifactRoot;
}

function readReleaseManifest(manifestPath: string, artifactRootDir: string): ReleaseManifest | undefined {
  try {
    return readJsonFile<ReleaseManifest>(manifestPath, "release manifest");
  } catch (error) {
    console.error(
      `release artifact verification: release manifest could not be read: ${rootRelativePath(artifactRootDir, manifestPath)}: ${safeErrorMessage(error)}`
    );
    return undefined;
  }
}

function verifyReleaseProvenance(
  manifestPath: string,
  manifest: ReleaseManifest,
  expectedGateIds: string[],
  artifactRootDir: string
): string[] {
  const provenancePath = path.join(path.dirname(manifestPath), "builder-gear-release-provenance.json");

  try {
    const provenance = readJsonFile<ReleaseProvenance>(provenancePath, "release provenance");
    return verifyReleaseProvenanceArtifacts({
      provenance,
      manifest,
      rootDir: artifactRootDir,
      expectedGateIds,
      expectedManifestPath: rootRelativePath(artifactRootDir, manifestPath)
    });
  } catch (error) {
    return [`release provenance could not be read: ${rootRelativePath(artifactRootDir, provenancePath)}: ${safeErrorMessage(error)}`];
  }
}

function readJsonFile<T>(filePath: string, label: string): T {
  const metadata = lstatSync(filePath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }

  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  if (metadata.size > MAX_RELEASE_JSON_FILE_BYTES) {
    throw new Error(`${label} exceeds maximum size of ${MAX_RELEASE_JSON_FILE_BYTES} bytes`);
  }

  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function repoRelativePath(absolutePath: string): string {
  return rootRelativePath(rootDir, absolutePath);
}

function rootRelativePath(baseDir: string, absolutePath: string): string {
  const relativePath = path.relative(baseDir, absolutePath).split(path.sep).join("/");

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

function verifyManifestArtifactMetadata(manifest: ReleaseManifest, artifactRootDir: string): string[] {
  if (!manifest.includeBundle || manifest.platform !== "macos") {
    return [];
  }

  const tauriConfigPath = path.join(rootDir, "apps/desktop/src-tauri/tauri.conf.json");
  let tauriConfig: Record<string, unknown>;

  try {
    tauriConfig = readJsonFile<Record<string, unknown>>(tauriConfigPath, "Tauri config");
  } catch (error) {
    return [`Tauri config could not be read: ${repoRelativePath(tauriConfigPath)}: ${safeErrorMessage(error)}`];
  }

  const macOS = objectAt(objectAt(tauriConfig, "bundle"), "macOS");
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const appArtifacts = artifacts.filter((artifact) => artifact.path.endsWith(".app"));

  if (appArtifacts.length === 0) {
    return ["macOS release must include an app bundle"];
  }

  return appArtifacts.flatMap((artifact) => {
    const appPath = resolveReleaseArtifactPath(artifactRootDir, artifact.path);

    if (!appPath) {
      return [`macOS app bundle path is invalid: ${artifact.path}`];
    }

    return verifyMacOSAppBundle({
      appPath,
      productName: stringAt(tauriConfig, "productName"),
      identifier: stringAt(tauriConfig, "identifier"),
      version: stringAt(tauriConfig, "version"),
      minimumSystemVersion: stringAt(macOS, "minimumSystemVersion"),
      categoryType: macOSCategoryType(stringAt(objectAt(tauriConfig, "bundle"), "category"))
    });
  });
}

function macOSCategoryType(category: string): string | undefined {
  if (category === "DeveloperTool") {
    return "public.app-category.developer-tools";
  }

  return undefined;
}

function stringAt(value: Record<string, unknown>, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(error: unknown): string {
  return errorMessage(error).replaceAll(rootDir, "[REPO_ROOT]");
}
