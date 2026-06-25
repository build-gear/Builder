#!/usr/bin/env tsx
import { lstatSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCheckedBinaryFile,
  safeErrorMessage as safeScriptErrorMessage
} from "./script-file-safety.js";
import {
  DEFAULT_REPOSITORY_PRIVACY_SCAN_MAX_BYTES,
  validateRepositoryPrivacyScanCoverage,
  validateRepositorySourceTree
} from "../packages/core/src/release-check.js";

interface Finding {
  path: string;
  line: number;
  label: string;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "release-candidate-artifact",
  "target",
  "test-results"
]);
const ignoredPathPrefixes = [
  ".builder/",
  "apps/desktop/dist/",
  "apps/desktop/src-tauri/target/"
];
const maxScannedBytes = DEFAULT_REPOSITORY_PRIVACY_SCAN_MAX_BYTES;

const findings: Finding[] = [];
const scanErrors: string[] = [];
const sourceTreeErrors = validateRepositorySourceTree(rootDir, {
  ignoredDirectories: [...ignoredDirectories],
  ignoredPathPrefixes
});
const coverageErrors = validateRepositoryPrivacyScanCoverage(rootDir, {
  ignoredDirectories: [...ignoredDirectories],
  ignoredPathPrefixes,
  maxScannedBytes
});
const repositoryFiles = collectRepositoryFiles(rootDir);
const patterns = sensitivePatterns();

for (const relativePath of repositoryFiles) {
  const absolutePath = path.join(rootDir, relativePath);
  let metadata;
  try {
    metadata = lstatSync(absolutePath);
  } catch (error) {
    scanErrors.push(`${relativePath}: could not be inspected: ${safeErrorMessage(error)}`);
    continue;
  }

  if (!metadata.isFile() || metadata.size > maxScannedBytes) {
    continue;
  }

  let bytes: Buffer;
  try {
    bytes = readCheckedBinaryFile(absolutePath, `privacy scan input ${relativePath}`, maxScannedBytes);
  } catch (error) {
    scanErrors.push(`${relativePath}: could not be scanned: ${safeErrorMessage(error)}`);
    continue;
  }

  if (bytes.includes(0)) {
    continue;
  }

  const source = bytes.toString("utf8");
  for (const { label, pattern } of patterns) {
    const match = source.match(pattern);
    if (match?.index !== undefined) {
      findings.push({
        path: relativePath,
        line: lineNumberAt(source, match.index),
        label
      });
    }
  }
}

if (sourceTreeErrors.length > 0 || coverageErrors.length > 0 || scanErrors.length > 0 || findings.length > 0) {
  for (const error of [...sourceTreeErrors, ...coverageErrors, ...scanErrors]) {
    console.error(`privacy scan: ${error}`);
  }
  for (const finding of findings) {
    console.error(`privacy scan: ${finding.path}:${finding.line}: ${finding.label}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Privacy scan passed for ${repositoryFiles.length} repository files.`);
}

function collectRepositoryFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

    if (ignoredPathPrefixes.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...collectRepositoryFiles(absolutePath));
      }
      continue;
    }

    if (entry.isFile() && !relativePath.endsWith(".tgz")) {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function sensitivePatterns(): Array<{ label: string; pattern: RegExp }> {
  const patterns: Array<{ label: string; pattern: RegExp }> = [
    { label: "OpenAI-style secret key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
    { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{32,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
    { label: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { label: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/ }
  ];

  const homePath = os.homedir();
  for (const candidate of [rootDir, homePath]) {
    if (candidate && candidate !== path.parse(candidate).root) {
      patterns.push({
        label: "developer-machine absolute path",
        pattern: new RegExp(escapeRegExp(candidate), "g")
      });
    }
  }

  for (const secretValue of secretEnvironmentValues()) {
    patterns.push({
      label: "current environment secret value",
      pattern: new RegExp(escapeRegExp(secretValue), "g")
    });
  }

  return patterns;
}

function secretEnvironmentValues(): string[] {
  const values = new Set<string>();
  const secretNamePattern = /(?:TOKEN|SECRET|PASSWORD|PRIVATE|CERTIFICATE|API_?KEY|AUTH)/i;

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 12 || !secretNamePattern.test(key)) {
      continue;
    }
    if (isPlaceholderSecretValue(value)) {
      continue;
    }
    values.add(value);
  }

  return [...values].sort((left, right) => right.length - left.length);
}

function isPlaceholderSecretValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return /^(true|false|none|null|undefined|changeme|placeholder)$/i.test(value) ||
    /^<[^>]+>$/.test(normalized) ||
    /^\$\{[^}]+}$/.test(normalized) ||
    /^(?:todo|tbd|replace-me|replace_me|dummy|example|sample|test)$/.test(normalized) ||
    /^(?:your|insert|replace)[\s_-]/.test(normalized);
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeErrorMessage(error: unknown): string {
  return safeScriptErrorMessage(rootDir, error);
}
