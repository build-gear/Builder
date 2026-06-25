#!/usr/bin/env tsx
import {
  createHash
} from "node:crypto";
import {
  existsSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  readCheckedJsonFile,
  readCheckedTextFile,
  readRepoJsonFile,
  readRepoTextFile,
  writeGeneratedRepoTextFile
} from "./script-file-safety.js";
import {
  releaseArtifactProfile,
  releaseCheckCommandEnvironment,
  releaseCheckCommands,
  releaseEnvironmentExamplePaths,
  renderStableUpdaterFeed,
  hashReleaseArtifactPath,
  loadReleaseEnvFileFromArgv,
  macOSDistributionVerificationCommands,
  parseReleaseCliChoice,
  validateReleaseCheckArgv,
  validateReleaseManifest,
  validateReleaseMetadata,
  validateRepositoryPrivacyScanCoverage,
  validateRepositorySourceTree,
  validateReleaseGitState,
  verifyMacOSAppBundle,
  verifyReleaseManifestArtifacts,
  verifyReleaseProvenanceArtifacts,
  type DistributionChannel,
  type ReleaseArch,
  type ReleasePlatform,
  type ReleaseManifest,
  type ReleaseManifestInventory,
  type ReleaseInventory,
  type ReleaseInventoryEntry,
  type ReleaseCheckCommand,
  type ReleaseProvenance,
  type ReleaseProvenanceFile
} from "../packages/core/src/release-check.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const includeBundle = !process.argv.includes("--skip-bundle");
const distribution = process.argv.includes("--distribution");
const platformArgument = requestedPlatform();
const channelArgument = requestedChannel();
const channel = distribution ? channelArgument.value ?? "internal" : undefined;
const generatedStableTauriConfigRelativePath = "apps/desktop/src-tauri/target/release-config/tauri.stable.generated.conf.json";
const generatedStableTauriConfigFromDesktop = "src-tauri/target/release-config/tauri.stable.generated.conf.json";

async function main() {
  const argumentErrors = releaseArgumentErrors();
  if (argumentErrors.length > 0) {
    for (const error of argumentErrors) {
      console.error(`release args: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const envFileEnvironment = distribution ? process.env : { ...process.env };
  const envFileErrors = loadReleaseEnvFileFromArgv(process.argv, rootDir, envFileEnvironment);
  if (envFileErrors.length > 0) {
    for (const error of envFileErrors) {
      console.error(`release env: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const sourceTreeErrors = [
    ...validateRepositorySourceTree(rootDir),
    ...validateRepositoryPrivacyScanCoverage(rootDir)
  ];
  if (sourceTreeErrors.length > 0) {
    for (const error of sourceTreeErrors) {
      console.error(`release source tree: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const platform = requestedReleasePlatform();
  const arch = currentReleaseArch();
  const distributionPolicy = readJson("release/distribution-policy.json");
  const stableTauriConfigPath = writeGeneratedStableTauriConfig(channel);
  const tauriConfig = readEffectiveTauriConfig(channel);
  const metadataErrors = validateReleaseMetadata({
    rootPackage: readJson("package.json"),
    corePackage: readJson("packages/core/package.json"),
    cliPackage: readJson("packages/cli/package.json"),
    desktopPackage: readJson("apps/desktop/package.json"),
    cargoPackage: readCargoPackage("apps/desktop/src-tauri/Cargo.toml"),
    cliEntryText: readText("packages/cli/src/index.ts"),
    tauriConfig,
    tauriCapability: readJson("apps/desktop/src-tauri/capabilities/default.json"),
    distributionPolicy,
    repositoryFiles: collectRepositoryFiles(),
    gitignoreText: readText(".gitignore"),
    dependabotConfigText: readText(".github/dependabot.yml"),
    releaseCandidateWorkflowText: readText(".github/workflows/release-candidate.yml"),
    releaseEnvExampleTexts: releaseEnvExampleTexts(),
    readmeText: readText("README.md"),
    securityText: readText("SECURITY.md"),
    privacyText: readText("PRIVACY.md")
  }, { distributionChannel: channel });

  if (metadataErrors.length > 0) {
    for (const error of metadataErrors) {
      console.error(`release metadata: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const git = collectGitInfo();
  const gitErrors = validateReleaseGitState(git, distribution ? "distribution" : "debug");
  if (gitErrors.length > 0) {
    for (const error of gitErrors) {
      console.error(`release git: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const commands = releaseCheckCommands({ includeBundle, distribution, platform, channel, stableTauriConfigPath });

  for (const command of commands) {
    await runCommand(command, distributionPolicy);
  }

  const artifactProfile = releaseArtifactProfile({ platform, distribution, channel });
  const artifactRoot = artifactProfile.artifactRoot;
  const requiredArtifacts = artifactProfile.requiredArtifacts;
  const artifactDirectory = path.join(rootDir, artifactRoot);
  let artifactPaths = includeBundle
    ? resolveArtifacts(artifactDirectory, requiredArtifacts)
    : [];
  const outputDirectory = includeBundle
    ? artifactDirectory
    : path.join(rootDir, "apps/desktop/src-tauri/target/release-readiness");

  if (includeBundle) {
    for (const artifact of requiredArtifacts) {
      const artifactPath = path.join(rootDir, artifactRoot, artifact);

      if (!artifactExists(artifactDirectory, artifact)) {
        console.error(`release artifact missing: ${repoRelativePath(artifactPath)}`);
        process.exitCode = 1;
        return;
      }
    }

    if (distribution && channel === "stable") {
      artifactPaths = [
        ...artifactPaths,
        writeStableUpdaterFeed({
          outputDirectory,
          rootPackage: readJson("package.json"),
          tauriConfig,
          platform,
          arch,
          artifactPaths
        })
      ].sort((left, right) => left.localeCompare(right));
    }
  }

  const metadataVerificationErrors = verifyBuiltArtifactMetadata({
    platform,
    includeBundle,
    tauriConfig,
    artifactPaths
  });

  if (metadataVerificationErrors.length > 0) {
    for (const error of metadataVerificationErrors) {
      console.error(`release artifact metadata: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const artifactVerificationCommands = distribution && platform === "macos"
    ? macOSDistributionVerificationCommands(artifactPaths)
    : [];

  for (const command of artifactVerificationCommands) {
    await runCommand({
      ...command,
      title: `${command.title}: ${path.relative(rootDir, command.artifactPath)}`
    }, distributionPolicy);
  }

  const completedCommands = [...commands, ...artifactVerificationCommands];
  const inventory = buildReleaseInventory({
    rootPackage: readJson("package.json"),
    tauriConfig,
    commands: completedCommands,
    platform,
    channel,
    distribution,
    artifactPaths
  });
  const inventoryReference = writeReleaseInventory(inventory, outputDirectory);
  const manifest = buildReleaseManifest({
    rootPackage: readJson("package.json"),
    corePackage: readJson("packages/core/package.json"),
    cliPackage: readJson("packages/cli/package.json"),
    desktopPackage: readJson("apps/desktop/package.json"),
    cargoPackage: readCargoPackage("apps/desktop/src-tauri/Cargo.toml"),
    tauriConfig,
    commands: completedCommands,
    platform,
    arch,
    includeBundle,
    distribution,
    channel,
    git,
    artifactPaths,
    inventory: inventoryReference
  });
  const expectedGateIds = completedCommands.map((command) => command.id);
  const manifestErrors = validateReleaseManifest(manifest, expectedGateIds);

  if (manifestErrors.length > 0) {
    for (const error of manifestErrors) {
      console.error(`release manifest: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const manifestPath = writeReleaseManifest(manifest, outputDirectory);
  const manifestForVerification = readJsonAbsolute(manifestPath) as unknown as ReleaseManifest;
  const verificationErrors = verifyReleaseManifestArtifacts({
    manifest: manifestForVerification,
    rootDir,
    expectedGateIds,
    requireArtifacts: includeBundle
  });

  if (verificationErrors.length > 0) {
    for (const error of verificationErrors) {
      console.error(`release artifact verification: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const provenance = buildReleaseProvenance({
    manifest: manifestForVerification,
    manifestPath,
    inventory: inventoryReference,
    commands: completedCommands
  });
  const provenancePath = writeReleaseProvenance(provenance, outputDirectory);
  const provenanceErrors = verifyReleaseProvenanceArtifacts({
    provenance: readJsonAbsolute(provenancePath) as unknown as ReleaseProvenance,
    manifest: manifestForVerification,
    rootDir,
    expectedGateIds,
    expectedManifestPath: repoRelativePath(manifestPath)
  });

  if (provenanceErrors.length > 0) {
    for (const error of provenanceErrors) {
      console.error(`release provenance verification: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Release manifest written to ${repoRelativePath(manifestPath)}`);
  console.log(`Release provenance written to ${repoRelativePath(provenancePath)}`);
  console.log("Release readiness check passed.");
}

function readJson(relativePath: string): Record<string, unknown> {
  return readRepoJsonFile(rootDir, relativePath, `release input ${relativePath}`);
}

function readText(relativePath: string): string {
  return readRepoTextFile(rootDir, relativePath, `release input ${relativePath}`);
}

function releaseEnvExampleTexts(): Record<string, string> {
  return Object.fromEntries(
    releaseEnvironmentExamplePaths().map((examplePath) => [examplePath, readText(examplePath)])
  );
}

function readCargoPackage(relativePath: string): Record<string, unknown> {
  const source = readText(relativePath);
  const cargoPackage: Record<string, unknown> = {};
  let inPackageSection = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) {
      continue;
    }

    const section = /^\[([^\]]+)\]$/.exec(line)?.[1];
    if (section) {
      inPackageSection = section === "package";
      continue;
    }

    if (!inPackageSection) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      cargoPackage[match[1]] = match[2];
    }
  }

  return cargoPackage;
}

function readTextAbsolute(absolutePath: string): string {
  return readCheckedTextFile(absolutePath, `release input ${repoRelativePath(absolutePath)}`);
}

function readEffectiveTauriConfig(channel?: DistributionChannel): Record<string, unknown> {
  const baseConfig = readJson("apps/desktop/src-tauri/tauri.conf.json");

  if (channel !== "stable") {
    return baseConfig;
  }

  return deepMerge(baseConfig, stableTauriConfigOverlay());
}

function writeGeneratedStableTauriConfig(channel?: DistributionChannel): string | undefined {
  if (channel !== "stable") {
    return undefined;
  }

  writeGeneratedRepoTextFile(
    rootDir,
    generatedStableTauriConfigRelativePath,
    `${JSON.stringify(stableTauriConfigOverlay(), null, 2)}\n`,
    "stable Tauri config"
  );
  return generatedStableTauriConfigFromDesktop;
}

function stableTauriConfigOverlay(): Record<string, unknown> {
  const overlay = readJson("release/tauri.stable.conf.json");
  const pubkey = process.env.BUILDER_GEAR_UPDATER_PUBKEY?.trim();
  const endpoint = process.env.BUILDER_GEAR_UPDATE_ENDPOINT?.trim();

  if (!pubkey && !endpoint) {
    return overlay;
  }

  const updater: Record<string, unknown> = {};
  if (pubkey) {
    updater.pubkey = pubkey;
  }
  if (endpoint) {
    updater.endpoints = [endpoint];
  }

  return deepMerge(overlay, {
    plugins: {
      updater
    }
  });
}

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value)
      : value;
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonAbsolute(absolutePath: string): Record<string, unknown> {
  return readCheckedJsonFile(absolutePath, `release input ${repoRelativePath(absolutePath)}`);
}

function repoRelativePath(absolutePath: string): string {
  const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : "[REPO_EXTERNAL_PATH]";
}

function artifactExists(directory: string, pattern: string): boolean {
  const patternDirectory = path.dirname(pattern);
  const patternName = path.basename(pattern);
  const searchDirectory = patternDirectory === "." ? directory : path.join(directory, patternDirectory);

  if (!pattern.includes("*")) {
    return existsSync(path.join(directory, pattern));
  }

  const [prefix, suffix] = patternName.split("*");

  return existsSync(searchDirectory) && readdirSync(searchDirectory).some((entry) => (
    entry.startsWith(prefix ?? "") && entry.endsWith(suffix ?? "")
  ));
}

function resolveArtifacts(directory: string, patterns: string[]): string[] {
  const artifacts = new Set<string>();

  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      const artifactPath = path.join(directory, pattern);
      if (existsSync(artifactPath)) {
        artifacts.add(artifactPath);
      }
      continue;
    }

    const patternDirectory = path.dirname(pattern);
    const patternName = path.basename(pattern);
    const searchDirectory = patternDirectory === "." ? directory : path.join(directory, patternDirectory);
    const [prefix, suffix] = patternName.split("*");
    if (!existsSync(searchDirectory)) {
      continue;
    }

    for (const entry of readdirSync(searchDirectory)) {
      if (entry.startsWith(prefix ?? "") && entry.endsWith(suffix ?? "")) {
        artifacts.add(path.join(searchDirectory, entry));
      }
    }
  }

  return [...artifacts].sort((left, right) => left.localeCompare(right));
}

function writeStableUpdaterFeed(options: {
  outputDirectory: string;
  rootPackage: Record<string, unknown>;
  tauriConfig: Record<string, unknown>;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  artifactPaths: string[];
}): string {
  const bundle = stableUpdaterBundleArtifact(options.platform, options.artifactPaths);
  const endpoint = stringArrayAt(objectAt(objectAt(options.tauriConfig, "plugins"), "updater"), "endpoints")[0];
  if (!endpoint) {
    throw new Error("stable updater endpoint is missing before feed generation");
  }
  const feed = renderStableUpdaterFeed({
    version: stringAt(options.rootPackage, "version"),
    generatedAt: new Date().toISOString(),
    platform: options.platform,
    arch: options.arch,
    signature: readTextAbsolute(bundle.signaturePath).trim(),
    url: stableUpdaterArtifactUrl(endpoint, bundle.payloadPath)
  });
  const feedPath = writeGeneratedReleaseOutputFile(
    options.outputDirectory,
    "builder-gear-updater-latest.json",
    `${JSON.stringify(feed, null, 2)}\n`,
    "stable updater feed"
  );
  return feedPath;
}

function stableUpdaterBundleArtifact(platform: ReleasePlatform, artifactPaths: string[]): { payloadPath: string; signaturePath: string } {
  const payloadPath = stableUpdaterPayloadPath(platform, artifactPaths);
  const signaturePath = `${payloadPath}.sig`;

  if (!existsSync(signaturePath)) {
    throw new Error(`stable updater signature is missing for ${repoRelativePath(payloadPath)}`);
  }

  return { payloadPath, signaturePath };
}

function stableUpdaterPayloadPath(platform: ReleasePlatform, artifactPaths: string[]): string {
  const payloadPath = platform === "windows"
    ? artifactPaths.find((artifactPath) => /[/\\]nsis[/\\].+\.exe$/.test(artifactPath)) ??
      artifactPaths.find((artifactPath) => /[/\\]msi[/\\].+\.msi$/.test(artifactPath))
    : artifactPaths.find((artifactPath) => (
      platform === "macos"
        ? artifactPath.endsWith(".app.tar.gz")
        : artifactPath.endsWith(".AppImage")
    ));

  if (!payloadPath) {
    throw new Error(`stable updater payload is missing for ${platform}`);
  }

  return payloadPath;
}

function stableUpdaterArtifactUrl(endpoint: string, artifactPath: string): string {
  const baseUrl = stableUpdaterDownloadBaseUrl(endpoint);
  return new URL(encodeUrlPathSegment(path.basename(artifactPath)), baseUrl).toString();
}

function stableUpdaterDownloadBaseUrl(endpoint: string): string {
  try {
    return new URL(".", endpoint).toString();
  } catch {
    throw new Error("stable updater endpoint must be a valid absolute URL before feed generation");
  }
}

function encodeUrlPathSegment(segment: string): string {
  return segment.split("/").map(encodeURIComponent).join("/");
}

function buildReleaseManifest(options: {
  rootPackage: Record<string, unknown>;
  corePackage: Record<string, unknown>;
  cliPackage: Record<string, unknown>;
  desktopPackage: Record<string, unknown>;
  cargoPackage: Record<string, unknown>;
  tauriConfig: Record<string, unknown>;
  commands: ReleaseCheckCommand[];
  platform: ReleasePlatform;
  arch: ReleaseArch;
  channel?: DistributionChannel;
  includeBundle: boolean;
  distribution: boolean;
  git: ReleaseManifest["git"];
  artifactPaths: string[];
  inventory: ReleaseManifestInventory;
}): ReleaseManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: options.distribution ? "distribution" : "debug",
    platform: options.platform,
    arch: options.arch,
    channel: options.distribution ? options.channel ?? "internal" : undefined,
    includeBundle: options.includeBundle,
    versions: {
      root: stringAt(options.rootPackage, "version"),
      core: stringAt(options.corePackage, "version"),
      cli: stringAt(options.cliPackage, "version"),
      desktop: stringAt(options.desktopPackage, "version"),
      tauri: stringAt(options.tauriConfig, "version"),
      cargo: stringAt(options.cargoPackage, "version")
    },
    packageManager: stringAt(options.rootPackage, "packageManager"),
    productName: stringAt(options.tauriConfig, "productName"),
    identifier: stringAt(options.tauriConfig, "identifier"),
    git: options.git,
    gateIds: options.commands.map((command) => command.id),
    buildInputs: releaseManifestBuildInputs(options.tauriConfig, options.channel),
    artifacts: options.artifactPaths.map((artifactPath) => ({
      path: path.relative(rootDir, artifactPath).split(path.sep).join("/"),
      sha256: hashReleaseArtifactPath(artifactPath)
    })),
    inventory: options.inventory
  };
}

function releaseManifestBuildInputs(tauriConfig: Record<string, unknown>, channel?: DistributionChannel): ReleaseManifest["buildInputs"] {
  const buildInputs: ReleaseManifest["buildInputs"] = {
    tauriConfigSha256: hashJson(tauriConfig)
  };

  if (channel === "stable") {
    const updater = objectAt(objectAt(tauriConfig, "plugins"), "updater");
    const pubkey = stringAt(updater, "pubkey");
    buildInputs.stableUpdater = {
      pubkeySha256: hashText(pubkey),
      endpoints: stringArrayAt(updater, "endpoints")
    };
  }

  return buildInputs;
}

function hashJson(value: unknown): string {
  return hashText(stableJson(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function buildReleaseInventory(options: {
  rootPackage: Record<string, unknown>;
  tauriConfig: Record<string, unknown>;
  commands: ReleaseCheckCommand[];
  platform: ReleasePlatform;
  channel?: DistributionChannel;
  distribution: boolean;
  artifactPaths: string[];
}): ReleaseInventory {
  const sourceEntries = releaseInventorySourceEntries();
  const artifactEntries = options.artifactPaths.map((artifactPath): ReleaseInventoryEntry => ({
    kind: "artifact",
    path: path.relative(rootDir, artifactPath).split(path.sep).join("/"),
    sha256: hashReleaseArtifactPath(artifactPath)
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productName: stringAt(options.tauriConfig, "productName"),
    version: stringAt(options.rootPackage, "version"),
    platform: options.platform,
    mode: options.distribution ? "distribution" : "debug",
    channel: options.distribution ? options.channel ?? "internal" : undefined,
    gateIds: options.commands.map((command) => command.id),
    entries: [...sourceEntries, ...artifactEntries].sort((left, right) => left.path.localeCompare(right.path))
  };
}

function buildReleaseProvenance(options: {
  manifest: ReleaseManifest;
  manifestPath: string;
  inventory: ReleaseManifestInventory;
  commands: ReleaseCheckCommand[];
}): ReleaseProvenance {
  const files: ReleaseProvenanceFile[] = [
    releaseFile("manifest", options.manifestPath),
    {
      kind: "inventory",
      path: options.inventory.path,
      sha256: options.inventory.sha256,
      entryCount: options.inventory.entryCount
    },
    releaseFile("sbom", path.join(rootDir, "release/SBOM.cdx.json")),
    releaseFile("notices", path.join(rootDir, "release/THIRD_PARTY_NOTICES.md")),
    releaseFile("policy", path.join(rootDir, ".github/dependabot.yml")),
    releaseFile("policy", path.join(rootDir, "release/distribution-policy.json")),
    releaseFile("policy", path.join(rootDir, "release/license-policy.json")),
    ...options.manifest.artifacts.map((artifact): ReleaseProvenanceFile => ({
      kind: "artifact",
      path: artifact.path,
      sha256: artifact.sha256
    }))
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productName: options.manifest.productName,
    version: options.manifest.versions.root,
    mode: options.manifest.mode,
    platform: options.manifest.platform,
    channel: options.manifest.channel,
    git: options.manifest.git,
    gateIds: options.commands.map((command) => command.id),
    files: files.sort((left, right) => (
      left.kind.localeCompare(right.kind) ||
      left.path.localeCompare(right.path)
    ))
  };
}

function releaseFile(kind: ReleaseProvenanceFile["kind"], absolutePath: string): ReleaseProvenanceFile {
  return {
    kind,
    path: path.relative(rootDir, absolutePath).split(path.sep).join("/"),
    sha256: hashReleaseArtifactPath(absolutePath)
  };
}

function releaseInventorySourceEntries(): ReleaseInventoryEntry[] {
  return collectRepositoryFiles().map((filePath) => ({
    kind: releaseInventoryKind(filePath),
    path: filePath,
    sha256: hashReleaseArtifactPath(path.join(rootDir, filePath))
  }));
}

function releaseInventoryKind(filePath: string): ReleaseInventoryEntry["kind"] {
  if (filePath.endsWith("pnpm-lock.yaml") || filePath.endsWith("Cargo.lock")) {
    return "lockfile";
  }

  if (filePath.startsWith(".github/workflows/")) {
    return "workflow";
  }

  if (filePath === ".github/dependabot.yml" || filePath.startsWith("release/") || filePath === "SECURITY.md" || filePath === "PRIVACY.md") {
    return "policy";
  }

  return "source";
}

function requestedReleasePlatform(): ReleasePlatform {
  return platformArgument.value ?? currentReleasePlatform();
}

function currentReleasePlatform(): ReleasePlatform {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function currentReleaseArch(): ReleaseArch {
  switch (process.arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    case "ia32":
      return "i686";
    case "arm":
      return "armv7";
    default:
      throw new Error(`unsupported release architecture: ${process.arch}`);
  }
}

function releaseArgumentErrors(): string[] {
  const errors = [
    ...validateReleaseCheckArgv(process.argv),
    ...platformArgument.errors,
    ...channelArgument.errors
  ];

  if (!distribution && channelArgument.provided) {
    errors.push("--channel requires --distribution");
  }

  return errors;
}

function requestedPlatform(): CliChoice<ReleasePlatform> {
  return parseReleaseCliChoice(process.argv, "--platform", ["macos", "windows", "linux"]);
}

function requestedChannel(): CliChoice<DistributionChannel> {
  return parseReleaseCliChoice(process.argv, "--channel", ["internal", "stable"]);
}

interface CliChoice<T extends string> {
  value?: T;
  provided: boolean;
  errors: string[];
}

function verifyBuiltArtifactMetadata(options: {
  platform: ReleasePlatform;
  includeBundle: boolean;
  tauriConfig: Record<string, unknown>;
  artifactPaths: string[];
}): string[] {
  if (!options.includeBundle || options.platform !== "macos") {
    return [];
  }

  const macOS = objectAt(objectAt(options.tauriConfig, "bundle"), "macOS");
  const appPaths = options.artifactPaths.filter((artifactPath) => artifactPath.endsWith(".app"));

  if (appPaths.length === 0) {
    return ["macOS release must include an app bundle"];
  }

  return appPaths.flatMap((appPath) => verifyMacOSAppBundle({
    appPath,
    productName: stringAt(options.tauriConfig, "productName"),
    identifier: stringAt(options.tauriConfig, "identifier"),
    version: stringAt(options.tauriConfig, "version"),
    minimumSystemVersion: stringAt(macOS, "minimumSystemVersion"),
    categoryType: macOSCategoryType(stringAt(objectAt(options.tauriConfig, "bundle"), "category"))
  }));
}

function macOSCategoryType(category: string): string | undefined {
  if (category === "DeveloperTool") {
    return "public.app-category.developer-tools";
  }

  return undefined;
}

function writeReleaseInventory(inventory: ReleaseInventory, outputDirectory: string): ReleaseManifestInventory {
  const inventoryPath = writeGeneratedReleaseOutputFile(
    outputDirectory,
    "builder-gear-release-inventory.json",
    `${JSON.stringify(inventory, null, 2)}\n`,
    "release inventory"
  );

  return {
    path: path.relative(rootDir, inventoryPath).split(path.sep).join("/"),
    sha256: hashReleaseArtifactPath(inventoryPath),
    entryCount: inventory.entries.length
  };
}

function writeReleaseManifest(manifest: ReleaseManifest, outputDirectory: string): string {
  return writeGeneratedReleaseOutputFile(
    outputDirectory,
    "builder-gear-release-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
    "release manifest"
  );
}

function writeReleaseProvenance(provenance: ReleaseProvenance, outputDirectory: string): string {
  return writeGeneratedReleaseOutputFile(
    outputDirectory,
    "builder-gear-release-provenance.json",
    `${JSON.stringify(provenance, null, 2)}\n`,
    "release provenance"
  );
}

function writeGeneratedReleaseOutputFile(
  outputDirectory: string,
  fileName: string,
  body: string,
  label: string
): string {
  return writeGeneratedRepoTextFile(
    rootDir,
    releaseOutputRelativePath(outputDirectory, fileName),
    body,
    label
  );
}

function releaseOutputRelativePath(outputDirectory: string, fileName: string): string {
  if (fileName !== path.basename(fileName)) {
    throw new Error(`release output file name must not contain path separators: ${fileName}`);
  }

  const outputPath = path.resolve(outputDirectory, fileName);
  const relativePath = path.relative(rootDir, outputPath).split(path.sep).join("/");

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`release output path must stay inside the repository: ${fileName}`);
  }

  return relativePath;
}

function collectGitInfo(): ReleaseManifest["git"] {
  const commit = runCapture("git", ["rev-parse", "HEAD"]);
  const status = runCapture("git", ["status", "--porcelain"]);

  return {
    commit: commit || null,
    dirty: status === undefined ? null : status.length > 0
  };
}

function collectRepositoryFiles(): string[] {
  const ignoredDirectories = new Set([
    ".git",
    ".builder",
    "node_modules",
    "dist",
    "target",
    "coverage",
    "test-results",
    "playwright-report",
    "release-candidate-artifact"
  ]);
  const files: string[] = [];

  walk(rootDir);

  return files.sort((left, right) => left.localeCompare(right));

  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (entry.isFile() && !relativePath.endsWith(".tgz")) {
        files.push(relativePath);
      }
    }
  }
}

function runCommand(command: ReleaseCheckCommand, distributionPolicy: Record<string, unknown>): Promise<void> {
  const cwd = path.join(rootDir, command.cwd ?? ".");
  const printable = [command.command, ...command.args].join(" ");
  console.log(`\n[${command.id}] ${command.title}`);
  console.log(`$ ${printable}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd,
      env: releaseCheckCommandEnvironment(process.env, { distribution, distributionPolicy }),
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command.id} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function stringAt(value: Record<string, unknown>, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}

function stringArrayAt(value: Record<string, unknown>, key: string): string[] {
  const child = value[key];
  return Array.isArray(child)
    ? child.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : {};
}

function runCapture(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout.trim();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
