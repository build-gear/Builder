#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateDependencyLicenses,
  type LicensePolicy
} from "../packages/core/src/release-check.js";
import { collectDependencyLicenseEntries } from "./license-data.js";
import { readRepoJsonFile, safeErrorMessage } from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  try {
    const policy = readRepoJsonFile<LicensePolicy>(rootDir, "release/license-policy.json", "license policy");
    const entries = collectDependencyLicenseEntries(rootDir);
    const errors = validateDependencyLicenses(entries, policy);

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`license policy: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const ecosystems = new Map<string, number>();
    for (const entry of entries) {
      ecosystems.set(entry.ecosystem, (ecosystems.get(entry.ecosystem) ?? 0) + 1);
    }
    const summary = [...ecosystems.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([ecosystem, count]) => `${ecosystem} ${count}`)
      .join(", ");

    console.log(`License policy passed for ${entries.length} dependencies (${summary}).`);
  } catch (error) {
    console.error(`license policy: ${safeErrorMessage(rootDir, error)}`);
    process.exitCode = 1;
  }
}
