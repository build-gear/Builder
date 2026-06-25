#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderThirdPartyNotices } from "../packages/core/src/release-check.js";
import { collectDependencyLicenseEntries } from "./license-data.js";
import {
  readRepoTextFile,
  safeErrorMessage,
  writeGeneratedRepoTextFile
} from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noticesRelativePath = "release/THIRD_PARTY_NOTICES.md";
const checkOnly = process.argv.includes("--check");

main();

function main() {
  try {
    const notices = renderThirdPartyNotices(collectDependencyLicenseEntries(rootDir));

    if (checkOnly) {
      const current = readRepoTextFile(rootDir, noticesRelativePath, "third-party notices");
      if (normalizeGeneratedText(current) !== notices) {
        console.error("license notices: release/THIRD_PARTY_NOTICES.md is stale; run pnpm license:notices");
        process.exitCode = 1;
      } else {
        console.log("Third-party notices are current.");
      }
    } else {
      const noticesPath = writeGeneratedRepoTextFile(rootDir, noticesRelativePath, notices, "third-party notices");
      console.log(`Third-party notices written to ${path.relative(rootDir, noticesPath).split(path.sep).join("/")}`);
    }
  } catch (error) {
    console.error(`license notices: ${safeErrorMessage(rootDir, error)}`);
    process.exitCode = 1;
  }
}

function normalizeGeneratedText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
