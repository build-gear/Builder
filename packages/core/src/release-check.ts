import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync
} from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface ReleaseCheckCommand {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd?: string;
}

export interface ReleaseArtifactVerificationCommand extends ReleaseCheckCommand {
  artifactPath: string;
}

export type ReleasePlatform = "macos" | "windows" | "linux";
export type DistributionChannel = "internal" | "stable";
export type ReleaseArch = "x86_64" | "aarch64" | "i686" | "armv7";

export interface ReleaseArtifactProfile {
  platform: ReleasePlatform;
  artifactRoot: string;
  requiredArtifacts: string[];
}

export interface ParsedReleaseEnvFile {
  values: Record<string, string>;
  errors: string[];
}

export interface ReleaseCliChoice<T extends string> {
  value?: T;
  provided: boolean;
  errors: string[];
}

export interface ReleaseMetadata {
  rootPackage: Record<string, unknown>;
  corePackage?: Record<string, unknown>;
  cliPackage?: Record<string, unknown>;
  desktopPackage: Record<string, unknown>;
  cargoPackage?: Record<string, unknown>;
  cliEntryText?: string;
  tauriConfig: Record<string, unknown>;
  tauriCapability?: Record<string, unknown>;
  distributionPolicy: Record<string, unknown>;
  repositoryFiles?: string[];
  gitignoreText?: string;
  dependabotConfigText?: string;
  releaseCandidateWorkflowText?: string;
  releaseEnvExampleTexts?: Record<string, string | undefined>;
  readmeText?: string;
  securityText?: string;
  privacyText?: string;
}

export interface WorkflowFile {
  path: string;
  content: string;
}

export interface DependencyLicenseEntry {
  ecosystem: "node" | "rust";
  name: string;
  version: string;
  license?: string | null;
  source?: string | null;
  homepage?: string | null;
  repository?: string | null;
}

export interface LicensePolicy {
  schemaVersion?: number;
  allowedLicenses?: string[];
  noticeRequiredLicenses?: string[];
  reviewRequiredLicenses?: string[];
}

export interface SbomMetadata {
  productName: string;
  version: string;
}

export interface ValidateReleaseMetadataOptions {
  distributionChannel?: DistributionChannel;
}

export interface ValidateRepositorySourceTreeOptions {
  ignoredDirectories?: string[];
  ignoredPathPrefixes?: string[];
}

export interface ValidateRepositoryPrivacyScanCoverageOptions extends ValidateRepositorySourceTreeOptions {
  maxScannedBytes?: number;
  textExtensions?: string[];
  textFileNames?: string[];
}

export const DEFAULT_REPOSITORY_PRIVACY_SCAN_MAX_BYTES = 2_097_152;

export interface ReleaseManifestArtifact {
  path: string;
  sha256: string;
}

export interface ReleaseManifestInventory {
  path: string;
  sha256: string;
  entryCount: number;
}

export interface ReleaseManifestBuildInputs {
  tauriConfigSha256: string;
  stableUpdater?: {
    pubkeySha256: string;
    endpoints: string[];
  };
}

export interface ReleaseInventoryEntry {
  kind: "source" | "lockfile" | "policy" | "workflow" | "artifact";
  path: string;
  sha256: string;
}

export interface ReleaseInventory {
  schemaVersion: 1;
  generatedAt: string;
  productName: string;
  version: string;
  platform: ReleasePlatform;
  mode: "debug" | "distribution";
  channel?: DistributionChannel;
  gateIds: string[];
  entries: ReleaseInventoryEntry[];
}

export interface ReleaseManifest {
  schemaVersion: 1;
  generatedAt: string;
  mode: "debug" | "distribution";
  platform: ReleasePlatform;
  arch: ReleaseArch;
  includeBundle: boolean;
  versions: {
    root: string;
    core: string;
    cli: string;
    desktop: string;
    tauri: string;
    cargo: string;
  };
  packageManager: string;
  productName: string;
  identifier: string;
  channel?: DistributionChannel;
  git: {
    commit: string | null;
    dirty: boolean | null;
  };
  gateIds: string[];
  buildInputs: ReleaseManifestBuildInputs;
  artifacts: ReleaseManifestArtifact[];
  inventory: ReleaseManifestInventory;
}

export type ReleaseGitState = ReleaseManifest["git"];

export interface ReleaseProvenanceFile {
  kind: "manifest" | "inventory" | "sbom" | "notices" | "policy" | "artifact";
  path: string;
  sha256: string;
  entryCount?: number;
}

export interface ReleaseProvenance {
  schemaVersion: 1;
  generatedAt: string;
  productName: string;
  version: string;
  mode: ReleaseManifest["mode"];
  platform: ReleasePlatform;
  channel?: DistributionChannel;
  git: ReleaseGitState;
  gateIds: string[];
  files: ReleaseProvenanceFile[];
}

export interface VerifyReleaseManifestArtifactsOptions {
  manifest: ReleaseManifest;
  rootDir: string;
  sourceRootDir?: string;
  expectedGateIds?: string[];
  requireArtifacts?: boolean;
}

export interface VerifyMacOSAppBundleOptions {
  appPath: string;
  productName: string;
  identifier: string;
  version: string;
  minimumSystemVersion: string;
  categoryType?: string;
}

export interface VerifyReleaseProvenanceArtifactsOptions {
  provenance: ReleaseProvenance;
  manifest: ReleaseManifest;
  rootDir: string;
  expectedGateIds?: string[];
  expectedManifestPath?: string;
}

export type DistributionPreflightEnv = Record<string, string | undefined>;

export interface StableUpdaterFeed {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, {
    signature: string;
    url: string;
  }>;
}

export interface GitHubReleaseEnvironmentRequirement {
  environment: string;
  requiredSecrets: string[];
}

export interface GitHubReleaseSecretInventory {
  environment: string;
  secrets: string[];
}

const RELEASE_PLATFORMS = ["macos", "windows", "linux"] as const;
const DISTRIBUTION_CHANNELS = ["internal", "stable"] as const;

export function releaseCheckCommands(options: { includeBundle?: boolean; distribution?: boolean; platform?: ReleasePlatform; channel?: DistributionChannel; stableTauriConfigPath?: string } = {}): ReleaseCheckCommand[] {
  const includeBundle = options.includeBundle ?? true;
  const distribution = options.distribution ?? false;
  const platform = options.platform ?? "macos";
  const channel = options.channel ?? "internal";
  const commands: ReleaseCheckCommand[] = distribution ? [
    {
      id: "distribution-preflight",
      title: "Distribution signing and notarization preflight",
      command: "tsx",
      args: ["scripts/distribution-preflight.ts", "--platform", platform, "--channel", channel]
    }
  ] : [];

  commands.push(
    {
      id: "typecheck",
      title: "TypeScript typecheck",
      command: "pnpm",
      args: ["typecheck"]
    },
    {
      id: "lint",
      title: "Workspace lint",
      command: "pnpm",
      args: ["lint"]
    },
    {
      id: "unit-tests",
      title: "TypeScript unit tests",
      command: "pnpm",
      args: ["test"]
    },
    {
      id: "security-audit",
      title: "Dependency security audit",
      command: "pnpm",
      args: ["security:audit"]
    },
    {
      id: "privacy-scan",
      title: "Repository privacy and secret scan",
      command: "pnpm",
      args: ["privacy:scan"]
    },
    {
      id: "license-policy",
      title: "Dependency license policy",
      command: "pnpm",
      args: ["license:policy"]
    },
    {
      id: "license-notices",
      title: "Third-party notices freshness",
      command: "pnpm",
      args: ["license:notices:check"]
    },
    {
      id: "sbom",
      title: "Dependency SBOM freshness",
      command: "pnpm",
      args: ["sbom:check"]
    },
    {
      id: "ci-policy",
      title: "CI workflow supply-chain policy",
      command: "pnpm",
      args: ["ci:policy"]
    },
    {
      id: "rust-format",
      title: "Rust formatting",
      command: "cargo",
      args: ["fmt", "--check"],
      cwd: "apps/desktop/src-tauri"
    },
    {
      id: "rust-clippy",
      title: "Rust static analysis",
      command: "cargo",
      args: ["clippy", "--all-targets", "--", "-D", "warnings"],
      cwd: "apps/desktop/src-tauri"
    },
    {
      id: "rust-tests",
      title: "Rust backend tests",
      command: "cargo",
      args: ["test"],
      cwd: "apps/desktop/src-tauri"
    },
    {
      id: "desktop-e2e",
      title: "Desktop E2E tests",
      command: "pnpm",
      args: ["--filter", "@builder/desktop", "test:e2e"]
    },
    {
      id: "workspace-build",
      title: "Workspace production build",
      command: "pnpm",
      args: ["build"]
    },
    {
      id: "cli-smoke",
      title: "Built CLI smoke test",
      command: "tsx",
      args: ["scripts/cli-smoke.ts"]
    }
  );

  if (includeBundle) {
    const artifactProfile = releaseArtifactProfile({ platform, distribution, channel });
    commands.push({
      id: "desktop-bundle",
      title: distribution ? "Tauri signed distribution bundle" : "Tauri desktop app bundle",
      command: "pnpm",
      args: tauriBuildArgs({ distribution, channel, platform, stableTauriConfigPath: options.stableTauriConfigPath })
    });
    commands.push({
      id: "desktop-bundle-smoke",
      title: "Desktop app bundle executable smoke verification",
      command: "tsx",
      args: [
        "scripts/desktop-bundle-smoke.ts",
        "--platform",
        platform,
        "--artifact-root",
        artifactProfile.artifactRoot,
        ...(distribution ? ["--distribution", "--channel", channel] : [])
      ]
    });
  }

  return commands;
}

export function validateRepositorySourceTree(rootDir: string, options: ValidateRepositorySourceTreeOptions = {}): string[] {
  const root = path.resolve(rootDir);
  const ignoredDirectories = new Set(options.ignoredDirectories ?? defaultRepositoryIgnoredDirectories());
  const ignoredPathPrefixes = options.ignoredPathPrefixes ?? [];
  const errors: string[] = [];

  walk(root);

  return errors;

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRepositoryPath(path.relative(root, absolutePath));

      if (ignoredPathPrefixes.some((prefix) => relativePath === prefix.replace(/\/$/, "") || relativePath.startsWith(prefix))) {
        continue;
      }

      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        errors.push(`repository source must not contain symlinks: ${relativePath}`);
        continue;
      }

      if (stats.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          walk(absolutePath);
        }
        continue;
      }
    }
  }
}

export function validateRepositoryPrivacyScanCoverage(
  rootDir: string,
  options: ValidateRepositoryPrivacyScanCoverageOptions = {}
): string[] {
  const root = path.resolve(rootDir);
  const ignoredDirectories = new Set(options.ignoredDirectories ?? defaultRepositoryIgnoredDirectories());
  const ignoredPathPrefixes = options.ignoredPathPrefixes ?? [];
  const maxScannedBytes = options.maxScannedBytes ?? DEFAULT_REPOSITORY_PRIVACY_SCAN_MAX_BYTES;
  const textExtensions = new Set((options.textExtensions ?? defaultRepositoryTextExtensions()).map((item) => item.toLowerCase()));
  const textFileNames = new Set((options.textFileNames ?? defaultRepositoryTextFileNames()).map((item) => item.toLowerCase()));
  const errors: string[] = [];

  walk(root);

  return errors;

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRepositoryPath(path.relative(root, absolutePath));

      if (ignoredPathPrefixes.some((prefix) => relativePath === prefix.replace(/\/$/, "") || relativePath.startsWith(prefix))) {
        continue;
      }

      const stats = lstatSync(absolutePath);
      if (stats.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          walk(absolutePath);
        }
        continue;
      }

      if (stats.isFile() && stats.size > maxScannedBytes && isRepositoryTextFile(relativePath, textExtensions, textFileNames)) {
        errors.push(`repository text file exceeds privacy scan size limit: ${relativePath}`);
      }
    }
  }
}

function defaultRepositoryIgnoredDirectories(): string[] {
  return [
    ".git",
    ".builder",
    ".turbo",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "release-candidate-artifact",
    "target",
    "test-results"
  ];
}

function defaultRepositoryTextExtensions(): string[] {
  return [
    ".bat",
    ".cmd",
    ".conf",
    ".cjs",
    ".css",
    ".csv",
    ".env",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".jsonc",
    ".jsonl",
    ".jsx",
    ".lock",
    ".md",
    ".mjs",
    ".plist",
    ".ps1",
    ".rs",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".tsv",
    ".txt",
    ".xml",
    ".yaml",
    ".yml"
  ];
}

function defaultRepositoryTextFileNames(): string[] {
  return [
    ".env.example",
    ".gitignore",
    "Dockerfile",
    "LICENSE",
    "Makefile",
    "NOTICE"
  ];
}

function isRepositoryTextFile(relativePath: string, textExtensions: Set<string>, textFileNames: Set<string>): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  const extension = path.posix.extname(relativePath).toLowerCase();

  return textFileNames.has(basename) || textExtensions.has(extension);
}

function tauriBuildArgs(options: { distribution: boolean; channel: DistributionChannel; platform: ReleasePlatform; stableTauriConfigPath?: string }): string[] {
  const args = options.distribution
    ? ["--filter", "@builder/desktop", "tauri", "build", "--bundles", bundleTargetsForPlatform(options.platform, true)]
    : ["--filter", "@builder/desktop", "tauri", "build", "--debug", "--bundles", bundleTargetsForPlatform(options.platform, false)];

  if (options.distribution && options.channel === "stable") {
    args.push("--config", options.stableTauriConfigPath ?? "../../release/tauri.stable.conf.json");
  }

  return args;
}

export function macOSDistributionVerificationCommands(artifactPaths: string[]): ReleaseArtifactVerificationCommand[] {
  const commands: ReleaseArtifactVerificationCommand[] = [];

  for (const artifactPath of [...artifactPaths].sort((left, right) => (
    macOSDistributionArtifactPriority(left) - macOSDistributionArtifactPriority(right) ||
    left.localeCompare(right)
  ))) {
    if (artifactPath.endsWith(".app")) {
      commands.push(
        {
          id: "macos-codesign-app",
          title: "macOS app code signature verification",
          command: "codesign",
          args: ["--verify", "--deep", "--strict", "--verbose=2", artifactPath],
          artifactPath
        },
        {
          id: "macos-spctl-app",
          title: "macOS app Gatekeeper assessment",
          command: "spctl",
          args: ["--assess", "--type", "execute", "--verbose", artifactPath],
          artifactPath
        },
        {
          id: "macos-stapler-app",
          title: "macOS app notarization staple validation",
          command: "xcrun",
          args: ["stapler", "validate", artifactPath],
          artifactPath
        }
      );
      continue;
    }

    if (artifactPath.endsWith(".dmg")) {
      commands.push(
        {
          id: "macos-codesign-dmg",
          title: "macOS DMG code signature verification",
          command: "codesign",
          args: ["--verify", "--verbose=2", artifactPath],
          artifactPath
        },
        {
          id: "macos-spctl-dmg",
          title: "macOS DMG Gatekeeper assessment",
          command: "spctl",
          args: ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", artifactPath],
          artifactPath
        },
        {
          id: "macos-stapler-dmg",
          title: "macOS DMG notarization staple validation",
          command: "xcrun",
          args: ["stapler", "validate", artifactPath],
          artifactPath
        }
      );
    }
  }

  return commands;
}

function macOSDistributionArtifactPriority(artifactPath: string): number {
  if (artifactPath.endsWith(".app")) {
    return 0;
  }

  if (artifactPath.endsWith(".dmg")) {
    return 1;
  }

  return 2;
}

function bundleTargetsForPlatform(platform: ReleasePlatform, distribution: boolean): string {
  switch (platform) {
    case "macos":
      return distribution ? "app,dmg" : "app";
    case "windows":
      return distribution ? "msi,nsis" : "msi";
    case "linux":
      return distribution ? "appimage,deb,rpm" : "appimage";
  }
}

export function releaseArtifactProfile(options: { platform: ReleasePlatform; distribution?: boolean; channel?: DistributionChannel }): ReleaseArtifactProfile {
  const distribution = options.distribution ?? false;
  const stable = distribution && options.channel === "stable";
  const profile = distribution ? "release" : "debug";

  switch (options.platform) {
    case "macos":
      return {
        platform: options.platform,
        artifactRoot: `apps/desktop/src-tauri/target/${profile}/bundle/macos`,
        requiredArtifacts: stable
          ? ["Builder Gear.app", "Builder Gear*.dmg", "Builder Gear.app.tar.gz", "Builder Gear.app.tar.gz.sig"]
          : distribution
            ? ["Builder Gear.app", "Builder Gear*.dmg"]
            : ["Builder Gear.app"]
      };
    case "windows":
      return {
        platform: options.platform,
        artifactRoot: `apps/desktop/src-tauri/target/${profile}/bundle`,
        requiredArtifacts: stable
          ? ["msi/Builder Gear*.msi", "msi/Builder Gear*.msi.sig", "nsis/Builder Gear*_x64-setup.exe", "nsis/Builder Gear*_x64-setup.exe.sig"]
          : distribution
            ? ["msi/Builder Gear*.msi", "nsis/Builder Gear*_x64-setup.exe"]
            : ["msi/Builder Gear*.msi"]
      };
    case "linux":
      return {
        platform: options.platform,
        artifactRoot: `apps/desktop/src-tauri/target/${profile}/bundle`,
        requiredArtifacts: stable
          ? ["appimage/Builder Gear*.AppImage", "appimage/Builder Gear*.AppImage.sig", "deb/builder-gear*.deb", "rpm/builder-gear*.rpm"]
          : distribution
            ? ["appimage/Builder Gear*.AppImage", "deb/builder-gear*.deb", "rpm/builder-gear*.rpm"]
            : ["appimage/Builder Gear*.AppImage"]
      };
  }
}

export function stableUpdaterPlatformKey(platform: ReleasePlatform, arch: ReleaseArch): string {
  const os = platform === "macos" ? "darwin" : platform;
  return `${os}-${arch}`;
}

export function renderStableUpdaterFeed(options: {
  version: string;
  generatedAt: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  url: string;
  signature: string;
  notes?: string;
}): StableUpdaterFeed {
  return {
    version: options.version,
    notes: options.notes ?? `Builder Gear ${options.version}`,
    pub_date: options.generatedAt,
    platforms: {
      [stableUpdaterPlatformKey(options.platform, options.arch)]: {
        signature: options.signature,
        url: options.url
      }
    }
  };
}

export function compareStableUpdaterFeeds(options: {
  readonly hostedFeed: StableUpdaterFeed;
  readonly localFeed: StableUpdaterFeed;
  readonly endpoint: string;
}): string[] {
  const errors: string[] = [];
  const allowedFeedFields = new Set(["version", "notes", "pub_date", "platforms"]);
  const allowedPlatformFields = new Set(["signature", "url"]);
  const hostedFeed = stableUpdaterObjectRecord(options.hostedFeed);
  const localFeed = stableUpdaterObjectRecord(options.localFeed);

  errors.push(...unexpectedStableUpdaterFields("hosted stable updater feed", options.hostedFeed, allowedFeedFields, options.endpoint));
  errors.push(...unexpectedStableUpdaterFields("staged stable updater feed", options.localFeed, allowedFeedFields, options.endpoint));
  compareStableUpdaterFeedField(errors, options.endpoint, "version", stableUpdaterStringAt(hostedFeed, "version"), stableUpdaterStringAt(localFeed, "version"));
  compareStableUpdaterFeedField(errors, options.endpoint, "notes", stableUpdaterStringAt(hostedFeed, "notes"), stableUpdaterStringAt(localFeed, "notes"));
  compareStableUpdaterFeedField(errors, options.endpoint, "pub_date", stableUpdaterStringAt(hostedFeed, "pub_date"), stableUpdaterStringAt(localFeed, "pub_date"));

  const hostedPlatforms = stableUpdaterObjectRecord(hostedFeed?.platforms) ?? {};
  const localPlatforms = stableUpdaterObjectRecord(localFeed?.platforms) ?? {};
  const hostedKeys = new Set(Object.keys(hostedPlatforms));
  const localKeys = new Set(Object.keys(localPlatforms));

  for (const platformKey of [...localKeys].sort()) {
    if (!hostedKeys.has(platformKey)) {
      errors.push(`hosted stable updater feed is missing platform entry ${platformKey}: ${options.endpoint}`);
    }
  }

  for (const platformKey of [...hostedKeys].sort()) {
    if (!localKeys.has(platformKey)) {
      errors.push(`hosted stable updater feed has unexpected platform entry ${platformKey}: ${options.endpoint}`);
    }
  }

  for (const platformKey of [...localKeys].filter((key) => hostedKeys.has(key)).sort()) {
    const hostedPlatform = hostedPlatforms[platformKey];
    const localPlatform = localPlatforms[platformKey];

    errors.push(...unexpectedStableUpdaterFields(`hosted stable updater feed platform ${platformKey}`, hostedPlatform, allowedPlatformFields, options.endpoint));
    errors.push(...unexpectedStableUpdaterFields(`staged stable updater feed platform ${platformKey}`, localPlatform, allowedPlatformFields, options.endpoint));
    compareStableUpdaterFeedField(
      errors,
      options.endpoint,
      `platforms.${platformKey}.url`,
      stableUpdaterStringAt(stableUpdaterObjectRecord(hostedPlatform), "url"),
      stableUpdaterStringAt(stableUpdaterObjectRecord(localPlatform), "url")
    );
    compareStableUpdaterFeedField(
      errors,
      options.endpoint,
      `platforms.${platformKey}.signature`,
      stableUpdaterStringAt(stableUpdaterObjectRecord(hostedPlatform), "signature"),
      stableUpdaterStringAt(stableUpdaterObjectRecord(localPlatform), "signature")
    );
  }

  return errors;
}

function stableUpdaterObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stableUpdaterStringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const child = value?.[key];
  return typeof child === "string" ? child : undefined;
}

function unexpectedStableUpdaterFields(
  label: string,
  value: unknown,
  allowedFields: Set<string>,
  endpoint: string
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label} must be an object: ${endpoint}`];
  }

  return Object.keys(value as Record<string, unknown>)
    .filter((field) => !allowedFields.has(field))
    .sort((left, right) => left.localeCompare(right))
    .map((field) => `${label} has unexpected field ${field}: ${endpoint}`);
}

function compareStableUpdaterFeedField(
  errors: string[],
  endpoint: string,
  field: string,
  hostedValue: string | undefined,
  localValue: string | undefined
): void {
  if (hostedValue !== localValue) {
    errors.push(`hosted stable updater feed field mismatch ${field}: ${endpoint}`);
  }
}

export function validateReleaseMetadata(metadata: ReleaseMetadata, options: ValidateReleaseMetadataOptions = {}): string[] {
  const errors: string[] = [];
  const rootScripts = objectAt(metadata.rootPackage, "scripts");
  const desktopScripts = objectAt(metadata.desktopPackage, "scripts");
  const desktopDependencies = objectAt(metadata.desktopPackage, "dependencies");
  const rootVersion = stringAt(metadata.rootPackage, "version");
  const coreVersion = stringAt(metadata.corePackage, "version");
  const cliVersion = stringAt(metadata.cliPackage, "version");
  const desktopVersion = stringAt(metadata.desktopPackage, "version");
  const cargoVersion = stringAt(metadata.cargoPackage, "version");
  const tauriVersion = stringAt(metadata.tauriConfig, "version");
  const tauriIdentifier = stringAt(metadata.tauriConfig, "identifier");
  const tauriProductName = stringAt(metadata.tauriConfig, "productName");
  const buildConfig = objectAt(metadata.tauriConfig, "build");
  const app = objectAt(metadata.tauriConfig, "app");
  const security = objectAt(app, "security");
  const bundle = objectAt(metadata.tauriConfig, "bundle");
  const macOS = objectAt(bundle, "macOS");
  const csp = stringAt(security, "csp");
  const devCsp = stringAt(security, "devCsp");
  const tauriCapability = metadata.tauriCapability ?? {};
  const distributionPolicy = metadata.distributionPolicy;
  const repositoryFiles = new Set(metadata.repositoryFiles ?? []);

  if (!stringAt(metadata.rootPackage, "packageManager")) {
    errors.push("root packageManager is required");
  }

  for (const scriptName of ["typecheck", "lint", "test", "build", "ci:policy", "license:policy", "license:notices", "license:notices:check", "sbom:generate", "sbom:check", "security:audit", "privacy:scan", "icons:generate", "release:check", "release:check:distribution", "release:check:stable", "release:preflight", "release:github-setup", "release:github-preflight", "release:smoke-bundle", "release:stage-upload", "release:verify", "release:verify-updater", "service:readiness"]) {
    if (!stringAt(rootScripts, scriptName)) {
      errors.push(`root script is missing: ${scriptName}`);
    }
  }

  const securityAuditScript = stringAt(rootScripts, "security:audit");
  if (securityAuditScript && !securityAuditScript.includes("--audit-level low")) {
    errors.push("root security:audit must fail on low and higher advisories");
  }

  for (const scriptName of ["typecheck", "test", "test:e2e", "build", "tauri"]) {
    if (!stringAt(desktopScripts, scriptName)) {
      errors.push(`desktop script is missing: ${scriptName}`);
    }
  }

  errors.push(...validateDesktopBuildPipeline(desktopScripts, buildConfig));

  for (const dependencyName of ["@tauri-apps/api", "@tauri-apps/plugin-updater"]) {
    if (!stringAt(desktopDependencies, dependencyName)) {
      errors.push(`desktop dependency is missing: ${dependencyName}`);
    }
  }

  if (!rootVersion || !coreVersion || !cliVersion || !desktopVersion || !tauriVersion || !cargoVersion) {
    errors.push("root, core, CLI, desktop, Tauri, and Cargo versions are required");
  } else if (
    rootVersion !== coreVersion ||
    coreVersion !== cliVersion ||
    cliVersion !== desktopVersion ||
    desktopVersion !== tauriVersion ||
    tauriVersion !== cargoVersion
  ) {
    errors.push("root, core, CLI, desktop, Tauri, and Cargo versions must match");
  }

  errors.push(...validateCliVersionSource(metadata.cliEntryText, cliVersion));

  if (!tauriProductName) {
    errors.push("Tauri productName is required");
  }

  if (!tauriIdentifier || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(tauriIdentifier)) {
    errors.push("Tauri identifier must be a reverse-DNS identifier");
  }

  if (booleanAt(bundle, "active") !== true) {
    errors.push("Tauri bundle.active must be true");
  }

  for (const field of ["publisher", "category", "license", "copyright"]) {
    if (!stringAt(bundle, field)) {
      errors.push(`Tauri bundle.${field} is required`);
    }
  }

  const bundleIcons = stringArrayAt(bundle, "icon");
  for (const iconPath of requiredTauriBundleIcons()) {
    if (!bundleIcons.includes(iconPath)) {
      errors.push(`Tauri bundle.icon must include ${iconPath}`);
    }

    const repositoryIconPath = normalizeRepositoryPath(path.posix.join("apps/desktop/src-tauri", iconPath));
    if (!repositoryFiles.has(repositoryIconPath)) {
      errors.push(`Tauri bundle icon is missing: ${repositoryIconPath}`);
    }
  }

  if (options.distributionChannel === "stable" && booleanAt(bundle, "createUpdaterArtifacts") !== true) {
    errors.push("Tauri updater artifacts must be enabled for the stable distribution channel");
  }

  if (options.distributionChannel === "stable") {
    errors.push(...validateStableUpdaterConfig(metadata.tauriConfig));
  }

  if (options.distributionChannel !== "stable" && booleanAt(bundle, "createUpdaterArtifacts") !== false) {
    errors.push("Tauri updater artifacts must remain disabled unless the stable distribution channel is selected");
  }

  if (booleanAt(macOS, "hardenedRuntime") !== true) {
    errors.push("Tauri macOS hardenedRuntime must be true");
  }

  if (!stringAt(macOS, "minimumSystemVersion")) {
    errors.push("Tauri macOS minimumSystemVersion is required");
  }

  const tauriEntitlements = stringAt(macOS, "entitlements");
  if (!tauriEntitlements) {
    errors.push("Tauri macOS entitlements file is required");
  } else {
    const entitlementsPath = tauriMacOSEntitlementsRepositoryPath(tauriEntitlements);

    if (!entitlementsPath) {
      errors.push("Tauri macOS entitlements file must be a relative path inside apps/desktop/src-tauri");
    } else if (!repositoryFiles.has(entitlementsPath)) {
      errors.push(`Tauri macOS entitlements file is missing: ${entitlementsPath}`);
    }
  }

  if (!csp) {
    errors.push("Tauri CSP must be explicit");
  } else {
    if (!csp.includes("default-src 'self'")) {
      errors.push("Tauri CSP must restrict default-src to self");
    }
    if (!csp.includes("script-src 'self'")) {
      errors.push("Tauri CSP must restrict script-src to self");
    }
    if (!csp.includes("object-src 'none'")) {
      errors.push("Tauri CSP must block object embedding");
    }
    if (!csp.includes("form-action 'none'")) {
      errors.push("Tauri CSP must block form submissions");
    }
    if (hasLocalhostDevOrigin(csp)) {
      errors.push("Tauri production CSP must not allow localhost dev origins");
    }
    errors.push(...validateProductionCspSources(csp));
  }

  if (!devCsp) {
    errors.push("Tauri devCsp must be explicit so production CSP can stay closed");
  }

  if (booleanAt(security, "freezePrototype") !== true) {
    errors.push("Tauri security.freezePrototype must be true");
  }

  errors.push(...validateTauriCapability(tauriCapability, repositoryFiles));
  errors.push(...validateDistributionPolicy(distributionPolicy, metadata.tauriConfig));
  errors.push(...validateReleaseEnvironmentOperationalCoverage({
    distributionPolicy,
    repositoryFiles,
    releaseCandidateWorkflowText: metadata.releaseCandidateWorkflowText,
    releaseEnvExampleTexts: metadata.releaseEnvExampleTexts
  }));
  errors.push(...validateOperationalFiles(repositoryFiles));
  errors.push(...validateReadmeOperationsDocs(metadata.readmeText, repositoryFiles));
  errors.push(...validateSecurityPrivacyDocs({
    repositoryFiles,
    securityText: metadata.securityText,
    privacyText: metadata.privacyText
  }));
  errors.push(...validateDependabotConfig(metadata.dependabotConfigText, repositoryFiles));
  errors.push(...validateGitIgnorePolicy(metadata.gitignoreText, repositoryFiles));

  return errors;
}

function validateCliVersionSource(cliEntryText: string | undefined, cliVersion: string | undefined): string[] {
  if (cliEntryText === undefined) {
    return [];
  }

  const errors: string[] = [];
  const cliVersionMatch = /\bconst\s+CLI_VERSION\s*=\s*["']([^"']+)["'];/.exec(cliEntryText);

  if (!cliVersionMatch) {
    errors.push("CLI entry must declare CLI_VERSION");
  } else if (cliVersion && cliVersionMatch[1] !== cliVersion) {
    errors.push("CLI_VERSION must match @builder/cli package version");
  }

  if (!/\.version\(\s*CLI_VERSION\s*\)/.test(cliEntryText)) {
    errors.push("CLI --version must use CLI_VERSION");
  }

  if (!/\bappVersion\s*:\s*CLI_VERSION\b/.test(cliEntryText)) {
    errors.push("CLI support bundle appVersion must use CLI_VERSION");
  }

  return errors;
}

function validateDesktopBuildPipeline(
  desktopScripts: Record<string, unknown> | undefined,
  tauriBuildConfig: Record<string, unknown> | undefined
): string[] {
  const errors: string[] = [];
  const desktopBuild = stringAt(desktopScripts, "build");
  const beforeBuildCommand = stringAt(tauriBuildConfig, "beforeBuildCommand");

  if (desktopBuild) {
    if (!desktopBuild.includes("tsc --noEmit")) {
      errors.push("desktop build script must typecheck before bundling");
    }
    if (!desktopBuild.includes("vite build")) {
      errors.push("desktop build script must produce the Vite production bundle");
    }
  }

  if (!beforeBuildCommand) {
    errors.push("Tauri build.beforeBuildCommand is required");
  } else if (beforeBuildCommand !== "pnpm build") {
    errors.push("Tauri build.beforeBuildCommand must run the desktop build script with typecheck");
  }

  return errors;
}

export function verifyReleaseManifestArtifacts(options: VerifyReleaseManifestArtifactsOptions): string[] {
  const expectedGateIds = options.expectedGateIds ?? releaseManifestGateIds(options.manifest);
  const requireArtifacts = options.requireArtifacts ?? options.manifest.includeBundle;
  const errors = validateReleaseManifest(options.manifest, expectedGateIds);
  const seenPaths = new Set<string>();
  const artifacts = releaseManifestArtifacts(options.manifest);

  if (requireArtifacts && artifacts.length === 0) {
    errors.push("release manifest artifacts are required for artifact verification");
  }

  errors.push(...verifyReleaseInventoryReference(options));

  for (const artifact of artifacts) {
    if (seenPaths.has(artifact.path)) {
      errors.push(`release manifest artifact path is duplicated: ${artifact.path}`);
      continue;
    }
    seenPaths.add(artifact.path);

    const artifactPath = resolveReleaseArtifactPath(options.rootDir, artifact.path);
    if (!artifactPath) {
      errors.push(`release manifest artifact path escapes repository root: ${artifact.path}`);
      continue;
    }

    if (!existsSync(artifactPath)) {
      errors.push(`release manifest artifact is missing: ${artifact.path}`);
      continue;
    }

    try {
      const actualSha256 = hashReleaseArtifactPath(artifactPath);
      if (actualSha256 !== artifact.sha256) {
        errors.push(`release manifest artifact sha256 mismatch: ${artifact.path}`);
      }
    } catch (error) {
      errors.push(`release manifest artifact could not be hashed: ${artifact.path}: ${errorMessage(error)}`);
    }
  }

  return errors;
}

function verifyReleaseInventoryReference(options: VerifyReleaseManifestArtifactsOptions): string[] {
  const errors: string[] = [];
  const inventory = options.manifest.inventory;

  if (!inventory || typeof inventory !== "object") {
    return ["release manifest inventory is required"];
  }

  if (!inventory.path?.trim()) {
    errors.push("release manifest inventory path is required");
  }
  if (!/^[a-f0-9]{64}$/.test(inventory.sha256 ?? "")) {
    errors.push("release manifest inventory has invalid sha256");
  }
  if (!Number.isInteger(inventory.entryCount) || inventory.entryCount < 1) {
    errors.push("release manifest inventory entryCount must be positive");
  }

  const inventoryPath = resolveReleaseArtifactPath(options.rootDir, inventory.path ?? "");
  if (!inventoryPath) {
    errors.push(`release manifest inventory path escapes repository root: ${inventory.path ?? ""}`);
    return errors;
  }

  if (!existsSync(inventoryPath)) {
    errors.push(`release manifest inventory is missing: ${inventory.path}`);
    return errors;
  }

  try {
    const actualSha256 = hashReleaseArtifactPath(inventoryPath);
    if (actualSha256 !== inventory.sha256) {
      errors.push(`release manifest inventory sha256 mismatch: ${inventory.path}`);
    }
  } catch (error) {
    errors.push(`release manifest inventory could not be hashed: ${inventory.path}: ${errorMessage(error)}`);
    return errors;
  }

  try {
    const parsed = JSON.parse(readFileSync(inventoryPath, "utf8")) as ReleaseInventory;
    errors.push(...validateReleaseInventory(parsed, options.manifest));
    errors.push(...verifyReleaseInventoryEntries(parsed, options.sourceRootDir ?? options.rootDir, options.rootDir));
  } catch (error) {
    errors.push(`release manifest inventory could not be parsed: ${inventory.path}: ${errorMessage(error)}`);
  }

  return errors;
}

export function resolveReleaseArtifactPath(rootDir: string, artifactPath: string): string | undefined {
  if (!artifactPath.trim() || artifactPath.includes("\0") || artifactPath.includes("\\") || path.isAbsolute(artifactPath)) {
    return undefined;
  }

  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, artifactPath);
  const relativePath = path.relative(root, resolved);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return resolved;
}

export function hashReleaseArtifactPath(artifactPath: string): string {
  const stats = lstatSync(artifactPath);

  if (stats.isFile()) {
    return createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  }

  if (stats.isDirectory()) {
    const hash = createHash("sha256");

    for (const filePath of collectArtifactEntries(artifactPath)) {
      const relativePath = path.relative(artifactPath, filePath).split(path.sep).join("/");
      const entryStats = lstatSync(filePath);
      hash.update(relativePath);
      hash.update("\0");

      if (entryStats.isSymbolicLink()) {
        const linkTarget = readlinkSync(filePath);
        if (path.isAbsolute(linkTarget)) {
          throw new Error(`artifact directory contains absolute symlink: ${relativePath}`);
        }

        const resolvedTarget = path.resolve(path.dirname(filePath), linkTarget);
        const relativeTarget = path.relative(path.resolve(artifactPath), resolvedTarget);
        if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
          throw new Error(`artifact directory contains symlink escaping artifact root: ${relativePath}`);
        }

        hash.update("symlink");
        hash.update("\0");
        hash.update(linkTarget);
        hash.update("\0");
        continue;
      }

      if (entryStats.isFile()) {
        hash.update("file");
        hash.update("\0");
        hash.update(createHash("sha256").update(readFileSync(filePath)).digest("hex"));
        hash.update("\0");
      }
    }

    return hash.digest("hex");
  }

  throw new Error("artifact path must be a file or directory");
}

export function verifyMacOSAppBundle(options: VerifyMacOSAppBundleOptions): string[] {
  const errors: string[] = [];

  if (!options.appPath.endsWith(".app")) {
    errors.push("macOS app bundle path must end with .app");
  }

  if (!existsSync(options.appPath)) {
    errors.push(`macOS app bundle is missing: ${options.appPath}`);
    return errors;
  }

  if (!lstatSync(options.appPath).isDirectory()) {
    errors.push(`macOS app bundle is not a directory: ${options.appPath}`);
    return errors;
  }

  const infoPlistPath = path.join(options.appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlistPath)) {
    errors.push("macOS app bundle is missing Contents/Info.plist");
    return errors;
  }

  const info = parsePlistValues(readFileSync(infoPlistPath, "utf8"));
  expectPlistValue(errors, info, "CFBundleDisplayName", options.productName);
  expectPlistValue(errors, info, "CFBundleName", options.productName);
  expectPlistValue(errors, info, "CFBundleIdentifier", options.identifier);
  expectPlistValue(errors, info, "CFBundleShortVersionString", options.version);
  expectPlistValue(errors, info, "CFBundleVersion", options.version);
  expectPlistValue(errors, info, "CFBundlePackageType", "APPL");
  expectPlistValue(errors, info, "LSMinimumSystemVersion", options.minimumSystemVersion);

  if (options.categoryType) {
    expectPlistValue(errors, info, "LSApplicationCategoryType", options.categoryType);
  }

  const executableName = info.CFBundleExecutable;
  if (!executableName) {
    errors.push("macOS app bundle Info.plist is missing CFBundleExecutable");
    return errors;
  }

  if (executableName.includes("/") || executableName.includes("\\") || executableName.includes("\0")) {
    errors.push("macOS app bundle CFBundleExecutable must be a file name");
    return errors;
  }

  const executablePath = path.join(options.appPath, "Contents", "MacOS", executableName);
  if (!existsSync(executablePath)) {
    errors.push(`macOS app bundle executable is missing: Contents/MacOS/${executableName}`);
  } else {
    const executableStats = lstatSync(executablePath);
    if (!executableStats.isFile()) {
      errors.push(`macOS app bundle executable is not a file: Contents/MacOS/${executableName}`);
    }
    if (supportsPosixExecutableBits() && (executableStats.mode & 0o111) === 0) {
      errors.push(`macOS app bundle executable is not executable: Contents/MacOS/${executableName}`);
    }
  }

  const iconFile = info.CFBundleIconFile;
  if (!iconFile) {
    errors.push("macOS app bundle Info.plist is missing CFBundleIconFile");
  } else if (iconFile.includes("/") || iconFile.includes("\\") || iconFile.includes("\0")) {
    errors.push("macOS app bundle CFBundleIconFile must be a file name");
  } else {
    const iconCandidates = iconFile.endsWith(".icns") ? [iconFile] : [iconFile, `${iconFile}.icns`];
    if (!iconCandidates.some((candidate) => existsSync(path.join(options.appPath, "Contents", "Resources", candidate)))) {
      errors.push(`macOS app bundle icon resource is missing: Contents/Resources/${iconCandidates.at(-1)}`);
    }
  }

  return errors;
}

function validateOperationalFiles(repositoryFiles: Set<string>): string[] {
  if (repositoryFiles.size === 0) {
    return ["release metadata repositoryFiles are required"];
  }

  const errors: string[] = [];

  for (const filePath of [
    ".gitignore",
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/release-candidate.yml",
    ".github/workflows/verify-stable-updater.yml",
    ...releaseEnvironmentExamplePaths(),
    "release/SBOM.cdx.json",
    "release/THIRD_PARTY_NOTICES.md",
    "release/license-policy.json",
    "release/tauri.stable.conf.json",
    "scripts/ci-policy.ts",
    "scripts/cli-smoke.ts",
    "scripts/desktop-bundle-smoke.ts",
    "scripts/distribution-preflight.ts",
    "scripts/github-release-preflight.ts",
    "scripts/github-release-setup.ts",
    "scripts/license-data.ts",
    "scripts/license-notices.ts",
    "scripts/license-policy.ts",
    "scripts/privacy-scan.ts",
    "scripts/release-check.ts",
    "scripts/sbom.ts",
    "scripts/release-script-args.ts",
    "scripts/service-readiness.ts",
    "scripts/script-file-safety.ts",
    "scripts/stage-release-upload.ts",
    "scripts/verify-stable-updater.ts",
    "scripts/verify-release-manifest.ts",
    "README.md",
    "SECURITY.md",
    "PRIVACY.md"
  ]) {
    if (!repositoryFiles.has(filePath)) {
      errors.push(`operational file is missing: ${filePath}`);
    }
  }

  return errors;
}

function supportsPosixExecutableBits(): boolean {
  return process.platform !== "win32";
}

function validateReadmeOperationsDocs(readmeText: string | undefined, repositoryFiles: Set<string>): string[] {
  if (!repositoryFiles.has("README.md")) {
    return [];
  }

  if (typeof readmeText !== "string" || !readmeText.trim()) {
    return ["README.md content is required for release metadata"];
  }

  const normalized = readmeText.toLowerCase();
  const errors: string[] = [];
  if (/\bopen-dialog\b|dialog:allow-open/.test(normalized)) {
    errors.push("README.md must not document renderer open-dialog permission");
  }

  if (!normalized.includes("event listen/unlisten") || !normalized.includes("updater check/download-install")) {
    errors.push("README.md must document the current least-privilege Tauri capability boundary");
  }

  if (!normalized.includes("workspace folder selection is mediated by a rust command")) {
    errors.push("README.md must document that workspace folder selection is mediated by Rust");
  }

  return errors;
}

function validateSecurityPrivacyDocs(options: {
  repositoryFiles: Set<string>;
  securityText?: string;
  privacyText?: string;
}): string[] {
  const errors: string[] = [];

  if (options.repositoryFiles.has("SECURITY.md")) {
    if (typeof options.securityText !== "string" || !options.securityText.trim()) {
      errors.push("SECURITY.md content is required for release metadata");
    } else {
      const normalized = normalizePolicyText(options.securityText);
      if (!documentsReadOnlyAuthBoundary(normalized)) {
        errors.push("SECURITY.md must document the read-only Codex auth-file boundary");
      }
      if (!containsAll(normalized, ["codex exec", "stdin", "argv"])) {
        errors.push("SECURITY.md must document stdin prompt delivery instead of argv prompts");
      }
      if (!normalized.includes("pnpm release:preflight") || !normalized.includes("pnpm release:verify-updater")) {
        errors.push("SECURITY.md must document distribution preflight and stable updater verification");
      }
      if (!containsAll(normalized, ["diagnostics", "support", "exclude prompts"])) {
        errors.push("SECURITY.md must document diagnostics and support-bundle privacy exclusions");
      }
    }
  }

  if (options.repositoryFiles.has("PRIVACY.md")) {
    if (typeof options.privacyText !== "string" || !options.privacyText.trim()) {
      errors.push("PRIVACY.md content is required for release metadata");
    } else {
      const normalized = normalizePolicyText(options.privacyText);
      if (!normalized.includes("local-first")) {
        errors.push("PRIVACY.md must document the local-first data model");
      }
      if (!documentsReadOnlyAuthBoundary(normalized)) {
        errors.push("PRIVACY.md must document the read-only Codex auth-file boundary");
      }
      if (!containsAll(normalized, ["prompts", "stdin", "command-line arguments"])) {
        errors.push("PRIVACY.md must document stdin prompt delivery instead of command-line prompt storage");
      }
      if (!containsAll(normalized, ["diagnostics", "exclude prompts", "codex auth contents"])) {
        errors.push("PRIVACY.md must document diagnostics privacy exclusions");
      }
      if (!containsAll(normalized, ["support bundles", "raw prompts", "workspace paths"])) {
        errors.push("PRIVACY.md must document support-bundle privacy exclusions");
      }
      if (!containsAll(normalized, ["does not add a separate cloud service", "network"])) {
        errors.push("PRIVACY.md must document the MVP network boundary");
      }
    }
  }

  return errors;
}

function normalizePolicyText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function containsAll(text: string, fragments: string[]): boolean {
  return fragments.every((fragment) => text.includes(fragment));
}

function documentsReadOnlyAuthBoundary(text: string): boolean {
  return (
    (text.includes("does not read") || text.includes("must not read")) &&
    containsAll(text, ["copy", "edit", "print", "upload", "persist auth file contents"])
  );
}

function validateDependabotConfig(dependabotConfigText: string | undefined, repositoryFiles: Set<string>): string[] {
  if (!repositoryFiles.has(".github/dependabot.yml")) {
    return [];
  }

  if (typeof dependabotConfigText !== "string" || !dependabotConfigText.trim()) {
    return ["Dependabot config content is required for release metadata"];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(dependabotConfigText) as unknown;
  } catch (error) {
    return [`Dependabot config must be valid YAML: ${errorMessage(error)}`];
  }

  const errors: string[] = [];
  if (numberAt(parsed, "version") !== 2) {
    errors.push("Dependabot config version must be 2");
  }

  const updates = objectArrayAt(parsed, "updates");
  if (updates.length === 0) {
    errors.push("Dependabot config must declare updates");
  }

  const requiredUpdates = [
    { ecosystem: "npm", directory: "/", label: "npm dependencies at /" },
    { ecosystem: "cargo", directory: "/apps/desktop/src-tauri", label: "Cargo dependencies at /apps/desktop/src-tauri" },
    { ecosystem: "github-actions", directory: "/", label: "GitHub Actions dependencies at /" }
  ];

  for (const required of requiredUpdates) {
    const update = updates.find((candidate) => (
      stringAt(candidate, "package-ecosystem") === required.ecosystem &&
      stringAt(candidate, "directory") === required.directory
    ));

    if (!update) {
      errors.push(`Dependabot config must monitor ${required.label}`);
      continue;
    }

    const schedule = objectAt(update, "schedule");
    if (stringAt(schedule, "interval") !== "weekly") {
      errors.push(`Dependabot config must check ${required.label} weekly`);
    }

    const openPullRequestsLimit = numberAt(update, "open-pull-requests-limit");
    if (
      typeof openPullRequestsLimit !== "number" ||
      !Number.isInteger(openPullRequestsLimit) ||
      openPullRequestsLimit < 1 ||
      openPullRequestsLimit > 10
    ) {
      errors.push(`Dependabot config must bound open pull requests for ${required.label}`);
    }
  }

  return errors;
}

function validateGitIgnorePolicy(gitignoreText: string | undefined, repositoryFiles: Set<string>): string[] {
  if (!repositoryFiles.has(".gitignore")) {
    return [];
  }

  if (typeof gitignoreText !== "string" || !gitignoreText.trim()) {
    return [".gitignore content is required for release metadata"];
  }

  const rules = new Set(
    gitignoreText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );
  const requiredRules = [
    ".builder/",
    "node_modules",
    "dist",
    "coverage",
    "test-results",
    "playwright-report",
    "release-candidate-artifact/",
    ".turbo",
    ".DS_Store",
    "*.log",
    "*.tgz",
    "apps/desktop/src-tauri/target",
    "apps/desktop/dist",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal"
  ];
  const errors: string[] = [];

  for (const rule of requiredRules) {
    if (!rules.has(rule)) {
      errors.push(`.gitignore must ignore local runtime or build state: ${rule}`);
    }
  }

  return errors;
}

function validateTauriCapability(capability: Record<string, unknown>, repositoryFiles: Set<string>): string[] {
  const errors: string[] = [];
  const requiredPath = "apps/desktop/src-tauri/capabilities/default.json";
  const requiredPermissions = requiredTauriCapabilityPermissions();
  const permissions = stringArrayAt(capability, "permissions");
  const windows = stringArrayAt(capability, "windows");

  if (!repositoryFiles.has(requiredPath)) {
    errors.push(`Tauri capability file is missing: ${requiredPath}`);
  }

  if (stringAt(capability, "identifier") !== "default") {
    errors.push("Tauri default capability identifier must be default");
  }

  if (windows.length !== 1 || windows[0] !== "main") {
    errors.push("Tauri default capability must be scoped only to the main window");
  }

  if (permissions.join("\n") !== requiredPermissions.join("\n")) {
    errors.push(`Tauri default capability permissions must be exactly: ${requiredPermissions.join(", ")}`);
  }

  if (permissions.some((permission) => permission.endsWith(":default"))) {
    errors.push("Tauri default capability must not include broad default permission sets");
  }

  if (permissions.some((permission) => permission.startsWith("fs:"))) {
    errors.push("Tauri default capability must not expose filesystem plugin permissions");
  }

  return errors;
}

function requiredTauriCapabilityPermissions(): string[] {
  return [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "updater:allow-check",
    "updater:allow-download-and-install"
  ];
}

function requiredTauriBundleIcons(): string[] {
  return [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ];
}

function hasLocalhostDevOrigin(csp: string): boolean {
  return /\b(?:http|ws):\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?\b/.test(csp);
}

function validateProductionCspSources(csp: string): string[] {
  const errors = new Set<string>();
  const directives = parseCspDirectives(csp);

  for (const [directive, sources] of directives) {
    for (const source of sources) {
      if (source === "*") {
        errors.add("Tauri production CSP must not use wildcard source expressions");
        continue;
      }

      if (source === "'unsafe-eval'") {
        errors.add("Tauri production CSP must not allow unsafe-eval");
        continue;
      }

      if (source === "'unsafe-inline'" && directive !== "style-src") {
        errors.add("Tauri production CSP must allow unsafe-inline only for style-src");
        continue;
      }

      if (source === "data:" && directive !== "img-src") {
        errors.add("Tauri production CSP must allow data: only for image sources");
        continue;
      }

      if (source === "asset:" && directive !== "img-src") {
        errors.add("Tauri production CSP must allow asset: only for image sources");
        continue;
      }

      if (source === "ipc:" && directive !== "connect-src") {
        errors.add("Tauri production CSP must allow ipc: only for connect sources");
        continue;
      }

      if (/^(?:http|https|ws|wss):$/i.test(source)) {
        errors.add("Tauri production CSP must not allow broad network schemes");
        continue;
      }

      if (isExternalProductionCspOrigin(directive, source)) {
        errors.add("Tauri production CSP must not allow external network origins");
      }
    }
  }

  return [...errors];
}

function parseCspDirectives(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();

  for (const rawDirective of csp.split(";")) {
    const parts = rawDirective.trim().split(/\s+/).filter(Boolean);
    const [directive, ...sources] = parts;

    if (!directive) {
      continue;
    }

    directives.set(directive.toLowerCase(), sources);
  }

  return directives;
}

function isExternalProductionCspOrigin(directive: string, source: string): boolean {
  if (!/^(?:http|https|ws|wss):\/\//i.test(source)) {
    return false;
  }

  try {
    const origin = new URL(source).origin.toLowerCase();
    const allowedInternalOrigins = directive === "img-src"
      ? new Set(["http://asset.localhost"])
      : directive === "connect-src"
        ? new Set(["http://ipc.localhost"])
        : new Set<string>();

    return !allowedInternalOrigins.has(origin);
  } catch {
    return true;
  }
}

export function requiredDistributionEnvironment(
  policy: Record<string, unknown>,
  platform: ReleasePlatform = "macos",
  channel?: DistributionChannel
): string[] {
  const policyKey = platform === "macos" ? "macOS" : platform;
  const platformPolicy = objectAt(policy, policyKey);
  const channelPolicy = channel ? distributionChannelPolicy(policy, channel) : undefined;

  return uniqueStrings([
    ...stringArrayAt(platformPolicy, "requiredEnvironment"),
    ...stringArrayAt(channelPolicy, "requiredEnvironment")
  ]);
}

export function releaseCheckCommandEnvironment(
  env: NodeJS.ProcessEnv,
  options: { distribution?: boolean; distributionPolicy?: Record<string, unknown> } = {}
): NodeJS.ProcessEnv {
  const commandEnv = { ...env };

  if (options.distribution === true) {
    return commandEnv;
  }

  for (const envName of releaseSensitiveEnvironmentNames(options.distributionPolicy)) {
    delete commandEnv[envName];
  }

  return commandEnv;
}

export function releaseSensitiveEnvironmentNames(policy?: Record<string, unknown>): string[] {
  const policyEnvironment = policy
    ? [
      ...requiredDistributionEnvironment(policy, "macos", "internal"),
      ...requiredDistributionEnvironment(policy, "macos", "stable"),
      ...requiredDistributionEnvironment(policy, "windows", "internal"),
      ...requiredDistributionEnvironment(policy, "windows", "stable"),
      ...requiredDistributionEnvironment(policy, "linux", "internal"),
      ...requiredDistributionEnvironment(policy, "linux", "stable")
    ]
    : [];

  return uniqueStrings([
    ...policyEnvironment,
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
    "APPLE_API_ISSUER",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_KEYCHAIN_PASSWORD",
    "WINDOWS_SIGNING_CERTIFICATE",
    "WINDOWS_SIGNING_PASSWORD",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "BUILDER_GEAR_UPDATER_PUBKEY",
    "BUILDER_GEAR_UPDATE_ENDPOINT"
  ]);
}

export function releaseCandidateGitHubEnvironmentRequirements(policy: Record<string, unknown>): GitHubReleaseEnvironmentRequirement[] {
  return [
    {
      environment: "internal-release",
      requiredSecrets: releaseCandidateGitHubSecretsForChannel(policy, "internal")
    },
    {
      environment: "production",
      requiredSecrets: releaseCandidateGitHubSecretsForChannel(policy, "stable")
    }
  ];
}

export function validateReleaseCandidateGitHubSecretInventory(
  policy: Record<string, unknown>,
  inventories: GitHubReleaseSecretInventory[]
): string[] {
  const inventoryByEnvironment = new Map(inventories.map((inventory) => [inventory.environment, inventory]));
  const errors: string[] = [];

  for (const requirement of releaseCandidateGitHubEnvironmentRequirements(policy)) {
    const inventory = inventoryByEnvironment.get(requirement.environment);
    if (!inventory) {
      errors.push(`GitHub release environment is missing: ${requirement.environment}`);
      continue;
    }

    const configuredSecrets = new Set(inventory.secrets);
    for (const secretName of requirement.requiredSecrets) {
      if (!configuredSecrets.has(secretName)) {
        errors.push(`GitHub release environment ${requirement.environment} is missing secret: ${secretName}`);
      }
    }
  }

  return errors;
}

function releaseCandidateGitHubSecretsForChannel(
  policy: Record<string, unknown>,
  channel: DistributionChannel
): string[] {
  return uniqueStrings([
    ...hostedMacOSReleaseCandidateSecrets(policy),
    ...requiredPlatformEnvironment(policy, "windows"),
    ...requiredPlatformEnvironment(policy, "linux"),
    ...requiredChannelEnvironment(policy, channel)
  ]);
}

function hostedMacOSReleaseCandidateSecrets(policy: Record<string, unknown>): string[] {
  return uniqueStrings([
    "APPLE_SIGNING_IDENTITY",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_KEYCHAIN_PASSWORD",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    ...requiredPlatformEnvironment(policy, "macos")
  ]);
}

export function releaseEnvironmentExamplePath(platform: ReleasePlatform, channel: DistributionChannel): string {
  return `release/${platform}.${channel}.env.example`;
}

export function releaseEnvironmentExamplePaths(): string[] {
  return RELEASE_PLATFORMS.flatMap((platform) => (
    DISTRIBUTION_CHANNELS.map((channel) => releaseEnvironmentExamplePath(platform, channel))
  ));
}

export function validateReleaseEnvironmentOperationalCoverage(options: {
  distributionPolicy: Record<string, unknown>;
  repositoryFiles?: Set<string> | string[];
  releaseCandidateWorkflowText?: string;
  releaseEnvExampleTexts?: Record<string, string | undefined>;
}): string[] {
  const repositoryFiles = options.repositoryFiles instanceof Set
    ? options.repositoryFiles
    : new Set(options.repositoryFiles ?? []);
  const errors: string[] = [];

  errors.push(...validateReleaseCandidateWorkflowPolicyEnvironment(
    options.distributionPolicy,
    options.releaseCandidateWorkflowText,
    repositoryFiles
  ));
  errors.push(...validateReleaseEnvExamplePolicyCoverage(
    options.distributionPolicy,
    options.releaseEnvExampleTexts,
    repositoryFiles
  ));

  return errors;
}

function validateReleaseCandidateWorkflowPolicyEnvironment(
  policy: Record<string, unknown>,
  releaseCandidateWorkflowText: string | undefined,
  repositoryFiles: Set<string>
): string[] {
  if (!repositoryFiles.has(".github/workflows/release-candidate.yml")) {
    return [];
  }

  if (typeof releaseCandidateWorkflowText !== "string" || !releaseCandidateWorkflowText.trim()) {
    return ["release candidate workflow content is required for distribution environment coverage"];
  }

  const errors: string[] = [];
  for (const platform of RELEASE_PLATFORMS) {
    for (const envName of requiredDistributionEnvironment(policy, platform, "internal")) {
      if (!workflowEnvLineUsesScopedSecret(releaseCandidateWorkflowText, envName, `inputs.platform == '${platform}'`)) {
        errors.push(`release candidate workflow must map distribution env ${envName} from ${platform} secrets`);
      }
    }
  }

  for (const channel of DISTRIBUTION_CHANNELS) {
    for (const envName of requiredChannelEnvironment(policy, channel)) {
      if (!workflowEnvLineUsesScopedSecret(releaseCandidateWorkflowText, envName, `inputs.channel == '${channel}'`)) {
        errors.push(`release candidate workflow must map distribution env ${envName} from ${channel} channel secrets`);
      }
    }
  }

  return [...new Set(errors)];
}

function validateReleaseEnvExamplePolicyCoverage(
  policy: Record<string, unknown>,
  releaseEnvExampleTexts: Record<string, string | undefined> | undefined,
  repositoryFiles: Set<string>
): string[] {
  const errors: string[] = [];

  for (const platform of RELEASE_PLATFORMS) {
    for (const channel of DISTRIBUTION_CHANNELS) {
      const examplePath = releaseEnvironmentExamplePath(platform, channel);
      if (!repositoryFiles.has(examplePath)) {
        continue;
      }

      const text = releaseEnvExampleTexts?.[examplePath];
      if (typeof text !== "string" || !text.trim()) {
        errors.push(`release env example content is required: ${examplePath}`);
        continue;
      }

      const parsed = parseReleaseEnvFile(text);
      errors.push(...parsed.errors.map((error) => `release env example ${examplePath}: ${error}`));

      const keys = releaseEnvExampleKeys(text);
      for (const envName of duplicatedReleaseEnvExampleKeys(text)) {
        errors.push(`release env example ${examplePath} has duplicate key: ${envName}`);
      }

      for (const envName of requiredDistributionEnvironment(policy, platform, channel)) {
        if (!keys.has(envName)) {
          errors.push(`release env example ${examplePath} must include ${envName}`);
        }
      }
    }
  }

  return errors;
}

function requiredChannelEnvironment(policy: Record<string, unknown>, channel: DistributionChannel): string[] {
  return stringArrayAt(distributionChannelPolicy(policy, channel), "requiredEnvironment");
}

function requiredPlatformEnvironment(policy: Record<string, unknown>, platform: ReleasePlatform): string[] {
  const policyKey = platform === "macos" ? "macOS" : platform;
  return stringArrayAt(objectAt(policy, policyKey), "requiredEnvironment");
}

function workflowEnvLineUsesScopedSecret(content: string, envName: string, scopeExpression: string): boolean {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(envName)}:\\s*\\$\\{\\{\\s*${escapeRegExp(scopeExpression)}\\s*&&\\s*secrets\\.${escapeRegExp(envName)}\\s*\\|\\|\\s*''\\s*\\}\\}\\s*$`,
    "m"
  );

  return pattern.test(content);
}

function releaseEnvExampleKeys(source: string): Set<string> {
  return new Set(releaseEnvExampleKeyList(source));
}

function duplicatedReleaseEnvExampleKeys(source: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const key of releaseEnvExampleKeyList(source)) {
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }

  return [...duplicates].sort();
}

function releaseEnvExampleKeyList(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (!line || line.startsWith("#")) {
        return [];
      }

      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
      return match?.[1] ? [match[1]] : [];
    });
}

export function parseReleaseEnvFile(source: string): ParsedReleaseEnvFile {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const lines = source.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      errors.push(`release env line ${lineNumber} must be KEY=value`);
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? "";
    if (!key) {
      errors.push(`release env line ${lineNumber} must be KEY=value`);
      continue;
    }

    const parsed = parseReleaseEnvValue(rawValue.trim(), lineNumber);
    if (typeof parsed === "string") {
      values[key] = parsed;
    } else {
      errors.push(parsed.error);
    }
  }

  return { values, errors };
}

export function parseReleaseCliChoice<T extends string>(
  argv: string[],
  flag: string,
  choices: readonly T[]
): ReleaseCliChoice<T> {
  let value: T | undefined;
  let provided = false;
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) {
      continue;
    }

    if (provided) {
      errors.push(`${flag} was provided more than once`);
      continue;
    }

    provided = true;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      errors.push(`${flag} value is missing`);
      continue;
    }

    if (!choices.includes(next as T)) {
      errors.push(`${flag} must be one of: ${choices.join(", ")}`);
      continue;
    }

    value = next as T;
  }

  return { value, provided, errors };
}

export function validateReleaseCheckArgv(argv: string[]): string[] {
  return validateKnownReleaseArgv(argv, {
    allowedFlags: ["--skip-bundle", "--distribution", "--platform", "--channel", "--env-file"],
    valueFlags: ["--platform", "--channel", "--env-file"],
    singletonFlags: ["--skip-bundle", "--distribution", "--env-file"]
  });
}

export function validateDistributionPreflightArgv(argv: string[]): string[] {
  return validateKnownReleaseArgv(argv, {
    allowedFlags: ["--platform", "--channel", "--env-file"],
    valueFlags: ["--platform", "--channel", "--env-file"],
    singletonFlags: ["--env-file"]
  });
}

function validateKnownReleaseArgv(
  argv: string[],
  options: {
    allowedFlags: readonly string[];
    valueFlags: readonly string[];
    singletonFlags: readonly string[];
  }
): string[] {
  const errors: string[] = [];
  const allowedFlags = new Set(options.allowedFlags);
  const valueFlags = new Set(options.valueFlags);
  const singletonFlags = new Set(options.singletonFlags);
  const seenSingletonFlags = new Set<string>();

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg || arg === "--") {
      continue;
    }

    if (arg.startsWith("--")) {
      if (!allowedFlags.has(arg)) {
        errors.push(`unknown release argument: ${arg}`);
        continue;
      }

      if (singletonFlags.has(arg)) {
        if (seenSingletonFlags.has(arg)) {
          errors.push(`${arg} was provided more than once`);
        }
        seenSingletonFlags.add(arg);
      }

      const next = argv[index + 1];
      if (valueFlags.has(arg) && next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      errors.push(`unknown release argument: ${arg}`);
      continue;
    }

    errors.push(`unexpected release argument: ${arg}`);
  }

  return errors;
}

export function loadReleaseEnvFileFromArgv(
  argv: string[],
  basePath: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const envFile = releaseEnvFileArgument(argv);
  if (envFile.errors.length > 0) {
    return envFile.errors;
  }

  if (!envFile.path) {
    return [];
  }

  const resolvedPath = path.isAbsolute(envFile.path)
    ? envFile.path
    : path.resolve(basePath, envFile.path);

  if (!existsSync(resolvedPath)) {
    return ["release env file is missing"];
  }

  const metadata = lstatSync(resolvedPath);
  if (metadata.isSymbolicLink()) {
    return ["release env file must not be a symlink"];
  }
  if (!metadata.isFile()) {
    return ["release env file must be a regular file"];
  }

  const parsed = parseReleaseEnvFile(readFileSync(resolvedPath, "utf8"));
  if (parsed.errors.length > 0) {
    return parsed.errors;
  }

  for (const [key, value] of Object.entries(parsed.values)) {
    if (!env[key]?.trim()) {
      env[key] = value;
    }
  }

  return [];
}

export function validateDistributionPreflightEnvironment(
  policy: Record<string, unknown>,
  platform: ReleasePlatform,
  env: DistributionPreflightEnv,
  options: { channel?: DistributionChannel; tauriConfig?: Record<string, unknown> } = {}
): string[] {
  const channel = options.channel ?? "internal";
  const requiredEnvironment = requiredDistributionEnvironment(policy, platform, channel);
  const missingEnvironment = requiredEnvironment.filter((envName) => !env[envName]?.trim());
  const missingEnvironmentSet = new Set(missingEnvironment);
  const placeholderEnvironment = placeholderDistributionEnvironment(requiredEnvironment, env);
  const errors = missingEnvironment.map((envName) => `distribution signing env is missing: ${envName}`);
  const channelPolicy = distributionChannelPolicy(policy, channel);

  errors.push(...[...placeholderEnvironment].map((envName) => `distribution signing env has a placeholder value: ${envName}`));

  if (!channelPolicy) {
    errors.push(`distribution channel is not configured: ${channel}`);
  } else if (booleanAt(channelPolicy, "requiresUpdaterArtifacts") === true) {
    const createUpdaterArtifacts = booleanAt(objectAt(options.tauriConfig, "bundle"), "createUpdaterArtifacts");

    if (createUpdaterArtifacts !== true) {
      errors.push(`distribution channel ${channel} requires Tauri updater artifacts to be enabled`);
    }

    if (!placeholderEnvironment.has("BUILDER_GEAR_UPDATE_ENDPOINT")) {
      errors.push(...validateStableUpdateEndpoint(env.BUILDER_GEAR_UPDATE_ENDPOINT));
    }

    if (!hasUnavailableStableUpdaterConfigEnvironment(missingEnvironmentSet, placeholderEnvironment)) {
      errors.push(...validateStableUpdaterConfig(options.tauriConfig ?? {}));
    }

    if (!placeholderEnvironment.has("TAURI_SIGNING_PRIVATE_KEY")) {
      errors.push(...validateTauriUpdaterPrivateKey(env.TAURI_SIGNING_PRIVATE_KEY));
    }
  }

  if (platform === "macos") {
    const appleId = env.APPLE_ID?.trim();
    const teamId = env.APPLE_TEAM_ID?.trim();

    if (appleId && !placeholderEnvironment.has("APPLE_ID") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleId)) {
      errors.push("APPLE_ID must look like an Apple ID email address");
    }

    if (teamId && !placeholderEnvironment.has("APPLE_TEAM_ID") && !/^[A-Z0-9]{10}$/.test(teamId)) {
      errors.push("APPLE_TEAM_ID must be a 10-character Apple team id");
    }
  }

  if (platform === "windows") {
    const certificate = env.WINDOWS_SIGNING_CERTIFICATE?.trim();
    if (placeholderEnvironment.has("WINDOWS_SIGNING_CERTIFICATE")) {
      return errors;
    }

    if (certificate?.startsWith("base64:")) {
      errors.push(...validateWindowsCertificateBase64(certificate));
    } else if (certificate && !existsSync(certificate)) {
      errors.push("WINDOWS_SIGNING_CERTIFICATE must point to an existing certificate file or use base64:<pfx>");
    }
  }

  return errors;
}

function releaseEnvFileArgument(argv: string[]): { path?: string; errors: string[] } {
  let value: string | undefined;
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--env-file") {
      continue;
    }

    if (value) {
      errors.push("release env file was provided more than once");
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      errors.push("release env file path is missing after --env-file");
      continue;
    }
    value = next;
  }

  return { path: value, errors };
}

function parseReleaseEnvValue(value: string, lineNumber: number): string | { error: string } {
  if (value.startsWith("\"")) {
    return parseDoubleQuotedReleaseEnvValue(value, lineNumber);
  }

  if (value.startsWith("'")) {
    const endIndex = value.indexOf("'", 1);
    if (endIndex < 0) {
      return { error: `release env line ${lineNumber} has an unterminated quoted value` };
    }
    return value.slice(1, endIndex);
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function parseDoubleQuotedReleaseEnvValue(value: string, lineNumber: number): string | { error: string } {
  let output = "";
  let escaped = false;

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      switch (char) {
        case "n":
          output += "\n";
          break;
        case "r":
          output += "\r";
          break;
        case "t":
          output += "\t";
          break;
        case "\\":
        case "\"":
          output += char;
          break;
        default:
          output += char;
      }
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      return output;
    }

    output += char;
  }

  return { error: `release env line ${lineNumber} has an unterminated quoted value` };
}

function hasUnavailableStableUpdaterConfigEnvironment(
  missingEnvironment: Set<string>,
  placeholderEnvironment: Set<string>
): boolean {
  return missingEnvironment.has("BUILDER_GEAR_UPDATER_PUBKEY") ||
    missingEnvironment.has("BUILDER_GEAR_UPDATE_ENDPOINT") ||
    placeholderEnvironment.has("BUILDER_GEAR_UPDATER_PUBKEY") ||
    placeholderEnvironment.has("BUILDER_GEAR_UPDATE_ENDPOINT");
}

function placeholderDistributionEnvironment(envNames: string[], env: DistributionPreflightEnv): Set<string> {
  return new Set(envNames
    .filter((envName) => {
      const value = env[envName]?.trim();
      return value ? isPlaceholderDistributionValue(value) : false;
    }));
}

export function isPlaceholderDistributionValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return /^<[^>]+>$/.test(normalized) ||
    /^\$\{[^}]+}$/.test(normalized) ||
    /^(?:todo|tbd|changeme|change-me|change_me|replace-me|replace_me|placeholder|dummy|example|sample|secret|password|token|private-key|test)$/.test(normalized) ||
    /^(?:base64:)?(?:todo|tbd|changeme|placeholder|dummy|example|sample|test)$/.test(normalized) ||
    /^(?:your|insert|replace)[\s_-]/.test(normalized) ||
    /^x{3,}$/.test(normalized);
}

function validateStableUpdateEndpoint(value: string | undefined): string[] {
  return validateProductionUpdateUrl("BUILDER_GEAR_UPDATE_ENDPOINT", value);
}

function validateStableUpdaterConfig(tauriConfig: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const updater = objectAt(objectAt(tauriConfig, "plugins"), "updater");
  const pubkey = stringAt(updater, "pubkey");
  const endpoints = stringArrayAt(updater, "endpoints");

  if (!updater) {
    errors.push("Tauri updater plugin configuration is required for the stable distribution channel");
  }

  if (!pubkey) {
    errors.push("Tauri updater pubkey is required for the stable distribution channel");
  } else {
    if (isPlaceholderDistributionValue(pubkey)) {
      errors.push("Tauri updater pubkey must not be a placeholder value");
    }
    if (looksLikeFilesystemPath(pubkey)) {
      errors.push("Tauri updater pubkey must be public key content, not a filesystem path");
    }
  }

  if (endpoints.length === 0) {
    errors.push("Tauri updater endpoints must include at least one production HTTPS URL for the stable distribution channel");
  }

  for (const endpoint of endpoints) {
    errors.push(...validateProductionUpdateUrl("Tauri updater endpoint", endpoint));
  }

  if (booleanAt(updater, "dangerousInsecureTransportProtocol") === true) {
    errors.push("Tauri updater dangerousInsecureTransportProtocol must stay disabled for the stable distribution channel");
  }

  return errors;
}

function validateTauriUpdaterPrivateKey(value: string | undefined): string[] {
  const privateKey = value?.trim();
  if (!privateKey) {
    return [];
  }

  if (privateKey.startsWith("base64:")) {
    const payloadErrors = validateBase64Payload("TAURI_SIGNING_PRIVATE_KEY", privateKey.slice("base64:".length), {
      minimumDecodedBytes: 32
    });

    return payloadErrors.length > 0
      ? payloadErrors
      : [];
  }

  if (looksLikeFilesystemPath(privateKey) && !existsSync(resolveUserPath(privateKey))) {
    return ["TAURI_SIGNING_PRIVATE_KEY points to a missing private key file"];
  }

  if (!looksLikeFilesystemPath(privateKey) && privateKey.length < 64) {
    return ["TAURI_SIGNING_PRIVATE_KEY must be a private key file path or key content with at least 64 characters"];
  }

  return [];
}

function validateWindowsCertificateBase64(value: string): string[] {
  const errors = validateBase64Payload("WINDOWS_SIGNING_CERTIFICATE", value.slice("base64:".length), {
    minimumDecodedBytes: 256
  });

  if (errors.length > 0) {
    return errors;
  }

  const decoded = Buffer.from(value.slice("base64:".length), "base64");
  return decoded[0] === 0x30
    ? []
    : ["WINDOWS_SIGNING_CERTIFICATE base64 payload must decode to a DER PKCS#12/PFX certificate"];
}

function validateBase64Payload(label: string, value: string, options: { minimumDecodedBytes: number }): string[] {
  const normalized = value.replace(/\s+/g, "");

  if (!normalized) {
    return [`${label} base64 payload is empty`];
  }

  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return [`${label} base64 payload must be valid base64`];
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length < options.minimumDecodedBytes) {
    return [`${label} base64 payload is too small to be valid signing material`];
  }

  return [];
}

function validateProductionUpdateUrl(label: string, value: string | undefined): string[] {
  const endpoint = value?.trim();
  const errors: string[] = [];

  if (!endpoint) {
    return errors;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [`${label} must be a valid absolute URL`];
  }

  if (url.protocol !== "https:") {
    errors.push(`${label} must use HTTPS`);
  }

  if (url.username || url.password) {
    errors.push(`${label} must not include URL credentials`);
  }

  if (url.hash) {
    errors.push(`${label} must not include a URL fragment`);
  }

  if (url.search) {
    errors.push(`${label} must not include a URL query string`);
  }

  if (!/\.json$/i.test(url.pathname)) {
    errors.push(`${label} must point to a static JSON updater feed`);
  }

  let decodedPathname = url.pathname;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    // Keep the parser-normalized path if decoding fails; the URL is still invalid
    // for release purposes if other endpoint checks fail.
  }

  if (/\{\{[^}]+}}/.test(endpoint) || /\{\{[^}]+}}/.test(decodedPathname)) {
    errors.push(`${label} must not include updater template variables when generating a static JSON feed`);
  }

  if (isLocalUpdateHost(url.hostname)) {
    errors.push(`${label} must not point at localhost or a loopback address`);
  } else if (isPrivateOrReservedUpdateHost(url.hostname)) {
    errors.push(`${label} must point at a public update host`);
  }

  return errors;
}

function looksLikeFilesystemPath(value: string): boolean {
  return value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\") ||
    /\.(?:key|pem|p8|p12|pfx)$/i.test(value);
}

function resolveUserPath(value: string): string {
  return value.startsWith("~/")
    ? path.join(process.env.HOME ?? "", value.slice(2))
    : value;
}

function isLocalUpdateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  return normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("127.");
}

function isPrivateOrReservedUpdateHost(hostname: string): boolean {
  const normalized = normalizeUpdateHost(hostname);
  const ipv4 = parseIPv4Address(normalized);

  if (reservedUpdateDomains().some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))) {
    return true;
  }

  if (ipv4) {
    return isPrivateOrReservedIPv4(ipv4);
  }

  const mappedIPv4 = parseIPv4Address(normalized.split(":").at(-1) ?? "");
  if (mappedIPv4) {
    return isPrivateOrReservedIPv4(mappedIPv4);
  }

  return isPrivateOrReservedIPv6(normalized);
}

function normalizeUpdateHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function reservedUpdateDomains(): string[] {
  return [
    "example",
    "example.com",
    "example.net",
    "example.org",
    "invalid",
    "local",
    "localhost",
    "test"
  ];
}

function parseIPv4Address(value: string): [number, number, number, number] | undefined {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index])) {
    return undefined;
  }

  return octets as [number, number, number, number];
}

function isPrivateOrReservedIPv4([first, second, third]: [number, number, number, number]): boolean {
  return first === 0 ||
    first === 10 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 ||
    first === 100 && second >= 64 && second <= 127 ||
    first === 192 && second === 0 && (third === 0 || third === 2) ||
    first === 198 && (second === 18 || second === 19 || second === 51 && third === 100) ||
    first === 203 && second === 0 && third === 113 ||
    first >= 224;
}

function isPrivateOrReservedIPv6(value: string): boolean {
  if (!value.includes(":")) {
    return false;
  }

  return value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:");
}

function distributionChannelPolicy(
  policy: Record<string, unknown>,
  channel: DistributionChannel
): Record<string, unknown> | undefined {
  return objectArrayAt(policy, "channels").find((candidate) => stringAt(candidate, "id") === channel);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function countBy<T>(values: T[], keyForValue: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = keyForValue(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function markdownTableCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function dependencyBomRef(entry: DependencyLicenseEntry): string {
  return `${entry.ecosystem}:${entry.name}@${entry.version}`;
}

function dependencyPurl(entry: DependencyLicenseEntry): string {
  const encodedVersion = encodeURIComponent(entry.version);

  if (entry.ecosystem === "node") {
    return `pkg:npm/${entry.name.split("/").map(encodeURIComponent).join("/")}@${encodedVersion}`;
  }

  return `pkg:cargo/${encodeURIComponent(entry.name)}@${encodedVersion}`;
}

function dependencyExternalReferences(entry: DependencyLicenseEntry): Array<{ type: string; url: string }> {
  const references: Array<{ type: string; url: string }> = [];

  if (entry.repository?.trim()) {
    references.push({ type: "vcs", url: entry.repository.trim() });
  }

  if (entry.homepage?.trim()) {
    references.push({ type: "website", url: entry.homepage.trim() });
  }

  return references;
}

export function validateReleaseManifest(manifest: ReleaseManifest, expectedGateIds: string[]): string[] {
  const errors: string[] = [];
  const manifestRecord = objectAt({ manifest }, "manifest");

  if (!manifestRecord) {
    return ["release manifest must be an object"];
  }

  const versions = objectAt(manifest, "versions");
  const gateIds = releaseManifestGateIds(manifest);
  const artifacts = releaseManifestArtifacts(manifest);

  if (manifest.schemaVersion !== 1) {
    errors.push("release manifest schemaVersion must be 1");
  }

  if (!manifest.generatedAt || Number.isNaN(Date.parse(manifest.generatedAt))) {
    errors.push("release manifest generatedAt must be an ISO timestamp");
  }

  if (!["debug", "distribution"].includes(manifest.mode)) {
    errors.push("release manifest mode is invalid");
  }

  if (manifest.mode === "distribution" && !["internal", "stable"].includes(manifest.channel ?? "")) {
    errors.push("release manifest distribution channel is required");
  }

  if (manifest.mode === "debug" && manifest.channel) {
    errors.push("release manifest debug mode must not declare a distribution channel");
  }

  if (!["macos", "windows", "linux"].includes(manifest.platform)) {
    errors.push("release manifest platform is invalid");
  }

  if (!["x86_64", "aarch64", "i686", "armv7"].includes(manifest.arch)) {
    errors.push("release manifest arch is invalid");
  }

  const rootVersion = stringAt(versions, "root");
  const coreVersion = stringAt(versions, "core");
  const cliVersion = stringAt(versions, "cli");
  const desktopVersion = stringAt(versions, "desktop");
  const tauriVersion = stringAt(versions, "tauri");
  const cargoVersion = stringAt(versions, "cargo");
  if (!rootVersion || !coreVersion || !cliVersion || !desktopVersion || !tauriVersion || !cargoVersion) {
    errors.push("release manifest versions are required");
  } else if (
    rootVersion !== coreVersion ||
    coreVersion !== cliVersion ||
    cliVersion !== desktopVersion ||
    desktopVersion !== tauriVersion ||
    tauriVersion !== cargoVersion
  ) {
    errors.push("release manifest versions must match");
  }

  if (!manifest.packageManager) {
    errors.push("release manifest packageManager is required");
  }

  if (!manifest.productName) {
    errors.push("release manifest productName is required");
  }

  if (!manifest.identifier) {
    errors.push("release manifest identifier is required");
  }

  errors.push(...validateReleaseGitState(manifest.git, manifest.mode));

  if (!Array.isArray((manifest as { gateIds?: unknown }).gateIds) || gateIds.length !== (manifest as { gateIds?: unknown[] }).gateIds?.length) {
    errors.push("release manifest gateIds must be an array of strings");
  } else if (gateIds.join("\n") !== expectedGateIds.join("\n")) {
    errors.push("release manifest gateIds must match the executed release gate order");
  }

  errors.push(...validateReleaseManifestBuildInputs(manifest));

  if (!Array.isArray((manifest as { artifacts?: unknown }).artifacts)) {
    errors.push("release manifest artifacts must be an array");
  }

  if (manifest.includeBundle && artifacts.length === 0) {
    errors.push("release manifest must include artifacts when bundle checks run");
  }

  if (!manifest.includeBundle && artifacts.length > 0) {
    errors.push("release manifest must not include artifacts when bundle checks are skipped");
  }

  errors.push(...validateReleaseManifestArtifactLocations(manifest, artifacts));

  if (manifest.mode === "distribution" && manifest.channel === "stable") {
    errors.push(...validateStableUpdaterArtifacts(manifest));
  }

  if (!manifest.inventory) {
    errors.push("release manifest inventory is required");
  } else {
    if (!manifest.inventory.path?.trim()) {
      errors.push("release manifest inventory path is required");
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.inventory.sha256)) {
      errors.push("release manifest inventory has invalid sha256");
    }
    if (!Number.isInteger(manifest.inventory.entryCount) || manifest.inventory.entryCount < 1) {
      errors.push("release manifest inventory entryCount must be positive");
    }
  }

  for (const artifact of artifacts) {
    if (!artifact.path) {
      errors.push("release manifest artifact path is required");
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      errors.push(`release manifest artifact has invalid sha256: ${artifact.path}`);
    }
  }

  return errors;
}

function validateReleaseManifestArtifactLocations(
  manifest: ReleaseManifest,
  artifacts: ReleaseManifestArtifact[]
): string[] {
  if (!manifest.includeBundle || artifacts.length === 0) {
    return [];
  }

  if (!["macos", "windows", "linux"].includes(manifest.platform) || !["debug", "distribution"].includes(manifest.mode)) {
    return [];
  }

  const artifactRoot = releaseArtifactProfile({
    platform: manifest.platform,
    distribution: manifest.mode === "distribution",
    channel: manifest.channel
  }).artifactRoot;
  const artifactRootPrefix = `${artifactRoot}/`;

  return artifacts
    .filter((artifact) => artifact.path && artifact.path !== artifactRoot && !artifact.path.startsWith(artifactRootPrefix))
    .map((artifact) => `release manifest artifact must be under ${artifactRoot}: ${artifact.path}`);
}

function releaseManifestGateIds(manifest: ReleaseManifest): string[] {
  const gateIds = (manifest as { gateIds?: unknown }).gateIds;
  return Array.isArray(gateIds)
    ? gateIds.filter((gateId): gateId is string => typeof gateId === "string")
    : [];
}

function releaseManifestArtifacts(manifest: ReleaseManifest): ReleaseManifestArtifact[] {
  const artifacts = (manifest as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }

  return artifacts.map((artifact): ReleaseManifestArtifact => ({
    path: stringAt(artifact, "path") ?? "",
    sha256: stringAt(artifact, "sha256") ?? ""
  }));
}

function validateReleaseManifestBuildInputs(manifest: ReleaseManifest): string[] {
  const errors: string[] = [];
  const buildInputs = manifest.buildInputs;

  if (!buildInputs || typeof buildInputs !== "object") {
    return ["release manifest buildInputs are required"];
  }

  if (!/^[a-f0-9]{64}$/.test(buildInputs.tauriConfigSha256 ?? "")) {
    errors.push("release manifest buildInputs.tauriConfigSha256 must be a SHA-256 hash");
  }

  if (manifest.mode === "distribution" && manifest.channel === "stable") {
    const stableUpdater = buildInputs.stableUpdater;
    if (!stableUpdater || typeof stableUpdater !== "object") {
      errors.push("stable release manifest must include updater build inputs");
    } else {
      if (!/^[a-f0-9]{64}$/.test(stableUpdater.pubkeySha256 ?? "")) {
        errors.push("stable release manifest updater pubkey must be recorded as a SHA-256 hash");
      }
      if (!Array.isArray(stableUpdater.endpoints) || stableUpdater.endpoints.length === 0) {
        errors.push("stable release manifest updater endpoints are required");
      } else {
        for (const endpoint of stableUpdater.endpoints) {
          errors.push(...validateProductionUpdateUrl("stable release manifest updater endpoint", endpoint));
        }
      }
    }
  } else if (buildInputs.stableUpdater) {
    errors.push("release manifest stable updater build inputs must not be declared outside the stable channel");
  }

  return errors;
}

function validateStableUpdaterArtifacts(manifest: ReleaseManifest): string[] {
  if (!manifest.includeBundle) {
    return [];
  }

  const artifactPaths = releaseManifestArtifacts(manifest).map((artifact) => artifact.path);

  switch (manifest.platform) {
    case "macos":
      return requiredStableArtifactErrors(artifactPaths, [
        {
          label: "Tauri updater static JSON feed",
          match: isStableUpdaterFeedArtifact
        },
        {
          label: "macOS updater payload",
          match: (artifactPath) => artifactPath.endsWith(".app.tar.gz")
        },
        {
          label: "macOS updater signature",
          match: (artifactPath) => artifactPath.endsWith(".app.tar.gz.sig")
        }
      ]);
    case "windows":
      return requiredStableArtifactErrors(artifactPaths, [
        {
          label: "Tauri updater static JSON feed",
          match: isStableUpdaterFeedArtifact
        },
        {
          label: "Windows MSI updater payload",
          match: (artifactPath) => /\/msi\/.+\.msi$/.test(`/${artifactPath}`)
        },
        {
          label: "Windows MSI updater signature",
          match: (artifactPath) => /\/msi\/.+\.msi\.sig$/.test(`/${artifactPath}`)
        },
        {
          label: "Windows NSIS updater payload",
          match: (artifactPath) => /\/nsis\/.+\.exe$/.test(`/${artifactPath}`)
        },
        {
          label: "Windows NSIS updater signature",
          match: (artifactPath) => /\/nsis\/.+\.exe\.sig$/.test(`/${artifactPath}`)
        }
      ]);
    case "linux":
      return requiredStableArtifactErrors(artifactPaths, [
        {
          label: "Tauri updater static JSON feed",
          match: isStableUpdaterFeedArtifact
        },
        {
          label: "Linux AppImage updater payload",
          match: (artifactPath) => /\/appimage\/.+\.AppImage$/.test(`/${artifactPath}`)
        },
        {
          label: "Linux AppImage updater signature",
          match: (artifactPath) => /\/appimage\/.+\.AppImage\.sig$/.test(`/${artifactPath}`)
        }
      ]);
  }
}

function isStableUpdaterFeedArtifact(artifactPath: string): boolean {
  return artifactPath.endsWith("builder-gear-updater-latest.json");
}

function requiredStableArtifactErrors(
  artifactPaths: string[],
  requirements: Array<{ label: string; match: (artifactPath: string) => boolean }>
): string[] {
  return requirements
    .filter((requirement) => !artifactPaths.some(requirement.match))
    .map((requirement) => `stable release manifest is missing ${requirement.label}`);
}

export function validateReleaseProvenance(
  provenance: ReleaseProvenance,
  manifest: ReleaseManifest,
  expectedGateIds: string[] = releaseManifestGateIds(manifest)
): string[] {
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  const manifestArtifacts = releaseManifestArtifacts(manifest);
  const manifestArtifactPaths = new Set(manifestArtifacts.map((artifact) => artifact.path));
  const allowedNonArtifactFiles = releaseProvenanceAllowedNonArtifactFiles(manifest);
  const files = releaseProvenanceFiles(provenance);
  const manifestRootVersion = stringAt(objectAt(manifest, "versions"), "root");

  if (!objectAt({ provenance }, "provenance")) {
    return ["release provenance must be an object"];
  }

  if (provenance.schemaVersion !== 1) {
    errors.push("release provenance schemaVersion must be 1");
  }
  if (!provenance.generatedAt || Number.isNaN(Date.parse(provenance.generatedAt))) {
    errors.push("release provenance generatedAt must be an ISO timestamp");
  }
  if (provenance.productName !== manifest.productName) {
    errors.push("release provenance productName must match manifest");
  }
  if (provenance.version !== manifestRootVersion) {
    errors.push("release provenance version must match manifest");
  }
  if (provenance.mode !== manifest.mode) {
    errors.push("release provenance mode must match manifest");
  }
  if (provenance.platform !== manifest.platform) {
    errors.push("release provenance platform must match manifest");
  }
  if (provenance.channel !== manifest.channel) {
    errors.push("release provenance channel must match manifest");
  }
  if (JSON.stringify(provenance.git) !== JSON.stringify(manifest.git)) {
    errors.push("release provenance git state must match manifest");
  }
  const provenanceGateIds = releaseProvenanceGateIds(provenance);
  const manifestGateIds = releaseManifestGateIds(manifest);
  if (!Array.isArray((provenance as { gateIds?: unknown }).gateIds) || provenanceGateIds.length !== (provenance as { gateIds?: unknown[] }).gateIds?.length) {
    errors.push("release provenance gateIds must be an array of strings");
  } else if (provenanceGateIds.join("\n") !== expectedGateIds.join("\n") || provenanceGateIds.join("\n") !== manifestGateIds.join("\n")) {
    errors.push("release provenance gateIds must match the executed release gate order");
  }

  if (!Array.isArray(provenance.files) || provenance.files.length === 0) {
    errors.push("release provenance files are required");
    return errors;
  }

  for (const file of files) {
    if (!["manifest", "inventory", "sbom", "notices", "policy", "artifact"].includes(file.kind)) {
      errors.push(`release provenance file kind is invalid: ${file.path}`);
    }
    if (!file.path?.trim()) {
      errors.push("release provenance file path is required");
    }
    if (file.path.includes("\0") || file.path.includes("\\") || path.isAbsolute(file.path) || file.path.startsWith("../")) {
      errors.push(`release provenance file path is unsafe: ${file.path}`);
    }
    if (file.kind === "artifact" && !manifestArtifactPaths.has(file.path)) {
      errors.push(`release provenance has artifact file not declared in manifest: ${file.path}`);
    }
    if (file.kind !== "artifact" && !isAllowedReleaseProvenanceFile(file, allowedNonArtifactFiles)) {
      errors.push(`release provenance has undeclared ${file.kind} file: ${file.path}`);
    }
    if (file.kind !== "artifact" && isLocalRuntimeProvenancePath(file.path)) {
      errors.push(`release provenance must not include local runtime state: ${file.path}`);
    }
    if (seenPaths.has(file.path)) {
      errors.push(`release provenance file path is duplicated: ${file.path}`);
    }
    seenPaths.add(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      errors.push(`release provenance file has invalid sha256: ${file.path}`);
    }
    if (file.kind === "inventory" && (!Number.isInteger(file.entryCount) || (file.entryCount ?? 0) < 1)) {
      errors.push("release provenance inventory entryCount must be positive");
    }
  }

  if (files.filter((file) => file.kind === "manifest").length !== 1) {
    errors.push("release provenance must include exactly one manifest file");
  }

  for (const required of allowedNonArtifactFiles) {
    if (!files.some((file) => isRequiredReleaseProvenanceFile(file, required))) {
      errors.push(`release provenance is missing ${required.kind} file: ${required.path}`);
    }
  }

  for (const artifact of manifestArtifacts) {
    if (!files.some((file) => file.kind === "artifact" && file.path === artifact.path && file.sha256 === artifact.sha256)) {
      errors.push(`release provenance is missing artifact file: ${artifact.path}`);
    }
  }

  return errors;
}

function releaseProvenanceAllowedNonArtifactFiles(
  manifest: ReleaseManifest
): Array<{ kind: Exclude<ReleaseProvenanceFile["kind"], "artifact">; path: string; match: "exact" | "suffix" }> {
  const inventory = objectAt(manifest, "inventory");

  return [
    { kind: "manifest", path: "builder-gear-release-manifest.json", match: "suffix" },
    { kind: "inventory", path: stringAt(inventory, "path") ?? "", match: "exact" },
    { kind: "sbom", path: "release/SBOM.cdx.json", match: "exact" },
    { kind: "notices", path: "release/THIRD_PARTY_NOTICES.md", match: "exact" },
    { kind: "policy", path: ".github/dependabot.yml", match: "exact" },
    { kind: "policy", path: "release/distribution-policy.json", match: "exact" },
    { kind: "policy", path: "release/license-policy.json", match: "exact" }
  ];
}

function releaseProvenanceGateIds(provenance: ReleaseProvenance): string[] {
  const gateIds = (provenance as { gateIds?: unknown }).gateIds;
  return Array.isArray(gateIds)
    ? gateIds.filter((gateId): gateId is string => typeof gateId === "string")
    : [];
}

function releaseProvenanceFiles(provenance: ReleaseProvenance): ReleaseProvenanceFile[] {
  const files = (provenance as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return [];
  }

  return files.map((file): ReleaseProvenanceFile => ({
    kind: stringAt(file, "kind") as ReleaseProvenanceFile["kind"],
    path: stringAt(file, "path") ?? "",
    sha256: stringAt(file, "sha256") ?? "",
    entryCount: numberAt(file, "entryCount")
  }));
}

function isAllowedReleaseProvenanceFile(
  file: ReleaseProvenanceFile,
  allowedFiles: Array<{ kind: Exclude<ReleaseProvenanceFile["kind"], "artifact">; path: string; match: "exact" | "suffix" }>
): boolean {
  return allowedFiles.some((allowed) => isRequiredReleaseProvenanceFile(file, allowed));
}

function isRequiredReleaseProvenanceFile(
  file: ReleaseProvenanceFile,
  required: { kind: Exclude<ReleaseProvenanceFile["kind"], "artifact">; path: string; match: "exact" | "suffix" }
): boolean {
  if (file.kind !== required.kind) {
    return false;
  }

  return required.match === "exact"
    ? file.path === required.path
    : file.path.endsWith(required.path);
}

export function verifyReleaseProvenanceArtifacts(options: VerifyReleaseProvenanceArtifactsOptions): string[] {
  const errors = validateReleaseProvenance(options.provenance, options.manifest, options.expectedGateIds);

  if (options.expectedManifestPath) {
    const expectedPath = options.expectedManifestPath;
    const manifestFiles = releaseProvenanceFiles(options.provenance).filter((file) => file.kind === "manifest");
    if (!manifestFiles.some((file) => file.path === expectedPath)) {
      errors.push(`release provenance manifest file must match verified manifest: ${expectedPath}`);
    }
    for (const file of manifestFiles) {
      if (file.path !== expectedPath) {
        errors.push(`release provenance has manifest file not being verified: ${file.path}`);
      }
    }
  }

  for (const file of releaseProvenanceFiles(options.provenance)) {
    const filePath = resolveReleaseArtifactPath(options.rootDir, file.path);

    if (!filePath) {
      errors.push(`release provenance file path escapes repository root: ${file.path}`);
      continue;
    }

    if (!existsSync(filePath)) {
      errors.push(`release provenance file is missing: ${file.path}`);
      continue;
    }

    const fileKindErrors = verifyReleaseProvenanceFileKind(file, filePath);
    if (fileKindErrors.length > 0) {
      errors.push(...fileKindErrors);
      continue;
    }

    try {
      const actualSha256 = hashReleaseArtifactPath(filePath);
      if (actualSha256 !== file.sha256) {
        errors.push(`release provenance file sha256 mismatch: ${file.path}`);
      }
    } catch (error) {
      errors.push(`release provenance file could not be hashed: ${file.path}: ${errorMessage(error)}`);
    }
  }

  return errors;
}

function verifyReleaseProvenanceFileKind(file: ReleaseProvenanceFile, filePath: string): string[] {
  if (file.kind === "artifact") {
    return [];
  }

  try {
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      return [`release provenance ${file.kind} file must not be a symlink: ${file.path}`];
    }
    if (!stats.isFile()) {
      return [`release provenance ${file.kind} file must be a regular file: ${file.path}`];
    }
  } catch (error) {
    return [`release provenance file could not be inspected: ${file.path}: ${errorMessage(error)}`];
  }

  return [];
}

export function validateReleaseGitState(git: ReleaseGitState | undefined, mode: ReleaseManifest["mode"]): string[] {
  const errors: string[] = [];

  if (!git || typeof git !== "object") {
    return ["release manifest git state is required"];
  }

  if (git.commit !== null && (typeof git.commit !== "string" || !git.commit.trim())) {
    errors.push("release manifest git.commit must be a non-empty string or null");
  }

  if (typeof git.commit === "string" && git.commit.trim() && !/^[a-f0-9]{40}$/.test(git.commit)) {
    errors.push("release manifest git.commit must be a full 40-character lowercase SHA");
  }

  if (git.dirty !== null && typeof git.dirty !== "boolean") {
    errors.push("release manifest git.dirty must be a boolean or null");
  }

  if (mode === "distribution") {
    if (typeof git.commit !== "string" || !git.commit.trim()) {
      errors.push("distribution release requires a git commit");
    }

    if (git.dirty !== false) {
      errors.push("distribution release requires a clean git worktree");
    }
  }

  return errors;
}

export function validateWorkflowActionRefs(workflows: WorkflowFile[]): string[] {
  const errors: string[] = [];

  for (const workflow of workflows) {
    if (workflow.path === ".github/workflows/ci.yml") {
      errors.push(...validateReleaseReadinessWorkflow(workflow));
    }
    if (workflow.path === ".github/workflows/release-candidate.yml") {
      errors.push(...validateReleaseCandidateWorkflow(workflow));
    }
    if (workflow.path === ".github/workflows/verify-stable-updater.yml") {
      errors.push(...validateStableUpdaterVerificationWorkflow(workflow));
    }

    const lines = workflow.content.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^"'\s#]+)["']?/);
      if (!match) {
        continue;
      }

      const specifier = match[1] ?? "";
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        continue;
      }

      const location = `${workflow.path}:${index + 1}`;
      if (specifier.startsWith("docker://")) {
        if (!/@sha256:[a-f0-9]{64}$/i.test(specifier)) {
          errors.push(`workflow Docker action must be pinned by sha256 digest at ${location}: ${specifier}`);
        }
        continue;
      }

      const refIndex = specifier.lastIndexOf("@");
      if (refIndex < 0) {
        errors.push(`workflow action must include a ref at ${location}: ${specifier}`);
        continue;
      }

      const ref = specifier.slice(refIndex + 1);
      if (!/^[a-f0-9]{40}$/i.test(ref)) {
        errors.push(`workflow action must be pinned to a 40-character commit SHA at ${location}: ${specifier}`);
      }
    }
  }

  return errors;
}

function validateReleaseReadinessWorkflow(workflow: WorkflowFile): string[] {
  const errors: string[] = [];
  const content = workflow.content;
  const requiredSnippets = [
    ["pull_request:", "CI workflow must run on pull requests"],
    ["push:", "CI workflow must run on protected push targets"],
    ["- main", "CI workflow push trigger must include main"],
    ["- \"release/**\"", "CI workflow push trigger must include release/**"],
    ["permissions:\n  contents: read", "CI workflow must use read-only repository contents permission"],
    ["macos-14", "CI workflow must run release readiness on macOS"],
    ["windows-2022", "CI workflow must run release readiness on Windows"],
    ["ubuntu-22.04", "CI workflow must run release readiness on Ubuntu"],
    ["pnpm install --frozen-lockfile", "CI workflow must install dependencies with a frozen lockfile"],
    ["pnpm --filter @builder/desktop exec playwright install chromium", "CI workflow must install the Chromium browser for desktop E2E tests from the desktop workspace"],
    ["pnpm release:check:fast", "CI workflow must run the fast release readiness gate"],
    [
      "pnpm release:verify -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json",
      "CI workflow must verify the generated release manifest"
    ],
    [
      "pnpm service:readiness -- --manifest apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json --skip-github --skip-updater --json",
      "CI workflow must run the local service readiness audit"
    ],
    [
      "pnpm release:stage-upload -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json",
      "CI workflow must stage the verified release upload set"
    ]
  ] as const;

  for (const [snippet, message] of requiredSnippets) {
    if (!content.includes(snippet)) {
      errors.push(message);
    }
  }

  if (!/timeout-minutes:\s*(?:[1-9]|[1-5][0-9]|60)\b/.test(content)) {
    errors.push("CI workflow release readiness job must have a bounded timeout");
  }

  errors.push(...validateCheckoutCredentialPersistence(
    workflow,
    "CI workflow checkout must disable persisted GitHub credentials"
  ));

  return errors;
}

function validateReleaseCandidateWorkflow(workflow: WorkflowFile): string[] {
  const errors: string[] = [];
  const content = workflow.content;
  const requiredSnippets = [
    ["workflow_dispatch:", "release candidate workflow must be manually dispatched"],
    ["type: choice", "release candidate workflow must use bounded choice inputs"],
    ["- macos", "release candidate workflow platform input must include macOS"],
    ["- windows", "release candidate workflow platform input must include Windows"],
    ["- linux", "release candidate workflow platform input must include Linux"],
    ["- internal", "release candidate workflow channel input must include internal"],
    ["- stable", "release candidate workflow channel input must include stable"],
    ["attestations: write", "release candidate workflow must allow artifact attestation writes"],
    ["contents: read", "release candidate workflow must use read-only repository contents permission"],
    ["id-token: write", "release candidate workflow must allow OIDC tokens for artifact attestations"],
    ["macos-14", "release candidate workflow must support macOS release builds"],
    ["windows-2022", "release candidate workflow must support Windows release builds"],
    ["ubuntu-22.04", "release candidate workflow must support Linux release builds"],
    ["pnpm install --frozen-lockfile", "release candidate workflow must install dependencies with a frozen lockfile"],
    ["pnpm --filter @builder/desktop exec playwright install chromium", "release candidate workflow must install Chromium for release E2E tests from the desktop workspace"],
    ["pnpm release:check:distribution -- --platform \"${{ inputs.platform }}\"", "release candidate workflow must run the internal distribution gate for the selected platform"],
    ["pnpm release:check:stable -- --platform \"${{ inputs.platform }}\"", "release candidate workflow must run the stable distribution gate for the selected platform"],
    ["Validate release environment secrets", "release candidate workflow must validate selected release secret names before build"],
    ["Missing release environment secret: %s", "release candidate workflow must report missing release secret names without printing values"],
    ["Import Apple signing certificate", "release candidate workflow must import the Apple signing certificate on macOS"],
    ["if: inputs.platform == 'macos'", "release candidate workflow must scope Apple certificate import to macOS"],
    ["security create-keychain", "release candidate workflow must create an isolated macOS signing keychain"],
    ["security import \"$CERTIFICATE_PATH\"", "release candidate workflow must import the macOS signing certificate"],
    ["security set-key-partition-list", "release candidate workflow must allow codesign to use the imported key"],
    ["security find-identity -v -p codesigning \"$KEYCHAIN_PATH\" | grep -F \"$APPLE_SIGNING_IDENTITY\"", "release candidate workflow must verify the imported Apple signing identity"],
    ["pnpm release:verify -- \"$MANIFEST_PATH\"", "release candidate workflow must verify the generated release manifest before upload"],
    ["pnpm release:stage-upload -- \"$MANIFEST_PATH\"", "release candidate workflow must stage only verified release files before upload"],
    ["actions/attest-build-provenance@", "release candidate workflow must attest release artifacts"],
    ["subject-path: apps/desktop/src-tauri/target/release-upload/**", "release candidate workflow must attest staged release files"],
    ["actions/upload-artifact@", "release candidate workflow must upload release artifacts"],
    ["apps/desktop/src-tauri/target/release-upload/**", "release candidate workflow must upload staged release files"],
    ["if-no-files-found: error", "release candidate workflow must fail when release artifacts are missing"],
    ["retention-days: 14", "release candidate workflow must use bounded artifact retention"]
  ] as const;

  for (const [snippet, message] of requiredSnippets) {
    if (!content.includes(snippet)) {
      errors.push(message);
    }
  }

  errors.push(...validateReleaseCandidateSecretScope(content));
  errors.push(...validateReleaseCandidatePermissionScope(content));
  errors.push(...validateReleaseCandidateBranchGuard(content));
  errors.push(...validateReleaseCandidateSecretValidationOrder(content));
  errors.push(...validateAppleSigningCleanupStep(content));
  errors.push(...validateReleaseCandidateAttestationOrder(content));

  if (!/timeout-minutes:\s*(?:[1-9]|[1-5][0-9]|60)\b/.test(content)) {
    errors.push("release candidate workflow job must have a bounded timeout");
  }

  if (/path:\s*apps\/desktop\/src-tauri\/target\/release\/bundle\/\*\*/.test(content)) {
    errors.push("release candidate workflow must not upload the raw Tauri bundle directory");
  }
  if (/subject-path:\s*apps\/desktop\/src-tauri\/target\/release\/bundle\/\*\*/.test(content)) {
    errors.push("release candidate workflow must not attest the raw Tauri bundle directory");
  }

  errors.push(...validateCheckoutCredentialPersistence(
    workflow,
    "release candidate workflow checkout must disable persisted GitHub credentials"
  ));

  return errors;
}

function validateStableUpdaterVerificationWorkflow(workflow: WorkflowFile): string[] {
  const errors: string[] = [];
  const content = workflow.content;
  const requiredSnippets = [
    ["workflow_dispatch:", "stable updater verification workflow must be manually dispatched"],
    ["release_run_id:", "stable updater verification workflow must require a release workflow run ID"],
    ["type: choice", "stable updater verification workflow must use bounded platform inputs"],
    ["- macos", "stable updater verification workflow platform input must include macOS"],
    ["- windows", "stable updater verification workflow platform input must include Windows"],
    ["- linux", "stable updater verification workflow platform input must include Linux"],
    ["verify_downloads:", "stable updater verification workflow must expose payload download verification"],
    ["environment:\n      name: production", "stable updater verification workflow must run in the production environment"],
    ["actions: read", "stable updater verification workflow must allow reading release candidate artifacts"],
    ["attestations: read", "stable updater verification workflow must allow reading release candidate attestations"],
    ["contents: read", "stable updater verification workflow must use read-only repository contents permission"],
    ["actions/download-artifact@", "stable updater verification workflow must download the stable candidate artifact"],
    ["run-id: ${{ inputs.release_run_id }}", "stable updater verification workflow must download from the requested release run"],
    ["github-token: ${{ github.token }}", "stable updater verification workflow must use the scoped GitHub token for artifact download"],
    ["pattern: builder-gear-stable-${{ inputs.platform }}-*", "stable updater verification workflow must download only stable artifacts for the selected platform"],
    ["path: release-candidate-artifact", "stable updater verification workflow must isolate downloaded release artifacts from the source checkout"],
    ["merge-multiple: true", "stable updater verification workflow must merge the staged release upload set"],
    ["pnpm install --frozen-lockfile", "stable updater verification workflow must install dependencies with a frozen lockfile"],
    ["gh run view \"${{ inputs.release_run_id }}\"", "stable updater verification workflow must inspect the selected release run before download"],
    ["--json workflowName,event,conclusion,headBranch,headSha", "stable updater verification workflow must read release run workflow, event, conclusion, branch, and commit metadata"],
    ["\"$workflow_name\" != \"Release Candidate\"", "stable updater verification workflow must require the Release Candidate workflow"],
    ["\"$event\" != \"workflow_dispatch\"", "stable updater verification workflow must require manually dispatched release candidates"],
    ["\"$conclusion\" != \"success\"", "stable updater verification workflow must require a successful release candidate run"],
    ["case \"$head_branch\" in", "stable updater verification workflow must require release candidate runs from main or release branches"],
    ["[[ \"$head_sha\" =~ ^[a-f0-9]{40}$ ]]", "stable updater verification workflow must require a valid release candidate commit SHA"],
    ["printf 'head_sha=%s\\n' \"$head_sha\" >> \"$GITHUB_OUTPUT\"", "stable updater verification workflow must expose the selected release commit as a step output"],
    ["printf 'RELEASE_CANDIDATE_HEAD_SHA=%s\\n' \"$head_sha\" >> \"$GITHUB_ENV\"", "stable updater verification workflow must carry the selected release commit into manifest verification"],
    ["ref: ${{ steps.release-run-metadata.outputs.head_sha }}", "stable updater verification workflow must check out the selected release candidate commit"],
    ["ARTIFACT_ROOT: release-candidate-artifact", "stable updater verification workflow must pass the isolated artifact root into manifest verification"],
    ["pnpm release:verify -- --artifact-root \"$ARTIFACT_ROOT\" \"$MANIFEST_PATH\"", "stable updater verification workflow must verify the downloaded release manifest from the isolated artifact root"],
    ["EXPECTED_PLATFORM: ${{ inputs.platform }}", "stable updater verification workflow must pass the requested platform into manifest verification"],
    ["manifest.mode !== \"distribution\" || manifest.channel !== \"stable\" || manifest.includeBundle !== true", "stable updater verification workflow must require a bundled stable distribution manifest"],
    ["manifest.platform !== expectedPlatform", "stable updater verification workflow must require the downloaded manifest platform to match the selected platform"],
    ["manifest.git?.commit !== expectedHeadSha", "stable updater verification workflow must match the downloaded manifest to the selected release run"],
    ["GH_TOKEN: ${{ github.token }}", "stable updater verification workflow must authenticate GitHub CLI with the scoped token"],
    ["gh attestation verify \"$file\"", "stable updater verification workflow must verify release candidate attestations"],
    ["--repo \"$GITHUB_REPOSITORY\"", "stable updater verification workflow must verify attestations against the current repository"],
    ["--signer-workflow \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/release-candidate.yml\"", "stable updater verification workflow must require the release candidate signer workflow"],
    ["--deny-self-hosted-runners", "stable updater verification workflow must reject self-hosted attestation runners"],
    ["find release-candidate-artifact/apps/desktop/src-tauri/target/release-upload", "stable updater verification workflow must attest only files from the isolated release upload set"],
    ["pnpm release:verify-updater -- --artifact-root release-candidate-artifact \"$MANIFEST_PATH\"", "stable updater verification workflow must verify the hosted updater feed from the isolated artifact root"],
    [
      "pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github",
      "stable updater verification workflow must run the service readiness audit from the isolated artifact root"
    ],
    ["--verify-downloads", "stable updater verification workflow must support hosted payload SHA-256 verification"]
  ] as const;

  for (const [snippet, message] of requiredSnippets) {
    if (!content.includes(snippet)) {
      errors.push(message);
    }
  }

  errors.push(...validateStableUpdaterVerificationBranchGuard(content));

  const verifyJob = findWorkflowJob(content, "verify");
  if (!verifyJob || !/timeout-minutes:\s*(?:[1-9]|1[0-9]|20)\b/.test(verifyJob)) {
    errors.push("stable updater verification workflow job must have a bounded timeout");
  }

  errors.push(...validateCheckoutCredentialPersistence(
    workflow,
    "stable updater verification workflow checkout must disable persisted GitHub credentials"
  ));

  return errors;
}

function validateStableUpdaterVerificationBranchGuard(content: string): string[] {
  const verifyJob = findWorkflowJob(content, "verify");
  const guardJob = findWorkflowJob(content, "ref-guard");
  const errors: string[] = [];

  if (!verifyJob) {
    return ["stable updater verification workflow must run only from main or release branches"];
  }

  if (!guardJob) {
    errors.push("stable updater verification workflow must fail before production checks on non-release refs");
  } else {
    if (!/Stable updater verification ref guard/.test(guardJob) || !/Require main or release ref/.test(guardJob)) {
      errors.push("stable updater verification workflow must fail before production checks on non-release refs");
    }
    if (!/runs-on:\s*ubuntu-22\.04/.test(guardJob)) {
      errors.push("stable updater verification ref guard must run on Ubuntu without production environment access");
    }
    if (!/timeout-minutes:\s*(?:[1-9]|10)\b/.test(guardJob)) {
      errors.push("stable updater verification ref guard must have a bounded timeout");
    }
    if (!/refs\/heads\/main\|refs\/heads\/release\/\*/.test(guardJob) || !/\bexit 1\b/.test(guardJob)) {
      errors.push("stable updater verification workflow must fail before production checks on non-release refs");
    }
  }

  if (!/^\s+needs:\s*ref-guard\s*$/m.test(verifyJob)) {
    errors.push("stable updater verification job must depend on the release ref guard");
  }

  const guarded = verifyJob
    .split(/\r?\n/)
    .some((line) => /^\s+if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]\s*\|\|\s*startsWith\(github\.ref,\s*['"]refs\/heads\/release\/['"]\)/.test(line));

  if (!guarded) {
    errors.push("stable updater verification workflow must run only from main or release branches");
  }

  return [...new Set(errors)];
}

function validateReleaseCandidatePermissionScope(content: string): string[] {
  const errors: string[] = [];
  const topLevelPermissions = findTopLevelWorkflowBlock(content, "permissions");
  const buildJob = findWorkflowJob(content, "build");

  if (!topLevelPermissions || !/^\s+contents:\s*read\s*$/m.test(topLevelPermissions)) {
    errors.push("release candidate workflow must use read-only repository contents permission");
  }

  if (topLevelPermissions && /^\s+(?:attestations|id-token):\s*write\s*$/m.test(topLevelPermissions)) {
    errors.push("release candidate workflow must scope artifact attestation permissions to the build job");
  }

  if (!buildJob || !/^\s+permissions:\s*$/m.test(buildJob)) {
    errors.push("release candidate build job must declare scoped permissions");
  } else {
    if (!/^\s+attestations:\s*write\s*$/m.test(buildJob)) {
      errors.push("release candidate workflow must allow artifact attestation writes");
    }
    if (!/^\s+contents:\s*read\s*$/m.test(buildJob)) {
      errors.push("release candidate workflow must use read-only repository contents permission");
    }
    if (!/^\s+id-token:\s*write\s*$/m.test(buildJob)) {
      errors.push("release candidate workflow must allow OIDC tokens for artifact attestations");
    }
  }

  return errors;
}

function validateReleaseCandidateBranchGuard(content: string): string[] {
  const buildJob = findWorkflowJob(content, "build");
  const guardJob = findWorkflowJob(content, "ref-guard");
  const errors: string[] = [];

  if (!buildJob) {
    return ["release candidate workflow must run only from main or release branches"];
  }

  if (!guardJob) {
    errors.push("release candidate workflow must fail before signing when dispatched from non-release refs");
  } else {
    if (!/Release ref guard/.test(guardJob) || !/Require main or release ref/.test(guardJob)) {
      errors.push("release candidate workflow must fail before signing when dispatched from non-release refs");
    }
    if (!/runs-on:\s*ubuntu-22\.04/.test(guardJob)) {
      errors.push("release candidate ref guard must run on Ubuntu without signing secrets");
    }
    if (!/timeout-minutes:\s*(?:[1-9]|10)\b/.test(guardJob)) {
      errors.push("release candidate ref guard must have a bounded timeout");
    }
    if (!/refs\/heads\/main\|refs\/heads\/release\/\*/.test(guardJob) || !/\bexit 1\b/.test(guardJob)) {
      errors.push("release candidate workflow must fail before signing when dispatched from non-release refs");
    }
  }

  if (!/^\s+needs:\s*ref-guard\s*$/m.test(buildJob)) {
    errors.push("release candidate build job must depend on the release ref guard");
  }

  const guarded = buildJob
    .split(/\r?\n/)
    .some((line) => /^\s+if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]\s*\|\|\s*startsWith\(github\.ref,\s*['"]refs\/heads\/release\/['"]\)/.test(line));

  if (!guarded) {
    errors.push("release candidate workflow must run only from main or release branches");
  }

  return [...new Set(errors)];
}

function validateReleaseCandidateAttestationOrder(content: string): string[] {
  const attestIndex = content.indexOf("actions/attest-build-provenance@");
  const uploadIndex = content.indexOf("actions/upload-artifact@");

  if (attestIndex < 0 || uploadIndex < 0) {
    return [];
  }

  return attestIndex < uploadIndex
    ? []
    : ["release candidate workflow must attest release artifacts before upload"];
}

function validateReleaseCandidateSecretValidationOrder(content: string): string[] {
  const validateIndex = content.indexOf("Validate release environment secrets");
  if (validateIndex < 0) {
    return [];
  }

  const installIndex = content.indexOf("pnpm install --frozen-lockfile");
  const buildIndex = content.indexOf("Build release candidate");

  if (installIndex >= 0 && validateIndex > installIndex || buildIndex >= 0 && validateIndex > buildIndex) {
    return ["release candidate workflow must validate selected release secret names before dependency install or build"];
  }

  return [];
}

function findWorkflowJob(content: string, jobId: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let startLine = -1;
  let jobIndent = "";

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (!match || match[2] !== jobId) {
      continue;
    }

    const previousLine = lines[index - 1] ?? "";
    const priorContent = lines.slice(0, index).join("\n");
    if (!/^jobs:\s*$/.test(previousLine) && !/\njobs:\s*(?:\n|$)/.test(priorContent)) {
      continue;
    }

    startLine = index;
    jobIndent = match[1] ?? "";
    break;
  }

  if (startLine < 0) {
    return undefined;
  }

  const boundaryPattern = new RegExp(`^${escapeRegExp(jobIndent)}[A-Za-z0-9_-]+:\\s*$`);
  const jobLines = [lines[startLine] ?? ""];
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (boundaryPattern.test(line)) {
      break;
    }
    jobLines.push(line);
  }

  return jobLines.join("\n");
}

function findTopLevelWorkflowBlock(content: string, blockName: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let startLine = -1;

  for (const [index, line] of lines.entries()) {
    if (line === `${blockName}:`) {
      startLine = index;
      break;
    }
  }

  if (startLine < 0) {
    return undefined;
  }

  const blockLines = [lines[startLine] ?? ""];
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  return blockLines.join("\n");
}

function validateAppleSigningCleanupStep(content: string): string[] {
  const cleanupStep = findNamedWorkflowStep(content, "Remove Apple signing keychain");
  const missingMessages = [
    "release candidate workflow must remove the temporary Apple signing keychain",
    "release candidate workflow must always clean up the Apple signing keychain on macOS",
    "release candidate workflow must delete the temporary Apple signing certificate file",
    "release candidate workflow must restore the default macOS login keychain",
    "release candidate workflow must delete the temporary Apple signing keychain"
  ];

  if (!cleanupStep) {
    return missingMessages;
  }

  const errors: string[] = [];
  if (!/\bif:\s*always\(\)\s*&&\s*inputs\.platform\s*==\s*['"]macos['"]/.test(cleanupStep)) {
    errors.push("release candidate workflow must always clean up the Apple signing keychain on macOS");
  }
  if (!cleanupStep.includes("CERTIFICATE_PATH=\"$RUNNER_TEMP/builder-gear-signing.p12\"") || !cleanupStep.includes("rm -f \"$CERTIFICATE_PATH\"")) {
    errors.push("release candidate workflow must delete the temporary Apple signing certificate file");
  }
  if (!cleanupStep.includes("security default-keychain -s login.keychain-db || true")) {
    errors.push("release candidate workflow must restore the default macOS login keychain");
  }
  if (!cleanupStep.includes("security delete-keychain \"$KEYCHAIN_PATH\" || true")) {
    errors.push("release candidate workflow must delete the temporary Apple signing keychain");
  }

  return errors;
}

function findNamedWorkflowStep(content: string, name: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let startLine = -1;
  let stepIndent = "";

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const stepName = (match[2] ?? "").replace(/^["']|["']$/g, "");
    if (stepName === name) {
      startLine = index;
      stepIndent = match[1] ?? "";
      break;
    }
  }

  if (startLine < 0) {
    return undefined;
  }

  const boundaryPattern = new RegExp(`^${escapeRegExp(stepIndent)}-\\s+(?:name:|uses:|run:)`);
  const stepLines = [lines[startLine] ?? ""];
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (boundaryPattern.test(line)) {
      break;
    }
    stepLines.push(line);
  }

  return stepLines.join("\n");
}

function validateCheckoutCredentialPersistence(workflow: WorkflowFile, message: string): string[] {
  const checkoutStepPattern = /uses:\s*actions\/checkout@[a-f0-9]{40}\b[\s\S]*?(?=\n\s*-\s+(?:name:|uses:|run:)|\s*$)/gi;
  const checkoutSteps = workflow.content.match(checkoutStepPattern) ?? [];

  if (checkoutSteps.length === 0) {
    return [message];
  }

  return checkoutSteps.every((step) => /\bpersist-credentials:\s*false\b/.test(step))
    ? []
    : [message];
}

function validateReleaseCandidateSecretScope(content: string): string[] {
  const errors: string[] = [];
  const scopedSecrets = [
    {
      envName: "APPLE_SIGNING_IDENTITY",
      expression: "inputs.platform == 'macos' && secrets.APPLE_SIGNING_IDENTITY || ''",
      message: "release candidate workflow must scope Apple signing identity to macOS"
    },
    {
      envName: "APPLE_CERTIFICATE",
      expression: "inputs.platform == 'macos' && secrets.APPLE_CERTIFICATE || ''",
      message: "release candidate workflow must scope Apple signing certificate to macOS"
    },
    {
      envName: "APPLE_CERTIFICATE_PASSWORD",
      expression: "inputs.platform == 'macos' && secrets.APPLE_CERTIFICATE_PASSWORD || ''",
      message: "release candidate workflow must scope Apple certificate password to macOS"
    },
    {
      envName: "APPLE_KEYCHAIN_PASSWORD",
      expression: "inputs.platform == 'macos' && secrets.APPLE_KEYCHAIN_PASSWORD || ''",
      message: "release candidate workflow must scope Apple keychain password to macOS"
    },
    {
      envName: "APPLE_ID",
      expression: "inputs.platform == 'macos' && secrets.APPLE_ID || ''",
      message: "release candidate workflow must scope Apple ID to macOS"
    },
    {
      envName: "APPLE_PASSWORD",
      expression: "inputs.platform == 'macos' && secrets.APPLE_PASSWORD || ''",
      message: "release candidate workflow must scope Apple password to macOS"
    },
    {
      envName: "APPLE_TEAM_ID",
      expression: "inputs.platform == 'macos' && secrets.APPLE_TEAM_ID || ''",
      message: "release candidate workflow must scope Apple team ID to macOS"
    },
    {
      envName: "WINDOWS_SIGNING_CERTIFICATE",
      expression: "inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_CERTIFICATE || ''",
      message: "release candidate workflow must scope Windows signing certificate to Windows"
    },
    {
      envName: "WINDOWS_SIGNING_PASSWORD",
      expression: "inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_PASSWORD || ''",
      message: "release candidate workflow must scope Windows signing password to Windows"
    },
    {
      envName: "TAURI_SIGNING_PRIVATE_KEY",
      expression: "inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY || ''",
      message: "release candidate workflow must scope Tauri updater private key to stable"
    },
    {
      envName: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      expression: "inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ''",
      message: "release candidate workflow must scope Tauri updater private key password to stable"
    },
    {
      envName: "BUILDER_GEAR_UPDATER_PUBKEY",
      expression: "inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATER_PUBKEY || ''",
      message: "release candidate workflow must scope updater public key to stable"
    },
    {
      envName: "BUILDER_GEAR_UPDATE_ENDPOINT",
      expression: "inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATE_ENDPOINT || ''",
      message: "release candidate workflow must scope updater endpoint to stable"
    }
  ];

  for (const secret of scopedSecrets) {
    const linePattern = new RegExp(
      `^\\s*${escapeRegExp(secret.envName)}:\\s*\\$\\{\\{\\s*${escapeRegExp(secret.expression)}\\s*\\}\\}\\s*$`,
      "m"
    );

    if (!linePattern.test(content)) {
      errors.push(secret.message);
    }
  }

  return errors;
}

export function validateDependencyLicenses(
  entries: DependencyLicenseEntry[],
  policy: LicensePolicy = {}
): string[] {
  const errors = validateLicensePolicy(policy);
  const allowedLicenses = new Set(policy.allowedLicenses ?? defaultAllowedDependencyLicenses());

  for (const entry of entries) {
    const label = `${entry.ecosystem}:${entry.name}@${entry.version}`;
    const license = entry.license?.trim();

    if (!license) {
      errors.push(`dependency license is missing: ${label}`);
      continue;
    }

    if (!isAllowedLicenseExpression(license, allowedLicenses)) {
      errors.push(`dependency license is not allowed: ${label} (${license})`);
    }
  }

  return errors;
}

export function renderThirdPartyNotices(entries: DependencyLicenseEntry[]): string {
  const sortedEntries = [...entries].sort(compareDependencyLicenseEntries);
  const ecosystemCounts = countBy(sortedEntries, (entry) => entry.ecosystem);
  const licenseCounts = countBy(sortedEntries, (entry) => entry.license?.trim() || "UNKNOWN");
  const lines = [
    "# Third-Party Notices",
    "",
    "This file is generated by `pnpm license:notices` from installed Node package metadata and Cargo metadata.",
    "Do not edit it manually; update dependencies or `release/license-policy.json`, then regenerate it.",
    "",
    `Total dependencies: ${sortedEntries.length}`,
    "",
    "## Ecosystem Summary",
    "",
    ...[...ecosystemCounts.entries()]
      .sort((left, right) => compareStableText(left[0], right[0]))
      .map(([ecosystem, count]) => `- ${ecosystem}: ${count}`),
    "",
    "## License Summary",
    "",
    ...[...licenseCounts.entries()]
      .sort((left, right) => compareStableText(left[0], right[0]))
      .map(([license, count]) => `- ${license}: ${count}`),
    "",
    "## Dependency Notices",
    "",
    "| Ecosystem | Package | Version | License | Source |",
    "| --- | --- | --- | --- | --- |",
    ...sortedEntries.map((entry) => [
      entry.ecosystem,
      entry.name,
      entry.version,
      entry.license?.trim() || "UNKNOWN",
      entry.repository?.trim() || entry.homepage?.trim() || entry.source?.trim() || "package metadata"
    ].map(markdownTableCell).join(" | ")).map((row) => `| ${row} |`),
    ""
  ];

  return `${lines.join("\n")}\n`;
}

export function renderCycloneDxSbom(entries: DependencyLicenseEntry[], metadata: SbomMetadata): string {
  const components = [...entries]
    .sort(compareDependencyLicenseEntries)
    .map((entry) => {
      const externalReferences = dependencyExternalReferences(entry);

      return {
        type: "library",
        "bom-ref": dependencyBomRef(entry),
        name: entry.name,
        version: entry.version,
        purl: dependencyPurl(entry),
        licenses: [
          {
            expression: entry.license?.trim() || "NOASSERTION"
          }
        ],
        ...(externalReferences.length > 0 ? { externalReferences } : {})
      };
    });
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      tools: [
        {
          vendor: "Builder Gear",
          name: "builder-gear-release-check",
          version: metadata.version
        }
      ],
      component: {
        type: "application",
        name: metadata.productName,
        version: metadata.version
      }
    },
    components
  };

  return `${JSON.stringify(sbom, null, 2)}\n`;
}

function compareDependencyLicenseEntries(left: DependencyLicenseEntry, right: DependencyLicenseEntry): number {
  return compareStableText(left.ecosystem, right.ecosystem) ||
    compareStableText(left.name, right.name) ||
    compareStableText(left.version, right.version) ||
    compareStableText(left.license ?? "", right.license ?? "");
}

function compareStableText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function validateLicensePolicy(policy: LicensePolicy): string[] {
  const errors: string[] = [];

  if (policy.schemaVersion !== 1) {
    errors.push("license policy schemaVersion must be 1");
  }

  const allowedLicenses = policy.allowedLicenses ?? [];
  if (allowedLicenses.length === 0) {
    errors.push("license policy allowedLicenses must not be empty");
  }

  for (const license of allowedLicenses) {
    if (!license.trim()) {
      errors.push("license policy allowedLicenses must not include empty values");
    }
  }

  return errors;
}

export function defaultAllowedDependencyLicenses(): string[] {
  return [
    "0BSD",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "CC-BY-4.0",
    "CC0-1.0",
    "CDLA-Permissive-2.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "Unicode-3.0",
    "Unlicense",
    "WTFPL",
    "Zlib"
  ];
}

function isAllowedLicenseExpression(expression: string, allowedLicenses: Set<string>): boolean {
  const normalized = expression
    .replace(/\s*\/\s*/g, " OR ")
    .replace(/\s+/g, " ")
    .trim();
  const parser = new LicenseExpressionParser(normalized, allowedLicenses);
  return parser.parse();
}

class LicenseExpressionParser {
  private readonly tokens: string[];
  private index = 0;

  constructor(expression: string, private readonly allowedLicenses: Set<string>) {
    this.tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/gi) ?? [];
  }

  parse(): boolean {
    if (this.tokens.length === 0) {
      return false;
    }

    const value = this.parseOr();
    return value && this.index === this.tokens.length;
  }

  private parseOr(): boolean {
    let value = this.parseAnd();

    while (this.peekUpper() === "OR") {
      this.index += 1;
      value = this.parseAnd() || value;
    }

    return value;
  }

  private parseAnd(): boolean {
    let value = this.parseFactor();

    while (this.peekUpper() === "AND") {
      this.index += 1;
      value = this.parseFactor() && value;
    }

    return value;
  }

  private parseFactor(): boolean {
    if (this.peek() === "(") {
      this.index += 1;
      const value = this.parseOr();
      if (this.peek() !== ")") {
        return false;
      }
      this.index += 1;
      return value;
    }

    const license = this.consume();
    if (!license) {
      return false;
    }

    if (this.peekUpper() === "WITH") {
      this.index += 1;
      const exception = this.consume();
      return Boolean(exception) && this.allowedLicenses.has(`${license} WITH ${exception}`);
    }

    return this.allowedLicenses.has(license);
  }

  private consume(): string | undefined {
    const value = this.tokens[this.index];
    this.index += 1;
    return value;
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private peekUpper(): string | undefined {
    return this.peek()?.toUpperCase();
  }
}

export function validateReleaseInventory(inventory: ReleaseInventory, manifest: ReleaseManifest): string[] {
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  const entries = releaseInventoryEntries(inventory);
  const inventoryGateIds = releaseInventoryGateIds(inventory);
  const manifestGateIds = releaseManifestGateIds(manifest);
  const manifestRootVersion = stringAt(objectAt(manifest, "versions"), "root");
  const manifestInventory = objectAt(manifest, "inventory");

  if (!objectAt({ inventory }, "inventory")) {
    return ["release inventory must be an object"];
  }

  if (inventory.schemaVersion !== 1) {
    errors.push("release inventory schemaVersion must be 1");
  }
  if (!inventory.generatedAt || Number.isNaN(Date.parse(inventory.generatedAt))) {
    errors.push("release inventory generatedAt must be an ISO timestamp");
  }
  if (inventory.productName !== manifest.productName) {
    errors.push("release inventory productName must match manifest");
  }
  if (inventory.version !== manifestRootVersion) {
    errors.push("release inventory version must match manifest");
  }
  if (inventory.platform !== manifest.platform) {
    errors.push("release inventory platform must match manifest");
  }
  if (inventory.mode !== manifest.mode) {
    errors.push("release inventory mode must match manifest");
  }
  if (inventory.channel !== manifest.channel) {
    errors.push("release inventory channel must match manifest");
  }
  if (!Array.isArray((inventory as { gateIds?: unknown }).gateIds) || inventoryGateIds.length !== (inventory as { gateIds?: unknown[] }).gateIds?.length) {
    errors.push("release inventory gateIds must be an array of strings");
  } else if (inventoryGateIds.join("\n") !== manifestGateIds.join("\n")) {
    errors.push("release inventory gateIds must match manifest");
  }
  if (!Array.isArray((inventory as { entries?: unknown }).entries)) {
    errors.push("release inventory entries must be an array");
  }
  if (entries.length !== numberAt(manifestInventory, "entryCount")) {
    errors.push("release inventory entry count must match manifest");
  }

  for (const entry of entries) {
    if (!["source", "lockfile", "policy", "workflow", "artifact"].includes(entry.kind)) {
      errors.push(`release inventory entry kind is invalid: ${entry.path}`);
    }
    if (!entry.path.trim()) {
      errors.push("release inventory entry path is required");
    }
    if (entry.path.includes("\0") || entry.path.includes("\\") || path.isAbsolute(entry.path) || entry.path.startsWith("../")) {
      errors.push(`release inventory entry path is unsafe: ${entry.path}`);
    }
    if (entry.kind !== "artifact" && isLocalRuntimeInventoryPath(entry.path)) {
      errors.push(`release inventory must not include local runtime state: ${entry.path}`);
    }
    if (seenPaths.has(entry.path)) {
      errors.push(`release inventory entry path is duplicated: ${entry.path}`);
    }
    seenPaths.add(entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      errors.push(`release inventory entry has invalid sha256: ${entry.path}`);
    }
  }

  for (const requiredPath of [
    "package.json",
    "pnpm-lock.yaml",
    "apps/desktop/src-tauri/Cargo.lock",
    "apps/desktop/src-tauri/tauri.conf.json",
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/release-candidate.yml",
    ".github/workflows/verify-stable-updater.yml",
    "release/distribution-policy.json",
    "release/license-policy.json",
    "release/SBOM.cdx.json",
    "release/THIRD_PARTY_NOTICES.md"
  ]) {
    if (!seenPaths.has(requiredPath)) {
      errors.push(`release inventory is missing required entry: ${requiredPath}`);
    }
  }

  for (const artifact of releaseManifestArtifacts(manifest)) {
    if (!seenPaths.has(artifact.path)) {
      errors.push(`release inventory is missing artifact entry: ${artifact.path}`);
    }
  }

  return errors;
}

function releaseInventoryGateIds(inventory: ReleaseInventory): string[] {
  const gateIds = (inventory as { gateIds?: unknown }).gateIds;
  return Array.isArray(gateIds)
    ? gateIds.filter((gateId): gateId is string => typeof gateId === "string")
    : [];
}

function releaseInventoryEntries(inventory: ReleaseInventory): ReleaseInventoryEntry[] {
  const entries = (inventory as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.map((entry): ReleaseInventoryEntry => ({
    kind: stringAt(entry, "kind") as ReleaseInventoryEntry["kind"],
    path: stringAt(entry, "path") ?? "",
    sha256: stringAt(entry, "sha256") ?? ""
  }));
}

function isLocalRuntimeInventoryPath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);
  const parts = normalized.split("/");

  return normalized === ".builder" ||
    normalized.startsWith(".builder/") ||
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes("coverage") ||
    parts.includes("test-results") ||
    parts.includes("playwright-report") ||
    parts.includes("release-candidate-artifact") ||
    normalized.endsWith(".tgz") ||
    parts.includes("target");
}

function isLocalRuntimeProvenancePath(filePath: string): boolean {
  const normalized = normalizeRepositoryPath(filePath);
  const parts = normalized.split("/");

  return normalized === ".builder" ||
    normalized.startsWith(".builder/") ||
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes("coverage") ||
    parts.includes("test-results") ||
    parts.includes("playwright-report") ||
    parts.includes("release-candidate-artifact") ||
    normalized.endsWith(".tgz");
}

export function verifyReleaseInventoryEntries(
  inventory: ReleaseInventory,
  sourceRootDir: string,
  artifactRootDir = sourceRootDir
): string[] {
  const errors: string[] = [];

  for (const entry of releaseInventoryEntries(inventory)) {
    const entryRootDir = entry.kind === "artifact" ? artifactRootDir : sourceRootDir;
    const entryPath = resolveReleaseArtifactPath(entryRootDir, entry.path);

    if (!entryPath) {
      errors.push(`release inventory entry path escapes repository root: ${entry.path}`);
      continue;
    }

    if (!existsSync(entryPath)) {
      errors.push(`release inventory entry is missing: ${entry.path}`);
      continue;
    }

    try {
      const actualSha256 = hashReleaseArtifactPath(entryPath);
      if (actualSha256 !== entry.sha256) {
        errors.push(`release inventory entry sha256 mismatch: ${entry.path}`);
      }
    } catch (error) {
      errors.push(`release inventory entry could not be hashed: ${entry.path}: ${errorMessage(error)}`);
    }
  }

  return errors;
}

function validateDistributionPolicy(
  policy: Record<string, unknown>,
  tauriConfig: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const bundle = objectAt(tauriConfig, "bundle");
  const macOS = objectAt(bundle, "macOS");
  const policyMacOS = objectAt(policy, "macOS");
  const policyWindows = objectAt(policy, "windows");
  const policyLinux = objectAt(policy, "linux");
  const channels = objectArrayAt(policy, "channels");
  const bundleTargets = stringArrayAt(policy, "bundleTargets");
  const requiredEnvironment = requiredDistributionEnvironment(policy);

  if (numberAt(policy, "schemaVersion") !== 1) {
    errors.push("distribution policy schemaVersion must be 1");
  }

  if (!stringAt(policy, "artifactName")) {
    errors.push("distribution policy artifactName is required");
  }

  for (const target of ["app", "dmg"]) {
    if (!bundleTargets.includes(target)) {
      errors.push(`distribution policy bundleTargets must include ${target}`);
    }
  }

  for (const channelId of ["internal", "stable"]) {
    const channel = channels.find((candidate) => stringAt(candidate, "id") === channelId);

    if (!channel) {
      errors.push(`distribution policy channel is missing: ${channelId}`);
      continue;
    }

    if (booleanAt(channel, "requiresCodeSigning") !== true) {
      errors.push(`distribution policy ${channelId} channel must require code signing`);
    }
    if (booleanAt(channel, "requiresNotarization") !== true) {
      errors.push(`distribution policy ${channelId} channel must require notarization`);
    }
  }

  if (booleanAt(channels.find((candidate) => stringAt(candidate, "id") === "stable"), "requiresUpdaterArtifacts") !== true) {
    errors.push("distribution policy stable channel must require updater artifacts");
  }
  if (booleanAt(channels.find((candidate) => stringAt(candidate, "id") === "internal"), "requiresUpdaterArtifacts") !== false) {
    errors.push("distribution policy internal channel must not require updater artifacts");
  }

  const stableChannel = channels.find((candidate) => stringAt(candidate, "id") === "stable");
  for (const envName of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "BUILDER_GEAR_UPDATER_PUBKEY", "BUILDER_GEAR_UPDATE_ENDPOINT"]) {
    if (!stringArrayAt(stableChannel, "requiredEnvironment").includes(envName)) {
      errors.push(`distribution policy stable channel requiredEnvironment must include ${envName}`);
    }
  }

  if (stringAt(policyMacOS, "minimumSystemVersion") !== stringAt(macOS, "minimumSystemVersion")) {
    errors.push("distribution policy macOS minimumSystemVersion must match Tauri config");
  }

  if (booleanAt(policyMacOS, "hardenedRuntime") !== true || booleanAt(policyMacOS, "hardenedRuntime") !== booleanAt(macOS, "hardenedRuntime")) {
    errors.push("distribution policy macOS hardenedRuntime must match Tauri config and be true");
  }

  const policyEntitlements = stringAt(policyMacOS, "entitlements");
  const tauriEntitlements = stringAt(macOS, "entitlements");
  if (!policyEntitlements || !tauriEntitlements) {
    errors.push("distribution policy and Tauri config must declare macOS entitlements");
  } else {
    const tauriEntitlementsPath = tauriMacOSEntitlementsRepositoryPath(tauriEntitlements);
    const policyEntitlementsPath = normalizeRepositoryPath(policyEntitlements);

    if (tauriEntitlementsPath && policyEntitlementsPath !== tauriEntitlementsPath) {
      errors.push("distribution policy macOS entitlements path must match Tauri config");
    }
  }

  for (const envName of ["APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
    if (!requiredEnvironment.includes(envName)) {
      errors.push(`distribution policy requiredEnvironment must include ${envName}`);
    }
  }

  if (!stringArrayAt(policyWindows, "bundleTargets").includes("msi")) {
    errors.push("distribution policy windows bundleTargets must include msi");
  }
  if (!stringArrayAt(policyWindows, "bundleTargets").includes("nsis")) {
    errors.push("distribution policy windows bundleTargets must include nsis");
  }
  for (const envName of ["WINDOWS_SIGNING_CERTIFICATE", "WINDOWS_SIGNING_PASSWORD"]) {
    if (!stringArrayAt(policyWindows, "requiredEnvironment").includes(envName)) {
      errors.push(`distribution policy windows requiredEnvironment must include ${envName}`);
    }
  }

  for (const target of ["appimage", "deb", "rpm"]) {
    if (!stringArrayAt(policyLinux, "bundleTargets").includes(target)) {
      errors.push(`distribution policy linux bundleTargets must include ${target}`);
    }
  }

  return errors;
}

function tauriMacOSEntitlementsRepositoryPath(entitlementsPath: string): string | undefined {
  if (path.isAbsolute(entitlementsPath)) {
    return undefined;
  }

  const normalized = normalizeRepositoryPath(path.posix.join("apps/desktop/src-tauri", entitlementsPath));
  if (!normalized.startsWith("apps/desktop/src-tauri/")) {
    return undefined;
  }

  return normalized;
}

function normalizeRepositoryPath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll("\\", "/"));
}

function collectArtifactEntries(directory: string): string[] {
  const entries: string[] = [];
  const artifactRoot = path.resolve(directory);
  walk(artifactRoot);
  return entries.sort((left, right) => left.localeCompare(right));

  function walk(currentDirectory: string) {
    for (const entry of readdirSync(currentDirectory)) {
      const entryPath = path.join(currentDirectory, entry);
      const stats = lstatSync(entryPath);

      if (stats.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (stats.isFile() || stats.isSymbolicLink()) {
        entries.push(entryPath);
        continue;
      }

      const relativePath = path.relative(artifactRoot, entryPath).split(path.sep).join("/");
      throw new Error(`artifact directory contains unsupported entry: ${relativePath}`);
    }
  }
}

function parsePlistValues(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /<key>([^<]+)<\/key>\s*<(string|true|false)\/?>(?:([^<]*)<\/string>)?/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const key = decodeXml(match[1] ?? "");
    const kind = match[2];
    const value = kind === "string" ? decodeXml(match[3] ?? "") : kind ?? "";

    if (key) {
      values[key] = value;
    }
  }

  return values;
}

function expectPlistValue(
  errors: string[],
  info: Record<string, string>,
  key: string,
  expectedValue: string
) {
  const actualValue = info[key];

  if (!actualValue) {
    errors.push(`macOS app bundle Info.plist is missing ${key}`);
    return;
  }

  if (actualValue !== expectedValue) {
    errors.push(`macOS app bundle Info.plist ${key} must be ${expectedValue}; got ${actualValue}`);
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child)
    ? child as Record<string, unknown>
    : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" && child.trim() ? child : undefined;
}

function booleanAt(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const child = (value as Record<string, unknown>)[key];
  return typeof child === "boolean" ? child : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const child = (value as Record<string, unknown>)[key];
  return typeof child === "number" ? child : undefined;
}

function stringArrayAt(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child)
    ? child.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function objectArrayAt(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child)
    ? child.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}
