import { describe, expect, it } from "vitest";
import { MAX_AGENT_REFERENCE_IDS } from "@builder/core/browser";
import {
  activeRunStatus,
  createInitialLayout,
  createLocalEventId,
  createPersistedRequestOptions,
  createPersistedEventSummary,
  createQueuedEvent,
  formatDisplayEventPayload,
  isLayoutPanelVisible,
  normalizeStoredEvents,
  normalizeStoredLayout,
  normalizeStoredRequest,
  settledRunStartStatus,
  trackRunFinished,
  trackRunStarted,
  togglePanelVisibility
} from "./model.js";

describe("desktop model", () => {
  it("creates queued run events from GUI requests", () => {
    const event = createQueuedEvent(
      {
        workspacePath: "/workspace",
        prompt: "Ship the app",
        sandboxMode: "workspace-write",
        approvalMode: "never"
      },
      new Date("2026-06-23T00:00:00.000Z")
    );

    expect(event.type).toBe("queued");
    expect(event.runId).toMatch(/^local-1782172800000-\d+$/);
    expect(event.payload).toMatchObject({
      workspaceSelected: true,
      pathRedacted: true
    });
    expect(JSON.stringify(event)).not.toContain("/workspace");
  });

  it("keeps local event ids unique when UI events share a timestamp", () => {
    const now = new Date("2026-06-23T00:00:00.000Z");
    const ids = new Set([
      createLocalEventId(now),
      createLocalEventId(now),
      createQueuedEvent({
        workspacePath: "/workspace",
        prompt: "Ship the app",
        sandboxMode: "workspace-write",
        approvalMode: "never"
      }, now).runId
    ]);

    expect(ids.size).toBe(3);
  });

  it("toggles persisted layout panels", () => {
    const layout = createInitialLayout();
    const next = togglePanelVisibility(layout, "logs");

    expect(layout.panels.find((panel) => panel.id === "logs")?.visible).toBe(true);
    expect(next.panels.find((panel) => panel.id === "logs")?.visible).toBe(false);
    expect(isLayoutPanelVisible(layout, "logs")).toBe(true);
    expect(isLayoutPanelVisible(next, "logs")).toBe(false);
    expect(isLayoutPanelVisible(next, "runs")).toBe(true);
  });

  it("tracks overlapping active runs without clearing newer runs when an older run finishes", () => {
    const withFirstRun = trackRunStarted([], "run-1");
    const withSecondRun = trackRunStarted(withFirstRun, "run-2");

    expect(withSecondRun).toEqual(["run-2", "run-1"]);
    expect(trackRunStarted(withSecondRun, "run-1")).toEqual(["run-1", "run-2"]);
    expect(trackRunFinished(withSecondRun, "run-1")).toEqual(["run-2"]);
    expect(trackRunFinished(withSecondRun, "missing-run")).toEqual(withSecondRun);
    expect(activeRunStatus(0)).toBe("Ready");
    expect(activeRunStatus(1)).toBe("1 run active");
    expect(activeRunStatus(2)).toBe("2 runs active");
  });

  it("does not let a late invoke resolution mask an already delivered terminal run event", () => {
    expect(settledRunStartStatus({
      currentStatus: "Starting",
      pendingStatus: "Starting",
      queuedStatus: "Run queued",
      activeRunIds: [],
      runId: "run-1"
    })).toBe("Run queued");

    expect(settledRunStartStatus({
      currentStatus: "Run failed",
      pendingStatus: "Starting",
      queuedStatus: "Run queued",
      activeRunIds: [],
      runId: "run-1"
    })).toBe("Run failed");

    expect(settledRunStartStatus({
      currentStatus: "Starting",
      pendingStatus: "Starting",
      queuedStatus: "Run queued",
      activeRunIds: ["run-2", "run-1"],
      runId: "run-1"
    })).toBe("2 runs active");
  });

  it("summarizes output events before browser persistence", () => {
    const summary = createPersistedEventSummary({
      runId: "run-1",
      type: "stdout",
      timestamp: "2026-06-24T00:00:00.000Z",
      payload: "secret prompt sk-1234567890abcdefghijkl"
    });
    const source = JSON.stringify(summary);

    expect(summary.payload).toMatchObject({
      summary: "stdout payload redacted from persisted history"
    });
    expect(source).not.toContain("secret prompt");
    expect(source).not.toContain("abcdefghijkl");
  });

  it("omits workspace paths and codex payload bodies before browser persistence", () => {
    const queued = createPersistedEventSummary({
      runId: "run-1",
      type: "queued",
      timestamp: "2026-06-24T00:00:00.000Z",
      payload: {
        workspacePath: "/Users/example/private-project",
        sandboxMode: "workspace-write",
        approvalMode: "never",
        timeoutSeconds: 3600,
        skillIds: ["build-plan"],
        ontologyContextIds: ["goal-first-run"]
      }
    });
    const codex = createPersistedEventSummary({
      runId: "run-1",
      type: "codex_event",
      timestamp: "2026-06-24T00:00:00.000Z",
      payload: {
        type: "agent_message",
        message: "Do not persist this output"
      }
    });
    const source = JSON.stringify([queued, codex]);

    expect(queued.payload).toMatchObject({
      sandboxMode: "workspace-write",
      timeoutSeconds: 3600,
      skillCount: 1,
      ontologyContextCount: 1
    });
    expect(codex.payload).toMatchObject({
      summary: "Codex JSON event payload redacted from persisted history",
      codexType: "agent_message"
    });
    expect(source).not.toContain("private-project");
    expect(source).not.toContain("Do not persist this output");
  });

  it("redacts error event messages before browser persistence", () => {
    const summary = createPersistedEventSummary({
      runId: "run-1",
      type: "error",
      timestamp: "2026-06-24T00:00:00.000Z",
      payload: {
        timedOut: true,
        message: "OPENAI_API_KEY=sk-1234567890abcdefghijkl failed at /Users/example/private/App.tsx"
      }
    });
    const source = JSON.stringify(summary);

    expect(summary.payload).toMatchObject({ timedOut: true });
    expect(source).toContain("[LOCAL_PATH]");
    expect(source).toContain("[REDACTED_KEY]");
    expect(source).not.toContain("/Users/example");
    expect(source).not.toContain("abcdefghijkl");
  });

  it("redacts visible event payloads before rendering them in the event panel", () => {
    const payload = {
      workspacePath: "/Volumes/External/private-project",
      fileUrl: "file:///Users/example/private/source.ts",
      windowsPath: "C:\\Users\\example\\AppData\\Local\\Builder\\auth.json",
      prompt: "Private customer migration plan",
      payload: {
        body: "Raw run payload should not render"
      },
      nested: {
        content: "Model output should not render"
      },
      output: "Command output should not render",
      tokenCount: 42,
      promptTokens: 7,
      secretToken: "sess-abcdefghijklmnopqrstuvwxyz123456",
      message: "OPENAI_API_KEY=sk-1234567890abcdefghijkl"
    };
    const source = formatDisplayEventPayload(payload);

    expect(source).toContain("[LOCAL_PATH]");
    expect(source).toContain("[LOCAL_FILE_URL]");
    expect(source).toContain("[REDACTED_EVENT_FIELD]");
    expect(source).toContain("[REDACTED_SECRET_FIELD]");
    expect(source).toContain("[REDACTED_KEY]");
    expect(source).toContain("tokenCount");
    expect(source).toContain("promptTokens");
    expect(source).not.toContain("private-project");
    expect(source).not.toContain("C:\\Users\\example");
    expect(source).not.toContain("Private customer migration plan");
    expect(source).not.toContain("Raw run payload should not render");
    expect(source).not.toContain("Model output should not render");
    expect(source).not.toContain("Command output should not render");
    expect(source).not.toContain("abcdefghijkl");
    expect(source).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("keeps explicit privacy booleans visible in support bundle previews", () => {
    const source = formatDisplayEventPayload({
      kind: "support_bundle_preview",
      privacy: {
        redacted: true,
        includesAuthContents: false,
        includesRawPrompts: false,
        includesWorkspacePaths: false,
        includesRunPayloads: false
      }
    });

    expect(source).toContain("includesRawPrompts");
    expect(source).toContain("includesRunPayloads");
    expect(source).toContain("false");
    expect(source).not.toContain("[REDACTED_EVENT_FIELD]");
  });

  it("redacts operational artifact path-like fields without hiding safe privacy metadata", () => {
    const source = formatDisplayEventPayload({
      kind: "diagnostics_report",
      artifactPath: "/Users/example/private-project/diagnostics/report.json",
      bundlePath: "/private/var/folders/xy/private-project/support.json",
      outputDir: "/tmp/private-project",
      diagnosticsUrl: "file:///Users/example/private-project/log.json",
      publicUrl: "https://updates.buildergear.example/releases/latest.json",
      pathRedacted: true,
      pathFingerprint: "abc123"
    });

    expect(source).toContain("[LOCAL_PATH]");
    expect(source).toContain("[LOCAL_FILE_URL]");
    expect(source).toContain("https://updates.buildergear.example/releases/latest.json");
    expect(source).toContain("pathRedacted");
    expect(source).toContain("true");
    expect(source).toContain("pathFingerprint");
    expect(source).toContain("abc123");
    expect(source).not.toContain("/Users/example");
    expect(source).not.toContain("/private/var/folders");
    expect(source).not.toContain("/tmp/private-project");
    expect(source).not.toContain("private-project/log.json");
  });

  it("bounds visible event payloads and handles circular structures", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    payload.details = "x".repeat(200);
    const source = formatDisplayEventPayload(payload, 120);

    expect(source).toContain("[Circular]");
    expect(source.length).toBeLessThanOrEqual(123);
    expect(source.endsWith("...")).toBe(true);
  });

  it("normalizes malformed stored events without crashing startup", () => {
    expect(normalizeStoredEvents({ not: "an array" })).toEqual([]);
    expect(normalizeStoredEvents([
      null,
      { runId: "run-1", type: "stdout", timestamp: "bad-date", payload: "bad" },
      {
        runId: "run-2",
        type: "queued",
        timestamp: "2026-06-24T00:00:00.000Z",
        payload: {
          workspacePath: "/Users/example/private-project",
          sandboxMode: "workspace-write",
          approvalMode: "never",
          skillIds: ["build-plan"]
        }
      }
    ])).toEqual([
      {
        runId: "run-2",
        type: "queued",
        timestamp: "2026-06-24T00:00:00.000Z",
        payload: {
          sandboxMode: "workspace-write",
          approvalMode: "never",
          skillCount: 1,
          ontologyContextCount: 0,
          scheduleId: undefined
        }
      }
    ]);
  });

  it("merges stored layout visibility only for known default panels", () => {
    const fallback = createInitialLayout();
    const layout = normalizeStoredLayout({
      id: "custom",
      name: "Custom",
      version: fallback.version,
      panels: [
        { id: "logs", visible: false },
        { id: "unknown", title: "Unknown", kind: "logs", region: "bottom", visible: false }
      ]
    }, fallback);

    expect(layout.id).toBe("custom");
    expect(layout.name).toBe("Custom");
    expect(layout.panels).toHaveLength(fallback.panels.length);
    expect(layout.panels.find((panel) => panel.id === "logs")?.visible).toBe(false);
    expect(layout.panels.find((panel) => panel.id === "unknown")).toBeUndefined();
    expect(normalizeStoredLayout({ version: 999, panels: [] }, fallback)).toEqual(fallback);
  });

  it("normalizes stored request fields and drops stale prompts, workspace paths, and unsafe CLI options", () => {
    const fallback = {
      workspacePath: "",
      prompt: "",
      sandboxMode: "workspace-write" as const,
      approvalMode: "never" as const,
      skillIds: ["build-plan"],
      ontologyContextIds: ["goal-mvp"],
      timeoutSeconds: 1200
    };

    expect(normalizeStoredRequest({
      workspacePath: "/workspace",
      prompt: "should not be restored",
      sandboxMode: "bad",
      approvalMode: "on-request",
      skillIds: ["build-plan", "", 42, "bad/skill", "build-plan"],
      ontologyContextIds: "bad",
      timeoutSeconds: 3600,
      model: "gpt-5",
      profile: "/Users/example/private-profile"
    }, fallback)).toEqual({
      workspacePath: "",
      prompt: "",
      sandboxMode: "workspace-write",
      approvalMode: "on-request",
      skillIds: ["build-plan"],
      ontologyContextIds: ["goal-mvp"],
      timeoutSeconds: 3600,
      model: "gpt-5",
      profile: undefined
    });
  });

  it("bounds and sanitizes restored request reference ids from browser storage", () => {
    const fallback = {
      workspacePath: "",
      prompt: "",
      sandboxMode: "workspace-write" as const,
      approvalMode: "never" as const,
      skillIds: ["fallback-skill"],
      ontologyContextIds: ["fallback-goal"]
    };
    const restored = normalizeStoredRequest({
      skillIds: [
        " build-plan ",
        "bad/skill",
        "build-plan",
        ...Array.from({ length: MAX_AGENT_REFERENCE_IDS + 5 }, (_, index) => `skill-${index}`)
      ],
      ontologyContextIds: [
        "goal-mvp",
        "bad goal",
        "goal-mvp",
        `g${"x".repeat(128)}`
      ]
    }, fallback);

    expect(restored.skillIds).toHaveLength(MAX_AGENT_REFERENCE_IDS);
    expect(restored.skillIds?.[0]).toBe("build-plan");
    expect(restored.skillIds).not.toContain("bad/skill");
    expect(restored.skillIds).toEqual([...new Set(restored.skillIds)]);
    expect(restored.ontologyContextIds).toEqual(["goal-mvp"]);
  });

  it("creates persisted request options without prompts, workspace paths, local model paths, or profile secrets", () => {
    const stored = createPersistedRequestOptions({
      workspacePath: "/Users/example/private-client",
      prompt: "Do not persist this customer prompt",
      model: "file:///Users/example/private-model.json",
      profile: "OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      sandboxMode: "workspace-write",
      approvalMode: "never",
      timeoutSeconds: 1800,
      skillIds: ["build-plan", "bad/skill", "build-plan"],
      ontologyContextIds: ["goal-first-run", "bad goal", "goal-first-run"]
    });
    const source = JSON.stringify(stored);

    expect(stored).toEqual({
      model: undefined,
      profile: undefined,
      sandboxMode: "workspace-write",
      approvalMode: "never",
      timeoutSeconds: 1800,
      skillIds: ["build-plan"],
      ontologyContextIds: ["goal-first-run"]
    });
    expect(source).not.toContain("private-client");
    expect(source).not.toContain("customer prompt");
    expect(source).not.toContain("private-model");
    expect(source).not.toContain("abcdefghijkl");
  });
});
