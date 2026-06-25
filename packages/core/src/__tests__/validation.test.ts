import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_CLI_OPTION_CHARS,
  MAX_AGENT_PROMPT_CHARS,
  MAX_AGENT_REFERENCE_ID_CHARS,
  MAX_AGENT_REFERENCE_IDS,
  MAX_AGENT_RUN_TIMEOUT_SECONDS,
  validateAgentRunRequest
} from "../validation.js";
import type { AgentRunRequest } from "../types.js";

const validRequest: AgentRunRequest = {
  workspacePath: "/workspace",
  prompt: "Build the release plan",
  model: "gpt-5",
  profile: "builder.release",
  sandboxMode: "workspace-write",
  approvalMode: "never",
  timeoutSeconds: 3600,
  skillIds: ["build-plan"],
  ontologyContextIds: ["goal-mvp", "crm:lead.stage-1"],
  scheduleId: "daily-plan"
};

describe("agent run request validation", () => {
  it("accepts bounded production run requests", () => {
    expect(validateAgentRunRequest(validRequest)).toEqual([]);
  });

  it("rejects oversized prompts before Codex is spawned", () => {
    expect(validateAgentRunRequest({
      ...validRequest,
      prompt: "x".repeat(MAX_AGENT_PROMPT_CHARS + 1)
    })).toEqual(expect.arrayContaining([
      `prompt exceeds maximum length of ${MAX_AGENT_PROMPT_CHARS} characters`
    ]));
  });

  it("rejects unsafe workspace and CLI option values", () => {
    expect(validateAgentRunRequest({
      ...validRequest,
      workspacePath: "/workspace\nother",
      model: "gpt-5\n--profile",
      profile: "x".repeat(MAX_AGENT_CLI_OPTION_CHARS + 1)
    })).toEqual(expect.arrayContaining([
      "workspacePath must not contain control characters",
      "model must not contain whitespace or control characters",
      `profile exceeds maximum length of ${MAX_AGENT_CLI_OPTION_CHARS} characters`
    ]));
  });

  it("rejects invalid run timeouts", () => {
    expect(validateAgentRunRequest({
      ...validRequest,
      timeoutSeconds: 0
    })).toContain(`timeoutSeconds must be a whole number between 1 and ${MAX_AGENT_RUN_TIMEOUT_SECONDS}`);

    expect(validateAgentRunRequest({
      ...validRequest,
      timeoutSeconds: MAX_AGENT_RUN_TIMEOUT_SECONDS + 1
    })).toContain(`timeoutSeconds must be a whole number between 1 and ${MAX_AGENT_RUN_TIMEOUT_SECONDS}`);

    expect(validateAgentRunRequest({
      ...validRequest,
      timeoutSeconds: 1.5
    })).toContain(`timeoutSeconds must be a whole number between 1 and ${MAX_AGENT_RUN_TIMEOUT_SECONDS}`);
  });

  it("bounds and validates run reference ids", () => {
    expect(validateAgentRunRequest({
      ...validRequest,
      skillIds: [
        "build-plan",
        "bad/skill",
        "build-plan",
        ...Array.from({ length: MAX_AGENT_REFERENCE_IDS }, (_, index) => `skill-${index}`)
      ],
      ontologyContextIds: ["goal good", `g${"x".repeat(MAX_AGENT_REFERENCE_ID_CHARS)}`],
      scheduleId: " nightly "
    })).toEqual(expect.arrayContaining([
      `skillIds exceeds maximum length of ${MAX_AGENT_REFERENCE_IDS}`,
      "skillIds[1] contains unsupported id characters",
      "skillIds contains duplicate ids",
      "ontologyContextIds[0] contains unsupported id characters",
      `ontologyContextIds[1] exceeds maximum length of ${MAX_AGENT_REFERENCE_ID_CHARS} characters`,
      "scheduleId must not contain surrounding whitespace or control characters",
      "scheduleId contains unsupported id characters"
    ]));
  });
});
