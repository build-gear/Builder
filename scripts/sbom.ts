#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCycloneDxSbom } from "../packages/core/src/release-check.js";
import { collectDependencyLicenseEntries } from "./license-data.js";
import {
  readRepoJsonFile,
  readRepoTextFile,
  safeErrorMessage,
  writeGeneratedRepoTextFile
} from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sbomRelativePath = "release/SBOM.cdx.json";
const checkOnly = process.argv.includes("--check");

main();

function main() {
  try {
    const rootPackage = readRepoJsonFile<{ version?: string }>(rootDir, "package.json", "root package");
    const rootVersion = requirePackageVersion(rootPackage, "root package");
    const sbom = renderCycloneDxSbom(collectDependencyLicenseEntries(rootDir), {
      productName: "Builder Gear",
      version: rootVersion
    });

    if (checkOnly) {
      const current = readRepoTextFile(rootDir, sbomRelativePath, "SBOM");
      if (current !== sbom) {
        console.error("sbom: release/SBOM.cdx.json is stale; run pnpm sbom:generate");
        process.exitCode = 1;
      } else {
        console.log("SBOM is current.");
      }
    } else {
      const sbomPath = writeGeneratedRepoTextFile(rootDir, sbomRelativePath, sbom, "SBOM");
      console.log(`SBOM written to ${path.relative(rootDir, sbomPath).split(path.sep).join("/")}`);
    }
  } catch (error) {
    console.error(`sbom: ${safeErrorMessage(rootDir, error)}`);
    process.exitCode = 1;
  }
}

function requirePackageVersion(packageJson: { version?: string }, label: string): string {
  const version = packageJson.version?.trim();

  if (!version) {
    throw new Error(`${label} version is required`);
  }

  return version;
}
