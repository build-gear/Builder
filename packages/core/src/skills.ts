import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  ensurePathStaysInsideRoot,
  existingDirectoryForRead,
  readRegularTextFile
} from "./fs-safety.js";
import type { SkillManifest } from "./types.js";

export interface LoadedSkill {
  manifest: SkillManifest;
  manifestPath: string;
  instructionsAbsolutePath: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeSkillManifest(raw: unknown): SkillManifest {
  const data = asObject(raw);
  const manifest: SkillManifest = {
    id: String(data.id ?? ""),
    name: String(data.name ?? ""),
    version: String(data.version ?? "0.1.0"),
    occupations: readStringArray(data.occupations),
    inputsJsonSchema: asObject(data.inputsJsonSchema ?? { type: "object", additionalProperties: true }),
    instructionsPath: String(data.instructionsPath ?? "instructions.md"),
    requiredTools: readStringArray(data.requiredTools),
    uiPanels: readStringArray(data.uiPanels),
    scheduleTemplates: Array.isArray(data.scheduleTemplates) ? (data.scheduleTemplates as SkillManifest["scheduleTemplates"]) : undefined
  };

  const errors = validateSkillManifest(manifest);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return manifest;
}

export function validateSkillManifest(manifest: SkillManifest): string[] {
  const errors: string[] = [];

  if (!manifest.id.trim()) {
    errors.push("skill id is required");
  } else if (!isPathSafeId(manifest.id)) {
    errors.push("skill id contains unsupported path characters");
  }

  if (!manifest.name.trim()) {
    errors.push("skill name is required");
  }

  if (!manifest.version.trim()) {
    errors.push("skill version is required");
  }

  if (!manifest.instructionsPath.trim()) {
    errors.push("instructionsPath is required");
  } else if (!isSafeRelativeInstructionPath(manifest.instructionsPath)) {
    errors.push("instructionsPath must stay inside the skill directory");
  }

  return errors;
}

function isPathSafeId(value: string): boolean {
  return [...value].every((character) => (
    /[A-Za-z0-9_-]/.test(character)
  ));
}

function isSafeRelativeInstructionPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");

  if (
    normalized === "." ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    normalized.startsWith("/") ||
    normalized.startsWith("../")
  ) {
    return false;
  }

  return normalized
    .split("/")
    .filter(Boolean)
    .every((segment) => segment !== "." && segment !== "..");
}

export async function loadSkillManifest(manifestPath: string): Promise<LoadedSkill> {
  const source = await readRegularTextFile(manifestPath, "skill manifest");
  const parsed = YAML.parse(source);
  const manifest = normalizeSkillManifest(parsed);
  const skillDirectory = path.dirname(manifestPath);
  const instructionsAbsolutePath = path.resolve(skillDirectory, manifest.instructionsPath);
  await ensurePathStaysInsideRoot(skillDirectory, instructionsAbsolutePath, "skill instructions");
  await readRegularTextFile(instructionsAbsolutePath, "skill instructions");

  return {
    manifest,
    manifestPath,
    instructionsAbsolutePath
  };
}

export async function discoverSkillManifests(rootDir: string): Promise<LoadedSkill[]> {
  const manifests: LoadedSkill[] = [];
  const safeRoot = await existingDirectoryForRead(rootDir, "skills");
  if (!safeRoot) {
    return manifests;
  }
  const skillsRoot = safeRoot;

  async function visit(currentDir: string, depth: number): Promise<void> {
    if (depth > 3) {
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`skill path must not be a symlink: ${absolutePath}`);
      }

      if (entry.isFile() && entry.name === "skill.yaml") {
        manifests.push(await loadSkillManifest(absolutePath));
      }

      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await ensurePathStaysInsideRoot(skillsRoot, absolutePath, "skill");
        await visit(absolutePath, depth + 1);
      }
    }
  }

  await visit(skillsRoot, 0);
  return manifests.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}
