export const ONTOLOGY_ENTITY_TYPES = [
  "Profession",
  "Workspace",
  "Project",
  "Goal",
  "Task",
  "Artifact",
  "Tool",
  "Skill",
  "Schedule",
  "Run"
] as const;

export type OntologyEntityType = (typeof ONTOLOGY_ENTITY_TYPES)[number];

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ApprovalMode = "untrusted" | "on-failure" | "on-request" | "never";

export type AgentRunEventType =
  | "queued"
  | "codex_event"
  | "stdout"
  | "stderr"
  | "artifact"
  | "error"
  | "done";

export interface AgentRunRequest {
  workspacePath: string;
  prompt: string;
  model?: string;
  profile?: string;
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  timeoutSeconds?: number;
  skillIds?: string[];
  ontologyContextIds?: string[];
  scheduleId?: string;
}

export interface AgentRunEvent {
  runId: string;
  type: AgentRunEventType;
  timestamp: string;
  payload: unknown;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  occupations: string[];
  inputsJsonSchema: Record<string, unknown>;
  instructionsPath: string;
  requiredTools: string[];
  uiPanels?: string[];
  scheduleTemplates?: ScheduleSpec[];
}

export type ScheduleTrigger =
  | { kind: "once"; runAt: string }
  | { kind: "interval"; everySeconds: number }
  | { kind: "cron"; expression: string };

export type MissedRunPolicy = "run-on-start" | "skip";

export interface ScheduleSpec {
  id: string;
  name: string;
  trigger: ScheduleTrigger;
  timezone: string;
  runRequest: AgentRunRequest;
  missedRunPolicy: MissedRunPolicy;
  enabled: boolean;
}

export interface OntologyRelation {
  type: string;
  targetId: string;
}

export interface OntologyEntity {
  id: string;
  type: OntologyEntityType;
  label: string;
  properties: Record<string, unknown>;
  relations: OntologyRelation[];
}

export interface LayoutPanel {
  id: string;
  title: string;
  kind: "runs" | "skills" | "ontology" | "schedules" | "artifacts" | "logs";
  region: "left" | "main" | "right" | "bottom";
  visible: boolean;
}

export interface LayoutProfile {
  id: string;
  name: string;
  version: number;
  panels: LayoutPanel[];
}

export type HealthCheckStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthCheckStatus;
  message: string;
  action?: string;
}

export interface HealthReport {
  generatedAt: string;
  status: HealthCheckStatus;
  checks: HealthCheck[];
}

export interface SupportBundlePlatform {
  os: string;
  arch: string;
  node: string;
}

export interface SupportBundleWorkspace {
  selected: boolean;
  basename?: string;
  pathFingerprint: string;
  pathRedacted: true;
}

export interface SupportBundlePrivacy {
  redacted: true;
  includesAuthContents: false;
  includesRawPrompts: false;
  includesWorkspacePaths: false;
  includesRunPayloads: false;
}

export interface SupportBundle {
  schemaVersion: 1;
  generatedAt: string;
  appVersion: string;
  platform: SupportBundlePlatform;
  workspace: SupportBundleWorkspace;
  health: HealthReport;
  diagnostics?: unknown;
  privacy: SupportBundlePrivacy;
}
