import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DependencyLicenseEntry } from "../packages/core/src/release-check.js";

export function collectDependencyLicenseEntries(rootDir: string): DependencyLicenseEntry[] {
  return [
    ...nodeLicenseEntries(rootDir),
    ...rustLicenseEntries(rootDir)
  ];
}

function nodeLicenseEntries(rootDir: string): DependencyLicenseEntry[] {
  const output = runCapture("pnpm", ["licenses", "list", "--json"], rootDir);
  const grouped = JSON.parse(output) as Record<string, Array<{
    name?: string;
    versions?: string[];
    license?: string;
    homepage?: string;
  }>>;
  const entries: DependencyLicenseEntry[] = [];

  for (const [license, packages] of Object.entries(grouped)) {
    for (const packageInfo of packages) {
      for (const version of packageInfo.versions ?? []) {
        entries.push({
          ecosystem: "node",
          name: packageInfo.name ?? "unknown",
          version,
          license: packageInfo.license ?? license,
          homepage: packageInfo.homepage
        });
      }
    }
  }

  return entries;
}

function rustLicenseEntries(rootDir: string): DependencyLicenseEntry[] {
  const output = runCapture("cargo", ["metadata", "--format-version", "1"], path.join(rootDir, "apps/desktop/src-tauri"));
  const metadata = JSON.parse(output) as {
    packages: Array<{
      name: string;
      version: string;
      license?: string | null;
      source?: string | null;
      repository?: string | null;
      homepage?: string | null;
    }>;
  };

  return metadata.packages
    .filter((packageInfo) => packageInfo.source)
    .map((packageInfo) => ({
      ecosystem: "rust" as const,
      name: packageInfo.name,
      version: packageInfo.version,
      license: packageInfo.license,
      source: packageInfo.source,
      repository: packageInfo.repository,
      homepage: packageInfo.homepage
    }));
}

function runCapture(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }

  return result.stdout;
}
