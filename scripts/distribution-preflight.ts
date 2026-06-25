#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readRepoJsonFile,
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";
import {
  type DistributionChannel,
  isPlaceholderDistributionValue,
  loadReleaseEnvFileFromArgv,
  parseReleaseCliChoice,
  validateDistributionPreflightArgv,
  validateDistributionPreflightEnvironment,
  type ReleasePlatform
} from "../packages/core/src/release-check.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const platformArgument = requestedPlatform();
  const channelArgument = requestedChannel();
  const argumentErrors = [
    ...validateDistributionPreflightArgv(process.argv),
    ...platformArgument.errors,
    ...channelArgument.errors
  ];
  if (argumentErrors.length > 0) {
    for (const error of argumentErrors) {
      console.error(`release args: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const envFileErrors = loadReleaseEnvFileFromArgv(process.argv, rootDir, process.env);
  if (envFileErrors.length > 0) {
    for (const error of envFileErrors) {
      console.error(`release env: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const platform = platformArgument.value ?? currentReleasePlatform();
  const channel = channelArgument.value ?? "internal";
  const policy = readReleaseJson("release/distribution-policy.json", "distribution policy");
  const tauriConfig = policy ? readReleaseConfig(channel) : undefined;

  if (!policy || !tauriConfig) {
    process.exitCode = 1;
    return;
  }

  const errors = [
    ...validateDistributionPreflightEnvironment(policy, platform, process.env, { channel, tauriConfig }),
    ...platformToolErrors(platform)
  ];

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`distribution preflight: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Distribution preflight passed for ${platform} ${channel}.`);
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

function readEffectiveTauriConfig(channel: DistributionChannel): Record<string, unknown> {
  const baseConfig = readJson("apps/desktop/src-tauri/tauri.conf.json");

  if (channel !== "stable") {
    return baseConfig;
  }

  return deepMerge(baseConfig, stableTauriConfigOverlay());
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

function readJson(relativePath: string, label = relativePath): Record<string, unknown> {
  return readRepoJsonFile(rootDir, relativePath, label);
}

function readReleaseJson(relativePath: string, label: string): Record<string, unknown> | undefined {
  try {
    return readJson(relativePath, label);
  } catch (error) {
    console.error(`distribution preflight: ${label} could not be read: ${relativePath}: ${safeErrorMessage(error)}`);
    return undefined;
  }
}

function readReleaseConfig(channel: DistributionChannel): Record<string, unknown> | undefined {
  try {
    return readEffectiveTauriConfig(channel);
  } catch (error) {
    console.error(`distribution preflight: Tauri config could not be read: ${safeErrorMessage(error)}`);
    return undefined;
  }
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

function platformToolErrors(platform: ReleasePlatform): string[] {
  switch (platform) {
    case "macos":
      return macOSToolErrors();
    case "windows":
      return windowsToolErrors();
    case "linux":
      return linuxToolErrors();
  }
}

function macOSToolErrors(): string[] {
  const errors: string[] = [];
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();

  if (process.platform !== "darwin") {
    return ["macOS distribution builds must run on macOS"];
  }

  for (const tool of ["codesign", "security"]) {
    if (!commandSucceeds("xcrun", ["--find", tool])) {
      errors.push(`macOS signing tool is missing: ${tool}`);
    }
  }

  for (const tool of ["notarytool", "stapler"]) {
    if (!commandSucceeds("xcrun", ["--find", tool])) {
      errors.push(`macOS notarization tool is missing: ${tool}`);
    }
  }

  if (!commandSucceeds("xcrun", ["--find", "spctl"]) && !commandSucceeds("which", ["spctl"])) {
    errors.push("macOS Gatekeeper assessment tool is missing: spctl");
  }

  if (identity && !isPlaceholderDistributionValue(identity)) {
    const identities = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    if (identities.status !== 0) {
      errors.push("macOS codesigning identities could not be read from the keychain");
    } else if (!identities.stdout.includes(identity)) {
      errors.push("APPLE_SIGNING_IDENTITY was not found in the macOS codesigning keychain");
    }
  }

  return errors;
}

function windowsToolErrors(): string[] {
  if (process.platform !== "win32") {
    return ["Windows distribution builds must run on Windows"];
  }

  return commandSucceeds("where", ["signtool"])
    ? []
    : ["Windows signing tool is missing: signtool"];
}

function linuxToolErrors(): string[] {
  if (process.platform !== "linux") {
    return ["Linux distribution builds must run on Linux"];
  }

  const errors: string[] = [];
  for (const tool of ["dpkg-deb", "rpmbuild"]) {
    if (!commandSucceeds("which", [tool])) {
      errors.push(`Linux packaging tool is missing: ${tool}`);
    }
  }
  return errors;
}

function commandSucceeds(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8"
  });

  return result.status === 0;
}

function safeErrorMessage(error: unknown): string {
  return safeScriptErrorMessage(rootDir, error);
}
