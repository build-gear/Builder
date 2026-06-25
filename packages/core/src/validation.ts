import type { AgentRunRequest } from "./types.js";

export const MAX_AGENT_PROMPT_CHARS = 1_048_576;
export const MAX_AGENT_WORKSPACE_PATH_CHARS = 4_096;
export const MAX_AGENT_CLI_OPTION_CHARS = 128;
export const MAX_AGENT_REFERENCE_ID_CHARS = 128;
export const MAX_AGENT_REFERENCE_IDS = 50;
export const MAX_AGENT_RUN_TIMEOUT_SECONDS = 24 * 60 * 60;

export function validateAgentRunRequest(request: AgentRunRequest): string[] {
  const errors: string[] = [];

  if (!request.workspacePath || request.workspacePath.trim().length === 0) {
    errors.push("workspacePath is required");
  } else {
    validateBoundedRuntimeString(errors, "workspacePath", request.workspacePath, MAX_AGENT_WORKSPACE_PATH_CHARS);
    if (hasControlCharacters(request.workspacePath)) {
      errors.push("workspacePath must not contain control characters");
    }
  }

  if (!request.prompt || request.prompt.trim().length === 0) {
    errors.push("prompt is required");
  } else if (Array.from(request.prompt).length > MAX_AGENT_PROMPT_CHARS) {
    errors.push(`prompt exceeds maximum length of ${MAX_AGENT_PROMPT_CHARS} characters`);
  }

  if (!["read-only", "workspace-write", "danger-full-access"].includes(request.sandboxMode)) {
    errors.push(`unsupported sandboxMode: ${request.sandboxMode}`);
  }

  if (!["untrusted", "on-failure", "on-request", "never"].includes(request.approvalMode)) {
    errors.push(`unsupported approvalMode: ${request.approvalMode}`);
  }

  validateOptionalTimeoutSeconds(errors, "timeoutSeconds", request.timeoutSeconds);
  validateOptionalCliToken(errors, "model", request.model);
  validateOptionalCliToken(errors, "profile", request.profile);
  validateReferenceIdList(errors, "skillIds", request.skillIds, true);
  validateReferenceIdList(errors, "ontologyContextIds", request.ontologyContextIds, false);
  validateOptionalReferenceId(errors, "scheduleId", request.scheduleId, false);

  return errors;
}

export function validateAgentReferenceId(field: string, value: string, pathSafeOnly = false): string[] {
  const errors: string[] = [];
  validateReferenceId(errors, field, value, pathSafeOnly);
  return errors;
}

function validateOptionalTimeoutSeconds(errors: string[], field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_AGENT_RUN_TIMEOUT_SECONDS) {
    errors.push(`${field} must be a whole number between 1 and ${MAX_AGENT_RUN_TIMEOUT_SECONDS}`);
  }
}

function validateOptionalCliToken(errors: string[], field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return;
  }

  if (!value.trim()) {
    errors.push(`${field} must not be empty`);
    return;
  }

  validateBoundedRuntimeString(errors, field, value, MAX_AGENT_CLI_OPTION_CHARS);

  if (value !== value.trim() || /\s/.test(value) || hasControlCharacters(value)) {
    errors.push(`${field} must not contain whitespace or control characters`);
  }
}

function validateReferenceIdList(errors: string[], field: string, value: unknown, pathSafeOnly: boolean): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }

  if (value.length > MAX_AGENT_REFERENCE_IDS) {
    errors.push(`${field} exceeds maximum length of ${MAX_AGENT_REFERENCE_IDS}`);
  }

  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      errors.push(`${field}[${index}] must be a string`);
      continue;
    }

    validateReferenceId(errors, `${field}[${index}]`, item, pathSafeOnly);

    if (seen.has(item)) {
      errors.push(`${field} contains duplicate ids`);
    }
    seen.add(item);
  }
}

function validateOptionalReferenceId(errors: string[], field: string, value: unknown, pathSafeOnly: boolean): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return;
  }

  validateReferenceId(errors, field, value, pathSafeOnly);
}

function validateReferenceId(errors: string[], field: string, value: string, pathSafeOnly: boolean): void {
  if (!value.trim()) {
    errors.push(`${field} is required`);
    return;
  }

  validateBoundedRuntimeString(errors, field, value, MAX_AGENT_REFERENCE_ID_CHARS);

  if (value !== value.trim() || hasControlCharacters(value)) {
    errors.push(`${field} must not contain surrounding whitespace or control characters`);
  }

  if (pathSafeOnly ? !isPathSafeId(value) : !isReferenceSafeId(value)) {
    errors.push(`${field} contains unsupported id characters`);
  }
}

function validateBoundedRuntimeString(errors: string[], field: string, value: string, maxLength: number): void {
  if (Array.from(value).length > maxLength) {
    errors.push(`${field} exceeds maximum length of ${maxLength} characters`);
  }
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function isPathSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isReferenceSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}
