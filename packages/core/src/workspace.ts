import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureWorkspaceChildDirForWrite, ensureWorkspaceRootForWrite } from "./fs-safety.js";

export interface PreparedWorkspaceFile {
  path: string;
  status: "created" | "existing";
}

export interface PreparedWorkspace {
  workspacePath: string;
  files: PreparedWorkspaceFile[];
}

const STARTER_BUILD_PLAN_SKILL = `id: build-plan
name: Build Plan
version: 0.1.0
occupations:
  - developer
  - operator
  - designer
inputsJsonSchema:
  type: object
  additionalProperties: true
instructionsPath: instructions.md
requiredTools:
  - codex
  - git
uiPanels:
  - runs
  - skills
`;

const STARTER_BUILD_PLAN_INSTRUCTIONS = `# Build Plan

Turn the user's goal into a concrete implementation plan, identify risks, and keep the next action executable through the Builder Gear run contract.
`;

const STARTER_ONTOLOGY = `[
  {
    "id": "profession-builder",
    "type": "Profession",
    "label": "Professional Builder",
    "properties": {
      "audience": "cross-functional"
    },
    "relations": [
      {
        "type": "uses",
        "targetId": "skill-build-plan"
      }
    ]
  },
  {
    "id": "goal-first-run",
    "type": "Goal",
    "label": "Prepare the first Builder Gear run",
    "properties": {
      "status": "active"
    },
    "relations": [
      {
        "type": "guided-by",
        "targetId": "profession-builder"
      }
    ]
  }
]
`;

const STARTER_FILES = [
  {
    relativePath: path.join("skills", "build-plan", "skill.yaml"),
    body: STARTER_BUILD_PLAN_SKILL
  },
  {
    relativePath: path.join("skills", "build-plan", "instructions.md"),
    body: STARTER_BUILD_PLAN_INSTRUCTIONS
  },
  {
    relativePath: path.join("ontology", "builder-gear.json"),
    body: STARTER_ONTOLOGY
  },
  {
    relativePath: path.join(".builder", "schedules.json"),
    body: "[]\n"
  }
] as const;

export async function prepareBuilderWorkspace(workspacePath: string): Promise<PreparedWorkspace> {
  const resolvedWorkspacePath = await ensureWorkspaceRootForWrite(workspacePath);
  await ensureWorkspaceChildDirForWrite(resolvedWorkspacePath, "skills", "skills");
  await ensureWorkspaceChildDirForWrite(resolvedWorkspacePath, path.join("skills", "build-plan"), "build-plan skill");
  await ensureWorkspaceChildDirForWrite(resolvedWorkspacePath, "ontology", "ontology");
  await ensureWorkspaceChildDirForWrite(resolvedWorkspacePath, ".builder", "builder");

  const files: PreparedWorkspaceFile[] = [];
  for (const starterFile of STARTER_FILES) {
    const absolutePath = path.join(resolvedWorkspacePath, starterFile.relativePath);
    const created = await writeTextFileIfMissing(absolutePath, starterFile.body);

    files.push({
      path: path.relative(resolvedWorkspacePath, absolutePath).split(path.sep).join("/"),
      status: created ? "created" : "existing"
    });
  }

  return {
    workspacePath: resolvedWorkspacePath,
    files
  };
}

async function writeTextFileIfMissing(filePath: string, body: string): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });

  try {
    await writeFile(filePath, body, { flag: "wx" });
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      await validateExistingStarterFile(filePath);
      return false;
    }

    throw error;
  }
}

async function validateExistingStarterFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);

  if (metadata.isSymbolicLink()) {
    throw new Error(`starter file must not be a symlink: ${filePath}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`starter path exists but is not a file: ${filePath}`);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
