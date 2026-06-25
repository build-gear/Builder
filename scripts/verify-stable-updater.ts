#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveReleaseArtifactPath,
  stableUpdaterPlatformKey,
  compareStableUpdaterFeeds,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
  type StableUpdaterFeed
} from "../packages/core/src/release-check.js";
import {
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";
import { parseReleaseScriptArgs } from "./release-script-args.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RELEASE_JSON_FILE_BYTES = 2_097_152;
const MAX_UPDATER_FEED_BYTES = 1_048_576;
const MAX_UPDATER_DOWNLOAD_BYTES = 1_073_741_824;
const parsedArgs = parseReleaseScriptArgs(process.argv.slice(2), {
  usage: "Usage: pnpm release:verify-updater -- [--artifact-root <path>] <path/to/builder-gear-release-manifest.json> [--verify-downloads]",
  allowedFlags: ["--verify-downloads"],
  allowedValueOptions: ["--artifact-root"]
});

if (!parsedArgs.ok) {
  console.error(parsedArgs.message);
  process.exitCode = parsedArgs.exitCode;
} else {
  const verifyDownloads = parsedArgs.args.flags.has("--verify-downloads");
  const artifactRootDir = resolveArtifactRoot(parsedArgs.args.options.get("--artifact-root") ?? ".");

  if (!artifactRootDir) {
    process.exitCode = 1;
  } else {
    const manifestPath = resolveReleaseArtifactPath(artifactRootDir, parsedArgs.args.manifestArg);

    if (!manifestPath) {
      console.error("stable updater verification: release manifest path must be artifact-root-relative");
      process.exitCode = 1;
    } else {
      verifyStableUpdater(manifestPath, artifactRootDir, verifyDownloads).catch((error: unknown) => {
        console.error(`stable updater verification: ${safeErrorMessage(error)}`);
        process.exitCode = 1;
      });
    }
  }
}

function resolveArtifactRoot(artifactRootArg: string): string | undefined {
  const artifactRoot = resolveReleaseArtifactPath(rootDir, artifactRootArg);

  if (!artifactRoot) {
    console.error("stable updater verification: artifact root must be repository-relative");
    return undefined;
  }

  try {
    const metadata = lstatSync(artifactRoot);
    if (metadata.isSymbolicLink()) {
      console.error("stable updater verification: artifact root must not be a symlink");
      return undefined;
    }
    if (!metadata.isDirectory()) {
      console.error("stable updater verification: artifact root must be a directory");
      return undefined;
    }
  } catch (error) {
    console.error(`stable updater verification: artifact root could not be read: ${safeErrorMessage(error)}`);
    return undefined;
  }

  return artifactRoot;
}

async function verifyStableUpdater(manifestPath: string, artifactRootDir: string, verifyDownloads: boolean): Promise<void> {
  const manifest = readJsonFile<ReleaseManifest>(manifestPath, "release manifest");
  const endpoints = stableUpdaterEndpoints(manifest);
  const localFeedArtifact = stableFeedArtifact(manifest);
  const localFeedPath = resolveReleaseArtifactPath(artifactRootDir, localFeedArtifact.path);

  if (!localFeedPath) {
    throw new Error(`stable updater feed path is unsafe: ${localFeedArtifact.path}`);
  }

  const localFeedSha256 = hashLocalFile(localFeedPath);
  if (localFeedSha256 !== localFeedArtifact.sha256) {
    throw new Error(`local stable updater feed sha256 mismatch: ${localFeedArtifact.path}`);
  }

  const localFeed = readJsonFile<StableUpdaterFeed>(localFeedPath, "stable updater feed");
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    const hostedFeed = await fetchStableUpdaterFeed(endpoint);
    const feedErrors = compareStableUpdaterFeeds({ hostedFeed, localFeed, endpoint });
    errors.push(...feedErrors);

    if (verifyDownloads && feedErrors.length === 0) {
      errors.push(...await verifyHostedUpdaterDownloads(hostedFeed, manifest));
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`stable updater verification: ${error}`);
    }
    process.exitCode = 1;
  } else {
    const downloadText = verifyDownloads ? " and downloads" : "";
    console.log(`Stable updater feed${downloadText} verified for ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}.`);
  }
}

function stableUpdaterEndpoints(manifest: ReleaseManifest): string[] {
  if (manifest.mode !== "distribution" || manifest.channel !== "stable") {
    throw new Error("release manifest must be a stable distribution manifest");
  }

  if (!manifest.includeBundle) {
    throw new Error("stable updater verification requires bundled release artifacts");
  }

  const endpoints = manifest.buildInputs?.stableUpdater?.endpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error("stable release manifest must include updater endpoints");
  }

  for (const endpoint of endpoints) {
    const url = parseHttpsUrl(endpoint, "stable updater endpoint");
    if (!/\.json$/i.test(url.pathname)) {
      throw new Error("stable updater endpoint must point to a static JSON feed");
    }
  }

  return endpoints;
}

function stableFeedArtifact(manifest: ReleaseManifest): ReleaseManifestArtifact {
  const artifact = manifest.artifacts.find((entry) => entry.path.endsWith("builder-gear-updater-latest.json"));

  if (!artifact) {
    throw new Error("stable release manifest is missing Tauri updater static JSON feed");
  }

  return artifact;
}

async function fetchStableUpdaterFeed(endpoint: string): Promise<StableUpdaterFeed> {
  const url = parseHttpsUrl(endpoint, "stable updater endpoint");
  const response = await fetch(url, {
    headers: {
      "accept": "application/json"
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new Error(`stable updater endpoint returned HTTP ${response.status}`);
  }

  const body = await readResponseText(response, MAX_UPDATER_FEED_BYTES, "stable updater feed");
  return JSON.parse(body) as StableUpdaterFeed;
}

async function verifyHostedUpdaterDownloads(feed: StableUpdaterFeed, manifest: ReleaseManifest): Promise<string[]> {
  const errors: string[] = [];
  const platformKey = stableUpdaterPlatformKey(manifest.platform, manifest.arch);
  const platform = feed.platforms?.[platformKey];

  if (!platform) {
    return [`hosted stable updater feed is missing platform entry: ${platformKey}`];
  }

  const payloadUrl = parseHttpsUrl(platform.url, "stable updater payload URL");
  const payloadArtifact = stablePayloadArtifact(manifest, payloadUrl);
  const actualSha256 = await hashRemoteArtifact(payloadUrl);

  if (actualSha256 !== payloadArtifact.sha256) {
    errors.push(`hosted stable updater payload sha256 mismatch: ${payloadUrl.toString()}`);
  }

  return errors;
}

function stablePayloadArtifact(manifest: ReleaseManifest, payloadUrl: URL): ReleaseManifestArtifact {
  const payloadName = decodeURIComponent(path.basename(payloadUrl.pathname));
  const artifact = manifest.artifacts.find((entry) => path.basename(entry.path) === payloadName);

  if (!artifact) {
    throw new Error(`stable updater payload is not declared in release manifest: ${payloadName}`);
  }

  return artifact;
}

async function hashRemoteArtifact(url: URL): Promise<string> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    throw new Error(`stable updater payload returned HTTP ${response.status}: ${url.toString()}`);
  }

  if (!response.body) {
    throw new Error(`stable updater payload response has no body: ${url.toString()}`);
  }

  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let totalBytes = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_UPDATER_DOWNLOAD_BYTES) {
      throw new Error(`stable updater payload exceeds maximum size of ${MAX_UPDATER_DOWNLOAD_BYTES} bytes: ${url.toString()}`);
    }
    hash.update(chunk.value);
  }

  return hash.digest("hex");
}

async function readResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
  if (!response.body) {
    throw new Error(`${label} response has no body`);
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let totalBytes = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }

  return Buffer.concat(chunks).toString("utf8");
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

function hashLocalFile(filePath: string): string {
  const metadata = lstatSync(filePath);

  if (metadata.isSymbolicLink()) {
    throw new Error("stable updater feed must not be a symlink");
  }

  if (!metadata.isFile()) {
    throw new Error("stable updater feed must be a regular file");
  }

  if (metadata.size > MAX_UPDATER_FEED_BYTES) {
    throw new Error(`stable updater feed exceeds maximum size of ${MAX_UPDATER_FEED_BYTES} bytes`);
  }

  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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
