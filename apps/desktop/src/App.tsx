import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AlertTriangle,
  Archive,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CirclePlus,
  Command as CommandIcon,
  Cpu,
  Database,
  Download,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LifeBuoy,
  Mic,
  PanelLeft,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Store,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import {
  ONTOLOGY_ENTITY_TYPES,
  validateAgentRunRequest,
  type AgentRunEvent,
  type AgentRunRequest,
  type HealthReport,
  type LayoutProfile,
  type MissedRunPolicy,
  type OntologyEntity,
  type ScheduleSpec,
  type ScheduleTrigger,
  type SkillManifest
} from "@builder/core/browser";
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
import { isRetryableRunError, snapshotRunRequest } from "./retry.js";
import { installGlobalRuntimeErrorHandlers } from "./runtime-errors.js";
import { isBrowserPreviewRuntime } from "./runtime.js";
import { runUpdaterFlow, updaterErrorMessage } from "./update.js";
import { redactSensitiveText, truncateText } from "./redaction.js";

interface CliInfo {
  codexAvailable: boolean;
  codexVersion?: string;
  authPath: string;
  authExists: boolean;
  authChecked?: boolean;
  defaultWorkspacePath?: string;
}

interface BuilderCatalog {
  skills: SkillManifest[];
  ontology: OntologyEntity[];
  schedules: ScheduleSpec[];
}

interface ScheduleTickResult {
  checkedAt: string;
  scheduleCount: number;
  queuedRunIds: string[];
  skippedScheduleIds: string[];
  errors: string[];
}

interface SkillSource {
  manifest: SkillManifest;
  instructions: string;
}

interface DiagnosticsReportResult {
  path: string;
  pathRedacted: boolean;
  report: unknown;
}

interface SupportBundleResult {
  path: string;
  pathRedacted: boolean;
  bundle: unknown;
}

interface WorkspaceBackupSummary {
  name: string;
  relativePath: string;
  kind: string;
  createdAt?: string;
  sizeBytes: number;
  entryCount: number;
  directory: boolean;
  targetRelativePath?: string;
}

interface RestoreWorkspaceBackupResult {
  restored: WorkspaceBackupSummary;
  targetRelativePath: string;
  preRestoreBackup?: WorkspaceBackupSummary;
}

interface PruneWorkspaceBackupsResult {
  keep: number;
  dryRun: boolean;
  retained: WorkspaceBackupSummary[];
  candidates: WorkspaceBackupSummary[];
  pruned: WorkspaceBackupSummary[];
}

type View = "runs" | "skills" | "ontology" | "schedules" | "backups" | "layout";
type OntologyDraft = Pick<OntologyEntity, "id" | "type" | "label">;
type ScheduleTriggerKind = ScheduleTrigger["kind"];
interface SkillDraft {
  id: string;
  name: string;
  version: string;
  occupationsText: string;
  requiredToolsText: string;
  instructions: string;
}
interface ScheduleDraft {
  id: string;
  name: string;
  triggerKind: ScheduleTriggerKind;
  intervalSeconds: string;
  runAt: string;
  cronExpression: string;
  timezone: string;
  missedRunPolicy: MissedRunPolicy;
  enabled: boolean;
  prompt: string;
  sandboxMode: AgentRunRequest["sandboxMode"];
  approvalMode: AgentRunRequest["approvalMode"];
  timeoutSeconds: string;
}

const EVENTS_STORAGE_KEY = "builder-gear.events.v1";
const LAYOUT_STORAGE_KEY = "builder-gear.layout.v1";
const REQUEST_STORAGE_KEY = "builder-gear.request.v1";
const MAX_BROWSER_STATE_CHARS = 512_000;
const MAX_STORED_EVENTS = 80;
const SCHEDULE_TICK_MS = 60_000;
const RUN_EVENT_NAME = "builder://run-event";
const DEFAULT_REQUEST: AgentRunRequest = {
  workspacePath: "",
  prompt: "",
  sandboxMode: "workspace-write",
  approvalMode: "never",
  skillIds: ["build-plan"],
  ontologyContextIds: ["goal-mvp"]
};

const previewCatalog: BuilderCatalog = {
  skills: [
    {
      id: "research-brief",
      name: "Research Brief",
      version: "0.1.0",
      occupations: ["analyst", "planner"],
      inputsJsonSchema: { type: "object" },
      instructionsPath: "instructions.md",
      requiredTools: ["codex", "web"]
    },
    {
      id: "build-plan",
      name: "Build Plan",
      version: "0.1.0",
      occupations: ["developer", "operator", "designer"],
      inputsJsonSchema: { type: "object" },
      instructionsPath: "instructions.md",
      requiredTools: ["codex", "git"]
    }
  ],
  ontology: [
    {
      id: "profession-builder",
      type: "Profession",
      label: "Professional Builder",
      properties: { audience: "cross-functional" },
      relations: [{ type: "uses", targetId: "skill-build-plan" }]
    },
    {
      id: "goal-mvp",
      type: "Goal",
      label: "Ship Builder Gear MVP",
      properties: { status: "active" },
      relations: [{ type: "contains", targetId: "task-cli-first" }]
    },
    {
      id: "task-cli-first",
      type: "Task",
      label: "Codex CLI-first execution",
      properties: { owner: "core" },
      relations: [{ type: "produces", targetId: "artifact-run-events" }]
    }
  ],
  schedules: [
    {
      id: "morning-build",
      name: "Morning Build Plan",
      trigger: { kind: "interval", everySeconds: 86400 },
      timezone: "Asia/Seoul",
      missedRunPolicy: "run-on-start",
      enabled: true,
      runRequest: {
        workspacePath: ".",
        prompt: "Create the daily build plan",
        sandboxMode: "read-only",
        approvalMode: "never",
        skillIds: ["build-plan"],
        ontologyContextIds: ["goal-mvp"]
      }
    }
  ]
};

const emptyCatalog: BuilderCatalog = {
  skills: [],
  ontology: [],
  schedules: []
};

export function App() {
  const [activeView, setActiveView] = useState<View>("runs");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [request, setRequest] = useState<AgentRunRequest>(readStoredRequest);
  const [events, setEvents] = useState<AgentRunEvent[]>(readStoredEvents);
  const [layout, setLayout] = useState<LayoutProfile>(readStoredLayout);
  const [catalog, setCatalog] = useState<BuilderCatalog>(emptyCatalog);
  const [catalogStatus, setCatalogStatus] = useState("Loading catalog");
  const [catalogError, setCatalogError] = useState<string | undefined>();
  const [scheduleStatus, setScheduleStatus] = useState("Scheduler idle");
  const [cliInfo, setCliInfo] = useState<CliInfo | undefined>();
  const [status, setStatus] = useState("Ready");
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const [runStartPending, setRunStartPending] = useState(false);
  const [retryRunId, setRetryRunId] = useState<string | undefined>();
  const [retryRunRequest, setRetryRunRequest] = useState<AgentRunRequest | undefined>();
  const [ontologyDraft, setOntologyDraft] = useState<OntologyDraft>(createEmptyOntologyDraft);
  const [editingOntologyId, setEditingOntologyId] = useState<string | undefined>();
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(createEmptySkillDraft);
  const [editingSkillId, setEditingSkillId] = useState<string | undefined>();
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(createEmptyScheduleDraft);
  const [editingScheduleId, setEditingScheduleId] = useState<string | undefined>();
  const [workspaceBackups, setWorkspaceBackups] = useState<WorkspaceBackupSummary[]>([]);
  const [workspaceBackupsLoaded, setWorkspaceBackupsLoaded] = useState(false);
  const [backupKeepCount, setBackupKeepCount] = useState("50");
  const [backupBusy, setBackupBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [prunePreview, setPrunePreview] = useState<PruneWorkspaceBackupsResult | undefined>();
  const runRequestsRef = useRef<Record<string, AgentRunRequest>>({});
  const pendingStartRequestRef = useRef<AgentRunRequest | undefined>();
  const activeRunIdsRef = useRef<string[]>([]);
  const lastSchedulerErrorRef = useRef<string | undefined>();
  const storageWarningRef = useRef(false);
  const eventBridgeUnavailableRef = useRef(false);

  useEffect(() => {
    invoke<CliInfo>("builder_cli_info")
      .then((info) => {
        setCliInfo(info);
        applyDefaultWorkspace(info.defaultWorkspacePath);
      })
      .catch((error) => {
        if (!isBrowserPreviewRuntime()) {
          const message = error instanceof Error ? error.message : String(error);
          setCliInfo({
            codexAvailable: false,
            authPath: "Unavailable",
            authExists: false,
            authChecked: true
          });
          setEvents((current) => appendEvents([createErrorEvent(message, "runtime")], current));
          setStatus("Desktop bridge failed");
          return;
        }

        const previewInfo = {
          codexAvailable: false,
          codexVersion: "Browser preview",
          authPath: "codex auth file (auth.json)",
          authExists: false,
          authChecked: false,
          defaultWorkspacePath: "."
        };
        setCliInfo(previewInfo);
        applyDefaultWorkspace(previewInfo.defaultWorkspacePath);
      });
  }, []);

  useEffect(() => installGlobalRuntimeErrorHandlers(window, (message) => {
    setEvents((current) => appendEvents([createErrorEvent(message, "runtime")], current));
    setStatus("Runtime warning");
  }), []);

  useEffect(() => {
    let active = true;

    invoke<AgentRunEvent[]>("builder_list_run_events")
      .then((storedEvents) => {
        if (active) {
          setEvents(storedEvents);
        }
      })
      .catch((error) => {
        if (!active || isBrowserPreviewRuntime()) {
          // Browser preview keeps the localStorage-backed event list.
          return;
        }

        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error), "history")
        ], current));
        setStatus("History load failed");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    loadCatalogForWorkspace(request.workspacePath, () => active);

    return () => {
      active = false;
    };
  }, [request.workspacePath]);

  useEffect(() => {
    let active = true;

    async function tickSchedules() {
      try {
        const result = await invoke<ScheduleTickResult>("builder_tick_schedules", {
          request: { workspacePath: request.workspacePath }
        });

        if (!active) {
          return;
        }

        if (result.errors.length > 0) {
          setScheduleStatus("Scheduler error");
          recordSchedulerError(result.errors.join("; "));
          return;
        }

        lastSchedulerErrorRef.current = undefined;

        if (result.queuedRunIds.length > 0) {
          setScheduleStatus(`${result.queuedRunIds.length} queued`);
          setStatus("Scheduled run queued");
          return;
        }

        if (result.skippedScheduleIds.length > 0) {
          setScheduleStatus(`${result.skippedScheduleIds.length} skipped`);
          return;
        }

        setScheduleStatus(`${result.scheduleCount} watched`);
      } catch (error) {
        if (active) {
          if (isBrowserPreviewRuntime()) {
            setScheduleStatus("Preview scheduler");
          } else {
            setScheduleStatus("Scheduler offline");
            recordSchedulerError(error instanceof Error ? error.message : String(error));
          }
        }
      }
    }

    tickSchedules();
    const intervalId = window.setInterval(tickSchedules, SCHEDULE_TICK_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [request.workspacePath]);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;

    listen<AgentRunEvent>(RUN_EVENT_NAME, (message) => {
      const runEvent = message.payload;
      setEvents((current) => appendEvents([runEvent], current));

      if (runEvent.type === "queued") {
        if (pendingStartRequestRef.current) {
          runRequestsRef.current[runEvent.runId] = pendingStartRequestRef.current;
          pendingStartRequestRef.current = undefined;
        }

        setRunStartPending(false);
        setStatus(activeRunStatus(rememberRunStarted(runEvent.runId).length));
      }

      if (runEvent.type === "done") {
        delete runRequestsRef.current[runEvent.runId];
        setRunStartPending(false);
        const next = rememberRunFinished(runEvent.runId);
        setStatus(next.length > 0 ? `Run complete; ${activeRunStatus(next.length)}` : "Run complete");
      }

      if (runEvent.type === "error") {
        const rememberedRequest = runRequestsRef.current[runEvent.runId];
        delete runRequestsRef.current[runEvent.runId];

        if (rememberedRequest && isRetryableRunError(runEvent)) {
          setRetryRunId(runEvent.runId);
          setRetryRunRequest(rememberedRequest);
        }

        setRunStartPending(false);
        const next = rememberRunFinished(runEvent.runId);
        const baseStatus = isCancelledEvent(runEvent) ? "Run cancelled" : "Run failed";
        setStatus(next.length > 0 ? `${baseStatus}; ${activeRunStatus(next.length)}` : baseStatus);
      }
    })
      .then((unlisten) => {
        if (active) {
          cleanup = unlisten;
        } else {
          unlisten();
        }
      })
      .catch((error) => {
        if (!active || isBrowserPreviewRuntime()) {
          return;
        }

        eventBridgeUnavailableRef.current = true;
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error), "event-bridge")
        ], current));
      });

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    warnIfStorageWriteFailed(writeStoredValue(
      EVENTS_STORAGE_KEY,
      events.slice(0, MAX_STORED_EVENTS).map(createPersistedEventSummary)
    ));
  }, [events]);

  useEffect(() => {
    warnIfStorageWriteFailed(writeStoredValue(LAYOUT_STORAGE_KEY, layout));
  }, [layout]);

  useEffect(() => {
    warnIfStorageWriteFailed(writeStoredValue(REQUEST_STORAGE_KEY, createPersistedRequestOptions(request)));
  }, [request]);

  const visiblePanels = useMemo(() => layout.panels.filter((panel) => panel.visible), [layout.panels]);
  const runsPanelVisible = isLayoutPanelVisible(layout, "runs");
  const skillsPanelVisible = isLayoutPanelVisible(layout, "skills");
  const ontologyPanelVisible = isLayoutPanelVisible(layout, "ontology");
  const schedulesPanelVisible = isLayoutPanelVisible(layout, "schedules");
  const artifactsPanelVisible = isLayoutPanelVisible(layout, "artifacts");
  const logsPanelVisible = isLayoutPanelVisible(layout, "logs");
  const activeRunId = activeRunIds[0];
  const activeRunCount = activeRunIds.length;
  const isRunning = activeRunCount > 0;
  const runControlBusy = runStartPending || isRunning;
  const authChecked = cliInfo?.authChecked ?? true;
  const authReady = authChecked && Boolean(cliInfo?.authExists);
  const authLabel = authChecked ? (authReady ? "Codex Auth" : "No Auth") : "Preview";
  const runtimeSubline = authChecked ? (authReady ? "Auth file ready" : "Auth missing") : "Desktop bridge offline";

  function applyDefaultWorkspace(defaultWorkspacePath?: string) {
    const nextWorkspacePath = defaultWorkspacePath?.trim();
    if (!nextWorkspacePath) {
      return;
    }

    setRequest((current) => (
      current.workspacePath.trim()
        ? current
        : { ...current, workspacePath: nextWorkspacePath }
    ));
  }

  function rememberRunStarted(runId: string): string[] {
    const next = trackRunStarted(activeRunIdsRef.current, runId);
    activeRunIdsRef.current = next;
    setActiveRunIds(next);
    return next;
  }

  function rememberRunFinished(runId: string): string[] {
    const next = trackRunFinished(activeRunIdsRef.current, runId);
    activeRunIdsRef.current = next;
    setActiveRunIds(next);
    return next;
  }

  function recordSchedulerError(message: string) {
    const nextMessage = message.trim() || "Scheduler error";

    if (lastSchedulerErrorRef.current === nextMessage) {
      return;
    }

    lastSchedulerErrorRef.current = nextMessage;
    setEvents((current) => appendEvents([
      createErrorEvent(nextMessage, "scheduler")
    ], current));
  }

  function warnIfStorageWriteFailed(succeeded: boolean) {
    if (succeeded || storageWarningRef.current) {
      return;
    }

    storageWarningRef.current = true;
    setStatus("Local state not persisted");
    setEvents((current) => appendEvents([
      createErrorEvent("Browser storage rejected local state persistence", "storage")
    ], current));
  }

  async function queueRun() {
    await startRun(request, "Starting");
  }

  async function retryFailedRun() {
    if (!retryRunRequest) {
      return;
    }

    const retryRequest = snapshotRunRequest(retryRunRequest);
    setRequest(retryRequest);
    setRetryRunId(undefined);
    setRetryRunRequest(undefined);
    await startRun(retryRequest, "Retrying");
  }

  async function startRun(runRequest: AgentRunRequest, startingStatus: string) {
    if (runControlBusy) {
      return;
    }

    if (eventBridgeUnavailableRef.current && !isBrowserPreviewRuntime()) {
      setEvents((current) => appendEvents([
        createErrorEvent("Run event bridge is unavailable; refusing to start an unobservable run", "event-bridge")
      ], current));
      setStatus("Event bridge unavailable");
      return;
    }

    const snapshot = snapshotRunRequest(runRequest);
    const errors = validateAgentRunRequest(snapshot);

    if (errors.length > 0) {
      setEvents((current) => appendEvents([createErrorEvent(errors.join("; "))], current));
      setStatus("Request invalid");
      return;
    }

    setRunStartPending(true);
    setStatus(startingStatus);
    pendingStartRequestRef.current = snapshot;

    try {
      const runId = await invoke<string>("builder_start_codex_run", { request: snapshot });
      runRequestsRef.current[runId] = snapshot;
      setRunStartPending(false);
      setStatus((currentStatus) => settledRunStartStatus({
        currentStatus,
        pendingStatus: startingStatus,
        queuedStatus: "Run queued",
        activeRunIds: activeRunIdsRef.current,
        runId
      }));
    } catch (error) {
      pendingStartRequestRef.current = undefined;
      setRunStartPending(false);

      if (!isBrowserPreviewRuntime()) {
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error))
        ], current));
        setStatus("Run failed");
        return;
      }

      setEvents((current) => appendEvents([createQueuedEvent(snapshot)], current));
      setStatus("Run queued");

      try {
        const preview = await invoke("builder_codex_invocation", { request: snapshot });
        const now = new Date();
        setEvents((current) => appendEvents([
          createArtifactEvent(preview, now)
        ], current));
      } catch {
        // Browser dev mode has no Tauri IPC; the queued event remains useful for UI testing.
      }
    }
  }

  async function cancelRun() {
    if (!activeRunId) {
      return;
    }

    setStatus("Cancelling");

    try {
      await invoke("builder_cancel_codex_run", { runId: activeRunId });
    } catch (error) {
      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      rememberRunFinished(activeRunId);
      setStatus("Cancel failed");
    } finally {
      if (activeRunId) {
        delete runRequestsRef.current[activeRunId];
      }
    }
  }

  async function clearEvents() {
    if (!window.confirm("Clear run event history? Persisted run summaries will be deleted.")) {
      setStatus("History clear cancelled");
      return;
    }

    try {
      await invoke("builder_clear_run_events");
    } catch (error) {
      if (!isBrowserPreviewRuntime()) {
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error), "history")
        ], current));
        setStatus("History clear failed");
        return;
      }

      // Browser preview has no native history store; clear the visible local state anyway.
    }

    setEvents([]);
    setStatus("History cleared");
  }

  async function previewInvocation() {
    try {
      const preview = await invoke("builder_codex_invocation", { request });
      const now = new Date();
      setEvents((current) => appendEvents([
        createArtifactEvent(preview, now)
      ], current));
    } catch (error) {
      if (!isBrowserPreviewRuntime()) {
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error), "invocation")
        ], current));
        setStatus("Invocation preview failed");
        return;
      }

      setEvents((current) => appendEvents([createQueuedEvent(request)], current));
    }
  }

  async function saveSchedules(nextSchedules: ScheduleSpec[], successStatus: string): Promise<boolean> {
    try {
      const loadedCatalog = await invoke<BuilderCatalog>("builder_save_schedules", {
        request: {
          workspacePath: request.workspacePath,
          schedules: nextSchedules
        }
      });
      setCatalog(loadedCatalog);
      setCatalogStatus("Workspace catalog");
      setCatalogError(undefined);
      setStatus(successStatus);
      return true;
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        setCatalog((current) => ({ ...current, schedules: nextSchedules }));
        setStatus(successStatus);
        return true;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Schedule save failed");
      return false;
    }
  }

  async function toggleSchedule(schedule: ScheduleSpec) {
    const nextSchedules = catalog.schedules.map((candidate) => (
      candidate.id === schedule.id ? { ...candidate, enabled: !candidate.enabled } : candidate
    ));
    await saveSchedules(nextSchedules, schedule.enabled ? "Schedule disabled" : "Schedule enabled");
  }

  async function deleteSchedule(schedule: ScheduleSpec) {
    if (!window.confirm(`Delete schedule ${schedule.name}? A recovery backup will be created first.`)) {
      setStatus("Schedule delete cancelled");
      return;
    }

    const nextSchedules = catalog.schedules.filter((candidate) => candidate.id !== schedule.id);
    if (editingScheduleId === schedule.id) {
      resetScheduleDraft();
    }
    await saveSchedules(nextSchedules, "Schedule deleted");
  }

  async function prepareWorkspace() {
    try {
      const loadedCatalog = await invoke<BuilderCatalog>("builder_prepare_workspace", {
        request: {
          workspacePath: request.workspacePath
        }
      });
      setCatalog(loadedCatalog);
      setCatalogStatus("Workspace catalog");
      setCatalogError(undefined);
      setStatus("Workspace prepared");
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        setCatalog(previewCatalog);
        setCatalogStatus("Preview catalog");
        setCatalogError(undefined);
        setStatus("Workspace prepared");
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Workspace prepare failed");
    }
  }

  async function saveScheduleDraft() {
    const id = scheduleDraft.id.trim();
    const name = scheduleDraft.name.trim();
    const prompt = scheduleDraft.prompt.trim();

    if (!id || !name || !prompt) {
      setEvents((current) => appendEvents([createErrorEvent("Schedule id, name, and prompt are required")], current));
      setStatus("Schedule invalid");
      return;
    }

    const replacingDifferentSchedule = catalog.schedules.some((schedule) => schedule.id === id && schedule.id !== editingScheduleId);
    if (replacingDifferentSchedule) {
      setEvents((current) => appendEvents([createErrorEvent(`Schedule id already exists: ${id}`)], current));
      setStatus("Schedule invalid");
      return;
    }

    const triggerResult = scheduleTriggerFromDraft(scheduleDraft);
    if ("error" in triggerResult) {
      setEvents((current) => appendEvents([createErrorEvent(triggerResult.error)], current));
      setStatus("Schedule invalid");
      return;
    }

    const runRequest = snapshotRunRequest({
      workspacePath: request.workspacePath,
      prompt,
      sandboxMode: scheduleDraft.sandboxMode,
      approvalMode: scheduleDraft.approvalMode,
      timeoutSeconds: timeoutSecondsFromInput(scheduleDraft.timeoutSeconds),
      model: request.model,
      profile: request.profile,
      skillIds: request.skillIds ?? [],
      ontologyContextIds: request.ontologyContextIds ?? []
    });
    const runRequestErrors = validateAgentRunRequest(runRequest);
    if (runRequestErrors.length > 0) {
      setEvents((current) => appendEvents([createErrorEvent(runRequestErrors.join("; "))], current));
      setStatus("Schedule invalid");
      return;
    }

    const schedule: ScheduleSpec = {
      id,
      name,
      trigger: triggerResult.trigger,
      timezone: scheduleDraft.timezone.trim() || "UTC",
      missedRunPolicy: scheduleDraft.missedRunPolicy,
      enabled: scheduleDraft.enabled,
      runRequest
    };
    const nextSchedules = catalog.schedules
      .filter((candidate) => candidate.id !== editingScheduleId && candidate.id !== id)
      .concat(schedule);
    const saved = await saveSchedules(nextSchedules, editingScheduleId ? "Schedule updated" : "Schedule created");

    if (saved) {
      setEditingScheduleId(undefined);
      setScheduleDraft(createEmptyScheduleDraft());
    }
  }

  function editSchedule(schedule: ScheduleSpec) {
    setEditingScheduleId(schedule.id);
    setScheduleDraft(scheduleDraftFromSpec(schedule));
    setStatus("Editing schedule");
  }

  function resetScheduleDraft() {
    setEditingScheduleId(undefined);
    setScheduleDraft(createEmptyScheduleDraft());
    setStatus("Schedule draft reset");
  }

  async function saveSkillDraft() {
    const id = skillDraft.id.trim();
    const name = skillDraft.name.trim();
    const instructions = skillDraft.instructions.trim();

    if (!id || !name || !instructions) {
      setEvents((current) => appendEvents([createErrorEvent("Skill id, name, and instructions are required")], current));
      setStatus("Skill invalid");
      return;
    }

    const replacingDifferentSkill = catalog.skills.some((skill) => skill.id === id && skill.id !== editingSkillId);
    if (replacingDifferentSkill) {
      setEvents((current) => appendEvents([createErrorEvent(`Skill id already exists: ${id}`)], current));
      setStatus("Skill invalid");
      return;
    }

    const manifest: SkillManifest = {
      id,
      name,
      version: skillDraft.version.trim() || "0.1.0",
      occupations: parseCsvList(skillDraft.occupationsText),
      inputsJsonSchema: { type: "object", additionalProperties: true },
      instructionsPath: "instructions.md",
      requiredTools: parseCsvList(skillDraft.requiredToolsText),
      uiPanels: ["runs", "skills"]
    };

    try {
      const loadedCatalog = await invoke<BuilderCatalog>("builder_save_skill", {
        request: {
          workspacePath: request.workspacePath,
          originalId: editingSkillId,
          manifest,
          instructions: skillDraft.instructions
        }
      });
      setCatalog(loadedCatalog);
      setCatalogStatus("Workspace catalog");
      setCatalogError(undefined);
      setStatus(editingSkillId ? "Skill updated" : "Skill created");
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        const nextSkills = catalog.skills
          .filter((skill) => skill.id !== editingSkillId && skill.id !== id)
          .concat(manifest)
          .sort((left, right) => left.id.localeCompare(right.id));
        setCatalog((current) => ({ ...current, skills: nextSkills }));
        setStatus(editingSkillId ? "Skill updated" : "Skill created");
      } else {
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error))
        ], current));
        setStatus("Skill save failed");
        return;
      }
    }

    setEditingSkillId(undefined);
    setSkillDraft(createEmptySkillDraft());
  }

  async function editSkill(skill: SkillManifest) {
    try {
      const source = await invoke<SkillSource>("builder_load_skill_source", {
        request: {
          workspacePath: request.workspacePath,
          skillId: skill.id
        }
      });
      setEditingSkillId(source.manifest.id);
      setSkillDraft(skillDraftFromManifest(source.manifest, source.instructions));
      setStatus("Editing skill");
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        setEditingSkillId(skill.id);
        setSkillDraft(skillDraftFromManifest(skill, `# ${skill.name}\n\nDescribe how this skill should guide a Builder Gear run.\n`));
        setStatus("Editing skill");
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Skill load failed");
    }
  }

  async function deleteSkill(skill: SkillManifest) {
    if (!window.confirm(`Delete skill ${skill.name}? A recovery backup will be created first.`)) {
      setStatus("Skill delete cancelled");
      return;
    }

    try {
      const loadedCatalog = await invoke<BuilderCatalog>("builder_delete_skill", {
        request: {
          workspacePath: request.workspacePath,
          skillId: skill.id
        }
      });
      setCatalog(loadedCatalog);
      setCatalogStatus("Workspace catalog");
      setCatalogError(undefined);
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        setCatalog((current) => ({
          ...current,
          skills: current.skills.filter((candidate) => candidate.id !== skill.id)
        }));
      } else {
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error))
        ], current));
        setStatus("Skill delete failed");
        return;
      }
    }

    setRequest((current) => ({
      ...current,
      skillIds: (current.skillIds ?? []).filter((id) => id !== skill.id)
    }));
    setStatus("Skill deleted");
  }

  function resetSkillDraft() {
    setEditingSkillId(undefined);
    setSkillDraft(createEmptySkillDraft());
    setStatus("Skill draft reset");
  }

  async function saveOntology(nextOntology: OntologyEntity[], successStatus: string) {
    try {
      const loadedCatalog = await invoke<BuilderCatalog>("builder_save_ontology", {
        request: {
          workspacePath: request.workspacePath,
          ontology: nextOntology
        }
      });
      setCatalog(loadedCatalog);
      setCatalogStatus("Workspace catalog");
      setCatalogError(undefined);
      setStatus(successStatus);
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        setCatalog((current) => ({ ...current, ontology: nextOntology }));
        setStatus(successStatus);
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Ontology save failed");
    }
  }

  async function saveOntologyDraft() {
    const id = ontologyDraft.id.trim();
    const label = ontologyDraft.label.trim();

    if (!id || !label) {
      setEvents((current) => appendEvents([createErrorEvent("Ontology id and label are required")], current));
      setStatus("Ontology invalid");
      return;
    }

    const existing = editingOntologyId
      ? catalog.ontology.find((entity) => entity.id === editingOntologyId)
      : undefined;
    const nextEntity: OntologyEntity = {
      id,
      type: ontologyDraft.type,
      label,
      properties: existing?.properties ?? {},
      relations: existing?.relations ?? []
    };
    const withoutCurrent = catalog.ontology.filter((entity) => entity.id !== editingOntologyId && entity.id !== id);
    const replacingDifferentEntity = catalog.ontology.some((entity) => entity.id === id && entity.id !== editingOntologyId);

    if (replacingDifferentEntity) {
      setEvents((current) => appendEvents([createErrorEvent(`Ontology id already exists: ${id}`)], current));
      setStatus("Ontology invalid");
      return;
    }

    await saveOntology([...withoutCurrent, nextEntity], editingOntologyId ? "Ontology updated" : "Ontology created");
    setEditingOntologyId(undefined);
    setOntologyDraft(createEmptyOntologyDraft());
  }

  function editOntologyEntity(entity: OntologyEntity) {
    setEditingOntologyId(entity.id);
    setOntologyDraft({ id: entity.id, type: entity.type, label: entity.label });
    setStatus("Editing ontology");
  }

  function resetOntologyDraft() {
    setEditingOntologyId(undefined);
    setOntologyDraft(createEmptyOntologyDraft());
    setStatus("Ontology draft reset");
  }

  async function deleteOntologyEntity(entity: OntologyEntity) {
    if (!window.confirm(`Delete ontology entity ${entity.label}? A recovery backup will be created first.`)) {
      setStatus("Ontology delete cancelled");
      return;
    }

    const nextOntology = catalog.ontology.filter((candidate) => candidate.id !== entity.id);
    setRequest((current) => ({
      ...current,
      ontologyContextIds: (current.ontologyContextIds ?? []).filter((id) => id !== entity.id)
    }));
    await saveOntology(nextOntology, "Ontology deleted");
  }

  function toggleSkill(skillId: string) {
    const attached = request.skillIds?.includes(skillId) ?? false;
    setRequest((current) => ({
      ...current,
      skillIds: toggleString(current.skillIds ?? [], skillId)
    }));
    setStatus(attached ? "Skill detached" : "Skill attached");
  }

  function removeSkill(skillId: string) {
    setRequest((current) => ({
      ...current,
      skillIds: (current.skillIds ?? []).filter((candidate) => candidate !== skillId)
    }));
    setStatus("Skill detached");
  }

  function toggleOntologyContext(entityId: string) {
    const attached = request.ontologyContextIds?.includes(entityId) ?? false;
    setRequest((current) => ({
      ...current,
      ontologyContextIds: toggleString(current.ontologyContextIds ?? [], entityId)
    }));
    setStatus(attached ? "Context detached" : "Context attached");
  }

  function removeOntologyContext(entityId: string) {
    setRequest((current) => ({
      ...current,
      ontologyContextIds: (current.ontologyContextIds ?? []).filter((candidate) => candidate !== entityId)
    }));
    setStatus("Context detached");
  }

  async function runScheduleNow(schedule: ScheduleSpec) {
    const scheduledRequest = scheduleRunRequestForWorkspace(schedule, request.workspacePath);
    pendingStartRequestRef.current = scheduledRequest;
    setStatus("Starting scheduled run");

    try {
      const runId = await invoke<string>("builder_run_schedule_now", {
        request: {
          workspacePath: request.workspacePath,
          scheduleId: schedule.id
        }
      });
      runRequestsRef.current[runId] = scheduledRequest;
      setStatus((currentStatus) => settledRunStartStatus({
        currentStatus,
        pendingStatus: "Starting scheduled run",
        queuedStatus: "Scheduled run queued",
        activeRunIds: activeRunIdsRef.current,
        runId
      }));
    } catch (error) {
      pendingStartRequestRef.current = undefined;

      if (isBrowserPreviewRuntime()) {
        setEvents((current) => appendEvents([createQueuedEvent(scheduledRequest)], current));
        setStatus("Scheduled run queued");
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Schedule run failed");
    }
  }

  async function createDiagnosticsReport() {
    setStatus("Creating diagnostics");

    try {
      const result = await invoke<DiagnosticsReportResult>("builder_create_diagnostics_report", {
        request: { workspacePath: request.workspacePath }
      });
      const now = new Date();

      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "diagnostics_report",
          path: result.path,
          pathRedacted: result.pathRedacted,
          report: result.report
        }, now)
      ], current));
      setStatus("Diagnostics report created");
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        const now = new Date();
        setEvents((current) => appendEvents([
          createArtifactEvent({
            kind: "diagnostics_preview",
            workspace: {
              selected: Boolean(request.workspacePath.trim()),
              pathRedacted: true
            },
            catalogStatus,
            catalog: {
              skills: catalog.skills.length,
              ontology: catalog.ontology.length,
              schedules: catalog.schedules.length,
              enabledSchedules: catalog.schedules.filter((schedule) => schedule.enabled).length
            },
            eventCount: events.length
          }, now)
        ], current));
        setStatus("Diagnostics preview created");
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Diagnostics failed");
    }
  }

  async function createSupportBundle() {
    setStatus("Creating support bundle");

    try {
      const result = await invoke<SupportBundleResult>("builder_create_support_bundle", {
        request: { workspacePath: request.workspacePath }
      });
      const now = new Date();

      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "support_bundle",
          path: result.path,
          pathRedacted: result.pathRedacted,
          bundle: result.bundle
        }, now)
      ], current));
      setStatus("Support bundle created");
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        const now = new Date();
        const report = previewHealthReport(request.workspacePath, catalog, events.length);
        setEvents((current) => appendEvents([
          createArtifactEvent({
            kind: "support_bundle_preview",
            schemaVersion: 1,
            generatedAt: now.toISOString(),
            workspace: {
              selected: Boolean(request.workspacePath.trim()),
              pathRedacted: true
            },
            health: {
              status: report.status,
              checks: report.checks.map((check) => ({
                id: check.id,
                title: check.title,
                status: check.status
              }))
            },
            privacy: {
              redacted: true,
              includesAuthContents: false,
              includesRawPrompts: false,
              includesWorkspacePaths: false,
              includesRunPayloads: false
            }
          }, now)
        ], current));
        setStatus("Support bundle preview created");
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Support bundle failed");
    }
  }

  async function listWorkspaceBackups(recordEvent = true) {
    setActiveView("backups");
    setBackupBusy(true);
    setStatus("Listing workspace backups");

    try {
      const backups = await invoke<WorkspaceBackupSummary[]>("builder_list_workspace_backups", {
        request: { workspacePath: request.workspacePath }
      });
      const now = new Date();

      setWorkspaceBackups(backups);
      setWorkspaceBackupsLoaded(true);
      setPrunePreview(undefined);

      if (recordEvent) {
        setEvents((current) => appendEvents([
          createArtifactEvent({
            kind: "workspace_backups",
            count: backups.length,
            backups
          }, now)
        ], current));
      }
      setStatus(`${backups.length} backup${backups.length === 1 ? "" : "s"} found`);
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        const now = new Date();
        setWorkspaceBackups([]);
        setWorkspaceBackupsLoaded(true);
        setPrunePreview(undefined);
        if (recordEvent) {
          setEvents((current) => appendEvents([
            createArtifactEvent({
              kind: "workspace_backups_preview",
              count: 0,
              backups: []
            }, now)
          ], current));
        }
        setStatus("0 backups found");
        setBackupBusy(false);
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Backup listing failed");
    } finally {
      setBackupBusy(false);
    }
  }

  async function restoreWorkspaceBackup(backup: WorkspaceBackupSummary) {
    const target = backup.targetRelativePath ?? "the inferred workspace target";
    const confirmed = window.confirm(`Restore ${backup.name} to ${target}? A pre-restore backup will be created first.`);

    if (!confirmed) {
      setStatus("Backup restore cancelled");
      return;
    }

    setBackupBusy(true);
    setStatus("Restoring workspace backup");

    try {
      const result = await invoke<RestoreWorkspaceBackupResult>("builder_restore_workspace_backup", {
        request: {
          workspacePath: request.workspacePath,
          backupName: backup.name
        }
      });
      const now = new Date();

      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "workspace_backup_restored",
          restored: result.restored,
          targetRelativePath: result.targetRelativePath,
          preRestoreBackup: result.preRestoreBackup
        }, now)
      ], current));
      await refreshCatalog();
      await listWorkspaceBackups(false);
      setStatus(`Restored ${result.targetRelativePath}`);
    } catch (error) {
      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Backup restore failed");
    } finally {
      setBackupBusy(false);
    }
  }

  async function previewBackupPrune() {
    const keep = Number(backupKeepCount);
    if (!Number.isInteger(keep) || keep < 0) {
      setStatus("Backup keep count must be a non-negative integer");
      return;
    }

    setBackupBusy(true);
    setStatus("Previewing backup prune");

    try {
      const result = await invoke<PruneWorkspaceBackupsResult>("builder_prune_workspace_backups", {
        request: {
          workspacePath: request.workspacePath,
          keep,
          confirm: false
        }
      });
      const now = new Date();

      setPrunePreview(result);
      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "workspace_backups_prune_preview",
          keep: result.keep,
          candidateCount: result.candidates.length,
          retainedCount: result.retained.length,
          candidates: result.candidates
        }, now)
      ], current));
      setStatus(`${result.candidates.length} prune candidate${result.candidates.length === 1 ? "" : "s"}`);
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        const result: PruneWorkspaceBackupsResult = {
          keep,
          dryRun: true,
          retained: [],
          candidates: [],
          pruned: []
        };
        setPrunePreview(result);
        setStatus("0 prune candidates");
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Backup prune preview failed");
    } finally {
      setBackupBusy(false);
    }
  }

  async function confirmBackupPrune() {
    const keep = Number(backupKeepCount);
    const candidateCount = prunePreview?.candidates.length ?? 0;

    if (!Number.isInteger(keep) || keep < 0) {
      setStatus("Backup keep count must be a non-negative integer");
      return;
    }
    if (candidateCount === 0) {
      setStatus("No prune candidates");
      return;
    }
    if (!window.confirm(`Delete ${candidateCount} old workspace backup${candidateCount === 1 ? "" : "s"}?`)) {
      setStatus("Backup prune cancelled");
      return;
    }

    setBackupBusy(true);
    setStatus("Pruning workspace backups");

    try {
      const result = await invoke<PruneWorkspaceBackupsResult>("builder_prune_workspace_backups", {
        request: {
          workspacePath: request.workspacePath,
          keep,
          confirm: true
        }
      });
      const now = new Date();

      setPrunePreview(undefined);
      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "workspace_backups_pruned",
          keep: result.keep,
          prunedCount: result.pruned.length,
          retainedCount: result.retained.length,
          pruned: result.pruned
        }, now)
      ], current));
      await listWorkspaceBackups(false);
      setStatus(`Pruned ${result.pruned.length} backup${result.pruned.length === 1 ? "" : "s"}`);
    } catch (error) {
      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Backup prune failed");
    } finally {
      setBackupBusy(false);
    }
  }

  async function runHealthCheckAction() {
    setStatus("Checking health");

    try {
      const report = await invoke<HealthReport>("builder_health_check", {
        request: { workspacePath: request.workspacePath }
      });
      const now = new Date();

      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "health_report",
          status: report.status,
          checks: report.checks
        }, now)
      ], current));
      setStatus(`Health ${report.status}`);
    } catch (error) {
      if (isBrowserPreviewRuntime()) {
        const now = new Date();
        const report = previewHealthReport(request.workspacePath, catalog, events.length);
        setEvents((current) => appendEvents([
          createArtifactEvent({
            kind: "health_preview",
            status: report.status,
            checks: report.checks
          }, now)
        ], current));
        setStatus(`Health ${report.status}`);
        return;
      }

      setEvents((current) => appendEvents([
        createErrorEvent(error instanceof Error ? error.message : String(error))
      ], current));
      setStatus("Health check failed");
    }
  }

  async function checkForUpdates() {
    setUpdateBusy(true);
    setStatus("Checking for updates");

    if (isBrowserPreviewRuntime()) {
      const now = new Date();
      setEvents((current) => appendEvents([
        createArtifactEvent({
          kind: "update_check_preview",
          available: false,
          runtime: "browser-preview"
        }, now)
      ], current));
      setStatus("No update available");
      setUpdateBusy(false);
      return;
    }

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const result = await runUpdaterFlow({
        check,
        confirmInstall: (message) => window.confirm(message),
        currentVersion: __BUILDER_GEAR_APP_VERSION__,
        onArtifact: (payload) => {
          setEvents((current) => appendEvents([createArtifactEvent(payload)], current));
        },
        onStatus: setStatus
      });

      const updateError = result.error;
      if (updateError) {
        setEvents((current) => appendEvents([
          createErrorEvent(updateError, "updater")
        ], current));
      }
      setStatus(result.status);
    } catch (error) {
      setEvents((current) => appendEvents([
        createErrorEvent(updaterErrorMessage(error), "updater")
      ], current));
      setStatus("Update check failed");
    } finally {
      setUpdateBusy(false);
    }
  }

  async function loadCatalogForWorkspace(workspacePath: string, isActive = () => true) {
    try {
      const loadedCatalog = await invoke<BuilderCatalog>("builder_load_catalog", {
        request: { workspacePath }
      });

      if (!isActive()) {
        return;
      }

      setCatalog(loadedCatalog);
      setCatalogStatus("Workspace catalog");
      setCatalogError(undefined);
    } catch (error) {
      if (!isActive()) {
        return;
      }

      const message = truncateText(redactSensitiveText(error instanceof Error ? error.message : String(error)), 1000);

      if (isBrowserPreviewRuntime()) {
        setCatalog(previewCatalog);
        setCatalogStatus("Preview catalog");
        setCatalogError(undefined);
        return;
      }

      setCatalog({ skills: [], ontology: [], schedules: [] });
      setCatalogStatus("Catalog error");
      setCatalogError(message);
      setStatus("Catalog error");
      setEvents((current) => appendEvents([createErrorEvent(message)], current));
    }
  }

  function refreshCatalog() {
    setStatus("Refreshing catalog");
    void loadCatalogForWorkspace(request.workspacePath);
  }

  function focusPrompt() {
    setActiveView("runs");
    setStatus("Prompt focused");
    window.setTimeout(() => document.getElementById("prompt-input")?.focus(), 0);
  }

  function chooseContext() {
    setActiveView("skills");
    setStatus("Choose context");
  }

  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => !collapsed);
    setStatus(sidebarCollapsed ? "Sidebar expanded" : "Sidebar collapsed");
  }

  function toggleInspector() {
    setInspectorVisible((visible) => !visible);
    setStatus(inspectorVisible ? "Inspector hidden" : "Inspector visible");
  }

  async function chooseWorkspace() {
    setActiveView("runs");

    try {
      const selected = await invoke<string | null>("builder_select_workspace_directory");

      if (typeof selected === "string" && selected.trim()) {
        setRequest((current) => ({ ...current, workspacePath: selected }));
        setStatus("Workspace selected");
        window.setTimeout(() => document.getElementById("workspace-input")?.focus(), 0);
      }
    } catch (error) {
      if (!isBrowserPreviewRuntime()) {
        setEvents((current) => appendEvents([
          createErrorEvent(error instanceof Error ? error.message : String(error), "dialog")
        ], current));
        setStatus("Workspace dialog failed");
        return;
      }

      const typed = window.prompt("Workspace path", request.workspacePath);
      if (typed?.trim()) {
        setRequest((current) => ({ ...current, workspacePath: typed.trim() }));
        setStatus("Workspace selected");
        window.setTimeout(() => document.getElementById("workspace-input")?.focus(), 0);
      }
    }
  }

  function createErrorEvent(message: string, source = "app"): AgentRunEvent {
    const now = new Date();
    return {
      runId: createLocalEventId(now),
      type: "error",
      timestamp: now.toISOString(),
      payload: { message: truncateText(redactSensitiveText(message), 1000), source }
    };
  }

  return (
    <main className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className="sidebar">
        <div className="window-strip">
          <div className="traffic-lights" aria-hidden="true">
            <span className="traffic-light red" />
            <span className="traffic-light yellow" />
            <span className="traffic-light green" />
          </div>
          <button
            type="button"
            className="chrome-button"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={sidebarCollapsed}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleSidebar}
          >
            <PanelLeft size={16} />
          </button>
          <button type="button" className="chrome-button" aria-label="Search" title="Focus prompt" onClick={focusPrompt}>
            <Search size={16} />
          </button>
        </div>

        <div className="brand">
          <div className="brand-mark">
            <Cpu size={18} />
          </div>
          <div>
            <strong>Builder Gear</strong>
            <span>Hermess Runtime</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main">
          <NavButton
            icon={<CirclePlus size={18} />}
            label="New Agent"
            active={activeView === "runs"}
            meta="⌘N"
            onClick={() => setActiveView("runs")}
          />
          <NavButton icon={<Store size={18} />} label="Marketplace" active={activeView === "skills"} onClick={() => setActiveView("skills")} />
          <NavButton icon={<Boxes size={18} />} label="Ontology" active={activeView === "ontology"} onClick={() => setActiveView("ontology")} />
          <NavButton icon={<CalendarClock size={18} />} label="Schedules" active={activeView === "schedules"} onClick={() => setActiveView("schedules")} />
          <NavButton icon={<Archive size={18} />} label="Backups" active={activeView === "backups"} onClick={() => listWorkspaceBackups(false)} />
        </nav>

        <section className="workspace-list" aria-label="Workspaces">
          <h2>BUILD-CLIENT</h2>
          <button className={activeView === "runs" ? "workspace-item active" : "workspace-item"} onClick={() => setActiveView("runs")}>
            <span className="workspace-dot" />
            <span>Builder Gear</span>
          </button>
          <button className="workspace-item" onClick={chooseWorkspace}>
            <FolderOpen size={15} />
            <span>Open Workspace</span>
          </button>
        </section>

        <section className="status-panel" aria-label="Runtime status">
          <div className="profile-orb" aria-hidden="true">BG</div>
          <div className="status-stack">
            <strong>{cliInfo?.codexVersion ?? "Checking"}</strong>
            <span>{runtimeSubline}</span>
          </div>
          <div className="sidebar-actions">
            <button className="mini-button" aria-label="Layout" title="Customize layout" onClick={() => setActiveView("layout")}>
              <SlidersHorizontal size={16} />
            </button>
            <button className="mini-button" aria-label="Settings" title="Open settings" onClick={() => setActiveView("layout")}>
              <Settings size={16} />
            </button>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="route-title">
            <h1>{titleForView(activeView)}</h1>
            <ChevronDown size={16} />
            <span>{status}</span>
          </div>
          <div className="topbar-tools">
            <div className={catalogError ? "status-chip error" : "status-chip"}>
              {catalogError ? <AlertTriangle size={14} /> : <Database size={14} />}
              {catalogStatus}
            </div>
            <button className="chrome-button" aria-label="Refresh catalog" title="Refresh catalog" onClick={refreshCatalog}>
              <RefreshCw size={16} />
            </button>
            <button className="chrome-button" aria-label="Create diagnostics report" title="Create diagnostics report" onClick={createDiagnosticsReport}>
              <LifeBuoy size={16} />
            </button>
            <button className="chrome-button" aria-label="Create support bundle" title="Create support bundle" onClick={createSupportBundle}>
              <Wrench size={16} />
            </button>
            <button className="chrome-button" aria-label="List workspace backups" title="List workspace backups" onClick={() => listWorkspaceBackups()}>
              <Archive size={16} />
            </button>
            <button className="chrome-button" aria-label="Run health check" title="Run health check" onClick={runHealthCheckAction}>
              <Activity size={16} />
            </button>
            <button className="chrome-button" aria-label="Check for updates" title="Check for updates" onClick={checkForUpdates} disabled={updateBusy}>
              <Download size={16} />
            </button>
            <div className="status-chip">
              <CalendarClock size={14} />
              {scheduleStatus}
            </div>
            <div className={authReady ? "status-chip ok" : "status-chip warn"}>
              <ShieldCheck size={14} />
              {authLabel}
            </div>
            <button
              className="chrome-button"
              aria-label={inspectorVisible ? "Hide inspector" : "Show inspector"}
              aria-pressed={!inspectorVisible}
              title={inspectorVisible ? "Hide inspector" : "Show inspector"}
              onClick={toggleInspector}
            >
              <PanelLeft size={16} />
            </button>
          </div>
        </header>

        {activeView === "runs" && (
          <div className={inspectorVisible ? "run-workbench" : "run-workbench inspector-hidden"}>
            {runsPanelVisible ? (
              <section className="command-stage">
                <div className="command-shell">
                  <div className="command-header">
                    <div className="mode-select">
                      <span>Home</span>
                      <ChevronDown size={15} />
                      <Database size={16} />
                    </div>
                  </div>

                  <div className="prompt-frame">
                    <label className="sr-only" htmlFor="prompt-input">Prompt</label>
                    <textarea
                      id="prompt-input"
                      aria-label="Prompt"
                      value={request.prompt}
                      placeholder="Plan, Build, / commands, @ context"
                      onChange={(event) => setRequest({ ...request, prompt: event.target.value })}
                    />

                    <div className="composer-controls">
                      <button className="round-button" aria-label="Add context" title="Add skill context" onClick={chooseContext}>
                        <CirclePlus size={22} />
                      </button>

                      <label className="select-pill">
                        <span className="sr-only">Sandbox</span>
                        <select
                          value={request.sandboxMode}
                          onChange={(event) => setRequest({ ...request, sandboxMode: event.target.value as AgentRunRequest["sandboxMode"] })}
                        >
                          <option value="read-only">Read</option>
                          <option value="workspace-write">Auto</option>
                          <option value="danger-full-access">Full</option>
                        </select>
                        <ChevronDown size={14} aria-hidden="true" />
                      </label>

                      <label className="select-pill approval-pill">
                        <span className="sr-only">Approval</span>
                        <select
                          value={request.approvalMode}
                          onChange={(event) => setRequest({ ...request, approvalMode: event.target.value as AgentRunRequest["approvalMode"] })}
                        >
                          <option value="never">Never</option>
                          <option value="on-request">Ask</option>
                          <option value="on-failure">Retry</option>
                          <option value="untrusted">Guard</option>
                        </select>
                        <ChevronDown size={14} aria-hidden="true" />
                      </label>

                      <button className="mic-button" aria-label="Voice input unavailable" title="Voice input is not configured" disabled>
                        <Mic size={19} />
                      </button>

                      <button
                        className={isRunning ? "primary-action danger" : "primary-action"}
                        onClick={isRunning ? cancelRun : queueRun}
                        aria-label={runStartPending ? "Starting run" : isRunning ? "Cancel run" : "Queue run"}
                        title={runStartPending ? "Starting run" : isRunning ? "Cancel run" : "Queue run"}
                        disabled={runStartPending}
                      >
                        {isRunning ? <Square size={16} /> : <Play size={18} />}
                      </button>
                    </div>
                  </div>

                  <div className="quick-actions">
                    <button onClick={isRunning ? cancelRun : queueRun} disabled={runStartPending}>
                      <CommandIcon size={15} />
                      {runStartPending ? "Starting Run" : isRunning ? `Cancel Run${activeRunCount > 1 ? ` (${activeRunCount})` : ""}` : "Plan New Idea"}
                      <span>Tab</span>
                    </button>
                    <button onClick={previewInvocation} disabled={runControlBusy}>
                      <LayoutDashboard size={15} />
                      Preview Invocation
                    </button>
                    {retryRunRequest ? (
                      <button onClick={retryFailedRun} disabled={runControlBusy}>
                        <RefreshCw size={15} />
                        Retry Failed Run
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : (
              <HiddenPanelNotice title="Runs panel hidden" onOpenLayout={() => setActiveView("layout")} />
            )}

            {inspectorVisible && (runsPanelVisible || artifactsPanelVisible || logsPanelVisible) ? (
            <section className="context-dock">
              {runsPanelVisible ? (
                <div className="panel run-composer">
                  <div className="panel-heading">
                    <GitBranch size={17} />
                    <h2>Workspace</h2>
                    <div className="panel-heading-actions">
                      <button className="panel-tool-button" onClick={prepareWorkspace} aria-label="Prepare workspace" title="Prepare workspace">
                        <Wrench size={15} />
                      </button>
                      <button className="panel-tool-button" onClick={chooseWorkspace} aria-label="Choose workspace" title="Choose workspace">
                        <FolderOpen size={15} />
                      </button>
                    </div>
                  </div>
                <label>
                  Workspace
                  <input
                    id="workspace-input"
                    value={request.workspacePath}
                    onChange={(event) => setRequest({ ...request, workspacePath: event.target.value })}
                  />
                </label>
                <label>
                  Timeout seconds
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="86400"
                    value={request.timeoutSeconds ?? ""}
                    onChange={(event) => setRequest({
                      ...request,
                      timeoutSeconds: timeoutSecondsFromInput(event.target.value)
                    })}
                    placeholder="No limit"
                  />
                </label>
                  <div className="metric-row">
                    <span>Skills</span>
                    <strong>{request.skillIds?.length ?? 0}</strong>
                  </div>
                  <div className="metric-row">
                    <span>Context</span>
                    <strong>{request.ontologyContextIds?.length ?? 0}</strong>
                  </div>
                  <SelectionChips
                    label="Attached skills"
                    values={request.skillIds ?? []}
                    emptyLabel="No skills attached"
                    onRemove={removeSkill}
                  />
                  <SelectionChips
                    label="Ontology context"
                    values={request.ontologyContextIds ?? []}
                    emptyLabel="No context attached"
                    onRemove={removeOntologyContext}
                  />
                </div>
              ) : null}

              {artifactsPanelVisible ? <ArtifactsPanel events={events} /> : null}

              {logsPanelVisible ? (
                <EventsPanel
                  events={events}
                  onClear={clearEvents}
                  retryRunId={retryRunId}
                  onRetry={retryFailedRun}
                />
              ) : null}
            </section>
            ) : null}
          </div>
        )}

        {activeView === "skills" && (
          <section className="list-grid">
            {!skillsPanelVisible ? (
              <HiddenPanelNotice title="Skills panel hidden" onOpenLayout={() => setActiveView("layout")} />
            ) : catalogError ? (
              <CatalogError error={catalogError} onRefresh={refreshCatalog} />
            ) : (
              <>
                <section className="editor-panel wide">
                  <div className="item-card-title">
                    <Wrench size={18} />
                    <h2>{editingSkillId ? "Edit Skill" : "New Skill"}</h2>
                  </div>
                  <div className="form-grid skill-form-grid">
                    <label>
                      ID
                      <input
                        value={skillDraft.id}
                        onChange={(event) => setSkillDraft({ ...skillDraft, id: event.target.value })}
                        placeholder="qa-plan"
                      />
                    </label>
                    <label>
                      Name
                      <input
                        value={skillDraft.name}
                        onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })}
                        placeholder="QA Plan"
                      />
                    </label>
                    <label>
                      Version
                      <input
                        value={skillDraft.version}
                        onChange={(event) => setSkillDraft({ ...skillDraft, version: event.target.value })}
                        placeholder="0.1.0"
                      />
                    </label>
                    <label>
                      Occupations
                      <input
                        value={skillDraft.occupationsText}
                        onChange={(event) => setSkillDraft({ ...skillDraft, occupationsText: event.target.value })}
                        placeholder="developer, operator"
                      />
                    </label>
                    <label>
                      Required tools
                      <input
                        value={skillDraft.requiredToolsText}
                        onChange={(event) => setSkillDraft({ ...skillDraft, requiredToolsText: event.target.value })}
                        placeholder="codex, git"
                      />
                    </label>
                  </div>
                  <label className="textarea-field">
                    Instructions
                    <textarea
                      value={skillDraft.instructions}
                      onChange={(event) => setSkillDraft({ ...skillDraft, instructions: event.target.value })}
                      placeholder="# QA Plan&#10;&#10;Describe the skill workflow."
                    />
                  </label>
                  <div className="item-actions">
                    <button type="button" onClick={saveSkillDraft}>
                      <CheckCircle2 size={14} />
                      {editingSkillId ? "Save skill" : "Create skill"}
                    </button>
                    <button type="button" onClick={resetSkillDraft}>Reset</button>
                  </div>
                </section>

                {catalog.skills.length === 0 ? (
                  <div className="empty-state wide">No skills found in {catalogStatus}</div>
                ) : (
                  catalog.skills.map((skill) => (
                    <article className={request.skillIds?.includes(skill.id) ? "item-card selected" : "item-card"} key={skill.id}>
                      <div className="item-card-title">
                        <Wrench size={18} />
                        <h2>{skill.name}</h2>
                      </div>
                      <p>{skill.id}</p>
                      <div className="tag-row">
                        {skill.occupations.map((occupation) => (
                          <span key={occupation}>{occupation}</span>
                        ))}
                      </div>
                      <div className="item-actions">
                        <button type="button" onClick={() => toggleSkill(skill.id)}>
                          {request.skillIds?.includes(skill.id) ? <CheckCircle2 size={14} /> : <CirclePlus size={14} />}
                          {request.skillIds?.includes(skill.id) ? "Detach" : "Attach"}
                        </button>
                        <button type="button" onClick={() => editSkill(skill)}>Edit</button>
                        <button type="button" className="danger-action" onClick={() => deleteSkill(skill)}>
                          <Trash2 size={14} />
                          Delete
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </>
            )}
          </section>
        )}

        {activeView === "ontology" && (
          <section className="list-grid">
            {!ontologyPanelVisible ? (
              <HiddenPanelNotice title="Ontology panel hidden" onOpenLayout={() => setActiveView("layout")} />
            ) : catalogError ? (
              <CatalogError error={catalogError} onRefresh={refreshCatalog} />
            ) : (
              <>
                <section className="editor-panel wide">
                  <div className="item-card-title">
                    <Boxes size={18} />
                    <h2>{editingOntologyId ? "Edit Ontology Entity" : "New Ontology Entity"}</h2>
                  </div>
                  <div className="form-grid">
                    <label>
                      ID
                      <input
                        value={ontologyDraft.id}
                        onChange={(event) => setOntologyDraft({ ...ontologyDraft, id: event.target.value })}
                        placeholder="goal-new-workflow"
                      />
                    </label>
                    <label>
                      Type
                      <select
                        value={ontologyDraft.type}
                        onChange={(event) => setOntologyDraft({ ...ontologyDraft, type: event.target.value as OntologyEntity["type"] })}
                      >
                        {ONTOLOGY_ENTITY_TYPES.map((type) => (
                          <option value={type} key={type}>{type}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Label
                      <input
                        value={ontologyDraft.label}
                        onChange={(event) => setOntologyDraft({ ...ontologyDraft, label: event.target.value })}
                        placeholder="New workflow goal"
                      />
                    </label>
                  </div>
                  <div className="item-actions">
                    <button type="button" onClick={saveOntologyDraft}>
                      <CheckCircle2 size={14} />
                      {editingOntologyId ? "Save changes" : "Create entity"}
                    </button>
                    <button type="button" onClick={resetOntologyDraft}>Reset</button>
                  </div>
                </section>

                {catalog.ontology.length === 0 ? (
                  <div className="empty-state wide">No ontology entities found in {catalogStatus}</div>
                ) : (
                  catalog.ontology.map((entity) => (
                    <article className={request.ontologyContextIds?.includes(entity.id) ? "item-card selected" : "item-card"} key={entity.id}>
                      <div className="item-card-title">
                        <Boxes size={18} />
                        <h2>{entity.label}</h2>
                      </div>
                      <p>{entity.type}</p>
                      <div className="relation-list">
                        {entity.relations.length === 0 ? (
                          <span>No relations</span>
                        ) : (
                          entity.relations.map((relation) => (
                            <span key={`${relation.type}-${relation.targetId}`}>{relation.type}: {relation.targetId}</span>
                          ))
                        )}
                      </div>
                      <div className="item-actions">
                        <button type="button" onClick={() => toggleOntologyContext(entity.id)}>
                          {request.ontologyContextIds?.includes(entity.id) ? <CheckCircle2 size={14} /> : <CirclePlus size={14} />}
                          {request.ontologyContextIds?.includes(entity.id) ? "Remove context" : "Use context"}
                        </button>
                        <button type="button" onClick={() => editOntologyEntity(entity)}>Edit</button>
                        <button type="button" className="danger-action" onClick={() => deleteOntologyEntity(entity)}>
                          <Trash2 size={14} />
                          Delete
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </>
            )}
          </section>
        )}

        {activeView === "schedules" && (
          <section className="list-grid">
            {!schedulesPanelVisible ? (
              <HiddenPanelNotice title="Schedules panel hidden" onOpenLayout={() => setActiveView("layout")} />
            ) : catalogError ? (
              <CatalogError error={catalogError} onRefresh={refreshCatalog} />
            ) : (
              <>
                <section className="editor-panel wide">
                  <div className="item-card-title">
                    <CalendarClock size={18} />
                    <h2>{editingScheduleId ? "Edit Schedule" : "New Schedule"}</h2>
                  </div>
                  <div className="form-grid schedule-form-grid">
                    <label>
                      ID
                      <input
                        value={scheduleDraft.id}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, id: event.target.value })}
                        placeholder="weekday-build"
                      />
                    </label>
                    <label>
                      Name
                      <input
                        value={scheduleDraft.name}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, name: event.target.value })}
                        placeholder="Weekday Build"
                      />
                    </label>
                    <label>
                      Trigger
                      <select
                        value={scheduleDraft.triggerKind}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, triggerKind: event.target.value as ScheduleTriggerKind })}
                      >
                        <option value="interval">Interval</option>
                        <option value="once">Once</option>
                        <option value="cron">Cron</option>
                      </select>
                    </label>
                    {scheduleDraft.triggerKind === "interval" ? (
                      <label>
                        Every seconds
                        <input
                          inputMode="numeric"
                          value={scheduleDraft.intervalSeconds}
                          onChange={(event) => setScheduleDraft({ ...scheduleDraft, intervalSeconds: event.target.value })}
                          placeholder="86400"
                        />
                      </label>
                    ) : null}
                    {scheduleDraft.triggerKind === "once" ? (
                      <label>
                        Run at
                        <input
                          value={scheduleDraft.runAt}
                          onChange={(event) => setScheduleDraft({ ...scheduleDraft, runAt: event.target.value })}
                          placeholder="2026-06-24T09:00:00.000Z"
                        />
                      </label>
                    ) : null}
                    {scheduleDraft.triggerKind === "cron" ? (
                      <label>
                        Cron expression
                        <input
                          value={scheduleDraft.cronExpression}
                          onChange={(event) => setScheduleDraft({ ...scheduleDraft, cronExpression: event.target.value })}
                          placeholder="0 9 * * 1-5"
                        />
                      </label>
                    ) : null}
                    <label>
                      Timezone
                      <input
                        value={scheduleDraft.timezone}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, timezone: event.target.value })}
                        placeholder="Asia/Seoul"
                      />
                    </label>
                    <label>
                      Missed run
                      <select
                        value={scheduleDraft.missedRunPolicy}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, missedRunPolicy: event.target.value as MissedRunPolicy })}
                      >
                        <option value="run-on-start">Run on start</option>
                        <option value="skip">Skip</option>
                      </select>
                    </label>
                    <label>
                      Sandbox
                      <select
                        value={scheduleDraft.sandboxMode}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, sandboxMode: event.target.value as AgentRunRequest["sandboxMode"] })}
                      >
                        <option value="read-only">Read only</option>
                        <option value="workspace-write">Workspace write</option>
                        <option value="danger-full-access">Full access</option>
                      </select>
                    </label>
                    <label>
                      Approval
                      <select
                        value={scheduleDraft.approvalMode}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, approvalMode: event.target.value as AgentRunRequest["approvalMode"] })}
                      >
                        <option value="never">Never</option>
                        <option value="on-request">Ask</option>
                        <option value="on-failure">On failure</option>
                        <option value="untrusted">Untrusted</option>
                      </select>
                    </label>
                    <label>
                      Timeout seconds
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="86400"
                        value={scheduleDraft.timeoutSeconds}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, timeoutSeconds: event.target.value })}
                        placeholder="No limit"
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={scheduleDraft.enabled}
                        onChange={(event) => setScheduleDraft({ ...scheduleDraft, enabled: event.target.checked })}
                      />
                      Enabled
                    </label>
                  </div>
                  <label className="textarea-field">
                    Prompt
                    <textarea
                      value={scheduleDraft.prompt}
                      onChange={(event) => setScheduleDraft({ ...scheduleDraft, prompt: event.target.value })}
                      placeholder="Create the scheduled build plan."
                    />
                  </label>
                  <div className="item-actions">
                    <button type="button" onClick={saveScheduleDraft}>
                      <CheckCircle2 size={14} />
                      {editingScheduleId ? "Save schedule" : "Create schedule"}
                    </button>
                    <button type="button" onClick={resetScheduleDraft}>Reset</button>
                  </div>
                </section>

                {catalog.schedules.length === 0 ? (
                  <div className="empty-state wide">No schedules found in {catalogStatus}</div>
                ) : (
                  catalog.schedules.map((schedule) => (
                    <article className="item-card wide" key={schedule.id}>
                      <div className="item-card-title">
                        <CalendarClock size={18} />
                        <h2>{schedule.name}</h2>
                      </div>
                      <p>{schedule.id}</p>
                      <dl className="definition-grid">
                        <div><dt>Trigger</dt><dd>{scheduleTriggerLabel(schedule.trigger)}</dd></div>
                        <div><dt>Timezone</dt><dd>{schedule.timezone}</dd></div>
                        <div><dt>Missed run</dt><dd>{schedule.missedRunPolicy}</dd></div>
                        <div><dt>Enabled</dt><dd>{schedule.enabled ? "yes" : "no"}</dd></div>
                      </dl>
                      <div className="item-actions">
                        <button type="button" onClick={() => runScheduleNow(schedule)}>
                          <Play size={14} />
                          Run now
                        </button>
                        <button type="button" onClick={() => toggleSchedule(schedule)}>
                          {schedule.enabled ? "Disable" : "Enable"}
                        </button>
                        <button type="button" onClick={() => editSchedule(schedule)}>Edit</button>
                        <button type="button" className="danger-action" onClick={() => deleteSchedule(schedule)}>
                          <Trash2 size={14} />
                          Delete
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </>
            )}
          </section>
        )}

        {activeView === "backups" && (
          <section className="list-grid">
            <section className="editor-panel wide backup-manager">
              <div className="item-card-title">
                <Archive size={18} />
                <h2>Workspace Backups</h2>
              </div>
              <div className="backup-control-grid">
                <label>
                  Keep newest
                  <input
                    inputMode="numeric"
                    value={backupKeepCount}
                    onChange={(event) => setBackupKeepCount(event.target.value)}
                    placeholder="50"
                  />
                </label>
                <div className="backup-summary">
                  <span>{workspaceBackupsLoaded ? `${workspaceBackups.length} backups loaded` : "Backups not loaded"}</span>
                  <strong>{prunePreview ? `${prunePreview.candidates.length} prune candidates` : "No prune preview"}</strong>
                </div>
              </div>
              <div className="item-actions">
                <button type="button" onClick={() => listWorkspaceBackups()} disabled={backupBusy}>
                  <RefreshCw size={14} />
                  Refresh backups
                </button>
                <button type="button" onClick={previewBackupPrune} disabled={backupBusy}>
                  <Archive size={14} />
                  Preview prune
                </button>
                <button
                  type="button"
                  className="danger-action"
                  onClick={confirmBackupPrune}
                  disabled={backupBusy || !prunePreview || prunePreview.candidates.length === 0}
                >
                  <Trash2 size={14} />
                  Confirm prune
                </button>
              </div>
            </section>

            {!workspaceBackupsLoaded ? (
              <div className="empty-state wide">Load workspace backups to review recoverable snapshots</div>
            ) : workspaceBackups.length === 0 ? (
              <div className="empty-state wide">No workspace backups found</div>
            ) : (
              workspaceBackups.map((backup) => (
                <article className="item-card wide backup-card" key={backup.name}>
                  <div className="item-card-title">
                    <Archive size={18} />
                    <h2>{backup.kind}</h2>
                  </div>
                  <p>{backup.name}</p>
                  <dl className="definition-grid backup-definition-grid">
                    <div><dt>Target</dt><dd>{backup.targetRelativePath ?? "unsupported"}</dd></div>
                    <div><dt>Created</dt><dd>{backup.createdAt ? new Date(backup.createdAt).toLocaleString() : "unknown"}</dd></div>
                    <div><dt>Size</dt><dd>{formatBytes(backup.sizeBytes)}</dd></div>
                    <div><dt>Entries</dt><dd>{backup.entryCount}</dd></div>
                    <div><dt>Shape</dt><dd>{backup.directory ? "directory" : "file"}</dd></div>
                    <div><dt>Path</dt><dd>{backup.relativePath}</dd></div>
                  </dl>
                  <div className="item-actions">
                    <button
                      type="button"
                      onClick={() => restoreWorkspaceBackup(backup)}
                      disabled={backupBusy || !backup.targetRelativePath}
                    >
                      <RefreshCw size={14} />
                      Restore
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>
        )}

        {activeView === "layout" && (
          <section className="layout-editor">
            <div className="panel">
              <div className="panel-heading">
                <SlidersHorizontal size={18} />
                <h2>Panels</h2>
              </div>
              <div className="toggle-list">
                {layout.panels.map((panel) => (
                  <label className="toggle-row" key={panel.id}>
                    <input
                      type="checkbox"
                      checked={panel.visible}
                      onChange={() => setLayout(togglePanelVisibility(layout, panel.id))}
                    />
                    <span>{panel.title}</span>
                    <em>{panel.region}</em>
                  </label>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <LayoutDashboard size={18} />
                <h2>Visible</h2>
              </div>
              <div className="visible-panel-grid">
                {visiblePanels.map((panel) => (
                  <div key={panel.id}>{panel.title}</div>
                ))}
              </div>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function NavButton({
  icon,
  label,
  active,
  meta,
  onClick
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {meta ? <kbd>{meta}</kbd> : null}
    </button>
  );
}

function CatalogError({ error, onRefresh }: { error: string; onRefresh: () => void }) {
  return (
    <section className="catalog-error">
      <div>
        <AlertTriangle size={18} />
        <h2>Catalog Load Failed</h2>
      </div>
      <pre>{error}</pre>
      <button type="button" onClick={onRefresh}>
        <RefreshCw size={14} />
        Refresh catalog
      </button>
    </section>
  );
}

function HiddenPanelNotice({ title, onOpenLayout }: { title: string; onOpenLayout: () => void }) {
  return (
    <section className="empty-state wide hidden-panel-notice">
      <div>
        <strong>{title}</strong>
        <span>Enable it from Layout to show this workspace surface.</span>
      </div>
      <button type="button" onClick={onOpenLayout}>
        <LayoutDashboard size={14} />
        Open layout
      </button>
    </section>
  );
}

function ArtifactsPanel({ events }: { events: AgentRunEvent[] }) {
  const artifacts = events.filter(isArtifactLikeEvent).slice(0, 12);

  return (
    <section className="panel artifact-panel">
      <div className="panel-heading">
        <Archive size={17} />
        <h2>Artifacts</h2>
      </div>
      <div className="artifact-list" aria-label="Artifacts">
        {artifacts.length === 0 ? (
          <div className="empty-state compact">No artifacts</div>
        ) : (
          artifacts.map((event) => (
            <article className="artifact-row" key={`${event.runId}-${event.timestamp}-${event.type}`}>
              <span>{artifactLabel(event)}</span>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              <pre>{formatDisplayEventPayload(event.payload, 420)}</pre>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function isArtifactLikeEvent(event: AgentRunEvent): boolean {
  if (event.type === "artifact") {
    return true;
  }

  return Boolean(payloadKind(event.payload));
}

function artifactLabel(event: AgentRunEvent): string {
  return payloadKind(event.payload) ?? event.type;
}

function payloadKind(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const kind = (payload as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.trim() ? kind : undefined;
}

function EventsPanel({
  events,
  onClear,
  retryRunId,
  onRetry
}: {
  events: AgentRunEvent[];
  onClear: () => void;
  retryRunId?: string;
  onRetry: () => void;
}) {
  return (
    <section className="panel event-panel">
      <div className="panel-heading">
        <Activity size={17} />
        <h2>Events</h2>
        <button
          className="panel-tool-button"
          type="button"
          aria-label="Clear events"
          title="Clear events"
          onClick={onClear}
          disabled={events.length === 0}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <div className="event-list" aria-label="Run events">
        {events.length === 0 ? (
          <div className="empty-state">No events</div>
        ) : (
          events.map((event) => (
            <article className="event-row" key={`${event.runId}-${event.timestamp}-${event.type}`}>
              <span className={`event-type ${event.type}`}>{event.type}</span>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              {event.type === "error" && event.runId === retryRunId ? (
                <button type="button" className="event-action" onClick={onRetry}>
                  <RefreshCw size={13} />
                  Retry
                </button>
              ) : null}
              <pre>{formatDisplayEventPayload(event.payload)}</pre>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function SelectionChips({
  label,
  values,
  emptyLabel,
  onRemove
}: {
  label: string;
  values: string[];
  emptyLabel: string;
  onRemove: (value: string) => void;
}) {
  return (
    <div className="selection-block">
      <span>{label}</span>
      <div className="selection-chips">
        {values.length === 0 ? (
          <em>{emptyLabel}</em>
        ) : (
          values.map((value) => (
            <button type="button" key={value} onClick={() => onRemove(value)} aria-label={`Remove ${value}`}>
              {value}
              <X size={12} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function titleForView(view: View): string {
  const titles: Record<View, string> = {
    runs: "Runs",
    skills: "Skills",
    ontology: "Ontology",
    schedules: "Schedules",
    backups: "Backups",
    layout: "Layout"
  };

  return titles[view];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function scheduleTriggerLabel(trigger: ScheduleSpec["trigger"]): string {
  if (trigger.kind === "interval") {
    const hours = trigger.everySeconds / 3600;
    return Number.isInteger(hours) ? `Every ${hours}h` : `Every ${trigger.everySeconds}s`;
  }

  if (trigger.kind === "once") {
    return new Date(trigger.runAt).toLocaleString();
  }

  return trigger.expression;
}

function scheduleRunRequestForWorkspace(schedule: ScheduleSpec, workspacePath: string): AgentRunRequest {
  const runRequest = snapshotRunRequest({
    ...schedule.runRequest,
    scheduleId: schedule.id
  });

  if (!runRequest.workspacePath.trim() || runRequest.workspacePath === ".") {
    runRequest.workspacePath = workspacePath;
  }

  return runRequest;
}

function previewHealthReport(workspacePath: string, catalog: BuilderCatalog, eventCount: number): HealthReport {
  const checks: HealthReport["checks"] = [
    {
      id: "workspace",
      title: "Workspace",
      status: workspacePath.trim() ? "pass" : "fail",
      message: workspacePath.trim() ? "Workspace selected" : "Workspace path is empty",
      action: workspacePath.trim() ? undefined : "Select a valid Builder Gear workspace."
    },
    {
      id: "skills",
      title: "Skills",
      status: catalog.skills.length > 0 ? "pass" : "warn",
      message: `${catalog.skills.length} skill manifest${catalog.skills.length === 1 ? "" : "s"} loaded`,
      action: catalog.skills.length > 0 ? undefined : "Create at least one skill before shipping a workspace."
    },
    {
      id: "ontology",
      title: "Ontology",
      status: catalog.ontology.length > 0 ? "pass" : "warn",
      message: `${catalog.ontology.length} ontology entit${catalog.ontology.length === 1 ? "y" : "ies"} loaded`,
      action: catalog.ontology.length > 0 ? undefined : "Add ontology entities so runs can attach structured context."
    },
    {
      id: "schedules",
      title: "Schedules",
      status: "pass",
      message: `${catalog.schedules.length} schedule${catalog.schedules.length === 1 ? "" : "s"} loaded`
    },
    {
      id: "events",
      title: "Events",
      status: "pass",
      message: `${eventCount} visible event${eventCount === 1 ? "" : "s"} in the current session`
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "pass",
    checks
  };
}

function createArtifactEvent(payload: unknown, now = new Date()): AgentRunEvent {
  return {
    runId: createLocalEventId(now),
    type: "artifact",
    timestamp: now.toISOString(),
    payload
  };
}

function scheduleTriggerFromDraft(draft: ScheduleDraft): { trigger: ScheduleTrigger } | { error: string } {
  if (draft.triggerKind === "interval") {
    const everySeconds = Number(draft.intervalSeconds);

    if (!Number.isInteger(everySeconds) || everySeconds < 1) {
      return { error: "Interval schedules require whole seconds greater than 0" };
    }

    return { trigger: { kind: "interval", everySeconds } };
  }

  if (draft.triggerKind === "once") {
    const runAtMillis = Date.parse(draft.runAt);

    if (Number.isNaN(runAtMillis)) {
      return { error: "Once schedules require a valid ISO run time" };
    }

    return { trigger: { kind: "once", runAt: new Date(runAtMillis).toISOString() } };
  }

  const expression = draft.cronExpression.trim();
  if (!expression) {
    return { error: "Cron schedules require an expression" };
  }

  return { trigger: { kind: "cron", expression } };
}

function timeoutSecondsFromInput(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
}

function scheduleDraftFromSpec(schedule: ScheduleSpec): ScheduleDraft {
  return {
    id: schedule.id,
    name: schedule.name,
    triggerKind: schedule.trigger.kind,
    intervalSeconds: schedule.trigger.kind === "interval" ? String(schedule.trigger.everySeconds) : "86400",
    runAt: schedule.trigger.kind === "once" ? schedule.trigger.runAt : nextHourIso(),
    cronExpression: schedule.trigger.kind === "cron" ? schedule.trigger.expression : "0 9 * * 1-5",
    timezone: schedule.timezone,
    missedRunPolicy: schedule.missedRunPolicy,
    enabled: schedule.enabled,
    prompt: schedule.runRequest.prompt,
    sandboxMode: schedule.runRequest.sandboxMode,
    approvalMode: schedule.runRequest.approvalMode,
    timeoutSeconds: schedule.runRequest.timeoutSeconds?.toString() ?? ""
  };
}

function createEmptyScheduleDraft(): ScheduleDraft {
  return {
    id: "",
    name: "",
    triggerKind: "interval",
    intervalSeconds: "86400",
    runAt: nextHourIso(),
    cronExpression: "0 9 * * 1-5",
    timezone: browserTimezone(),
    missedRunPolicy: "run-on-start",
    enabled: true,
    prompt: "",
    sandboxMode: "read-only",
    approvalMode: "never",
    timeoutSeconds: ""
  };
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function nextHourIso(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function createEmptyOntologyDraft(): OntologyDraft {
  return {
    id: "",
    type: "Goal",
    label: ""
  };
}

function createEmptySkillDraft(): SkillDraft {
  return {
    id: "",
    name: "",
    version: "0.1.0",
    occupationsText: "",
    requiredToolsText: "codex",
    instructions: ""
  };
}

function skillDraftFromManifest(manifest: SkillManifest, instructions: string): SkillDraft {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    occupationsText: manifest.occupations.join(", "),
    requiredToolsText: manifest.requiredTools.join(", "),
    instructions
  };
}

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendEvents(nextEvents: AgentRunEvent[], currentEvents: AgentRunEvent[]): AgentRunEvent[] {
  return nextEvents.concat(currentEvents).slice(0, MAX_STORED_EVENTS);
}

function toggleString(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value].sort((left, right) => left.localeCompare(right));
}

function isCancelledEvent(event: AgentRunEvent): boolean {
  return Boolean(
    event.payload &&
      typeof event.payload === "object" &&
      "cancelled" in event.payload &&
      (event.payload as { cancelled?: unknown }).cancelled
  );
}

function readStoredEvents(): AgentRunEvent[] {
  return normalizeStoredEvents(readStoredValue<unknown>(EVENTS_STORAGE_KEY, []));
}

function readStoredLayout(): LayoutProfile {
  return normalizeStoredLayout(readStoredValue<unknown>(LAYOUT_STORAGE_KEY, undefined), createInitialLayout());
}

function readStoredRequest(): AgentRunRequest {
  return normalizeStoredRequest(readStoredValue<unknown>(REQUEST_STORAGE_KEY, {}), DEFAULT_REQUEST);
}

function readStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    if (raw.length > MAX_BROWSER_STATE_CHARS) {
      window.localStorage.removeItem(key);
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Broken storage should never block startup recovery.
    }
    return fallback;
  }
}

function writeStoredValue(key: string, value: unknown): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return false;
    }
    if (serialized.length > MAX_BROWSER_STATE_CHARS) {
      return false;
    }

    window.localStorage.setItem(key, serialized);
    return true;
  } catch {
    // Storage is a convenience layer; failed writes must not block runs.
    return false;
  }
}
