import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  ensureWorkspaceChildDirForWrite,
  resolveExistingWorkspaceRoot,
  workspaceChildDirForRead,
  isNotFoundError
} from "./fs-safety.js";

export const WORKSPACE_BACKUPS_DIR = ".builder/backups";
const NO_FOLLOW_OPEN_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export interface WorkspaceBackupSummary {
  name: string;
  relativePath: string;
  kind: string;
  createdAt?: string;
  sizeBytes: number;
  entryCount: number;
  directory: boolean;
  targetRelativePath?: string;
}

export interface RestoreWorkspaceBackupResult {
  restored: WorkspaceBackupSummary;
  targetRelativePath: string;
  preRestoreBackup?: WorkspaceBackupSummary;
}

export interface PruneWorkspaceBackupsOptions {
  keep: number;
  dryRun?: boolean;
}

export interface PruneWorkspaceBackupsResult {
  keep: number;
  dryRun: boolean;
  retained: WorkspaceBackupSummary[];
  candidates: WorkspaceBackupSummary[];
  pruned: WorkspaceBackupSummary[];
}

const BACKUP_KINDS = [
  "schedules-save",
  "ontology-save",
  "skill-save",
  "skill-delete",
  "restore-preimage"
] as const;

export async function listWorkspaceBackups(workspacePath: string): Promise<WorkspaceBackupSummary[]> {
  const workspace = await resolveExistingWorkspaceRoot(workspacePath);
  const backupsDir = await workspaceChildDirForRead(workspace, WORKSPACE_BACKUPS_DIR, "workspace backups");

  if (!backupsDir) {
    return [];
  }

  const summaries: WorkspaceBackupSummary[] = [];
  for (const entry of await readdir(backupsDir, { withFileTypes: true })) {
    const backupPath = path.join(backupsDir, entry.name);
    const metadata = await lstat(backupPath);

    if (metadata.isSymbolicLink()) {
      throw new Error(`workspace backup must not be a symlink: ${entry.name}`);
    }

    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new Error(`workspace backup is not a regular file or directory: ${entry.name}`);
    }

    const [sizeBytes, entryCount] = metadata.isDirectory()
      ? await summarizeBackupDirectory(backupPath)
      : [metadata.size, 1];
    summaries.push({
      name: entry.name,
      relativePath: relativeWorkspacePath(workspace, backupPath),
      kind: backupKind(entry.name),
      createdAt: backupCreatedAt(entry.name),
      sizeBytes,
      entryCount,
      directory: metadata.isDirectory(),
      targetRelativePath: targetRelativePathFromBackupName(entry.name)
    });
  }

  return summaries.sort((left, right) => {
    const created = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
    return created || right.name.localeCompare(left.name);
  });
}

export async function restoreWorkspaceBackup(
  workspacePath: string,
  backupName: string
): Promise<RestoreWorkspaceBackupResult> {
  const workspace = await resolveExistingWorkspaceRoot(workspacePath);
  validateBackupName(backupName);
  const backups = await listWorkspaceBackups(workspace);
  const restored = backups.find((backup) => backup.name === backupName);

  if (!restored) {
    throw new Error(`workspace backup not found: ${backupName}`);
  }

  const parsed = parseBackupName(backupName);
  const targetRelativePath = targetRelativePathFromParsedBackup(parsed, restored.directory);
  const backupPath = path.join(workspace, restored.relativePath);
  const targetPath = path.join(workspace, targetRelativePath);
  const preRestoreBackup = await snapshotCurrentTargetForRestore(workspace, targetPath);

  if (restored.directory) {
    await restoreDirectoryBackup(workspace, backupPath, targetPath);
  } else {
    await restoreFileBackup(workspace, backupPath, targetPath);
  }

  return {
    restored,
    targetRelativePath,
    preRestoreBackup
  };
}

export async function pruneWorkspaceBackups(
  workspacePath: string,
  options: PruneWorkspaceBackupsOptions
): Promise<PruneWorkspaceBackupsResult> {
  if (!Number.isInteger(options.keep) || options.keep < 0) {
    throw new Error("backup prune keep count must be a non-negative integer");
  }

  const workspace = await resolveExistingWorkspaceRoot(workspacePath);
  const dryRun = options.dryRun ?? true;
  const backups = await listWorkspaceBackups(workspace);
  const retained = backups.slice(0, options.keep);
  const candidates = backups.slice(options.keep);
  const pruned: WorkspaceBackupSummary[] = [];

  if (!dryRun) {
    for (const candidate of candidates) {
      await removeWorkspaceBackupEntry(workspace, candidate);
      pruned.push(candidate);
    }
  }

  return {
    keep: options.keep,
    dryRun,
    retained,
    candidates,
    pruned
  };
}

async function summarizeBackupDirectory(directoryPath: string): Promise<[number, number]> {
  let sizeBytes = 0;
  let entryCount = 0;

  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const childPath = path.join(directoryPath, entry.name);
    const metadata = await lstat(childPath);

    if (metadata.isSymbolicLink()) {
      throw new Error(`workspace backup entry must not be a symlink: ${childPath}`);
    }

    if (metadata.isDirectory()) {
      const [childSizeBytes, childEntryCount] = await summarizeBackupDirectory(childPath);
      sizeBytes += childSizeBytes;
      entryCount += childEntryCount;
    } else if (metadata.isFile()) {
      sizeBytes += metadata.size;
      entryCount += 1;
    } else {
      throw new Error(`workspace backup entry is not a regular file or directory: ${childPath}`);
    }
  }

  return [sizeBytes, entryCount];
}

async function removeWorkspaceBackupEntry(workspace: string, backup: WorkspaceBackupSummary): Promise<void> {
  const backupPath = path.join(workspace, backup.relativePath);
  const backupsRoot = path.join(workspace, WORKSPACE_BACKUPS_DIR);
  const relative = path.relative(backupsRoot, backupPath);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`backup entry must stay inside ${WORKSPACE_BACKUPS_DIR}`);
  }

  const metadata = await lstat(backupPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`workspace backup must not be a symlink: ${backup.name}`);
  }

  if (metadata.isDirectory()) {
    await rm(backupPath, { recursive: true });
  } else if (metadata.isFile()) {
    await rm(backupPath);
  } else {
    throw new Error(`workspace backup is not a regular file or directory: ${backup.name}`);
  }
}

async function snapshotCurrentTargetForRestore(
  workspace: string,
  targetPath: string
): Promise<WorkspaceBackupSummary | undefined> {
  const metadata = await lstat(targetPath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });

  if (!metadata) {
    return undefined;
  }

  if (metadata.isSymbolicLink()) {
    throw new Error(`restore target must not be a symlink: ${targetPath}`);
  }

  const backupsDir = await ensureWorkspaceChildDirForWrite(workspace, WORKSPACE_BACKUPS_DIR, "workspace backups");
  const backupName = workspaceBackupName(workspace, targetPath, "restore-preimage");
  const backupPath = path.join(backupsDir, backupName);

  if (metadata.isDirectory()) {
    await copyDirectoryRejectingSymlinks(targetPath, backupPath);
  } else if (metadata.isFile()) {
    await copyFileRejectingSymlinks(targetPath, backupPath);
  } else {
    throw new Error(`restore target is not a regular file or directory: ${targetPath}`);
  }

  return (await listWorkspaceBackups(workspace)).find((backup) => backup.name === backupName);
}

async function restoreFileBackup(workspace: string, backupPath: string, targetPath: string): Promise<void> {
  await prepareRestoreParent(workspace, targetPath);
  await rejectSymlinkedPath(targetPath, "restore target");

  const tempPath = `${targetPath}.restore-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const stagedPath = `${targetPath}.restore-staged-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let staged = false;

  await copyFileRejectingSymlinks(backupPath, tempPath);
  try {
    const metadata = await lstat(targetPath).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });

    if (metadata) {
      if (!metadata.isFile()) {
        throw new Error(`restore target is not a file: ${targetPath}`);
      }
      await rename(targetPath, stagedPath);
      staged = true;
    }

    await rename(tempPath, targetPath);
    if (staged) {
      await rm(stagedPath, { force: true });
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (staged) {
      await rename(stagedPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function restoreDirectoryBackup(workspace: string, backupPath: string, targetPath: string): Promise<void> {
  await prepareRestoreParent(workspace, targetPath);
  await ensureBackupDirectory(backupPath);
  await rejectSymlinkedPath(targetPath, "restore target");

  const tempPath = `${targetPath}.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagedPath = `${targetPath}.restore-staged-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let staged = false;

  await copyDirectoryRejectingSymlinks(backupPath, tempPath);
  try {
    const metadata = await lstat(targetPath).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });

    if (metadata) {
      if (!metadata.isDirectory()) {
        throw new Error(`restore target is not a directory: ${targetPath}`);
      }
      await rename(targetPath, stagedPath);
      staged = true;
    }

    await rename(tempPath, targetPath);
    if (staged) {
      await rm(stagedPath, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
    if (staged) {
      await rename(stagedPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function prepareRestoreParent(workspace: string, targetPath: string): Promise<void> {
  const relativeParent = path.relative(workspace, path.dirname(targetPath));

  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error("restore target must stay inside the workspace");
  }

  await ensureWorkspaceChildDirForWrite(workspace, relativeParent, "restore target parent");
}

async function copyDirectoryRejectingSymlinks(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);

  if (metadata.isSymbolicLink()) {
    throw new Error(`workspace backup source must not be a symlink: ${source}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`workspace backup source is not a directory: ${source}`);
  }

  await mkdir(destination);

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const entryMetadata = await lstat(sourcePath);

    if (entryMetadata.isSymbolicLink()) {
      throw new Error(`workspace backup entry must not be a symlink: ${sourcePath}`);
    }

    if (entryMetadata.isDirectory()) {
      await copyDirectoryRejectingSymlinks(sourcePath, destinationPath);
    } else if (entryMetadata.isFile()) {
      await copyFileRejectingSymlinks(sourcePath, destinationPath);
    } else {
      throw new Error(`workspace backup entry is not a regular file or directory: ${sourcePath}`);
    }
  }
}

async function copyFileRejectingSymlinks(source: string, destination: string): Promise<void> {
  const sourceMetadata = await lstat(source);

  if (sourceMetadata.isSymbolicLink()) {
    throw new Error(`workspace backup source must not be a symlink: ${source}`);
  }
  if (!sourceMetadata.isFile()) {
    throw new Error(`workspace backup source is not a file: ${source}`);
  }

  const sourceHandle = await open(source, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG).catch((error: unknown) => {
    throw new Error(`failed to open workspace backup source without following symlinks: ${errorMessage(error)}`);
  });
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const metadata = await sourceHandle.stat();
    if (!metadata.isFile()) {
      throw new Error(`workspace backup source is not a file: ${source}`);
    }
    if (fileIdentityChanged(sourceMetadata, metadata)) {
      throw new Error(`workspace backup source changed while opening: ${source}`);
    }

    destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, metadata.mode);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      await destinationHandle.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
    await destinationHandle.sync();
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await destinationHandle?.close().catch(() => undefined);
  }
}

async function ensureBackupDirectory(backupPath: string): Promise<void> {
  const metadata = await lstat(backupPath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`workspace backup must not be a symlink: ${backupPath}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`workspace backup is not a directory: ${backupPath}`);
  }
}

async function rejectSymlinkedPath(targetPath: string, label: string): Promise<void> {
  const metadata = await lstat(targetPath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });

  if (metadata?.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${targetPath}`);
  }
}

function parseBackupName(name: string): { timestamp: string; kind: string; targetSlug: string } {
  for (const kind of BACKUP_KINDS) {
    const pattern = new RegExp(`^(\\d{8}T\\d{6}Z)-\\d+-${escapeRegExp(kind)}-(.+)$`);
    const match = pattern.exec(name);

    if (match) {
      return {
        timestamp: match[1] ?? "",
        kind,
        targetSlug: match[2] ?? ""
      };
    }
  }

  throw new Error(`unsupported workspace backup name: ${name}`);
}

function targetRelativePathFromBackupName(name: string): string | undefined {
  try {
    return targetRelativePathFromParsedBackup(parseBackupName(name), undefined);
  } catch {
    return undefined;
  }
}

function targetRelativePathFromParsedBackup(
  parsed: { kind: string; targetSlug: string },
  directory: boolean | undefined
): string {
  if (parsed.targetSlug === ".builder-schedules.json" && directory !== true) {
    return path.join(".builder", "schedules.json");
  }

  if (parsed.targetSlug === "ontology-builder-gear.json" && directory !== true) {
    return path.join("ontology", "builder-gear.json");
  }

  if (parsed.targetSlug.startsWith("skills-") && directory !== false) {
    const skillId = parsed.targetSlug.slice("skills-".length);
    if (skillId && /^[A-Za-z0-9_-]+$/.test(skillId)) {
      return path.join("skills", skillId);
    }
  }

  throw new Error(`unsupported workspace backup target: ${parsed.targetSlug}`);
}

function validateBackupName(name: string): void {
  if (!name.trim()) {
    throw new Error("backup name is required");
  }

  if (name !== path.basename(name) || /[\\/]/.test(name)) {
    throw new Error("backup name must not contain path separators");
  }
}

function backupKind(name: string): string {
  try {
    return parseBackupName(name).kind;
  } catch {
    return "unknown";
  }
}

function backupCreatedAt(name: string): string | undefined {
  const timestamp = /^(\d{8})T(\d{6})Z/.exec(name);

  if (!timestamp) {
    return undefined;
  }

  const date = timestamp[1];
  const time = timestamp[2];
  if (!date || !time) {
    return undefined;
  }

  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function workspaceBackupName(workspace: string, source: string, operation: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const relative = path.relative(workspace, source).split(path.sep).join("-");
  const safeRelative = relative
    .split("")
    .map((character) => /[A-Za-z0-9_.-]/.test(character) ? character : "-")
    .join("")
    .replace(/^-+|-+$/g, "") || "workspace";
  const safeOperation = operation
    .split("")
    .map((character) => /[A-Za-z0-9_-]/.test(character) ? character : "-")
    .join("");

  return `${timestamp}-${nonce}-${safeOperation}-${safeRelative}`;
}

function relativeWorkspacePath(workspace: string, backupPath: string): string {
  return path.relative(workspace, backupPath).split(path.sep).join("/");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
