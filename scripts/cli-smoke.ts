#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(rootDir, "packages/cli/dist/index.js");
const cliPackageVersion = requirePackageVersion(readPackageJson("packages/cli/package.json"), "@builder/cli package");

main();

function main() {
  assert(existsSync(cliPath), `built CLI is missing: ${cliPath}`);

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "builder-cli-smoke-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    const codexHome = path.join(tempRoot, "codex-home");
    const secret = "sess-release-smoke-secret1234567890";
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ session_token: secret }), { mode: 0o600 });

    const version = runCli(["--version"]);
    assert(version.stdout.trim() === cliPackageVersion, `unexpected CLI version: ${version.stdout.trim()}`);

    const init = runCli(["init", "--workspace", workspace, "--json"]);
    const initResult = JSON.parse(init.stdout) as { files?: Array<{ status: string }> };
    assert(initResult.files?.every((file) => file.status === "created"), "CLI init did not create the starter workspace");
    const canonicalWorkspace = realpathSync(workspace);

    const doctor = runCli(["doctor", "--workspace", workspace, "--json"], {
      BUILDER_GEAR_CODEX_BIN: process.execPath,
      CODEX_HOME: codexHome
    });
    const report = JSON.parse(doctor.stdout) as { status?: string };
    assert(report.status === "pass", `CLI doctor did not pass: ${doctor.stdout}`);
    assert(!doctor.stdout.includes(secret), "CLI doctor printed auth file contents");

    const support = runCli(["doctor", "--workspace", workspace, "--support"], {
      BUILDER_GEAR_CODEX_BIN: process.execPath,
      CODEX_HOME: codexHome
    });
    const supportBundle = JSON.parse(support.stdout) as {
      health?: { status?: string };
      privacy?: {
        includesAuthContents?: boolean;
        includesRawPrompts?: boolean;
        includesWorkspacePaths?: boolean;
        includesRunPayloads?: boolean;
      };
    };
    assert(supportBundle.health?.status === "pass", `CLI support bundle did not pass: ${support.stdout}`);
    assert(supportBundle.privacy?.includesAuthContents === false, "support bundle privacy contract is missing auth-content exclusion");
    assert(supportBundle.privacy?.includesRawPrompts === false, "support bundle privacy contract is missing prompt exclusion");
    assert(supportBundle.privacy?.includesWorkspacePaths === false, "support bundle privacy contract is missing path exclusion");
    assert(supportBundle.privacy?.includesRunPayloads === false, "support bundle privacy contract is missing run-payload exclusion");
    assert(!support.stdout.includes(secret), "CLI support bundle printed auth file contents");
    assert(!support.stdout.includes(codexHome), "CLI support bundle printed the Codex home path");
    assert(!support.stdout.includes(canonicalWorkspace), "CLI support bundle printed the workspace path");

    const backupName = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
    mkdirSync(path.join(workspace, ".builder", "backups"), { recursive: true });
    writeFileSync(path.join(workspace, ".builder", "schedules.json"), "current smoke schedules");
    writeFileSync(path.join(workspace, ".builder", "backups", backupName), "previous smoke schedules");
    const backups = runCli(["backups", "list", "--workspace", workspace, "--json"]);
    const backupRows = JSON.parse(backups.stdout) as Array<{ name?: string; targetRelativePath?: string }>;
    assert(
      backupRows.some((row) => row.name === backupName && row.targetRelativePath === ".builder/schedules.json"),
      "CLI backup list did not identify the schedules backup target"
    );
    assert(!backups.stdout.includes("previous smoke schedules"), "CLI backup list printed backup file contents");
    const restorePreview = runCli(["backups", "restore", backupName, "--workspace", workspace, "--json"]);
    const restorePreviewResult = JSON.parse(restorePreview.stdout) as { dryRun?: boolean; targetRelativePath?: string };
    assert(restorePreviewResult.dryRun === true, "CLI backup restore should dry-run by default");
    assert(restorePreviewResult.targetRelativePath === ".builder/schedules.json", "CLI backup restore preview did not identify the target");
    assert(
      readFileSync(path.join(workspace, ".builder", "schedules.json"), "utf8") === "current smoke schedules",
      "CLI backup restore preview should not replace the target file"
    );
    const restored = runCli(["backups", "restore", backupName, "--workspace", workspace, "--confirm", "--json"]);
    const restoreResult = JSON.parse(restored.stdout) as { dryRun?: boolean; preRestoreBackup?: { relativePath?: string } };
    assert(restoreResult.dryRun === false, "CLI backup restore --confirm should disable dry-run");
    assert(
      readFileSync(path.join(workspace, ".builder", "schedules.json"), "utf8") === "previous smoke schedules",
      "CLI backup restore did not restore the target file"
    );
    assert(
      Boolean(restoreResult.preRestoreBackup?.relativePath) &&
        readFileSync(path.join(workspace, restoreResult.preRestoreBackup!.relativePath!), "utf8") === "current smoke schedules",
      "CLI backup restore did not save a pre-restore backup"
    );
    const prunePreview = runCli(["backups", "prune", "--workspace", workspace, "--keep", "2", "--json"]);
    const prunePreviewResult = JSON.parse(prunePreview.stdout) as { dryRun?: boolean; candidates?: unknown[] };
    assert(prunePreviewResult.dryRun === true, "CLI backup prune should dry-run by default");
    assert(Array.isArray(prunePreviewResult.candidates), "CLI backup prune did not return candidates");
    const pruneConfirmed = runCli(["backups", "prune", "--workspace", workspace, "--keep", "2", "--confirm", "--json"]);
    const pruneConfirmedResult = JSON.parse(pruneConfirmed.stdout) as { dryRun?: boolean; pruned?: unknown[] };
    assert(pruneConfirmedResult.dryRun === false, "CLI backup prune --confirm should disable dry-run");
    assert(Array.isArray(pruneConfirmedResult.pruned), "CLI backup prune --confirm did not return pruned entries");

    const scheduleDb = path.join(workspace, ".builder", "schedules.sqlite");
    writeFileSync(path.join(workspace, ".builder", "schedules.json"), JSON.stringify([{
      id: "smoke-plan",
      name: "Smoke Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: workspace,
        prompt: "Scheduled smoke prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));
    runCli(["schedules", "import", "--workspace", workspace, "--db", scheduleDb, "--json"]);
    const removePreview = runCli(["schedules", "remove", "smoke-plan", "--db", scheduleDb, "--json"]);
    const removePreviewResult = JSON.parse(removePreview.stdout) as { dryRun?: boolean; removed?: boolean };
    assert(removePreviewResult.dryRun === true && removePreviewResult.removed === false, "CLI schedule remove should dry-run by default");
    const scheduleListAfterPreview = JSON.parse(runCli(["schedules", "list", "--db", scheduleDb, "--json"]).stdout) as unknown[];
    assert(scheduleListAfterPreview.length === 1, "CLI schedule remove preview should not delete the schedule");
    const removeConfirmed = runCli(["schedules", "remove", "smoke-plan", "--db", scheduleDb, "--confirm", "--json"]);
    const removeConfirmedResult = JSON.parse(removeConfirmed.stdout) as { dryRun?: boolean; removed?: boolean };
    assert(removeConfirmedResult.dryRun === false && removeConfirmedResult.removed === true, "CLI schedule remove --confirm should delete the schedule");
    const scheduleListAfterConfirm = JSON.parse(runCli(["schedules", "list", "--db", scheduleDb, "--json"]).stdout) as unknown[];
    assert(scheduleListAfterConfirm.length === 0, "CLI schedule remove --confirm did not delete the schedule");

    writeFileSync(path.join(workspace, ".builder", "schedules.json"), JSON.stringify([{
      id: "stale-plan",
      name: "Stale Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: workspace,
        prompt: "Stale scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    }]));
    runCli(["schedules", "import", "--workspace", workspace, "--db", scheduleDb, "--json"]);
    writeFileSync(path.join(workspace, ".builder", "schedules.json"), "[]");
    const replacePreview = runCli(["schedules", "import", "--workspace", workspace, "--db", scheduleDb, "--replace", "--json"]);
    const replacePreviewResult = JSON.parse(replacePreview.stdout) as { dryRun?: boolean; removed?: number; stale?: number };
    assert(
      replacePreviewResult.dryRun === true && replacePreviewResult.removed === 0 && replacePreviewResult.stale === 1,
      "CLI schedules import --replace should preview stale removals by default"
    );
    const scheduleListAfterReplacePreview = JSON.parse(runCli(["schedules", "list", "--db", scheduleDb, "--json"]).stdout) as unknown[];
    assert(scheduleListAfterReplacePreview.length === 1, "CLI schedules import --replace preview should not delete stale schedules");
    const replaceConfirmed = runCli(["schedules", "import", "--workspace", workspace, "--db", scheduleDb, "--replace", "--confirm", "--json"]);
    const replaceConfirmedResult = JSON.parse(replaceConfirmed.stdout) as { dryRun?: boolean; removed?: number; stale?: number };
    assert(
      replaceConfirmedResult.dryRun === false && replaceConfirmedResult.removed === 1 && replaceConfirmedResult.stale === 1,
      "CLI schedules import --replace --confirm should delete stale schedules"
    );

    const scheduleAddPath = path.join(workspace, "schedule-add.json");
    const scheduleAddSpec = {
      id: "add-plan",
      name: "Add Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "UTC",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: workspace,
        prompt: "Add scheduled prompt",
        sandboxMode: "read-only",
        approvalMode: "never"
      }
    };
    writeFileSync(scheduleAddPath, JSON.stringify(scheduleAddSpec));
    const scheduleAdded = JSON.parse(runCli(["schedules", "add", scheduleAddPath, "--db", scheduleDb, "--json"]).stdout) as {
      created?: boolean;
      updated?: boolean;
      dryRun?: boolean;
    };
    assert(scheduleAdded.created === true && scheduleAdded.updated === false && scheduleAdded.dryRun === false, "CLI schedules add did not create a new schedule");
    writeFileSync(scheduleAddPath, JSON.stringify({ ...scheduleAddSpec, name: "Add Plan Updated" }));
    const scheduleUpdatePreview = JSON.parse(runCli(["schedules", "add", scheduleAddPath, "--db", scheduleDb, "--json"]).stdout) as {
      created?: boolean;
      updated?: boolean;
      dryRun?: boolean;
    };
    assert(
      scheduleUpdatePreview.created === false && scheduleUpdatePreview.updated === false && scheduleUpdatePreview.dryRun === true,
      "CLI schedules add should preview existing-id updates by default"
    );
    const scheduleListAfterUpdatePreview = JSON.parse(runCli(["schedules", "list", "--db", scheduleDb, "--json"]).stdout) as Array<{ spec?: { name?: string } }>;
    assert(scheduleListAfterUpdatePreview[0]?.spec?.name === "Add Plan", "CLI schedules add preview should not update the schedule");
    const scheduleUpdated = JSON.parse(runCli(["schedules", "add", scheduleAddPath, "--db", scheduleDb, "--confirm", "--json"]).stdout) as {
      created?: boolean;
      updated?: boolean;
      dryRun?: boolean;
    };
    assert(scheduleUpdated.created === false && scheduleUpdated.updated === true && scheduleUpdated.dryRun === false, "CLI schedules add --confirm should update the schedule");

    const prompt = "do not leak this release smoke prompt";
    const dryRun = runCli(["run", "--workspace", workspace, "--prompt", prompt, "--dry-run", "--json"], {
      BUILDER_GEAR_CODEX_BIN: process.execPath
    });
    const dryRunInvocation = JSON.parse(dryRun.stdout) as { bin?: string; args?: string[]; redacted?: boolean };
    assert(dryRunInvocation.redacted === true, "CLI dry-run should redact local paths by default");
    assert(dryRunInvocation.bin === "[LOCAL_PATH]", "CLI dry-run should redact local executable paths by default");
    assert(!dryRun.stdout.includes(prompt), "CLI dry-run printed prompt text");
    assert(!dryRun.stdout.includes(process.execPath), "CLI dry-run printed the local Codex executable path");
    assert(!dryRun.stdout.includes(canonicalWorkspace), "CLI dry-run printed the local workspace path");
    assert(Array.isArray(dryRunInvocation.args), "CLI dry-run did not print invocation args");
    assert(dryRunInvocation.args.at(-1) === "-", "CLI dry-run should pass the prompt through stdin");
    assert(
      dryRunInvocation.args.slice(0, 8).join("\0") === [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--cd",
        "[LOCAL_PATH]",
        "--sandbox",
        "workspace-write"
      ].join("\0"),
      "CLI dry-run no longer matches the supported Codex exec argument order"
    );

    const unsafeDryRun = runCli(["run", "--workspace", workspace, "--prompt", prompt, "--dry-run", "--unsafe-show-paths"], {
      BUILDER_GEAR_CODEX_BIN: process.execPath
    });
    const unsafeDryRunInvocation = JSON.parse(unsafeDryRun.stdout) as { bin?: string; args?: string[]; redacted?: boolean };
    assert(unsafeDryRunInvocation.redacted === false, "CLI dry-run --unsafe-show-paths should disclose exact local paths");
    assert(unsafeDryRunInvocation.bin === process.execPath, "CLI dry-run --unsafe-show-paths did not honor BUILDER_GEAR_CODEX_BIN");
    assert(!unsafeDryRun.stdout.includes(prompt), "CLI unsafe dry-run printed prompt text");
    assert(Array.isArray(unsafeDryRunInvocation.args), "CLI unsafe dry-run did not print invocation args");
    assert(
      matchesCodexExecPrefix(unsafeDryRunInvocation.args, canonicalWorkspace),
      `CLI unsafe dry-run no longer matches the supported Codex exec argument order: ${JSON.stringify(unsafeDryRunInvocation.args.slice(0, 8))}`
    );
    verifyInstalledCodexParser(unsafeDryRunInvocation.args);
    verifyPackedCliInstall(tempRoot);

    console.log("Built CLI smoke test passed.");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verifyPackedCliInstall(tempRoot: string) {
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "packed-install");
  const installedWorkspace = path.join(tempRoot, "packed-workspace");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  verifyPackedPackageContents(packWorkspacePackage("@builder/core", "builder-core-", packDir), {
    label: "core",
    requiredEntries: ["package/dist/index.js", "package/dist/browser.js"]
  });
  const tarball = packWorkspacePackage("@builder/cli", "builder-cli-", packDir);
  verifyPackedPackageContents(tarball, {
    label: "CLI",
    requiredEntries: ["package/dist/index.js"]
  });

  runCommand(commandName("npm"), ["init", "-y"], installDir);
  runCommand(commandName("npm"), ["install", tarball], installDir);

  const installedPackageDir = path.join(installDir, "node_modules", "@builder", "cli");
  const installedCliJs = path.join(installedPackageDir, "dist", "index.js");
  assert(existsSync(installedCliJs), "packed CLI install is missing dist/index.js");
  const installedCliSource = readFileSync(installedCliJs, "utf8");
  assert(!installedCliSource.includes("sourceMappingURL"), "packed CLI install should not reference sourcemaps");
  assert(!installedCliSource.includes("sourcesContent"), "packed CLI install should not include source map source content");
  assert(!existsSync(path.join(installedPackageDir, "src", "index.ts")), "packed CLI install should not include source files");
  assert(!existsSync(path.join(installedPackageDir, "src", "index.test.ts")), "packed CLI install should not include test files");

  const version = runCommand(commandName("npx"), ["builder", "--version"], installDir);
  assert(version.stdout.trim() === cliPackageVersion, `packed CLI version smoke failed: ${version.stdout.trim()}`);

  const init = runCommand(commandName("npx"), ["builder", "init", "--workspace", installedWorkspace, "--json"], installDir);
  const initResult = JSON.parse(init.stdout) as { files?: Array<{ status: string }> };
  assert(initResult.files?.every((file) => file.status === "created"), "packed CLI init did not create a starter workspace");

  const dryRun = runCommand(commandName("npx"), [
    "builder",
    "run",
    "--workspace",
    installedWorkspace,
    "--prompt",
    "packed smoke prompt",
    "--dry-run",
    "--json"
  ], installDir, {
    BUILDER_GEAR_CODEX_BIN: process.execPath
  });
  const dryRunInvocation = JSON.parse(dryRun.stdout) as { args?: string[]; redacted?: boolean };
  assert(dryRunInvocation.redacted === true, "packed CLI dry-run should redact paths by default");
  assert(dryRunInvocation.args?.at(-1) === "-", "packed CLI dry-run should pass the prompt through stdin");
  assert(!dryRun.stdout.includes("packed smoke prompt"), "packed CLI dry-run printed prompt text");
  assert(!dryRun.stdout.includes(installedWorkspace), "packed CLI dry-run printed workspace path");
}

function packWorkspacePackage(filter: string, tarballPrefix: string, packDir: string) {
  runCommand(commandName("pnpm"), ["--filter", filter, "pack", "--pack-destination", packDir], rootDir);
  const tarball = readdirSync(packDir)
    .filter((name) => name.startsWith(tarballPrefix) && name.endsWith(".tgz"))
    .map((name) => path.join(packDir, name))
    .sort()
    .at(-1);
  assert(tarball, `${filter} pack smoke did not produce a tarball`);
  return tarball;
}

function verifyPackedPackageContents(
  tarball: string,
  options: { label: string; requiredEntries: string[] }
) {
  const tarballListing = runCommand("tar", ["-tf", tarball], path.dirname(tarball)).stdout
    .split(/\r?\n/)
    .filter(Boolean);

  for (const entry of options.requiredEntries) {
    assert(tarballListing.includes(entry), `packed ${options.label} tarball is missing ${entry}`);
  }
  assert(tarballListing.every((entry) => !entry.endsWith(".map")), `packed ${options.label} tarball should not include sourcemaps`);
  assert(tarballListing.every((entry) => !entry.startsWith("package/src/")), `packed ${options.label} tarball should not include source files`);

  for (const entry of tarballListing.filter((value) => value.endsWith(".js"))) {
    const source = runCommand("tar", ["-xOf", tarball, entry], path.dirname(tarball)).stdout;
    assert(!source.includes("sourceMappingURL"), `packed ${options.label} ${entry} should not reference sourcemaps`);
    assert(!source.includes("sourcesContent"), `packed ${options.label} ${entry} should not include source map source content`);
  }
}

function verifyInstalledCodexParser(args: string[]) {
  const version = spawnSync("codex", ["--version"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (version.status !== 0) {
    console.warn("Skipping installed Codex parser smoke: codex CLI is not on PATH.");
    return;
  }

  const parseOnlyArgs = [...args.slice(0, -1), "--help"];
  const parsed = spawnSync("codex", parseOnlyArgs, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env
  });

  if (parsed.status !== 0) {
    throw new Error([
      "Installed Codex CLI rejected Builder Gear's invocation shape.",
      `codex version: ${version.stdout.trim() || version.stderr.trim()}`,
      `args: ${parseOnlyArgs.join(" ")}`,
      `stdout: ${parsed.stdout.trim()}`,
      `stderr: ${parsed.stderr.trim()}`
    ].join("\n"));
  }

  assert(
    parsed.stdout.includes("Run Codex non-interactively"),
    "Installed Codex parser smoke did not reach the exec command help"
  );
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: shouldRunThroughShell(command),
    env: {
      ...process.env,
      ...env
    }
  });
  const stdout = outputText(result.stdout);
  const stderr = outputText(result.stderr);

  if (result.error || result.status !== 0) {
    throw new Error([
      `CLI smoke command failed: ${command} ${args.join(" ")}`,
      `cwd: ${cwd}`,
      `exit code: ${result.status ?? "unknown"}`,
      result.error ? `spawn error: ${result.error.message}` : undefined,
      `stdout: ${stdout.trim()}`,
      `stderr: ${stderr.trim()}`
    ].filter(Boolean).join("\n"));
  }

  return { ...result, stdout, stderr };
}

function commandName(name: string) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function shouldRunThroughShell(command: string) {
  return process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
}

function outputText(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      INIT_CWD: rootDir
    }
  });

  if (result.status !== 0) {
    throw new Error([
      `CLI smoke command failed: node ${path.relative(rootDir, cliPath)} ${args.join(" ")}`,
      `exit code: ${result.status ?? "unknown"}`,
      `stdout: ${result.stdout.trim()}`,
      `stderr: ${result.stderr.trim()}`
    ].join("\n"));
  }

  return result;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function matchesCodexExecPrefix(args: string[], workspacePath: string) {
  return args.length >= 8
    && args[0] === "--ask-for-approval"
    && args[1] === "never"
    && args[2] === "exec"
    && args[3] === "--json"
    && args[4] === "--cd"
    && samePathForCurrentPlatform(args[5] ?? "", workspacePath)
    && args[6] === "--sandbox"
    && args[7] === "workspace-write";
}

function samePathForCurrentPlatform(actual: string, expected: string) {
  const actualPath = comparablePath(actual);
  const expectedPath = comparablePath(expected);

  if (process.platform !== "win32") {
    return actualPath === expectedPath;
  }

  return actualPath.toLowerCase() === expectedPath.toLowerCase();
}

function comparablePath(value: string) {
  try {
    return normalizePathForComparison(realpathSync.native(path.resolve(value)));
  } catch {
    return normalizePathForComparison(path.resolve(value));
  }
}

function normalizePathForComparison(value: string) {
  const normalized = path.normalize(value);

  if (process.platform !== "win32") {
    return normalized;
  }

  return normalized.replace(/^\\\\\?\\/, "").replace(/\//g, "\\");
}

function readPackageJson(relativePath: string): { version?: string } {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8")) as { version?: string };
}

function requirePackageVersion(packageJson: { version?: string }, label: string): string {
  const version = packageJson.version?.trim();

  if (!version) {
    throw new Error(`${label} version is required`);
  }

  return version;
}
