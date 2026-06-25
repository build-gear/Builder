import { describe, expect, it } from "vitest";
import { isRetryableRunError, snapshotRunRequest } from "./retry.js";
import type { AgentRunEvent, AgentRunRequest } from "@builder/core/browser";

const request: AgentRunRequest = {
  workspacePath: "/tmp/workspace",
  prompt: "Build it",
  sandboxMode: "workspace-write",
  approvalMode: "never",
  skillIds: ["build-plan"],
  ontologyContextIds: ["goal-mvp"]
};

function event(type: AgentRunEvent["type"], payload: unknown): AgentRunEvent {
  return {
    runId: "run-1",
    type,
    timestamp: "2026-06-24T00:00:00.000Z",
    payload
  };
}

describe("retry helpers", () => {
  it("snapshots mutable run request arrays", () => {
    const snapshot = snapshotRunRequest(request);
    request.skillIds?.push("later");

    expect(snapshot.skillIds).toEqual(["build-plan"]);
    expect(snapshot.ontologyContextIds).toEqual(["goal-mvp"]);
  });

  it("does not retry cancelled errors", () => {
    expect(isRetryableRunError(event("error", { cancelled: true }))).toBe(false);
    expect(isRetryableRunError(event("error", { message: "failed" }))).toBe(true);
    expect(isRetryableRunError(event("done", {}))).toBe(false);
  });
});

