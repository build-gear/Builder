#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseArtifactProfile,
  resolveReleaseArtifactPath,
  type DistributionChannel,
  type ReleasePlatform
} from "../packages/core/src/release-check.js";
import { readCheckedTextFile } from "./script-file-safety.js";

type ParsedArgs = {
  platform: ReleasePlatform;
  artifactRoot: string;
  distribution: boolean;
  channel: DistributionChannel;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: pnpm release:smoke-bundle -- --platform <macos|windows|linux> [--artifact-root <path>] [--distribution] [--channel <internal|stable>]";
const MACHO_MIN_BYTES = 4_096;

try {
  const parsedArgs = parseArgs(process.argv.slice(2));

  if (!parsedArgs.ok) {
    console.error(parsedArgs.message);
    process.exitCode = parsedArgs.exitCode;
  } else {
    const errors = verifyDesktopBundleSmoke(parsedArgs.args);

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`desktop bundle smoke: ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`Desktop bundle smoke verified: ${repoRelativePath(resolveArtifactRoot(parsedArgs.args.artifactRoot) ?? rootDir)}`);
    }
  }
} catch (error) {
  console.error(`desktop bundle smoke: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
}

function verifyDesktopBundleSmoke(args: ParsedArgs): string[] {
  const errors: string[] = [];
  const artifactRoot = resolveArtifactRoot(args.artifactRoot);

  if (!artifactRoot) {
    return ["artifact root must be repository-relative"];
  }

  try {
    const stats = lstatSync(artifactRoot);
    if (stats.isSymbolicLink()) {
      return ["artifact root must not be a symlink"];
    }
    if (!stats.isDirectory()) {
      return ["artifact root must be a directory"];
    }
  } catch (error) {
    return [`artifact root could not be read: ${repoRelativePath(artifactRoot)}: ${safeErrorMessage(error)}`];
  }

  const profile = releaseArtifactProfile({
    platform: args.platform,
    distribution: args.distribution,
    channel: args.channel
  });
  const resolvedArtifacts = resolveRequiredArtifacts(artifactRoot, profile.requiredArtifacts);
  errors.push(...resolvedArtifacts.errors);

  if (args.platform !== "macos") {
    errors.push(...verifyPackagedFiles(args.platform, resolvedArtifacts.paths, artifactRoot));
    return errors;
  }

  const appPaths = resolvedArtifacts.paths.filter((artifactPath) => artifactPath.endsWith(".app"));
  const packagePaths = resolvedArtifacts.paths.filter((artifactPath) => !artifactPath.endsWith(".app"));
  if (appPaths.length === 0) {
    errors.push("macOS release must include an app bundle");
  }

  errors.push(...verifyPackagedFiles(args.platform, packagePaths, artifactRoot));

  for (const appPath of appPaths) {
    errors.push(...verifyMacOSAppExecutableSmoke(appPath, artifactRoot));
  }

  return errors;
}

function parseArgs(argv: string[]): { ok: true; args: ParsedArgs } | { ok: false; exitCode: 0 | 1; message: string } {
  const args = argv.filter((arg) => arg !== "--");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ok: false, exitCode: 0, message: usage };
  }
  if (args.includes("--help") || args.includes("-h")) {
    return { ok: false, exitCode: 1, message: `help must be requested without other arguments\n${usage}` };
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--distribution") {
      if (flags.has(arg)) {
        return { ok: false, exitCode: 1, message: `duplicate option: ${arg}\n${usage}` };
      }
      flags.add(arg);
      continue;
    }

    if (arg === "--platform" || arg === "--artifact-root" || arg === "--channel") {
      if (values.has(arg)) {
        return { ok: false, exitCode: 1, message: `duplicate option: ${arg}\n${usage}` };
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, exitCode: 1, message: `missing value for option: ${arg}\n${usage}` };
      }
      values.set(arg, value);
      index += 1;
      continue;
    }

    return { ok: false, exitCode: 1, message: `unknown argument: ${arg}\n${usage}` };
  }

  const platform = values.get("--platform");
  if (!validPlatform(platform)) {
    return { ok: false, exitCode: 1, message: `--platform must be one of: macos, windows, linux\n${usage}` };
  }

  const channel = values.get("--channel") ?? "internal";
  if (!validChannel(channel)) {
    return { ok: false, exitCode: 1, message: `--channel must be one of: internal, stable\n${usage}` };
  }

  const distribution = flags.has("--distribution");
  const defaultArtifactRoot = releaseArtifactProfile({ platform, distribution, channel }).artifactRoot;

  return {
    ok: true,
    args: {
      platform,
      artifactRoot: values.get("--artifact-root") ?? defaultArtifactRoot,
      distribution,
      channel
    }
  };
}

function resolveArtifactRoot(artifactRoot: string): string | undefined {
  return resolveReleaseArtifactPath(rootDir, artifactRoot);
}

function resolveRequiredArtifacts(
  artifactRoot: string,
  patterns: string[]
): { paths: string[]; errors: string[] } {
  const paths = new Set<string>();
  const errors: string[] = [];

  for (const pattern of patterns) {
    const matches = resolveArtifactPattern(artifactRoot, pattern);
    if (matches.length === 0) {
      errors.push(`required desktop artifact is missing: ${pattern}`);
      continue;
    }
    for (const match of matches) {
      paths.add(match);
    }
  }

  return {
    paths: [...paths].sort((left, right) => left.localeCompare(right)),
    errors
  };
}

function resolveArtifactPattern(artifactRoot: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    const artifactPath = path.join(artifactRoot, pattern);
    return existsSync(artifactPath) ? [artifactPath] : [];
  }

  const patternDirectory = path.dirname(pattern);
  const patternName = path.basename(pattern);
  const searchDirectory = patternDirectory === "." ? artifactRoot : path.join(artifactRoot, patternDirectory);
  if (!existsSync(searchDirectory)) {
    return [];
  }

  const [prefix, suffix] = patternName.split("*");
  return readdirSync(searchDirectory)
    .filter((entry) => entry.startsWith(prefix ?? "") && entry.endsWith(suffix ?? ""))
    .map((entry) => path.join(searchDirectory, entry));
}

function verifyPackagedFiles(platform: ReleasePlatform, artifactPaths: string[], artifactRoot: string): string[] {
  const errors: string[] = [];

  for (const artifactPath of artifactPaths) {
    const relativePath = rootRelativePath(artifactRoot, artifactPath);
    const stats = lstatSync(artifactPath);
    if (stats.isSymbolicLink()) {
      errors.push(`desktop artifact must not be a symlink: ${relativePath}`);
      continue;
    }
    if (!stats.isFile()) {
      errors.push(`desktop artifact must be a regular file: ${relativePath}`);
      continue;
    }
    if (stats.size === 0) {
      errors.push(`desktop artifact must not be empty: ${relativePath}`);
      continue;
    }
    if (supportsPosixExecutableBits() && platform === "linux" && artifactPath.endsWith(".AppImage") && (stats.mode & 0o111) === 0) {
      errors.push(`Linux AppImage artifact is not executable: ${relativePath}`);
    }
    errors.push(...verifyArtifactHeader(platform, artifactPath, artifactRoot));
  }

  return errors;
}

function verifyArtifactHeader(platform: ReleasePlatform, artifactPath: string, artifactRoot: string): string[] {
  const relativePath = rootRelativePath(artifactRoot, artifactPath);
  const basename = path.basename(artifactPath);

  if (basename.endsWith(".sig")) {
    return [];
  }

  const header = readFileSync(artifactPath).subarray(0, 8);

  if (platform === "windows" && artifactPath.endsWith(".msi") && !matchesHeader(header, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return [`Windows MSI artifact does not have an MSI compound-file header: ${relativePath}`];
  }

  if (platform === "windows" && artifactPath.endsWith(".exe") && !matchesHeader(header, [0x4d, 0x5a])) {
    return [`Windows NSIS artifact does not have a PE executable header: ${relativePath}`];
  }

  if (platform === "linux" && artifactPath.endsWith(".AppImage") && !matchesHeader(header, [0x7f, 0x45, 0x4c, 0x46])) {
    return [`Linux AppImage artifact does not have an ELF executable header: ${relativePath}`];
  }

  if (platform === "linux" && artifactPath.endsWith(".deb") && !matchesHeader(header, [...Buffer.from("!<arch>\n")])) {
    return [`Linux deb artifact does not have an ar archive header: ${relativePath}`];
  }

  if (platform === "linux" && artifactPath.endsWith(".rpm") && !matchesHeader(header, [0xed, 0xab, 0xee, 0xdb])) {
    return [`Linux rpm artifact does not have an rpm package header: ${relativePath}`];
  }

  return [];
}

function matchesHeader(header: Buffer, expected: number[]): boolean {
  if (header.length < expected.length) {
    return false;
  }

  return expected.every((byte, index) => header[index] === byte);
}

function verifyMacOSAppExecutableSmoke(appPath: string, artifactRoot: string): string[] {
  const errors: string[] = [];
  const appRelativePath = rootRelativePath(artifactRoot, appPath);

  if (!appPath.endsWith(".app")) {
    errors.push(`macOS app bundle path must end with .app: ${appRelativePath}`);
    return errors;
  }

  const appStats = lstatSync(appPath);
  if (appStats.isSymbolicLink()) {
    errors.push(`macOS app bundle must not be a symlink: ${appRelativePath}`);
    return errors;
  }
  if (!appStats.isDirectory()) {
    errors.push(`macOS app bundle must be a directory: ${appRelativePath}`);
    return errors;
  }

  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlistPath)) {
    errors.push(`macOS app bundle is missing Contents/Info.plist: ${appRelativePath}`);
    return errors;
  }

  let info: Record<string, string>;
  try {
    info = parsePlistValues(readCheckedTextFile(
      infoPlistPath,
      `macOS app bundle Info.plist ${rootRelativePath(artifactRoot, infoPlistPath)}`
    ));
  } catch (error) {
    errors.push(`macOS app bundle Info.plist could not be read: ${rootRelativePath(artifactRoot, infoPlistPath)}: ${safeErrorMessage(error)}`);
    return errors;
  }

  const executableName = info.CFBundleExecutable;
  if (!executableName) {
    errors.push(`macOS app bundle Info.plist is missing CFBundleExecutable: ${appRelativePath}`);
    return errors;
  }
  if (executableName.includes("/") || executableName.includes("\\") || executableName.includes("\0")) {
    errors.push(`macOS app bundle CFBundleExecutable must be a file name: ${appRelativePath}`);
    return errors;
  }

  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const executableRelativePath = rootRelativePath(artifactRoot, executablePath);
  if (!existsSync(executablePath)) {
    errors.push(`macOS app bundle executable is missing: ${executableRelativePath}`);
    return errors;
  }

  const executableStats = lstatSync(executablePath);
  if (executableStats.isSymbolicLink()) {
    errors.push(`macOS app bundle executable must not be a symlink: ${executableRelativePath}`);
    return errors;
  }
  if (!executableStats.isFile()) {
    errors.push(`macOS app bundle executable must be a regular file: ${executableRelativePath}`);
    return errors;
  }
  if (supportsPosixExecutableBits() && (executableStats.mode & 0o111) === 0) {
    errors.push(`macOS app bundle executable is not executable: ${executableRelativePath}`);
  }
  if (executableStats.size < MACHO_MIN_BYTES) {
    errors.push(`macOS app bundle executable is too small to be a desktop binary: ${executableRelativePath}`);
    return errors;
  }

  const header = readFileSync(executablePath).subarray(0, 4);
  if (!isMachOHeader(header)) {
    errors.push(`macOS app bundle executable is not a Mach-O binary: ${executableRelativePath}`);
    return errors;
  }

  if (process.platform === "darwin") {
    errors.push(...verifyMacOSLinkTable(executablePath, executableRelativePath));
  }

  return errors;
}

function verifyMacOSLinkTable(executablePath: string, executableRelativePath: string): string[] {
  const result = spawnSync("otool", ["-L", executablePath], {
    encoding: "utf8",
    maxBuffer: 1_048_576
  });

  if (result.error) {
    return [`otool is required to inspect the macOS executable link table: ${safeErrorMessage(result.error)}`];
  }

  if (result.status !== 0) {
    const detail = firstNonEmptyLine(`${result.stderr}\n${result.stdout}`) ?? "otool failed";
    return [`macOS app bundle executable link table could not be read: ${executableRelativePath}: ${truncate(safeErrorMessage(detail))}`];
  }

  const output = result.stdout.trim();
  const linkedLibraries = output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
  if (linkedLibraries.length === 0) {
    return [`macOS app bundle executable has no readable dynamic library entries: ${executableRelativePath}`];
  }

  return [];
}

function isMachOHeader(header: Buffer): boolean {
  if (header.length < 4) {
    return false;
  }

  return new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
    0xcafebabf,
    0xbfbafeca
  ]).has(header.readUInt32BE(0));
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

function decodeXml(source: string): string {
  return source
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function validPlatform(platform: string | undefined): platform is ReleasePlatform {
  return platform === "macos" || platform === "windows" || platform === "linux";
}

function validChannel(channel: string | undefined): channel is DistributionChannel {
  return channel === "internal" || channel === "stable";
}

function firstNonEmptyLine(source: string): string | undefined {
  return source.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function truncate(source: string): string {
  return source.length > 240 ? `${source.slice(0, 240)}...` : source;
}

function repoRelativePath(absolutePath: string): string {
  return rootRelativePath(rootDir, absolutePath);
}

function rootRelativePath(baseDir: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(baseDir), absolutePath).split(path.sep).join("/");

  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : "[REPO_EXTERNAL_PATH]";
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(rootDir, "[REPO_ROOT]");
}

function supportsPosixExecutableBits(): boolean {
  return process.platform !== "win32";
}
