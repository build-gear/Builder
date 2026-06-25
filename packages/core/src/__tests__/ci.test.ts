import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("CI workflow", () => {
  it("runs release readiness across desktop platforms", () => {
    const workflow = readWorkflow();
    const job = releaseReadinessJob(workflow);
    const osMatrix = job.strategy.matrix.os;
    const steps = job.steps as Array<{ name?: string; run?: string; uses?: string; if?: string }>;

    expect(osMatrix).toEqual(["macos-14", "windows-2022", "ubuntu-22.04"]);
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(steps.some((step) => step.uses?.startsWith("swatinem/rust-cache@") && pinnedActionRef(step.uses))).toBe(true);
    expect(steps.some((step) => step.run === "pnpm release:check:fast")).toBe(true);
  });

  it("installs the Linux system dependencies required by Tauri 2", () => {
    const workflow = readWorkflow();
    const steps = releaseReadinessJob(workflow).steps as Array<{ name?: string; run?: string; if?: string }>;
    const linuxStep = steps.find((step) => step.name === "Install Linux Tauri dependencies");

    expect(linuxStep?.if).toBe("runner.os == 'Linux'");
    expect(linuxStep?.run).toContain("libwebkit2gtk-4.1-dev");
    expect(linuxStep?.run).toContain("libappindicator3-dev");
    expect(linuxStep?.run).toContain("librsvg2-dev");
    expect(linuxStep?.run).toContain("patchelf");
  });

  it("provides a manual release candidate packaging workflow", () => {
    const workflow = readWorkflowFile(".github/workflows/release-candidate.yml") as {
      on: {
        workflow_dispatch: {
          inputs: {
            platform: { options: string[] };
            channel: { options: string[] };
          };
        };
      };
      permissions: { contents: string };
      jobs: Record<string, {
        if?: string;
        needs?: string;
        name?: string;
        "runs-on": string;
        permissions?: { attestations?: string; contents?: string; "id-token"?: string };
        env: Record<string, string>;
        steps: Array<{ name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const guardJob = workflow.jobs["ref-guard"];
    const job = workflow.jobs.build;
    if (!guardJob) {
      throw new Error("release candidate ref guard job is missing");
    }
    if (!job) {
      throw new Error("release candidate build job is missing");
    }

    expect(workflow.on.workflow_dispatch.inputs.platform.options).toEqual(["macos", "windows", "linux"]);
    expect(workflow.on.workflow_dispatch.inputs.channel.options).toEqual(["internal", "stable"]);
    expect(workflow.permissions.contents).toBe("read");
    expect(guardJob.name).toBe("Release ref guard");
    expect(guardJob["runs-on"]).toBe("ubuntu-22.04");
    expect(guardJob.steps.some((step) => step.name === "Require main or release ref" && step.run?.includes("refs/heads/main|refs/heads/release/*") && step.run.includes("exit 1"))).toBe(true);
    expect(job.needs).toBe("ref-guard");
    expect(job.if).toBe("github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')");
    expect(job.permissions?.attestations).toBe("write");
    expect(job.permissions?.contents).toBe("read");
    expect(job.permissions?.["id-token"]).toBe("write");
    expect(job["runs-on"]).toContain("macos-14");
    expect(job["runs-on"]).toContain("windows-2022");
    expect(job["runs-on"]).toContain("ubuntu-22.04");
    expect(job.env.APPLE_SIGNING_IDENTITY).toBe("${{ inputs.platform == 'macos' && secrets.APPLE_SIGNING_IDENTITY || '' }}");
    expect(job.env.APPLE_CERTIFICATE).toBe("${{ inputs.platform == 'macos' && secrets.APPLE_CERTIFICATE || '' }}");
    expect(job.env.APPLE_CERTIFICATE_PASSWORD).toBe("${{ inputs.platform == 'macos' && secrets.APPLE_CERTIFICATE_PASSWORD || '' }}");
    expect(job.env.APPLE_KEYCHAIN_PASSWORD).toBe("${{ inputs.platform == 'macos' && secrets.APPLE_KEYCHAIN_PASSWORD || '' }}");
    expect(job.env.WINDOWS_SIGNING_CERTIFICATE).toBe("${{ inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_CERTIFICATE || '' }}");
    expect(job.env.TAURI_SIGNING_PRIVATE_KEY).toBe("${{ inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY || '' }}");
    expect(job.env.BUILDER_GEAR_UPDATE_ENDPOINT).toBe("${{ inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATE_ENDPOINT || '' }}");
    const appleImportStep = job.steps.find((step) => step.name === "Import Apple signing certificate");
    expect(appleImportStep?.if).toBe("inputs.platform == 'macos'");
    expect(appleImportStep?.run).toContain("security create-keychain");
    expect(appleImportStep?.run).toContain("security import \"$CERTIFICATE_PATH\"");
    expect(appleImportStep?.run).toContain("security set-key-partition-list");
    expect(appleImportStep?.run).toContain("security find-identity -v -p codesigning \"$KEYCHAIN_PATH\" | grep -F \"$APPLE_SIGNING_IDENTITY\"");
    expect(job.steps.some((step) => step.run?.includes("pnpm release:check:distribution -- --platform \"${{ inputs.platform }}\""))).toBe(true);
    expect(job.steps.some((step) => step.run?.includes("pnpm release:check:stable -- --platform \"${{ inputs.platform }}\""))).toBe(true);
    expect(job.steps.some((step) => step.run?.includes("pnpm release:verify -- \"$MANIFEST_PATH\""))).toBe(true);
    expect(job.steps.some((step) => step.run?.includes("pnpm release:stage-upload -- \"$MANIFEST_PATH\""))).toBe(true);
    expect(job.steps.some((step) => step.uses?.startsWith("actions/attest-build-provenance@") && pinnedActionRef(step.uses))).toBe(true);
    expect(job.steps.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"))?.with).toMatchObject({
      "subject-path": "apps/desktop/src-tauri/target/release-upload/**"
    });
    expect(job.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@") && pinnedActionRef(step.uses))).toBe(true);
    expect(job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with).toMatchObject({
      path: "apps/desktop/src-tauri/target/release-upload/**",
      "if-no-files-found": "error",
      "retention-days": 14
    });
  });

  it("provides a manual stable updater publication verifier", () => {
    const workflow = readWorkflowFile(".github/workflows/verify-stable-updater.yml") as {
      on: {
        workflow_dispatch: {
          inputs: {
            release_run_id: { type: string; required: boolean };
            platform: { options: string[] };
            verify_downloads: { type: string; default: boolean };
          };
        };
      };
      permissions: { contents: string };
      jobs: Record<string, {
        name?: string;
        needs?: string;
        if?: string;
        "runs-on": string;
        "timeout-minutes": number;
        environment?: { name: string };
        permissions?: { actions?: string; attestations?: string; contents?: string };
        steps: Array<{ name?: string; id?: string; env?: Record<string, unknown>; run?: string; uses?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const guardJob = workflow.jobs["ref-guard"];
    const job = workflow.jobs.verify;
    if (!guardJob) {
      throw new Error("stable updater verification ref guard job is missing");
    }
    if (!job) {
      throw new Error("stable updater verification job is missing");
    }

    expect(workflow.on.workflow_dispatch.inputs.release_run_id.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.release_run_id.type).toBe("string");
    expect(workflow.on.workflow_dispatch.inputs.platform.options).toEqual(["macos", "windows", "linux"]);
    expect(workflow.on.workflow_dispatch.inputs.verify_downloads.type).toBe("boolean");
    expect(workflow.on.workflow_dispatch.inputs.verify_downloads.default).toBe(true);
    expect(workflow.permissions.contents).toBe("read");
    expect(guardJob.name).toBe("Stable updater verification ref guard");
    expect(guardJob["runs-on"]).toBe("ubuntu-22.04");
    expect(guardJob.steps.some((step) => step.name === "Require main or release ref" && step.run?.includes("refs/heads/main|refs/heads/release/*") && step.run.includes("exit 1"))).toBe(true);
    expect(job.needs).toBe("ref-guard");
    expect(job.if).toBe("github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')");
    expect(job["runs-on"]).toBe("ubuntu-22.04");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
    expect(job.environment?.name).toBe("production");
    expect(job.permissions?.actions).toBe("read");
    expect(job.permissions?.attestations).toBe("read");
    expect(job.permissions?.contents).toBe("read");
    expect(job.steps.some((step) => step.uses?.startsWith("actions/download-artifact@") && pinnedActionRef(step.uses))).toBe(true);
    expect(job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))?.with).toMatchObject({
      "run-id": "${{ inputs.release_run_id }}",
      "github-token": "${{ github.token }}",
      pattern: "builder-gear-stable-${{ inputs.platform }}-*",
      path: "release-candidate-artifact",
      "merge-multiple": true
    });
    const releaseRunStep = job.steps.find((step) => step.name === "Validate release candidate run metadata");
    expect(releaseRunStep?.id).toBe("release-run-metadata");
    expect(releaseRunStep?.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(releaseRunStep?.run).toContain("gh run view \"${{ inputs.release_run_id }}\"");
    expect(releaseRunStep?.run).toContain("--json workflowName,event,conclusion,headBranch,headSha");
    expect(releaseRunStep?.run).toContain("\"$workflow_name\" != \"Release Candidate\"");
    expect(releaseRunStep?.run).toContain("\"$event\" != \"workflow_dispatch\"");
    expect(releaseRunStep?.run).toContain("\"$conclusion\" != \"success\"");
    expect(releaseRunStep?.run).toContain("case \"$head_branch\" in");
    expect(releaseRunStep?.run).toContain("[[ \"$head_sha\" =~ ^[a-f0-9]{40}$ ]]");
    expect(releaseRunStep?.run).toContain("printf 'head_sha=%s\\n' \"$head_sha\" >> \"$GITHUB_OUTPUT\"");
    expect(releaseRunStep?.run).toContain("RELEASE_CANDIDATE_HEAD_SHA");
    const checkoutStep = job.steps.find((step) => step.name === "Checkout selected release source");
    expect(checkoutStep?.uses).toBeDefined();
    expect(checkoutStep?.uses && pinnedActionRef(checkoutStep.uses)).toBe(true);
    expect(checkoutStep?.with).toMatchObject({
      ref: "${{ steps.release-run-metadata.outputs.head_sha }}",
      "persist-credentials": false
    });
    const manifestStep = job.steps.find((step) => step.name === "Verify staged stable manifest");
    expect(manifestStep?.env).toMatchObject({
      ARTIFACT_ROOT: "release-candidate-artifact",
      EXPECTED_PLATFORM: "${{ inputs.platform }}"
    });
    expect(manifestStep?.run).toContain("pnpm release:verify -- --artifact-root \"$ARTIFACT_ROOT\" \"$MANIFEST_PATH\"");
    expect(manifestStep?.run).toContain("manifest.mode !== \"distribution\" || manifest.channel !== \"stable\" || manifest.includeBundle !== true");
    expect(manifestStep?.run).toContain("manifest.platform !== expectedPlatform");
    expect(manifestStep?.run).toContain("manifest.git?.commit !== expectedHeadSha");
    const attestationStep = job.steps.find((step) => step.name === "Verify release candidate attestations");
    expect(attestationStep?.run).toContain("gh attestation verify \"$file\"");
    expect(attestationStep?.run).toContain("--repo \"$GITHUB_REPOSITORY\"");
    expect(attestationStep?.run).toContain("--signer-workflow \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/release-candidate.yml\"");
    expect(attestationStep?.run).toContain("--deny-self-hosted-runners");
    expect(attestationStep?.run).toContain("find release-candidate-artifact/apps/desktop/src-tauri/target/release-upload");
    expect(job.steps.some((step) => step.run?.includes("pnpm release:verify-updater -- --artifact-root release-candidate-artifact \"$MANIFEST_PATH\" --verify-downloads"))).toBe(true);
  });
});

function readWorkflow() {
  return readWorkflowFile(".github/workflows/ci.yml") as {
    jobs: Record<string, {
      strategy: {
        "fail-fast": boolean;
        matrix: {
          os: string[];
        };
      };
      steps: unknown[];
    }>;
  };
}

function readWorkflowFile(relativePath: string): unknown {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const workflowPath = path.resolve(dirname, "../../../..", relativePath);
  return YAML.parse(readFileSync(workflowPath, "utf8")) as unknown;
}

function releaseReadinessJob(workflow: ReturnType<typeof readWorkflow>) {
  const job = workflow.jobs["release-readiness"];

  if (!job) {
    throw new Error("release-readiness job is missing");
  }

  return job;
}

function pinnedActionRef(uses: string): boolean {
  const ref = uses.slice(uses.lastIndexOf("@") + 1);
  return /^[a-f0-9]{40}$/i.test(ref);
}
