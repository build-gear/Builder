import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const MAX_SCRIPT_TEXT_FILE_BYTES = 2_097_152;

export function readRepoTextFile(
  rootDir: string,
  relativePath: string,
  label: string,
  maxBytes = MAX_SCRIPT_TEXT_FILE_BYTES
): string {
  return readCheckedTextFile(resolveRepoPath(rootDir, relativePath), label, maxBytes);
}

export function readRepoJsonFile<T>(
  rootDir: string,
  relativePath: string,
  label: string,
  maxBytes = MAX_SCRIPT_TEXT_FILE_BYTES
): T {
  return JSON.parse(readRepoTextFile(rootDir, relativePath, label, maxBytes)) as T;
}

export function readCheckedTextFile(filePath: string, label: string, maxBytes = MAX_SCRIPT_TEXT_FILE_BYTES): string {
  return readCheckedFile(filePath, label, maxBytes).toString("utf8");
}

export function readCheckedBinaryFile(filePath: string, label: string, maxBytes = MAX_SCRIPT_TEXT_FILE_BYTES): Buffer {
  return readCheckedFile(filePath, label, maxBytes);
}

function readCheckedFile(filePath: string, label: string, maxBytes: number): Buffer {
  const metadata = lstatSync(filePath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }

  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
  }

  return readFileSync(filePath);
}

export function readCheckedJsonFile<T>(filePath: string, label: string, maxBytes = MAX_SCRIPT_TEXT_FILE_BYTES): T {
  return JSON.parse(readCheckedTextFile(filePath, label, maxBytes)) as T;
}

export function writeGeneratedRepoTextFile(
  rootDir: string,
  relativePath: string,
  body: string,
  label: string
): string {
  return writeGeneratedRepoFile(rootDir, relativePath, body, label);
}

export function writeGeneratedRepoBinaryFile(
  rootDir: string,
  relativePath: string,
  body: Uint8Array,
  label: string
): string {
  return writeGeneratedRepoFile(rootDir, relativePath, body, label);
}

export function writeGeneratedRepoFile(
  rootDir: string,
  relativePath: string,
  body: string | Uint8Array,
  label: string
): string {
  const outputPath = resolveRepoPath(rootDir, relativePath);
  ensureSafeParentDirectory(rootDir, outputPath, label);
  rejectUnsafeExistingOutput(outputPath, label, false);

  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  rejectUnsafeExistingOutput(tempPath, `${label} temporary file`, true);

  try {
    writeFileSync(tempPath, body);
    renameSync(tempPath, outputPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }

  return outputPath;
}

export function ensureGeneratedRepoDirectory(rootDir: string, relativePath: string, label: string): string {
  const directoryPath = resolveRepoPath(rootDir, relativePath);
  ensureSafeParentDirectory(rootDir, directoryPath, label);

  try {
    const metadata = lstatSync(directoryPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} must be a directory`);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      mkdirSync(directoryPath);
    } else {
      throw error;
    }
  }

  return directoryPath;
}

export function prepareGeneratedRepoDirectory(rootDir: string, relativePath: string, label: string): string {
  const directoryPath = resolveRepoPath(rootDir, relativePath);
  ensureSafeParentDirectory(rootDir, directoryPath, label);

  try {
    const metadata = lstatSync(directoryPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} must be a directory`);
    }
    rmSync(directoryPath, { recursive: true, force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  mkdirSync(directoryPath);

  return directoryPath;
}

export function removeGeneratedRepoDirectory(rootDir: string, relativePath: string, label: string): void {
  const directoryPath = resolveRepoPath(rootDir, relativePath);

  try {
    const metadata = lstatSync(directoryPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} must be a directory`);
    }
    rmSync(directoryPath, { recursive: true, force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

export function removeGeneratedRepoFile(rootDir: string, relativePath: string, label: string): void {
  const filePath = resolveRepoPath(rootDir, relativePath);

  try {
    const metadata = lstatSync(filePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    rmSync(filePath, { force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

export function ensureSafeRepoDirectory(rootDir: string, relativePath: string, label: string): string {
  const directoryPath = resolveRepoPath(rootDir, relativePath);
  const metadata = lstatSync(directoryPath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }

  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }

  return directoryPath;
}

export function resolveRepoPath(rootDir: string, relativePath: string): string {
  if (!relativePath.trim() || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("repository path must be relative");
  }

  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("repository path must stay inside the repository");
  }

  return resolved;
}

export function repoRelativePath(rootDir: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(rootDir), absolutePath).split(path.sep).join("/");

  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : "[REPO_EXTERNAL_PATH]";
}

export function safeErrorMessage(rootDir: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return safeExternalCommandOutput(rootDir, message);
}

export function safeExternalCommandOutput(rootDir: string, output: string): string {
  let redacted = output.replaceAll(path.resolve(rootDir), "[REPO_ROOT]");

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) {
      continue;
    }
    if (!/(SECRET|TOKEN|PASSWORD|PRIVATE|CERTIFICATE|KEY|APPLE|TAURI|UPDATER|GH|GITHUB)/i.test(key)) {
      continue;
    }
    redacted = redacted.split(value).join("[REDACTED_ENV_VALUE]");
  }

  return redacted
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

export function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensureSafeParentDirectory(rootDir: string, outputPath: string, label: string): void {
  const root = path.resolve(rootDir);
  const parent = path.dirname(outputPath);
  const parentRelative = path.relative(root, parent);

  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    throw new Error(`${label} parent must stay inside the repository`);
  }

  let current = root;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} parent must not contain symlinks: ${repoRelativePath(root, current)}`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`${label} parent must be a directory: ${repoRelativePath(root, current)}`);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        mkdirSync(current);
        continue;
      }
      throw error;
    }
  }
}

function rejectUnsafeExistingOutput(filePath: string, label: string, removeExisting: boolean): void {
  try {
    const metadata = lstatSync(filePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (removeExisting) {
      rmSync(filePath, { force: true });
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
