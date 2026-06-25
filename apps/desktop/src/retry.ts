import type { AgentRunEvent, AgentRunRequest } from "@builder/core/browser";

export function snapshotRunRequest(request: AgentRunRequest): AgentRunRequest {
  return {
    ...request,
    skillIds: request.skillIds ? [...request.skillIds] : undefined,
    ontologyContextIds: request.ontologyContextIds ? [...request.ontologyContextIds] : undefined
  };
}

export function isRetryableRunError(event: AgentRunEvent): boolean {
  if (event.type !== "error") {
    return false;
  }

  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return true;
  }

  return !("cancelled" in payload && (payload as { cancelled?: unknown }).cancelled === true);
}

