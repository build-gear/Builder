import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_REGULAR_TEXT_FILE_BYTES = 1_048_576;
const TEXT_READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW_OPEN_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export interface ReadRegularTextFileOptions {
  maxBytes?: number;
}

export async function ensureWorkspaceRootForWrite(workspacePath: string): Promise<string> {
  const resolvedWorkspacePath = path.resolve(workspacePath);

  try {
    await validateWorkspaceRoot(resolvedWorkspacePath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    await mkdir(resolvedWorkspacePath, { recursive: true });
    await validateWorkspaceRoot(resolvedWorkspacePath);
  }

  return realpath(resolvedWorkspacePath);
}

export async function resolveExistingWorkspaceRoot(workspacePath: string): Promise<string> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  await validateWorkspaceRoot(resolvedWorkspacePath);
  return realpath(resolvedWorkspacePath);
}

export async function resolveOptionalWorkspaceRootForRead(workspacePath: string): Promise<string | undefined> {
  const resolvedWorkspacePath = path.resolve(workspacePath);

  try {
    await validateWorkspaceRoot(resolvedWorkspacePath);
    return await realpath(resolvedWorkspacePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function ensureWorkspaceChildDirForWrite(
  workspacePath: string,
  relativePath: string,
  label: string
): Promise<string> {
  const childPath = path.join(workspacePath, relativePath);

  try {
    await validateDirectoryPath(workspacePath, childPath, label);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    await mkdir(childPath, { recursive: true });
    await validateDirectoryPath(workspacePath, childPath, label);
  }

  return childPath;
}

export async function workspaceChildDirForRead(
  workspacePath: string,
  relativePath: string,
  label: string
): Promise<string | undefined> {
  const childPath = path.join(workspacePath, relativePath);

  try {
    await validateDirectoryPath(workspacePath, childPath, label);
    return childPath;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function existingDirectoryForRead(
  directoryPath: string,
  label: string
): Promise<string | undefined> {
  try {
    const metadata = await lstat(directoryPath);

    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} directory must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} path exists but is not a directory`);
    }

    return directoryPath;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function ensurePathStaysInsideRoot(
  rootPath: string,
  candidatePath: string,
  label: string
): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(rootPath),
    realpath(candidatePath)
  ]);
  const relativePath = path.relative(realRoot, realCandidate);

  if (relativePath && (relativePath.startsWith("..") || path.isAbsolute(relativePath))) {
    throw new Error(`${label} path must stay inside ${realRoot}`);
  }
}

export async function readRegularTextFile(
  filePath: string,
  label: string,
  options: ReadRegularTextFileOptions = {}
): Promise<string> {
  const metadata = await lstat(filePath);
  const maxBytes = options.maxBytes ?? MAX_REGULAR_TEXT_FILE_BYTES;

  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`${label} maxBytes must be a non-negative integer`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${filePath}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
  }

  const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG).catch((error: unknown) => {
    throw new Error(`failed to open ${label} without following symlinks: ${filePath}: ${errorMessage(error)}`);
  });

  try {
    const openedMetadata = await handle.stat();

    if (!openedMetadata.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
    if (fileIdentityChanged(metadata, openedMetadata)) {
      throw new Error(`${label} changed while opening: ${filePath}`);
    }
    if (openedMetadata.size > maxBytes) {
      throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
    }

    return await readBoundedUtf8File(handle, maxBytes, label, filePath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readOptionalRegularTextFile(
  filePath: string,
  label: string,
  options: ReadRegularTextFileOptions = {}
): Promise<string | undefined> {
  try {
    return await readRegularTextFile(filePath, label, options);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function validateDirectoryPath(
  workspacePath: string,
  childPath: string,
  label: string
): Promise<void> {
  const metadata = await lstat(childPath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} directory must not be a symlink`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} path exists but is not a directory`);
  }

  await ensurePathStaysInsideRoot(workspacePath, childPath, label);
}

async function validateWorkspaceRoot(workspacePath: string): Promise<void> {
  const metadata = await lstat(workspacePath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`workspace path must not be a symlink: ${workspacePath}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`workspace path exists but is not a directory: ${workspacePath}`);
  }
}

async function readBoundedUtf8File(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  label: string,
  filePath: string
): Promise<string> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(TEXT_READ_CHUNK_BYTES, Math.max(1, maxBytes + 1)));
  let totalBytes = 0;
  let position = 0;

  while (true) {
    const readLength = Math.min(buffer.length, maxBytes + 1 - totalBytes);
    if (readLength <= 0) {
      throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
    }

    const { bytesRead } = await handle.read(buffer, 0, readLength, position);
    if (bytesRead === 0) {
      break;
    }

    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
    }

    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function fileIdentityChanged(before: Stats, after: Stats): boolean {
  if (!hasComparableIdentity(before) || !hasComparableIdentity(after)) {
    return false;
  }

  return before.dev !== after.dev || before.ino !== after.ino;
}

function hasComparableIdentity(metadata: Stats): boolean {
  return Number.isFinite(metadata.dev) &&
    Number.isFinite(metadata.ino) &&
    (metadata.dev !== 0 || metadata.ino !== 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
