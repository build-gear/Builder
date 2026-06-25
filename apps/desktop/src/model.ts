import {
  createDefaultLayoutProfile,
  MAX_AGENT_REFERENCE_IDS,
  validateAgentReferenceId,
  type AgentRunEvent,
  type AgentRunEventType,
  type AgentRunRequest,
  type ApprovalMode,
  type LayoutPanel,
  type LayoutProfile,
  type SandboxMode
} from "@builder/core/browser";
import { redactLocalPaths, redactSecretLikeText, truncateText } from "./redaction.js";

let localEventSequence = 0;
const REDACTED_EVENT_FIELD = "[REDACTED_EVENT_FIELD]";
const REDACTED_SECRET_FIELD = "[REDACTED_SECRET_FIELD]";
const REDACTED_PATH_FIELD = "[REDACTED_PATH_FIELD]";
const DISPLAY_PAYLOAD_MAX_DEPTH = 8;
const DISPLAY_PAYLOAD_MAX_ARRAY_ITEMS = 80;
const DISPLAY_PAYLOAD_MAX_OBJECT_KEYS = 120;
const DISPLAY_PAYLOAD_TRUNCATED_KEY = "__truncated__";

const EVENT_BODY_FIELD_KEYS = new Set([
  "body",
  "content",
  "contents",
  "eventpayload",
  "instruction",
  "instructions",
  "messagecontent",
  "output",
  "payload",
  "prompt",
  "rawprompt",
  "rawprompts",
  "runpayload",
  "stderr",
  "stdout",
  "systemprompt",
  "text",
  "userprompt"
]);

const PATH_FIELD_KEYS = new Set([
  "cwd",
  "directory",
  "dir",
  "filepath",
  "fileurl",
  "homedir",
  "instructionspath",
  "path",
  "workspacepath"
]);

export function createLocalEventId(now = new Date()): string {
  localEventSequence = (localEventSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `local-${now.getTime()}-${localEventSequence}`;
}

export function createQueuedEvent(request: AgentRunRequest, now = new Date()): AgentRunEvent {
  return {
    runId: createLocalEventId(now),
    type: "queued",
    timestamp: now.toISOString(),
    payload: {
      workspaceSelected: Boolean(request.workspacePath.trim()),
      pathRedacted: true,
      sandboxMode: request.sandboxMode,
      approvalMode: request.approvalMode,
      timeoutSeconds: request.timeoutSeconds,
      skillIds: request.skillIds ?? [],
      ontologyContextIds: request.ontologyContextIds ?? [],
      scheduleId: request.scheduleId
    }
  };
}

export function createInitialLayout(): LayoutProfile {
  return createDefaultLayoutProfile();
}

export function togglePanelVisibility(profile: LayoutProfile, panelId: string): LayoutProfile {
  return {
    ...profile,
    panels: profile.panels.map((panel) => (panel.id === panelId ? { ...panel, visible: !panel.visible } : panel))
  };
}

export function isLayoutPanelVisible(profile: LayoutProfile, kind: LayoutPanel["kind"]): boolean {
  return profile.panels.some((panel) => panel.kind === kind && panel.visible);
}

export function trackRunStarted(activeRunIds: string[], runId: string): string[] {
  if (!runId.trim()) {
    return activeRunIds;
  }

  return [runId, ...activeRunIds.filter((candidate) => candidate !== runId)];
}

export function trackRunFinished(activeRunIds: string[], runId: string): string[] {
  return activeRunIds.filter((candidate) => candidate !== runId);
}

export function activeRunStatus(activeRunCount: number): string {
  if (activeRunCount <= 0) {
    return "Ready";
  }

  return activeRunCount === 1 ? "1 run active" : `${activeRunCount} runs active`;
}

export function settledRunStartStatus(options: {
  currentStatus: string;
  pendingStatus: string;
  queuedStatus: string;
  activeRunIds: string[];
  runId: string;
}): string {
  if (options.activeRunIds.includes(options.runId)) {
    return activeRunStatus(options.activeRunIds.length);
  }

  return options.currentStatus === options.pendingStatus
    ? options.queuedStatus
    : options.currentStatus;
}

export function normalizeStoredEvents(value: unknown): AgentRunEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeStoredEvent)
    .filter((event): event is AgentRunEvent => Boolean(event))
    .map(createPersistedEventSummary);
}

export function normalizeStoredLayout(value: unknown, fallback = createInitialLayout()): LayoutProfile {
  if (!isRecord(value) || value.version !== fallback.version || !Array.isArray(value.panels)) {
    return fallback;
  }

  const storedPanels = new Map(value.panels
    .filter(isRecord)
    .map((panel) => [stringValue(panel.id), panel]));

  return {
    ...fallback,
    id: stringValue(value.id) ?? fallback.id,
    name: stringValue(value.name) ?? fallback.name,
    panels: fallback.panels.map((panel) => {
      const storedPanel = storedPanels.get(panel.id);
      return storedPanel
        ? { ...panel, visible: typeof storedPanel.visible === "boolean" ? storedPanel.visible : panel.visible }
        : panel;
    })
  };
}

export function normalizeStoredRequest(value: unknown, fallback: AgentRunRequest): AgentRunRequest {
  const stored = isRecord(value) ? value : {};

  return {
    ...fallback,
    workspacePath: fallback.workspacePath,
    prompt: "",
    model: persistedCliOptionValue(stored.model),
    profile: persistedCliOptionValue(stored.profile),
    sandboxMode: sandboxModeValue(stored.sandboxMode) ?? fallback.sandboxMode,
    approvalMode: approvalModeValue(stored.approvalMode) ?? fallback.approvalMode,
    timeoutSeconds: timeoutSecondsValue(stored.timeoutSeconds) ?? fallback.timeoutSeconds,
    skillIds: persistedReferenceIdList(stored.skillIds, true) ?? fallback.skillIds,
    ontologyContextIds: persistedReferenceIdList(stored.ontologyContextIds, false) ?? fallback.ontologyContextIds
  };
}

export function createPersistedRequestOptions(request: AgentRunRequest): Partial<AgentRunRequest> {
  return {
    model: persistedCliOptionValue(request.model),
    profile: persistedCliOptionValue(request.profile),
    sandboxMode: request.sandboxMode,
    approvalMode: request.approvalMode,
    timeoutSeconds: timeoutSecondsValue(request.timeoutSeconds),
    skillIds: persistedReferenceIdList(request.skillIds ?? [], true) ?? [],
    ontologyContextIds: persistedReferenceIdList(request.ontologyContextIds ?? [], false) ?? []
  };
}

export function createPersistedEventSummary(event: AgentRunEvent): AgentRunEvent {
  return {
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    payload: persistedPayload(event)
  };
}

function normalizeStoredEvent(value: unknown): AgentRunEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const runId = stringValue(value.runId);
  const timestamp = stringValue(value.timestamp);
  const type = eventTypeValue(value.type);

  if (!runId || !timestamp || !type || Number.isNaN(Date.parse(timestamp))) {
    return undefined;
  }

  return {
    runId,
    type,
    timestamp,
    payload: value.payload
  };
}

export function formatDisplayEventPayload(payload: unknown, maxLength = 3000): string {
  const source = stringifyPayload(sanitizeDisplayPayload(payload));
  const redacted = redactLocalPaths(redactSecretLikeText(source));

  return truncateText(redacted, maxLength);
}

function sanitizeDisplayPayload(payload: unknown): unknown {
  return sanitizeDisplayValue(payload, undefined, 0, new WeakSet<object>());
}

function sanitizeDisplayValue(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
  const field = key ? normalizedFieldKey(key) : "";

  if (isSecretField(field)) {
    return REDACTED_SECRET_FIELD;
  }

  if (EVENT_BODY_FIELD_KEYS.has(field)) {
    return REDACTED_EVENT_FIELD;
  }

  if (isPathField(field)) {
    return sanitizePathFieldValue(value);
  }

  if (typeof value === "string") {
    return redactLocalPaths(redactSecretLikeText(value));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= DISPLAY_PAYLOAD_MAX_DEPTH) {
    return "[Truncated]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, DISPLAY_PAYLOAD_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeDisplayValue(item, undefined, depth + 1, seen));

    if (value.length > DISPLAY_PAYLOAD_MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - DISPLAY_PAYLOAD_MAX_ARRAY_ITEMS} items omitted]`);
    }

    return items;
  }

  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);

  for (const [childKey, childValue] of entries.slice(0, DISPLAY_PAYLOAD_MAX_OBJECT_KEYS)) {
    sanitized[childKey] = sanitizeDisplayValue(childValue, childKey, depth + 1, seen);
  }

  if (entries.length > DISPLAY_PAYLOAD_MAX_OBJECT_KEYS) {
    sanitized[DISPLAY_PAYLOAD_TRUNCATED_KEY] = `${entries.length - DISPLAY_PAYLOAD_MAX_OBJECT_KEYS} fields omitted`;
  }

  return sanitized;
}

function normalizedFieldKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSecretField(field: string): boolean {
  return field.includes("apikey") ||
    field.includes("credential") ||
    field.includes("password") ||
    field.includes("privatekey") ||
    field.includes("secret") ||
    field === "token" ||
    field.endsWith("token");
}

function isPathField(field: string): boolean {
  if (field === "pathredacted" || field === "pathfingerprint") {
    return false;
  }

  return PATH_FIELD_KEYS.has(field) ||
    field.endsWith("path") ||
    field.endsWith("filepath") ||
    field.endsWith("fileurl") ||
    field.endsWith("dir") ||
    field.endsWith("directory") ||
    field.endsWith("url");
}

function sanitizePathFieldValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return REDACTED_PATH_FIELD;
  }

  const redacted = redactLocalPaths(redactSecretLikeText(value));

  if (redacted !== value) {
    return redacted;
  }

  if (/^(?:file:\/\/|\/|[A-Za-z]:\\|~\/)/.test(value)) {
    return "[LOCAL_PATH]";
  }

  return redacted;
}

function persistedPayload(event: AgentRunEvent): unknown {
  const payload = asRecord(event.payload);

  switch (event.type) {
    case "queued":
      return {
        sandboxMode: stringField(payload, "sandboxMode"),
        approvalMode: stringField(payload, "approvalMode"),
        timeoutSeconds: numberField(payload, "timeoutSeconds"),
        skillCount: arrayLengthField(payload, "skillIds"),
        ontologyContextCount: arrayLengthField(payload, "ontologyContextIds"),
        scheduleId: stringField(payload, "scheduleId")
      };
    case "done":
      return {
        exitCode: numberField(payload, "exitCode")
      };
    case "error":
      return {
        exitCode: numberField(payload, "exitCode"),
        cancelled: Boolean(payload.cancelled),
        timedOut: Boolean(payload.timedOut),
        message: safeMessage(typeof payload.message === "string" ? payload.message : "Run failed")
      };
    case "codex_event":
      return {
        summary: "Codex JSON event payload redacted from persisted history",
        codexType: stringField(payload, "type")
      };
    case "stdout":
    case "stderr":
      return {
        summary: `${event.type} payload redacted from persisted history`,
        byteLength: payloadByteLength(event.payload)
      };
    case "artifact":
      return {
        summary: "Artifact payload redacted from persisted history"
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function persistedCliOptionValue(value: unknown): string | undefined {
  const source = stringValue(value);

  if (!source) {
    return undefined;
  }

  const redacted = redactLocalPaths(redactSecretLikeText(source));
  if (source !== source.trim() || redacted !== source) {
    return undefined;
  }

  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(source) ? source : undefined;
}

function persistedReferenceIdList(value: unknown, pathSafeOnly: boolean): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const normalized = item.trim();
    if (
      !normalized ||
      seen.has(normalized) ||
      validateAgentReferenceId("id", normalized, pathSafeOnly).length > 0
    ) {
      continue;
    }

    seen.add(normalized);
    items.push(normalized);

    if (items.length >= MAX_AGENT_REFERENCE_IDS) {
      break;
    }
  }

  return items;
}

function eventTypeValue(value: unknown): AgentRunEventType | undefined {
  return value === "queued" ||
    value === "codex_event" ||
    value === "stdout" ||
    value === "stderr" ||
    value === "artifact" ||
    value === "error" ||
    value === "done"
    ? value
    : undefined;
}

function sandboxModeValue(value: unknown): SandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function approvalModeValue(value: unknown): ApprovalMode | undefined {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never"
    ? value
    : undefined;
}

function timeoutSecondsValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 86_400
    ? value
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const child = value[key];
  return typeof child === "string" && child.trim() ? redactSecretLikeText(child) : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const child = value[key];
  return typeof child === "number" ? child : undefined;
}

function arrayLengthField(value: Record<string, unknown>, key: string): number {
  const child = value[key];
  return Array.isArray(child) ? child.length : 0;
}

function payloadByteLength(value: unknown): number {
  return typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
}

function safeMessage(message: string): string {
  const redacted = redactLocalPaths(redactSecretLikeText(message));
  return truncateText(redacted, 500);
}

function stringifyPayload(payload: unknown): string {
  const seen = new WeakSet<object>();

  try {
    const stringified = JSON.stringify(payload, (_key, value) => {
      if (!value || typeof value !== "object") {
        return value;
      }

      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
      return value;
    }, 2);

    return stringified ?? String(payload);
  } catch {
    return String(payload);
  }
}
