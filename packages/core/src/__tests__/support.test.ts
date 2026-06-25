import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSupportBundle, redactSupportBundleText } from "../support.js";
import type { HealthReport } from "../types.js";

describe("support bundle", () => {
  it("redacts local paths and secret-shaped values from health details", () => {
    const workspace = path.join(os.tmpdir(), "builder-support", "Secret Client Alpha");
    const codexHome = path.join(os.tmpdir(), "builder-support", "codex-home");
    const secret = "OPENAI_API_KEY=sk-1234567890abcdefghijkl";
    const health: HealthReport = {
      generatedAt: "2026-06-24T00:00:00.000Z",
      status: "fail",
      checks: [
        {
          id: "workspace",
          title: "Workspace",
          status: "fail",
          message: `Workspace exists at ${workspace}`,
          action: `Inspect ${workspace}/skills/build-plan/skill.yaml`
        },
        {
          id: "codex-auth",
          title: "Codex Auth",
          status: "fail",
          message: `Auth file is present at ${codexHome}/auth.json ${secret}`
        }
      ]
    };

    const bundle = createSupportBundle({
      workspacePath: workspace,
      healthReport: health,
      appVersion: "0.1.0",
      generatedAt: new Date("2026-06-24T01:00:00.000Z"),
      platform: {
        os: "darwin",
        arch: "arm64",
        node: "v24.0.0"
      }
    });
    const serialized = JSON.stringify(bundle);

    expect(bundle.generatedAt).toBe("2026-06-24T01:00:00.000Z");
    expect(bundle.privacy).toEqual({
      redacted: true,
      includesAuthContents: false,
      includesRawPrompts: false,
      includesWorkspacePaths: false,
      includesRunPayloads: false
    });
    expect(bundle.workspace.pathRedacted).toBe(true);
    expect(bundle.workspace.pathFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(bundle.workspace.basename).toBeUndefined();
    expect(serialized).toContain("[WORKSPACE_PATH]");
    expect(serialized).toContain("[LOCAL_PATH]");
    expect(serialized).toContain("[REDACTED_KEY]");
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain("Secret Client Alpha");
    expect(serialized).not.toContain(codexHome);
    expect(serialized).not.toContain("abcdefghijkl");
  });

  it("redacts home-relative local paths", () => {
    const workspace = path.join(os.homedir(), "Builder Gear", "Client");

    expect(redactSupportBundleText(`Workspace selected: ${workspace}`, workspace)).toBe("Workspace selected: [WORKSPACE_PATH]");
    expect(redactSupportBundleText("Auth file is present at ~/.codex/auth.json", workspace)).toBe("Auth file is present at [LOCAL_PATH]");
    expect(redactSupportBundleText("External workspace failed: /Volumes/ClientDrive/workspace", workspace)).toBe("External workspace failed: [LOCAL_PATH]");
    expect(redactSupportBundleText("Container workspace failed: /workspace/private/project", workspace)).toBe("Container workspace failed: [LOCAL_PATH]");
  });

  it("redacts macOS /var and /private/var workspace aliases as the selected workspace", () => {
    if (process.platform === "win32") {
      return;
    }

    const selectedWorkspace = "/var/folders/xy/builder-support/workspace";
    const realWorkspace = "/private/var/folders/xy/builder-support/workspace";

    expect(redactSupportBundleText(`Workspace exists at ${realWorkspace}`, selectedWorkspace)).toBe("Workspace exists at [WORKSPACE_PATH]");
    expect(redactSupportBundleText(`Workspace exists at ${selectedWorkspace}`, realWorkspace)).toBe("Workspace exists at [WORKSPACE_PATH]");
  });

  it("sanitizes arbitrary diagnostics before including them in a support bundle", () => {
    const workspace = path.join(os.tmpdir(), "builder-support", "Secret Client Alpha");
    const diagnostics: Record<string, unknown> = {
      status: "fail",
      workspacePath: workspace,
      authPath: path.join(os.homedir(), ".codex", "auth.json"),
      prompt: "Build a confidential acquisition plan",
      eventPayload: {
        stdout: "OPENAI_API_KEY=sk-1234567890abcdefghijkl"
      },
      nested: {
        message: `Log at ${workspace}/logs/run.log with OPENAI_API_KEY=sk-1234567890abcdefghijkl`,
        sessionToken: "plain-session-token-value"
      },
      workspaceLabel: "workspace (Secret Client Alpha)",
      paths: [
        workspace,
        "file:///Users/example/private/prompt.txt"
      ],
      pathRedacted: true,
      pathFingerprint: "abc123",
      events: Array.from({ length: 105 }, (_, index) => ({ type: `event-${index}` }))
    };
    diagnostics.self = diagnostics;

    const bundle = createSupportBundle({
      workspacePath: workspace,
      healthReport: {
        generatedAt: "2026-06-24T00:00:00.000Z",
        status: "pass",
        checks: []
      },
      appVersion: "0.1.0",
      generatedAt: new Date("2026-06-24T01:00:00.000Z"),
      platform: {
        os: "darwin",
        arch: "arm64",
        node: "v24.0.0"
      },
      diagnostics
    });
    const sanitized = bundle.diagnostics as {
      pathRedacted: boolean;
      pathFingerprint: string;
      events: unknown[];
      self: string;
    };
    const serialized = JSON.stringify(bundle);

    expect(sanitized.pathRedacted).toBe(true);
    expect(sanitized.pathFingerprint).toBe("abc123");
    expect(sanitized.events).toHaveLength(101);
    expect(sanitized.events.at(-1)).toBe("[truncated]");
    expect(sanitized.self).toBe("[circular]");
    expect(serialized).toContain("[WORKSPACE_PATH]");
    expect(serialized).toContain("[WORKSPACE_NAME]");
    expect(serialized).toContain("[LOCAL_PATH]");
    expect(serialized).toContain("[LOCAL_FILE_URL]");
    expect(serialized).toContain("[REDACTED_DIAGNOSTIC_FIELD]");
    expect(serialized).toContain("[REDACTED_SECRET_FIELD]");
    expect(serialized).toContain("[REDACTED_KEY]");
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain("Secret Client Alpha");
    expect(serialized).not.toContain(os.homedir());
    expect(serialized).not.toContain("confidential acquisition");
    expect(serialized).not.toContain("plain-session-token-value");
    expect(serialized).not.toContain("abcdefghijkl");
  });
});
