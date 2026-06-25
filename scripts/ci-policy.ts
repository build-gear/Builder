#!/usr/bin/env tsx
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseEnvironmentExamplePaths,
  validateReleaseEnvironmentOperationalCoverage,
  validateWorkflowActionRefs
} from "../packages/core/src/release-check.js";
import {
  ensureSafeRepoDirectory,
  readRepoJsonFile,
  readCheckedTextFile,
  readRepoTextFile,
  repoRelativePath,
  safeErrorMessage
} from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const workflowsDir = ensureSafeRepoDirectory(rootDir, ".github/workflows", ".github/workflows directory");
  const workflows = readdirSync(workflowsDir, { withFileTypes: true })
    .flatMap((entry) => {
      const workflowPath = path.join(workflowsDir, entry.name);
      const workflowRelativePath = repoRelativePath(rootDir, workflowPath);

      if (entry.isSymbolicLink()) {
        throw new Error(`workflow file must not be a symlink: ${workflowRelativePath}`);
      }

      if (!entry.isFile() || !/\.(?:ya?ml)$/i.test(entry.name)) {
        return [];
      }

      return [{
        path: workflowRelativePath,
        content: normalizePolicyText(readCheckedTextFile(workflowPath, `workflow file ${workflowRelativePath}`))
      }];
    });

  const releaseCandidateWorkflow = workflows.find((workflow) => workflow.path === ".github/workflows/release-candidate.yml");
  const errors = [
    ...validateWorkflowActionRefs(workflows),
    ...validateReleaseEnvironmentOperationalCoverage({
      distributionPolicy: readRepoJsonFile<Record<string, unknown>>(rootDir, "release/distribution-policy.json", "distribution policy"),
      repositoryFiles: [
        ".github/workflows/release-candidate.yml",
        ...releaseEnvironmentExamplePaths()
      ],
      releaseCandidateWorkflowText: releaseCandidateWorkflow?.content,
      releaseEnvExampleTexts: releaseEnvExampleTexts()
    })
  ];

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ci policy: ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`CI policy passed for ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}.`);
  }
} catch (error) {
  console.error(`ci policy: ${safeErrorMessage(rootDir, error)}`);
  process.exitCode = 1;
}

function releaseEnvExampleTexts(): Record<string, string> {
  return Object.fromEntries(releaseEnvironmentExamplePaths().map((examplePath) => [
    examplePath,
    normalizePolicyText(readRepoTextFile(rootDir, examplePath, `release env example ${examplePath}`))
  ]));
}

function normalizePolicyText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
