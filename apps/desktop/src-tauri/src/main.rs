#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const RUN_EVENT_NAME: &str = "builder://run-event";
const RUN_HISTORY_FILE: &str = "run-events.json";
const SCHEDULE_STATE_FILE: &str = "schedule-state.json";
const DIAGNOSTICS_DIR: &str = "diagnostics";
const MAX_STORED_RUN_EVENTS: usize = 200;
const MAX_ACTIVE_RUNS: usize = 3;
const MAX_REGULAR_TEXT_FILE_BYTES: u64 = 1_048_576;
const MAX_APP_STATE_TEXT_FILE_BYTES: u64 = 1_048_576;
const MAX_AGENT_PROMPT_CHARS: usize = 1_048_576;
const MAX_AGENT_WORKSPACE_PATH_CHARS: usize = 4_096;
const MAX_AGENT_CLI_OPTION_CHARS: usize = 128;
const MAX_AGENT_REFERENCE_ID_CHARS: usize = 128;
const MAX_AGENT_REFERENCE_IDS: usize = 50;
const MAX_AGENT_RUN_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;
const MAX_EVENT_TEXT_CHARS: usize = 16_000;
const MAX_BUFFERED_EVENT_TEXT_CHARS: usize = MAX_EVENT_TEXT_CHARS + 4_096;
const MAX_CODEX_VERSION_OUTPUT_BYTES: usize = 4_096;
const CODEX_VERSION_TIMEOUT_MS: u64 = 5_000;
const CODEX_VERSION_POLL_MS: u64 = 20;
const OUTPUT_READ_CHUNK_BYTES: usize = 4_096;
const TRUNCATED_EVENT_SUFFIX: &str = "... [truncated]";
const DEFAULT_CODEX_BIN: &str = "codex";
const CODEX_CHILD_ENV_REMOVED_EXACT: &[&str] = &[
    "APPLE_ID",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_KEYCHAIN_PASSWORD",
    "APPLE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "WINDOWS_SIGNING_CERTIFICATE",
    "WINDOWS_SIGNING_PASSWORD",
];
const CODEX_CHILD_ENV_REMOVED_PREFIXES: &[&str] = &["BUILDER_GEAR_"];
const DEFAULT_WORKSPACE_DIR_NAME: &str = "Builder Gear";
const WORKSPACE_BACKUPS_DIR: &str = ".builder/backups";
const BACKUP_WARN_COUNT: usize = 50;
const BACKUP_WARN_SIZE_BYTES: u64 = 1_073_741_824;
const WORKSPACE_BACKUP_KINDS: &[&str] = &[
    "schedules-save",
    "ontology-save",
    "skill-save",
    "skill-delete",
    "restore-preimage",
];
const MAX_CRON_LOOKBACK_MINUTES: i64 = 366 * 24 * 60;
const STARTER_BUILD_PLAN_SKILL: &str = r#"id: build-plan
name: Build Plan
version: 0.1.0
occupations:
  - developer
  - operator
  - designer
inputsJsonSchema:
  type: object
  additionalProperties: true
instructionsPath: instructions.md
requiredTools:
  - codex
  - git
uiPanels:
  - runs
  - skills
"#;
const STARTER_BUILD_PLAN_INSTRUCTIONS: &str = r#"# Build Plan

Turn the user's goal into a concrete implementation plan, identify risks, and keep the next action executable through the Builder Gear run contract.
"#;
const STARTER_ONTOLOGY: &str = r#"[
  {
    "id": "profession-builder",
    "type": "Profession",
    "label": "Professional Builder",
    "properties": {
      "audience": "cross-functional"
    },
    "relations": [
      {
        "type": "uses",
        "targetId": "skill-build-plan"
      }
    ]
  },
  {
    "id": "goal-first-run",
    "type": "Goal",
    "label": "Prepare the first Builder Gear run",
    "properties": {
      "status": "active"
    },
    "relations": [
      {
        "type": "guided-by",
        "targetId": "profession-builder"
      }
    ]
  }
]
"#;

struct RunProcess {
    child: Child,
    cancelled: bool,
    timed_out: bool,
    timeout_seconds: Option<u64>,
    timeout_deadline: Option<Instant>,
    schedule_key: Option<String>,
}

struct StartCodexRunOutcome {
    run_id: String,
    process_started: bool,
}

type RunRegistry = Mutex<HashMap<String, Arc<Mutex<RunProcess>>>>;
type ActiveScheduleRuns = Mutex<BTreeSet<String>>;

static RUN_REGISTRY: OnceLock<RunRegistry> = OnceLock::new();
static ACTIVE_RUN_PERMITS: OnceLock<Mutex<usize>> = OnceLock::new();
static ACTIVE_SCHEDULE_RUNS: OnceLock<ActiveScheduleRuns> = OnceLock::new();
static RUN_HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SCHEDULE_STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static RUNTIME_STARTED_AT: OnceLock<chrono::DateTime<chrono::Utc>> = OnceLock::new();
static RUN_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static DIAGNOSTICS_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInfo {
    codex_available: bool,
    codex_version: Option<String>,
    auth_path: String,
    auth_exists: bool,
    auth_checked: bool,
    default_workspace_path: String,
}

#[derive(Debug)]
struct CodexAuthInspection {
    path: PathBuf,
    exists: bool,
    readable: bool,
    is_file: bool,
    is_symlink: bool,
    permissions_secure: Option<bool>,
    mode: Option<String>,
}

impl CodexAuthInspection {
    fn ready(&self) -> bool {
        self.exists
            && self.readable
            && self.is_file
            && !self.is_symlink
            && self.permissions_secure != Some(false)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunRequest {
    workspace_path: String,
    prompt: String,
    model: Option<String>,
    profile: Option<String>,
    sandbox_mode: String,
    approval_mode: String,
    timeout_seconds: Option<u64>,
    skill_ids: Option<Vec<String>>,
    ontology_context_ids: Option<Vec<String>>,
    schedule_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexInvocationPreview {
    bin: String,
    args: Vec<String>,
    redacted: bool,
    skill_ids: Vec<String>,
    ontology_context_ids: Vec<String>,
    schedule_id: Option<String>,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuilderCatalogRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareWorkspaceRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsReportRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundleRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBackupsRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreWorkspaceBackupRequest {
    workspace_path: String,
    backup_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneWorkspaceBackupsRequest {
    workspace_path: String,
    keep: i64,
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSchedulesRequest {
    workspace_path: String,
    schedules: Vec<ScheduleSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveOntologyRequest {
    workspace_path: String,
    ontology: Vec<OntologyEntity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSkillRequest {
    workspace_path: String,
    original_id: Option<String>,
    manifest: SkillManifest,
    instructions: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSkillRequest {
    workspace_path: String,
    skill_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillSourceRequest {
    workspace_path: String,
    skill_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSource {
    manifest: SkillManifest,
    instructions: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleRunRequest {
    workspace_path: String,
    schedule_id: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuilderCatalog {
    skills: Vec<SkillManifest>,
    ontology: Vec<OntologyEntity>,
    schedules: Vec<ScheduleSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillManifest {
    id: String,
    name: String,
    #[serde(default = "default_version")]
    version: String,
    #[serde(default)]
    occupations: Vec<String>,
    #[serde(default = "default_inputs_json_schema")]
    inputs_json_schema: Value,
    #[serde(default = "default_instructions_path")]
    instructions_path: String,
    #[serde(default)]
    required_tools: Vec<String>,
    #[serde(default)]
    ui_panels: Vec<String>,
    #[serde(default)]
    schedule_templates: Vec<ScheduleSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleSpec {
    id: String,
    name: String,
    trigger: Value,
    timezone: String,
    run_request: AgentRunRequest,
    missed_run_policy: String,
    enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleRuntimeState {
    #[serde(default)]
    last_run_at_by_key: HashMap<String, String>,
    #[serde(default)]
    last_skipped_at_by_key: HashMap<String, String>,
    #[serde(default)]
    last_checked_at_by_key: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleTickResult {
    checked_at: String,
    schedule_count: usize,
    queued_run_ids: Vec<String>,
    skipped_schedule_ids: Vec<String>,
    errors: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScheduleAction {
    Idle,
    Run,
    SkipAndMark,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsReportResult {
    path: String,
    path_redacted: bool,
    report: DiagnosticsReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundleResult {
    path: String,
    path_redacted: bool,
    bundle: SupportBundle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBackupSummary {
    name: String,
    relative_path: String,
    kind: String,
    created_at: Option<String>,
    size_bytes: u64,
    entry_count: usize,
    directory: bool,
    target_relative_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreWorkspaceBackupResult {
    restored: WorkspaceBackupSummary,
    target_relative_path: String,
    pre_restore_backup: Option<WorkspaceBackupSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PruneWorkspaceBackupsResult {
    keep: usize,
    dry_run: bool,
    retained: Vec<WorkspaceBackupSummary>,
    candidates: Vec<WorkspaceBackupSummary>,
    pruned: Vec<WorkspaceBackupSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsReport {
    schema_version: u8,
    generated_at: String,
    app_version: String,
    platform: DiagnosticsPlatform,
    codex: DiagnosticsCodex,
    workspace: DiagnosticsWorkspace,
    run_history: DiagnosticsRunHistory,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsPlatform {
    os: String,
    arch: String,
    debug_build: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsCodex {
    available: bool,
    version: Option<String>,
    auth_path: String,
    auth_exists: bool,
    auth_checked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsWorkspace {
    path: String,
    exists: bool,
    skill_count: usize,
    ontology_count: usize,
    schedule_count: usize,
    enabled_schedule_count: usize,
    backup_count: usize,
    backup_size_bytes: u64,
    catalog_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsRunHistory {
    event_count: usize,
    last_event_at: Option<String>,
    event_types: HashMap<String, usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthReport {
    generated_at: String,
    status: String,
    checks: Vec<HealthCheck>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheck {
    id: String,
    title: String,
    status: String,
    message: String,
    action: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundle {
    schema_version: u8,
    generated_at: String,
    app_version: String,
    platform: DiagnosticsPlatform,
    workspace: SupportBundleWorkspace,
    diagnostics: DiagnosticsReport,
    health: HealthReport,
    privacy: SupportBundlePrivacy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundleWorkspace {
    selected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    basename: Option<String>,
    path_fingerprint: String,
    path_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundlePrivacy {
    redacted: bool,
    includes_auth_contents: bool,
    includes_raw_prompts: bool,
    includes_workspace_paths: bool,
    includes_run_payloads: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OntologyEntity {
    id: String,
    #[serde(rename = "type")]
    entity_type: String,
    label: String,
    #[serde(default = "default_object")]
    properties: Value,
    #[serde(default)]
    relations: Vec<OntologyRelation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OntologyRelation {
    #[serde(rename = "type")]
    relation_type: String,
    target_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunEvent {
    run_id: String,
    #[serde(rename = "type")]
    event_type: String,
    timestamp: String,
    payload: Value,
}

#[tauri::command]
fn builder_cli_info() -> CliInfo {
    renderer_cli_info(collect_cli_info())
}

#[tauri::command]
async fn builder_select_workspace_directory(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_title("Select Builder workspace")
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

fn collect_cli_info() -> CliInfo {
    let codex_bin = codex_bin();
    let codex_version = detect_codex_cli_version(&codex_bin);

    let auth_path = codex_auth_path();
    let auth = inspect_codex_auth_path(&auth_path);

    CliInfo {
        codex_available: codex_version.is_some(),
        codex_version,
        auth_path: auth_path.to_string_lossy().to_string(),
        auth_exists: auth.ready(),
        auth_checked: true,
        default_workspace_path: default_workspace_path().to_string_lossy().to_string(),
    }
}

fn detect_codex_cli_version(codex_bin: &str) -> Option<String> {
    detect_codex_cli_version_with_timeout(
        codex_bin,
        Duration::from_millis(CODEX_VERSION_TIMEOUT_MS),
    )
}

fn detect_codex_cli_version_with_timeout(codex_bin: &str, timeout: Duration) -> Option<String> {
    let mut command = Command::new(codex_bin);
    apply_codex_child_env_policy(&mut command);
    let mut child = command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout_reader = child.stdout.take().map(|stdout| {
        thread::spawn(move || read_bounded_process_output(stdout, MAX_CODEX_VERSION_OUTPUT_BYTES))
    });
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(CODEX_VERSION_POLL_MS)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let status = status?;
    let output = stdout_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();

    if !status.success() {
        return None;
    }

    let version = String::from_utf8_lossy(&output).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn read_bounded_process_output<R: Read>(mut reader: R, max_bytes: usize) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 1024];

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        let remaining = max_bytes.saturating_sub(output.len());

        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }

    output
}

fn renderer_cli_info(mut info: CliInfo) -> CliInfo {
    info.codex_version = info
        .codex_version
        .map(|version| redact_sensitive_text(&version));
    info.auth_path = diagnostics_path_label(Path::new(&info.auth_path), "codex auth file");
    info
}

#[tauri::command]
fn builder_codex_invocation(request: AgentRunRequest) -> Result<CodexInvocationPreview, String> {
    let request = normalize_runnable_request(request)?;
    let args = build_codex_args(&request);

    Ok(redacted_codex_invocation_preview(
        codex_bin(),
        args,
        &request,
    ))
}

#[tauri::command]
fn builder_load_catalog(request: BuilderCatalogRequest) -> Result<BuilderCatalog, String> {
    let Some(workspace) = resolve_catalog_workspace_path(&request.workspace_path)? else {
        return Ok(BuilderCatalog::default());
    };

    Ok(BuilderCatalog {
        skills: discover_workspace_skills(&workspace)?,
        ontology: discover_workspace_ontology(&workspace)?,
        schedules: discover_workspace_schedules(&workspace)?,
    })
}

#[tauri::command]
fn builder_prepare_workspace(request: PrepareWorkspaceRequest) -> Result<BuilderCatalog, String> {
    let workspace = resolve_workspace_path(&request.workspace_path)?;
    prepare_workspace(&workspace)?;

    Ok(BuilderCatalog {
        skills: discover_workspace_skills(&workspace)?,
        ontology: discover_workspace_ontology(&workspace)?,
        schedules: discover_workspace_schedules(&workspace)?,
    })
}

#[tauri::command]
fn builder_health_check(request: HealthCheckRequest) -> Result<HealthReport, String> {
    let workspace = resolve_workspace_path(&request.workspace_path)?;
    Ok(build_health_report(&workspace))
}

#[tauri::command]
fn builder_create_diagnostics_report(
    app: AppHandle,
    request: DiagnosticsReportRequest,
) -> Result<DiagnosticsReportResult, String> {
    let generated_at = chrono::Utc::now();
    let report = build_diagnostics_report(
        &app,
        &request.workspace_path,
        generated_at,
        env!("CARGO_PKG_VERSION"),
    )?;
    let path = diagnostics_report_path(&app, generated_at)?;
    let body = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("failed to serialize diagnostics report: {error}"))?;

    write_text_atomic(&path, &format!("{body}\n"))?;

    Ok(DiagnosticsReportResult {
        path: diagnostics_path_label(&path, "diagnostics report"),
        path_redacted: true,
        report,
    })
}

#[tauri::command]
fn builder_create_support_bundle(
    app: AppHandle,
    request: SupportBundleRequest,
) -> Result<SupportBundleResult, String> {
    let generated_at = chrono::Utc::now();
    let bundle = build_support_bundle(
        &app,
        &request.workspace_path,
        generated_at,
        env!("CARGO_PKG_VERSION"),
    )?;
    let path = support_bundle_path(&app, generated_at)?;
    let body = serde_json::to_string_pretty(&bundle)
        .map_err(|error| format!("failed to serialize support bundle: {error}"))?;

    write_text_atomic(&path, &format!("{body}\n"))?;

    Ok(SupportBundleResult {
        path: diagnostics_path_label(&path, "support bundle"),
        path_redacted: true,
        bundle,
    })
}

#[tauri::command]
fn builder_list_workspace_backups(
    request: WorkspaceBackupsRequest,
) -> Result<Vec<WorkspaceBackupSummary>, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    list_workspace_backups(&workspace)
}

#[tauri::command]
fn builder_restore_workspace_backup(
    request: RestoreWorkspaceBackupRequest,
) -> Result<RestoreWorkspaceBackupResult, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    restore_workspace_backup(&workspace, &request.backup_name)
}

#[tauri::command]
fn builder_prune_workspace_backups(
    request: PruneWorkspaceBackupsRequest,
) -> Result<PruneWorkspaceBackupsResult, String> {
    if request.keep < 0 {
        return Err("backup prune keep count must be a non-negative integer".to_string());
    }

    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    prune_workspace_backups(&workspace, request.keep as usize, !request.confirm)
}

#[tauri::command]
fn builder_tick_schedules(
    app: AppHandle,
    request: BuilderCatalogRequest,
) -> Result<ScheduleTickResult, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    let schedules = discover_workspace_schedules(&workspace)?;
    let now = chrono::Utc::now();
    let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let runtime_started_at = *runtime_started_at();
    let mut queued_run_ids = Vec::new();
    let mut skipped_schedule_ids = Vec::new();
    let mut errors = Vec::new();

    let _guard = schedule_state_lock()
        .lock()
        .map_err(|_| "schedule state lock failed".to_string())?;
    let mut state = read_schedule_state(&app)?;

    for schedule in &schedules {
        let key = schedule_state_key(&workspace, &schedule.id);
        let action = schedule_action(schedule, &state, &key, now, runtime_started_at);

        match action {
            ScheduleAction::Run => {
                let run_request = scheduled_run_request(schedule, &workspace);
                match start_codex_run_with_outcome(app.clone(), run_request) {
                    Ok(outcome) => {
                        if outcome.process_started {
                            queued_run_ids.push(outcome.run_id);
                        } else {
                            errors.push(format!(
                                "{}: run failed before Codex process started",
                                schedule.id
                            ));
                        }
                    }
                    Err(error) => errors.push(format!("{}: {error}", schedule.id)),
                }
            }
            ScheduleAction::SkipAndMark => {
                state
                    .last_skipped_at_by_key
                    .insert(key.clone(), now_text.clone());
                skipped_schedule_ids.push(schedule.id.clone());
            }
            ScheduleAction::Idle => {}
        }

        state
            .last_checked_at_by_key
            .insert(key.clone(), now_text.clone());
    }

    write_schedule_state(&app, &state)?;

    Ok(ScheduleTickResult {
        checked_at: now_text,
        schedule_count: schedules.len(),
        queued_run_ids,
        skipped_schedule_ids,
        errors,
    })
}

#[tauri::command]
fn builder_save_schedules(request: SaveSchedulesRequest) -> Result<BuilderCatalog, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    write_workspace_schedules(&workspace, &request.schedules)?;

    Ok(BuilderCatalog {
        skills: discover_workspace_skills(&workspace)?,
        ontology: discover_workspace_ontology(&workspace)?,
        schedules: discover_workspace_schedules(&workspace)?,
    })
}

#[tauri::command]
fn builder_save_ontology(request: SaveOntologyRequest) -> Result<BuilderCatalog, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    write_workspace_ontology(&workspace, &request.ontology)?;

    Ok(BuilderCatalog {
        skills: discover_workspace_skills(&workspace)?,
        ontology: discover_workspace_ontology(&workspace)?,
        schedules: discover_workspace_schedules(&workspace)?,
    })
}

#[tauri::command]
fn builder_save_skill(request: SaveSkillRequest) -> Result<BuilderCatalog, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    write_workspace_skill(
        &workspace,
        request.original_id.as_deref(),
        &request.manifest,
        &request.instructions,
    )?;

    Ok(BuilderCatalog {
        skills: discover_workspace_skills(&workspace)?,
        ontology: discover_workspace_ontology(&workspace)?,
        schedules: discover_workspace_schedules(&workspace)?,
    })
}

#[tauri::command]
fn builder_delete_skill(request: DeleteSkillRequest) -> Result<BuilderCatalog, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    delete_workspace_skill(&workspace, &request.skill_id)?;

    Ok(BuilderCatalog {
        skills: discover_workspace_skills(&workspace)?,
        ontology: discover_workspace_ontology(&workspace)?,
        schedules: discover_workspace_schedules(&workspace)?,
    })
}

#[tauri::command]
fn builder_load_skill_source(request: SkillSourceRequest) -> Result<SkillSource, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    read_workspace_skill_source(&workspace, &request.skill_id)
}

#[tauri::command]
fn builder_run_schedule_now(app: AppHandle, request: ScheduleRunRequest) -> Result<String, String> {
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;
    let schedules = discover_workspace_schedules(&workspace)?;
    let schedule = schedules
        .iter()
        .find(|schedule| schedule.id == request.schedule_id)
        .ok_or_else(|| format!("schedule not found: {}", request.schedule_id))?;
    let outcome =
        start_codex_run_with_outcome(app.clone(), scheduled_run_request(schedule, &workspace))?;

    Ok(outcome.run_id)
}

#[tauri::command]
fn builder_start_codex_run(app: AppHandle, request: AgentRunRequest) -> Result<String, String> {
    start_codex_run(app, request)
}

fn start_codex_run(app: AppHandle, request: AgentRunRequest) -> Result<String, String> {
    Ok(start_codex_run_with_outcome(app, request)?.run_id)
}

fn start_codex_run_with_outcome(
    app: AppHandle,
    request: AgentRunRequest,
) -> Result<StartCodexRunOutcome, String> {
    let request = normalize_runnable_request(request)?;
    let permit = RunPermit::acquire()?;
    let schedule_claim = ScheduleRunClaim::acquire(schedule_key_for_request(&request))?;

    let run_id = new_run_id();
    emit_run_event(
        &app,
        run_event(
            &run_id,
            "queued",
            json!({
                "workspaceSelected": !request.workspace_path.trim().is_empty(),
                "pathRedacted": true,
                "sandboxMode": request.sandbox_mode.clone(),
                "approvalMode": request.approval_mode.clone(),
                "timeoutSeconds": request.timeout_seconds,
                "skillIds": request.skill_ids.clone().unwrap_or_default(),
                "ontologyContextIds": request.ontology_context_ids.clone().unwrap_or_default(),
                "scheduleId": request.schedule_id.clone(),
            }),
        ),
    );

    let args = build_codex_args(&request);
    let mut child = match spawn_codex_process(&request.workspace_path, &args) {
        Ok(child) => child,
        Err(error) => {
            emit_run_event(
                &app,
                run_event(
                    &run_id,
                    "error",
                    json!({
                        "message": redact_sensitive_text(&format!("failed to run codex: {error}")),
                    }),
                ),
            );
            return Ok(StartCodexRunOutcome {
                run_id,
                process_started: false,
            });
        }
    };

    if let Err(error) = write_prompt_to_child_stdin(&mut child, &request.prompt) {
        emit_run_event(
            &app,
            run_event(
                &run_id,
                "error",
                json!({
                    "message": redact_sensitive_text(&format!("failed to write prompt to codex stdin: {error}")),
                }),
            ),
        );
        let _ = child.kill();
        return Ok(StartCodexRunOutcome {
            run_id,
            process_started: false,
        });
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let timeout_deadline = request
        .timeout_seconds
        .map(|seconds| Instant::now() + Duration::from_secs(seconds));
    let schedule_key = schedule_claim.key().map(ToOwned::to_owned);
    let process = Arc::new(Mutex::new(RunProcess {
        child,
        cancelled: false,
        timed_out: false,
        timeout_seconds: request.timeout_seconds,
        timeout_deadline,
        schedule_key: schedule_key.clone(),
    }));

    match run_registry().lock() {
        Ok(mut registry) => {
            registry.insert(run_id.clone(), Arc::clone(&process));
        }
        Err(_) => {
            if let Ok(mut process) = process.lock() {
                let _ = process.child.kill();
            }
            return Err("run registry lock failed".to_string());
        }
    }
    permit.transfer_to_registry();
    schedule_claim.transfer_to_process();

    if let Some(stdout) = stdout {
        spawn_output_reader(app.clone(), run_id.clone(), stdout, "stdout");
    }

    if let Some(stderr) = stderr {
        spawn_output_reader(app.clone(), run_id.clone(), stderr, "stderr");
    }

    spawn_exit_watcher(app, run_id.clone(), process, schedule_key);

    Ok(StartCodexRunOutcome {
        run_id,
        process_started: true,
    })
}

#[tauri::command]
fn builder_cancel_codex_run(run_id: String) -> Result<(), String> {
    let process = run_registry()
        .lock()
        .map_err(|_| "run registry lock failed".to_string())?
        .get(&run_id)
        .cloned()
        .ok_or_else(|| format!("run not found: {run_id}"))?;

    let mut process = process
        .lock()
        .map_err(|_| "run process lock failed".to_string())?;
    cancel_run_process(&mut process)
}

fn cancel_run_process(process: &mut RunProcess) -> Result<(), String> {
    process.cancelled = true;

    match process.child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => process
            .child
            .kill()
            .map_err(|error| redact_sensitive_text(&format!("failed to cancel run: {error}"))),
        Err(error) => Err(redact_sensitive_text(&format!(
            "failed to inspect run before cancel: {error}"
        ))),
    }
}

#[tauri::command]
fn builder_list_run_events(app: AppHandle) -> Result<Vec<AgentRunEvent>, String> {
    let _guard = run_history_lock()
        .lock()
        .map_err(|_| "run history lock failed".to_string())?;

    read_run_history(&app)
}

#[tauri::command]
fn builder_clear_run_events(app: AppHandle) -> Result<(), String> {
    let _guard = run_history_lock()
        .lock()
        .map_err(|_| "run history lock failed".to_string())?;
    let path = run_history_path(&app)?;
    let temp_path = run_history_temp_path(&path);

    remove_app_state_file_if_present(&path, "run history")?;
    remove_app_state_file_if_present(&temp_path, "run history temporary file")?;

    Ok(())
}

fn spawn_codex_process(workspace_path: &str, args: &[String]) -> std::io::Result<Child> {
    spawn_codex_process_with_bin(&codex_bin(), workspace_path, args)
}

fn spawn_codex_process_with_bin(
    codex_bin: &str,
    workspace_path: &str,
    args: &[String],
) -> std::io::Result<Child> {
    let mut command = Command::new(codex_bin);
    apply_codex_child_env_policy(&mut command);
    command
        .args(args)
        .current_dir(Path::new(workspace_path))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn apply_codex_child_env_policy(command: &mut Command) {
    for key in CODEX_CHILD_ENV_REMOVED_EXACT {
        command.env_remove(key);
    }

    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if should_remove_codex_child_env_key(&key_text) {
            command.env_remove(key);
        }
    }
}

fn should_remove_codex_child_env_key(key: &str) -> bool {
    let normalized = key.to_ascii_uppercase();

    CODEX_CHILD_ENV_REMOVED_EXACT.contains(&normalized.as_str())
        || CODEX_CHILD_ENV_REMOVED_PREFIXES
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
}

fn write_prompt_to_child_stdin(child: &mut Child, prompt: &str) -> std::io::Result<()> {
    let Some(mut stdin) = child.stdin.take() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "codex stdin was not piped",
        ));
    };

    stdin.write_all(prompt.as_bytes())?;
    stdin.flush()
}

fn spawn_output_reader<R>(app: AppHandle, run_id: String, stream: R, stream_type: &'static str)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        read_output_events(&run_id, stream_type, stream, |event| {
            emit_run_event(&app, event);
        });
    });
}

#[derive(Default)]
struct BoundedEventTextBuffer {
    chunks: Vec<String>,
    char_count: usize,
    truncated: bool,
}

impl BoundedEventTextBuffer {
    fn append(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }

        let remaining = MAX_BUFFERED_EVENT_TEXT_CHARS.saturating_sub(self.char_count);
        if remaining == 0 {
            self.truncated = true;
            return;
        }

        let value_char_count = value.chars().count();
        if value_char_count > remaining {
            self.chunks.push(value.chars().take(remaining).collect());
            self.char_count += remaining;
            self.truncated = true;
            return;
        }

        self.chunks.push(value.to_string());
        self.char_count += value_char_count;
    }

    fn to_event_text(&self) -> Option<String> {
        if self.char_count == 0 {
            return None;
        }

        Some(safe_buffered_event_text(
            &self.chunks.concat(),
            self.truncated,
        ))
    }
}

fn read_output_events<R, F>(run_id: &str, stream_type: &str, stream: R, mut emit: F)
where
    R: Read,
    F: FnMut(AgentRunEvent),
{
    let mut reader = BufReader::new(stream);
    let mut buffer = [0_u8; OUTPUT_READ_CHUNK_BYTES];
    let mut line = BoundedEventTextBuffer::default();

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        let chunk = String::from_utf8_lossy(&buffer[..read]);

        for segment in chunk.split_inclusive('\n') {
            if let Some(without_newline) = segment.strip_suffix('\n') {
                line.append(
                    without_newline
                        .strip_suffix('\r')
                        .unwrap_or(without_newline),
                );
                emit_buffered_output_event(run_id, stream_type, &line, &mut emit);
                line = BoundedEventTextBuffer::default();
            } else {
                line.append(segment);
            }
        }
    }

    emit_buffered_output_event(run_id, stream_type, &line, &mut emit);
}

fn emit_buffered_output_event<F>(
    run_id: &str,
    stream_type: &str,
    line: &BoundedEventTextBuffer,
    emit: &mut F,
) where
    F: FnMut(AgentRunEvent),
{
    if let Some(event_text) = line.to_event_text() {
        if let Some(event) = event_for_safe_output_line(run_id, stream_type, &event_text) {
            emit(event);
        }
    }
}

#[cfg(test)]
fn event_for_output_line(run_id: &str, stream_type: &str, line: &str) -> Option<AgentRunEvent> {
    let safe_line = safe_event_text(line);
    event_for_safe_output_line(run_id, stream_type, &safe_line)
}

fn event_for_safe_output_line(
    run_id: &str,
    stream_type: &str,
    safe_line: &str,
) -> Option<AgentRunEvent> {
    if safe_line.trim().is_empty() {
        return None;
    }

    if stream_type == "stdout" {
        return match serde_json::from_str::<Value>(safe_line) {
            Ok(value) => Some(run_event(run_id, "codex_event", value)),
            Err(_) => Some(run_event(
                run_id,
                "stdout",
                Value::String(safe_line.to_string()),
            )),
        };
    }

    Some(run_event(
        run_id,
        "stderr",
        Value::String(safe_line.to_string()),
    ))
}

fn spawn_exit_watcher(
    app: AppHandle,
    run_id: String,
    process: Arc<Mutex<RunProcess>>,
    claimed_schedule_key: Option<String>,
) {
    thread::spawn(move || loop {
        let status = {
            let mut process = match process.lock() {
                Ok(process) => process,
                Err(_) => {
                    emit_run_event(
                        &app,
                        run_event(
                            &run_id,
                            "error",
                            json!({ "message": "run process lock failed" }),
                        ),
                    );
                    release_active_schedule_run(claimed_schedule_key.as_deref());
                    remove_run(&run_id);
                    return;
                }
            };

            maybe_timeout_run_process(&mut process, Instant::now());

            match process.child.try_wait() {
                Ok(Some(status)) => Some(Ok((
                    status,
                    process.cancelled,
                    process.timed_out,
                    process.timeout_seconds,
                    process.schedule_key.clone(),
                ))),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        };

        match status {
            Some(Ok((
                exit_status,
                cancelled,
                timed_out,
                timeout_seconds,
                finished_schedule_key,
            ))) => {
                if timed_out {
                    emit_run_event(
                        &app,
                        run_event(
                            &run_id,
                            "error",
                            json!({
                                "exitCode": exit_status.code(),
                                "timedOut": true,
                                "timeoutSeconds": timeout_seconds,
                                "message": format!(
                                    "run timed out after {} seconds",
                                    timeout_seconds.unwrap_or_default()
                                ),
                            }),
                        ),
                    );
                } else if cancelled {
                    emit_run_event(
                        &app,
                        run_event(
                            &run_id,
                            "error",
                            json!({ "message": "run cancelled", "cancelled": true }),
                        ),
                    );
                } else if exit_status.success() {
                    emit_run_event(
                        &app,
                        run_event(
                            &run_id,
                            "done",
                            json!({ "exitCode": exit_status.code().unwrap_or(0) }),
                        ),
                    );
                } else {
                    emit_run_event(
                        &app,
                        run_event(
                            &run_id,
                            "error",
                            json!({
                                "exitCode": exit_status.code(),
                                "message": format!(
                                    "codex exited with code {}",
                                    exit_status
                                        .code()
                                        .map_or("unknown".to_string(), |code| code.to_string())
                                ),
                            }),
                        ),
                    );
                }

                if exit_status.success() && !cancelled && !timed_out {
                    if let Some(key) = &finished_schedule_key {
                        let _ = record_schedule_run_success(&app, key);
                    }
                }
                release_active_schedule_run(finished_schedule_key.as_deref());
                remove_run(&run_id);
                return;
            }
            Some(Err(error)) => {
                emit_run_event(
                    &app,
                    run_event(
                        &run_id,
                        "error",
                        json!({ "message": redact_sensitive_text(&format!("failed to wait for codex: {error}")) }),
                    ),
                );
                release_active_schedule_run(claimed_schedule_key.as_deref());
                remove_run(&run_id);
                return;
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    });
}

fn maybe_timeout_run_process(process: &mut RunProcess, now: Instant) -> bool {
    if process.cancelled || process.timed_out {
        return false;
    }

    let Some(deadline) = process.timeout_deadline else {
        return false;
    };

    if now < deadline {
        return false;
    }

    process.timed_out = true;
    let _ = process.child.kill();
    true
}

fn emit_run_event(app: &AppHandle, event: AgentRunEvent) {
    let _ = append_run_history(app, &event);
    let _ = app.emit(RUN_EVENT_NAME, event);
}

fn run_registry() -> &'static RunRegistry {
    RUN_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_run_permits() -> &'static Mutex<usize> {
    ACTIVE_RUN_PERMITS.get_or_init(|| Mutex::new(0))
}

fn active_schedule_runs() -> &'static ActiveScheduleRuns {
    ACTIVE_SCHEDULE_RUNS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

struct RunPermit {
    transfer_to_registry: bool,
}

impl RunPermit {
    fn acquire() -> Result<Self, String> {
        let mut active_runs = active_run_permits()
            .lock()
            .map_err(|_| "active run permit lock failed".to_string())?;

        if *active_runs >= MAX_ACTIVE_RUNS {
            return Err(format!(
                "too many active runs; limit is {MAX_ACTIVE_RUNS}. Wait for a run to finish or cancel one before starting another."
            ));
        }

        *active_runs += 1;
        Ok(Self {
            transfer_to_registry: false,
        })
    }

    fn transfer_to_registry(mut self) {
        self.transfer_to_registry = true;
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        if !self.transfer_to_registry {
            release_run_permit();
        }
    }
}

fn release_run_permit() {
    if let Ok(mut active_runs) = active_run_permits().lock() {
        *active_runs = active_runs.saturating_sub(1);
    }
}

struct ScheduleRunClaim {
    key: Option<String>,
    transfer_to_process: bool,
}

impl ScheduleRunClaim {
    fn acquire(key: Option<String>) -> Result<Self, String> {
        let Some(key) = key else {
            return Ok(Self {
                key: None,
                transfer_to_process: false,
            });
        };

        let mut active_runs = active_schedule_runs()
            .lock()
            .map_err(|_| "active schedule run lock failed".to_string())?;

        if active_runs.contains(&key) {
            return Err("schedule already has an active run".to_string());
        }

        active_runs.insert(key.clone());
        Ok(Self {
            key: Some(key),
            transfer_to_process: false,
        })
    }

    fn key(&self) -> Option<&str> {
        self.key.as_deref()
    }

    fn transfer_to_process(mut self) {
        self.transfer_to_process = true;
    }
}

impl Drop for ScheduleRunClaim {
    fn drop(&mut self) {
        if !self.transfer_to_process {
            release_active_schedule_run(self.key.as_deref());
        }
    }
}

fn release_active_schedule_run(key: Option<&str>) {
    let Some(key) = key else {
        return;
    };

    if let Ok(mut active_runs) = active_schedule_runs().lock() {
        active_runs.remove(key);
    }
}

fn run_history_lock() -> &'static Mutex<()> {
    RUN_HISTORY_LOCK.get_or_init(|| Mutex::new(()))
}

fn schedule_state_lock() -> &'static Mutex<()> {
    SCHEDULE_STATE_LOCK.get_or_init(|| Mutex::new(()))
}

fn runtime_started_at() -> &'static chrono::DateTime<chrono::Utc> {
    RUNTIME_STARTED_AT.get_or_init(chrono::Utc::now)
}

fn prepare_app_data_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    match fs::symlink_metadata(app_data_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "app data directory must not be a symlink: {}",
                app_data_dir.display()
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "app data path exists but is not a directory: {}",
                app_data_dir.display()
            ));
        }
        Ok(_) => return Ok(app_data_dir.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect app data directory: {error}")),
    }

    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("failed to create app data directory: {error}"))?;

    let metadata = fs::symlink_metadata(app_data_dir)
        .map_err(|error| format!("failed to inspect app data directory: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "app data directory must not be a symlink: {}",
            app_data_dir.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "app data path exists but is not a directory: {}",
            app_data_dir.display()
        ));
    }

    Ok(app_data_dir.to_path_buf())
}

fn run_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let dir = prepare_app_data_dir(&dir)?;
    Ok(dir.join(RUN_HISTORY_FILE))
}

fn run_history_temp_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{RUN_HISTORY_FILE}.tmp"))
}

fn remove_app_state_file_if_present(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{label} must not be a symlink: {}", path.display()))
        }
        Ok(metadata) if !metadata.is_file() => {
            Err(format!("{label} is not a file: {}", path.display()))
        }
        Ok(_) => {
            fs::remove_file(path).map_err(|error| format!("failed to remove {label}: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to inspect {label} {}: {error}",
            path.display()
        )),
    }
}

fn read_run_history(app: &AppHandle) -> Result<Vec<AgentRunEvent>, String> {
    let path = run_history_path(app)?;
    read_run_history_from_path(&path)
}

fn read_run_history_from_path(path: &Path) -> Result<Vec<AgentRunEvent>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let source = match read_bounded_text_file(path, "run history", MAX_APP_STATE_TEXT_FILE_BYTES) {
        Ok(source) => source,
        Err(error) if is_oversized_text_file_error(&error) => {
            let _quarantined_path =
                quarantine_corrupt_file(path, "run history").map_err(|quarantine_error| {
                    format!("failed to read run history: {error}; {quarantine_error}")
                })?;
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };

    if source.trim().is_empty() {
        return Ok(Vec::new());
    }

    let events = match serde_json::from_str::<Vec<AgentRunEvent>>(&source) {
        Ok(events) => events,
        Err(error) => {
            let _quarantined_path =
                quarantine_corrupt_file(path, "run history").map_err(|quarantine_error| {
                    format!("failed to parse run history: {error}; {quarantine_error}")
                })?;
            return Ok(Vec::new());
        }
    };

    Ok(events
        .into_iter()
        .map(|event| persistable_run_event(&event))
        .take(MAX_STORED_RUN_EVENTS)
        .collect())
}

fn write_run_history(app: &AppHandle, events: &[AgentRunEvent]) -> Result<(), String> {
    let path = run_history_path(app)?;
    let body = serde_json::to_string_pretty(events)
        .map_err(|error| format!("failed to serialize run history: {error}"))?;

    write_text_atomic_with_temp(&path, &run_history_temp_path(&path), &body)
        .map_err(|error| format!("failed to persist run history: {error}"))
}

fn append_run_history(app: &AppHandle, event: &AgentRunEvent) -> Result<(), String> {
    let _guard = run_history_lock()
        .lock()
        .map_err(|_| "run history lock failed".to_string())?;
    let events = prepend_and_cap_history(read_run_history(app)?, persistable_run_event(event));

    write_run_history(app, &events)
}

fn persistable_run_event(event: &AgentRunEvent) -> AgentRunEvent {
    AgentRunEvent {
        run_id: event.run_id.clone(),
        event_type: event.event_type.clone(),
        timestamp: event.timestamp.clone(),
        payload: persistable_payload(event),
    }
}

fn persistable_payload(event: &AgentRunEvent) -> Value {
    match event.event_type.as_str() {
        "queued" => json!({
            "sandboxMode": string_field(&event.payload, "sandboxMode"),
            "approvalMode": string_field(&event.payload, "approvalMode"),
            "timeoutSeconds": event.payload.get("timeoutSeconds").and_then(Value::as_u64),
            "skillCount": array_len_field(&event.payload, "skillIds"),
            "ontologyContextCount": array_len_field(&event.payload, "ontologyContextIds"),
            "scheduleId": string_field(&event.payload, "scheduleId"),
        }),
        "done" => json!({
            "exitCode": event.payload.get("exitCode").and_then(Value::as_i64),
        }),
        "error" => json!({
            "exitCode": event.payload.get("exitCode").and_then(Value::as_i64),
            "cancelled": event.payload.get("cancelled").and_then(Value::as_bool).unwrap_or(false),
            "timedOut": event.payload.get("timedOut").and_then(Value::as_bool).unwrap_or(false),
            "message": event.payload
                .get("message")
                .and_then(Value::as_str)
                .map(safe_persisted_message)
                .unwrap_or_else(|| "Run failed".to_string()),
        }),
        "codex_event" => json!({
            "summary": "Codex JSON event payload redacted from persisted history",
            "codexType": string_field(&event.payload, "type"),
        }),
        "stdout" | "stderr" => json!({
            "summary": format!("{} payload redacted from persisted history", event.event_type),
            "byteLength": payload_byte_length(&event.payload),
        }),
        "artifact" => json!({
            "summary": "Artifact payload redacted from persisted history",
        }),
        _ => json!({
            "summary": "Event payload redacted from persisted history",
        }),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(redact_secret_like_text)
}

fn array_len_field(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default()
}

fn payload_byte_length(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len(),
        _ => value.to_string().len(),
    }
}

fn safe_persisted_message(message: &str) -> String {
    let redacted = redact_sensitive_text(message);
    let truncated = redacted.chars().take(500).collect::<String>();

    if truncated.len() == redacted.len() {
        truncated
    } else {
        format!("{truncated}...")
    }
}

fn prepend_and_cap_history(
    mut events: Vec<AgentRunEvent>,
    event: AgentRunEvent,
) -> Vec<AgentRunEvent> {
    events.insert(0, event);
    events.truncate(MAX_STORED_RUN_EVENTS);
    events
}

fn diagnostics_report_path(
    app: &AppHandle,
    generated_at: chrono::DateTime<chrono::Utc>,
) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let dir = prepare_diagnostics_dir(&app_data_dir)?;

    Ok(dir.join(diagnostics_artifact_file_name(
        "builder-gear-diagnostics",
        generated_at,
    )))
}

fn support_bundle_path(
    app: &AppHandle,
    generated_at: chrono::DateTime<chrono::Utc>,
) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let dir = prepare_diagnostics_dir(&app_data_dir)?;

    Ok(dir.join(diagnostics_artifact_file_name(
        "builder-gear-support-bundle",
        generated_at,
    )))
}

fn diagnostics_artifact_file_name(
    prefix: &str,
    generated_at: chrono::DateTime<chrono::Utc>,
) -> String {
    let sequence = DIAGNOSTICS_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    format!(
        "{prefix}-{}.{:09}Z-{sequence}.json",
        generated_at.format("%Y%m%dT%H%M%S"),
        generated_at.timestamp_subsec_nanos()
    )
}

fn prepare_diagnostics_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    let app_data_dir = prepare_app_data_dir(app_data_dir)?;
    let dir = app_data_dir.join(DIAGNOSTICS_DIR);

    match fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "diagnostics directory must not be a symlink: {}",
                dir.display()
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "diagnostics path exists but is not a directory: {}",
                dir.display()
            ));
        }
        Ok(_) => return Ok(dir),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect diagnostics directory: {error}")),
    }

    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create diagnostics directory: {error}"))?;

    let metadata = fs::symlink_metadata(&dir)
        .map_err(|error| format!("failed to inspect diagnostics directory: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "diagnostics directory must not be a symlink: {}",
            dir.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "diagnostics path exists but is not a directory: {}",
            dir.display()
        ));
    }

    Ok(dir)
}

fn build_support_bundle(
    app: &AppHandle,
    workspace_path: &str,
    generated_at: chrono::DateTime<chrono::Utc>,
    app_version: &str,
) -> Result<SupportBundle, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let diagnostics = build_diagnostics_report(app, workspace_path, generated_at, app_version)?;
    let health = build_health_report(&workspace);

    Ok(support_bundle_from_parts(
        app_version,
        generated_at,
        &workspace,
        diagnostics,
        health,
    ))
}

fn support_bundle_from_parts(
    app_version: &str,
    generated_at: chrono::DateTime<chrono::Utc>,
    workspace: &Path,
    diagnostics: DiagnosticsReport,
    health: HealthReport,
) -> SupportBundle {
    SupportBundle {
        schema_version: 1,
        generated_at: generated_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        app_version: app_version.to_string(),
        platform: DiagnosticsPlatform {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            debug_build: cfg!(debug_assertions),
        },
        workspace: support_bundle_workspace(workspace),
        diagnostics: sanitize_support_diagnostics_report(diagnostics, workspace),
        health: sanitize_support_health_report(health, workspace),
        privacy: SupportBundlePrivacy {
            redacted: true,
            includes_auth_contents: false,
            includes_raw_prompts: false,
            includes_workspace_paths: false,
            includes_run_payloads: false,
        },
    }
}

fn sanitize_support_diagnostics_report(
    mut report: DiagnosticsReport,
    workspace: &Path,
) -> DiagnosticsReport {
    report.codex.version = report
        .codex
        .version
        .map(|version| redact_support_bundle_text(&version, workspace));
    report.codex.auth_path = redact_support_bundle_text(&report.codex.auth_path, workspace);
    report.workspace.path = redact_support_bundle_text(&report.workspace.path, workspace);
    report.workspace.catalog_error = report
        .workspace
        .catalog_error
        .map(|error| redact_support_bundle_text(&error, workspace));
    report
}

fn support_bundle_workspace(workspace: &Path) -> SupportBundleWorkspace {
    SupportBundleWorkspace {
        selected: !workspace.as_os_str().is_empty(),
        basename: None,
        path_fingerprint: support_path_fingerprint(workspace),
        path_redacted: true,
    }
}

fn support_path_fingerprint(workspace: &Path) -> String {
    let digest = Sha256::digest(workspace.to_string_lossy().as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    hex.chars().take(16).collect()
}

fn sanitize_support_health_report(report: HealthReport, workspace: &Path) -> HealthReport {
    sanitize_health_report_text(report, workspace)
}

fn sanitize_health_report_text(report: HealthReport, workspace: &Path) -> HealthReport {
    HealthReport {
        generated_at: report.generated_at,
        status: report.status,
        checks: report
            .checks
            .into_iter()
            .map(|check| HealthCheck {
                id: check.id,
                title: check.title,
                status: check.status,
                message: redact_support_bundle_text(&check.message, workspace),
                action: check
                    .action
                    .map(|action| redact_support_bundle_text(&action, workspace)),
            })
            .collect(),
    }
}

fn redact_support_bundle_text(input: &str, workspace: &Path) -> String {
    let mut output = redact_secret_like_text(input);
    let candidates = support_path_redaction_candidates(workspace);

    for candidate in candidates {
        output = output.replace(&candidate, "[WORKSPACE_PATH]");
    }

    for candidate in support_workspace_name_redaction_candidates(workspace) {
        output = output.replace(&candidate, "[WORKSPACE_NAME]");
    }

    let patterns = [
        (r#"file:///[^"'\s)]+"#, "[LOCAL_FILE_URL]"),
        (
            r#"/(?:Users|home|tmp|var|private/var)/[^"'\s)]+"#,
            "[LOCAL_PATH]",
        ),
        (r#"(^|[\s"'(])/[^\s"')]+"#, "$1[LOCAL_PATH]"),
        (r#"[A-Za-z]:\\[^"'\s)]+"#, "[LOCAL_PATH]"),
        (r#"(^|[\s"'(])~/[^"'\s)]+"#, "$1[LOCAL_PATH]"),
    ];

    for (pattern, replacement) in patterns {
        if let Ok(regex) = regex::Regex::new(pattern) {
            output = regex.replace_all(&output, replacement).to_string();
        }
    }

    output
}

fn support_path_redaction_candidates(workspace: &Path) -> Vec<String> {
    let mut candidates = BTreeSet::new();
    insert_support_path_candidate(&mut candidates, workspace.to_string_lossy().to_string());
    insert_support_path_candidate(&mut candidates, user_visible_path(workspace));

    if let Ok(canonical) = fs::canonicalize(workspace) {
        insert_support_path_candidate(&mut candidates, canonical.to_string_lossy().to_string());
        insert_support_path_candidate(&mut candidates, user_visible_path(&canonical));
    }

    let mut candidates = candidates
        .into_iter()
        .filter(|candidate| !candidate.trim().is_empty())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.len()));
    candidates
}

fn insert_support_path_candidate(candidates: &mut BTreeSet<String>, candidate: String) {
    if candidate.trim().is_empty() {
        return;
    }

    for alias in macos_private_var_aliases(&candidate) {
        candidates.insert(alias);
    }
    candidates.insert(candidate);
}

fn macos_private_var_aliases(value: &str) -> Vec<String> {
    if value.starts_with("/var/") {
        return vec![format!("/private{value}")];
    }

    if value.starts_with("/private/var/") {
        return vec![value.replacen("/private", "", 1)];
    }

    Vec::new()
}

fn support_workspace_name_redaction_candidates(workspace: &Path) -> Vec<String> {
    let mut candidates = BTreeSet::new();

    if let Some(name) = workspace.file_name().and_then(|name| name.to_str()) {
        candidates.insert(name.to_string());
    }

    if let Ok(canonical) = fs::canonicalize(workspace) {
        if let Some(name) = canonical.file_name().and_then(|name| name.to_str()) {
            candidates.insert(name.to_string());
        }
    }

    let mut candidates = candidates
        .into_iter()
        .filter(|candidate| !candidate.trim().is_empty())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.len()));
    candidates
}

fn build_diagnostics_report(
    app: &AppHandle,
    workspace_path: &str,
    generated_at: chrono::DateTime<chrono::Utc>,
    app_version: &str,
) -> Result<DiagnosticsReport, String> {
    let cli_info = collect_cli_info();
    let workspace = resolve_workspace_path(workspace_path)?;
    let events = {
        let _guard = run_history_lock()
            .lock()
            .map_err(|_| "run history lock failed".to_string())?;
        read_run_history(app).unwrap_or_default()
    };

    Ok(diagnostics_report_from_parts(
        app_version,
        generated_at,
        cli_info,
        &workspace,
        events,
    ))
}

fn diagnostics_report_from_parts(
    app_version: &str,
    generated_at: chrono::DateTime<chrono::Utc>,
    cli_info: CliInfo,
    workspace: &Path,
    events: Vec<AgentRunEvent>,
) -> DiagnosticsReport {
    DiagnosticsReport {
        schema_version: 1,
        generated_at: generated_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        app_version: app_version.to_string(),
        platform: DiagnosticsPlatform {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            debug_build: cfg!(debug_assertions),
        },
        codex: DiagnosticsCodex {
            available: cli_info.codex_available,
            version: cli_info
                .codex_version
                .map(|version| redact_secret_like_text(&version)),
            auth_path: diagnostics_path_label(Path::new(&cli_info.auth_path), "codex auth file"),
            auth_exists: cli_info.auth_exists,
            auth_checked: cli_info.auth_checked,
        },
        workspace: diagnostics_workspace(workspace),
        run_history: diagnostics_run_history(events),
    }
}

fn diagnostics_workspace(workspace: &Path) -> DiagnosticsWorkspace {
    let mut errors = Vec::new();
    let mut skill_count = 0;
    let mut ontology_count = 0;
    let mut schedule_count = 0;
    let mut enabled_schedule_count = 0;
    let mut backup_count = 0;
    let mut backup_size_bytes = 0;
    let catalog_workspace = match existing_workspace_root_path(workspace) {
        Ok(workspace) => workspace,
        Err(_error) => {
            errors.push("workspace root is invalid".to_string());
            None
        }
    };

    if let Some(workspace) = catalog_workspace.as_deref() {
        match discover_workspace_skills(workspace) {
            Ok(skills) => skill_count = skills.len(),
            Err(error) => errors.push(error),
        }

        match discover_workspace_ontology(workspace) {
            Ok(ontology) => ontology_count = ontology.len(),
            Err(error) => errors.push(error),
        }

        match discover_workspace_schedules(workspace) {
            Ok(schedules) => {
                schedule_count = schedules.len();
                enabled_schedule_count =
                    schedules.iter().filter(|schedule| schedule.enabled).count();
            }
            Err(error) => errors.push(error),
        }

        match list_workspace_backups(workspace) {
            Ok(backups) => {
                backup_count = backups.len();
                backup_size_bytes = backups.iter().fold(0_u64, |total, backup| {
                    total.saturating_add(backup.size_bytes)
                });
            }
            Err(_error) => errors.push("workspace backups are invalid".to_string()),
        }
    }

    DiagnosticsWorkspace {
        path: diagnostics_workspace_label(),
        exists: catalog_workspace.is_some(),
        skill_count,
        ontology_count,
        schedule_count,
        enabled_schedule_count,
        backup_count,
        backup_size_bytes,
        catalog_error: if errors.is_empty() {
            None
        } else {
            Some("Workspace catalog has errors; run health check for local details.".to_string())
        },
    }
}

fn diagnostics_run_history(events: Vec<AgentRunEvent>) -> DiagnosticsRunHistory {
    let mut event_types = HashMap::new();

    for event in &events {
        *event_types.entry(event.event_type.clone()).or_insert(0) += 1;
    }

    DiagnosticsRunHistory {
        event_count: events.len(),
        last_event_at: events.first().map(|event| event.timestamp.clone()),
        event_types,
    }
}

fn build_health_report(workspace: &Path) -> HealthReport {
    let mut checks = Vec::new();
    checks.push(codex_health_check());
    checks.push(auth_health_check());
    checks.push(workspace_health_check(workspace));

    if let Ok(Some(workspace)) = existing_workspace_root_path(workspace) {
        checks.push(skill_health_check(&workspace));
        checks.push(ontology_health_check(&workspace));
        checks.push(schedule_health_check(&workspace));
        checks.push(backup_health_check(&workspace));
    }

    sanitize_health_report_text(
        HealthReport {
            generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            status: health_status(&checks),
            checks,
        },
        workspace,
    )
}

fn health_check(
    id: &str,
    title: &str,
    status: &str,
    message: String,
    action: Option<&str>,
) -> HealthCheck {
    HealthCheck {
        id: id.to_string(),
        title: title.to_string(),
        status: status.to_string(),
        message,
        action: action.map(str::to_string),
    }
}

fn codex_health_check() -> HealthCheck {
    let info = builder_cli_info();

    if info.codex_available {
        let version = info
            .codex_version
            .as_deref()
            .map(redact_secret_like_text)
            .unwrap_or_else(|| "version unknown".to_string());

        health_check(
            "codex-cli",
            "Codex CLI",
            "pass",
            format!("Codex CLI detected: {version}"),
            None,
        )
    } else {
        health_check(
            "codex-cli",
            "Codex CLI",
            "fail",
            "Codex CLI was not found on PATH".to_string(),
            Some("Install Codex CLI or set BUILDER_GEAR_CODEX_BIN to a compatible executable."),
        )
    }
}

fn auth_health_check() -> HealthCheck {
    let auth_path = codex_auth_path();
    auth_health_check_for_path(&auth_path)
}

fn auth_health_check_for_path(auth_path: &Path) -> HealthCheck {
    let auth = inspect_codex_auth_path(auth_path);

    if !auth.exists {
        health_check(
            "codex-auth",
            "Codex Auth",
            "fail",
            format!("Auth file is missing at {}", user_visible_path(&auth.path)),
            Some("Run Codex login. Builder Gear only checks auth metadata and will not read its contents."),
        )
    } else if auth.is_symlink {
        health_check(
            "codex-auth",
            "Codex Auth",
            "fail",
            format!(
                "Auth file must not be a symlink at {}",
                user_visible_path(&auth.path)
            ),
            Some("Remove the symlink and run Codex login so the auth file is user-owned."),
        )
    } else if !auth.is_file {
        health_check(
            "codex-auth",
            "Codex Auth",
            "fail",
            format!(
                "Auth path is not a regular file at {}",
                user_visible_path(&auth.path)
            ),
            Some("Run Codex login so auth.json is recreated as a regular user-owned file."),
        )
    } else if !auth.readable {
        health_check(
            "codex-auth",
            "Codex Auth",
            "fail",
            format!(
                "Auth file is not readable at {}",
                user_visible_path(&auth.path)
            ),
            Some("Keep the auth file user-owned and readable by the current user."),
        )
    } else if auth.permissions_secure == Some(false) {
        let mode = auth
            .mode
            .as_deref()
            .map(|value| format!(" ({value})"))
            .unwrap_or_default();
        health_check(
            "codex-auth",
            "Codex Auth",
            "fail",
            format!(
                "Auth file permissions are too open at {}{}",
                user_visible_path(&auth.path),
                mode
            ),
            Some("Restrict the auth file to the current user, for example with chmod 600."),
        )
    } else {
        health_check(
            "codex-auth",
            "Codex Auth",
            "pass",
            format!("Auth file is present at {}", user_visible_path(&auth.path)),
            None,
        )
    }
}

fn workspace_health_check(workspace: &Path) -> HealthCheck {
    match existing_workspace_root_path(workspace) {
        Ok(Some(workspace)) => health_check(
            "workspace",
            "Workspace",
            "pass",
            format!("Workspace exists at {}", user_visible_path(&workspace)),
            None,
        ),
        Ok(None) => health_check(
            "workspace",
            "Workspace",
            "fail",
            format!("Workspace is missing: {}", user_visible_path(workspace)),
            Some("Select or create a valid Builder Gear workspace."),
        ),
        Err(error) => health_check(
            "workspace",
            "Workspace",
            "fail",
            redact_secret_like_text(&error),
            Some("Select a real workspace directory, not a symlink or file path."),
        ),
    }
}

fn skill_health_check(workspace: &Path) -> HealthCheck {
    match discover_workspace_skills(workspace) {
        Ok(skills) if skills.is_empty() => health_check(
            "skills",
            "Skills",
            "warn",
            "No skills were found in the workspace".to_string(),
            Some("Create at least one skills/<skill-id>/skill.yaml file before shipping a workspace."),
        ),
        Ok(skills) => health_check(
            "skills",
            "Skills",
            "pass",
            format!("{} skill manifest{} loaded", skills.len(), if skills.len() == 1 { "" } else { "s" }),
            None,
        ),
        Err(error) => health_check(
            "skills",
            "Skills",
            "fail",
            redact_secret_like_text(&error),
            Some("Fix invalid skill.yaml files before running agents."),
        ),
    }
}

fn ontology_health_check(workspace: &Path) -> HealthCheck {
    match discover_workspace_ontology(workspace) {
        Ok(ontology) if ontology.is_empty() => health_check(
            "ontology",
            "Ontology",
            "warn",
            "No ontology JSON files were found".to_string(),
            Some("Add ontology entities so runs can attach structured context."),
        ),
        Ok(ontology) => health_check(
            "ontology",
            "Ontology",
            "pass",
            format!(
                "{} ontology entit{} loaded",
                ontology.len(),
                if ontology.len() == 1 { "y" } else { "ies" }
            ),
            None,
        ),
        Err(error) => health_check(
            "ontology",
            "Ontology",
            "fail",
            redact_secret_like_text(&error),
            Some("Fix ontology JSON before attaching context."),
        ),
    }
}

fn schedule_health_check(workspace: &Path) -> HealthCheck {
    match discover_workspace_schedules(workspace) {
        Ok(schedules) if schedules.is_empty() => health_check(
            "schedules",
            "Schedules",
            "warn",
            "No .builder/schedules.json file was found".to_string(),
            Some("Create schedules from the desktop app or CLI when recurring runs are needed."),
        ),
        Ok(schedules) => {
            let enabled_count = schedules.iter().filter(|schedule| schedule.enabled).count();

            health_check(
                "schedules",
                "Schedules",
                "pass",
                format!(
                    "{} schedule{} loaded; {} enabled",
                    schedules.len(),
                    if schedules.len() == 1 { "" } else { "s" },
                    enabled_count
                ),
                None,
            )
        }
        Err(error) => health_check(
            "schedules",
            "Schedules",
            "fail",
            redact_secret_like_text(&error),
            Some("Fix .builder/schedules.json before enabling scheduler runs."),
        ),
    }
}

fn backup_health_check(workspace: &Path) -> HealthCheck {
    match list_workspace_backups(workspace) {
        Ok(backups) => {
            let total_size = backups
                .iter()
                .fold(0_u64, |total, backup| total.saturating_add(backup.size_bytes));
            let message = format!(
                "{} workspace backup{}; {} total",
                backups.len(),
                if backups.len() == 1 { "" } else { "s" },
                format_bytes(total_size)
            );

            if backups.len() > BACKUP_WARN_COUNT || total_size > BACKUP_WARN_SIZE_BYTES {
                health_check(
                    "workspace-backups",
                    "Workspace Backups",
                    "warn",
                    message,
                    Some("Review old backups in the Backups view or run builder backups prune --keep 50 after confirming restore needs."),
                )
            } else {
                health_check(
                    "workspace-backups",
                    "Workspace Backups",
                    "pass",
                    message,
                    None,
                )
            }
        }
        Err(error) => health_check(
            "workspace-backups",
            "Workspace Backups",
            "fail",
            redact_secret_like_text(&error),
            Some("Inspect .builder/backups for unsupported or symlinked backup entries before pruning."),
        ),
    }
}

fn health_status(checks: &[HealthCheck]) -> String {
    if checks.iter().any(|check| check.status == "fail") {
        "fail".to_string()
    } else if checks.iter().any(|check| check.status == "warn") {
        "warn".to_string()
    } else {
        "pass".to_string()
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }

    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit_index = 0;

    while value >= 1024.0 && unit_index < units.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if value >= 10.0 {
        format!("{value:.0} {}", units[unit_index])
    } else {
        format!("{value:.1} {}", units[unit_index])
    }
}

fn user_visible_path(path: &Path) -> String {
    let home = home_dir();

    if let Ok(stripped) = path.strip_prefix(&home) {
        if stripped.as_os_str().is_empty() {
            return "~".to_string();
        }

        return format!("~/{}", stripped.to_string_lossy());
    }

    path.to_string_lossy().to_string()
}

fn diagnostics_path_label(path: &Path, kind: &str) -> String {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("selected");

    format!("{kind} ({})", redact_secret_like_text(name))
}

fn diagnostics_workspace_label() -> String {
    "workspace ([WORKSPACE_NAME])".to_string()
}

fn corrupt_backup_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("state.json");
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    parent.join(format!("{file_name}.corrupt-{timestamp}-{nonce}"))
}

fn quarantine_corrupt_file(path: &Path, kind: &str) -> Result<PathBuf, String> {
    let backup_path = corrupt_backup_path(path);
    fs::rename(path, &backup_path)
        .map_err(|error| format!("failed to quarantine corrupt {kind}: {error}"))?;
    Ok(backup_path)
}

fn schedule_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let dir = prepare_app_data_dir(&dir)?;
    Ok(dir.join(SCHEDULE_STATE_FILE))
}

fn schedule_state_temp_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{SCHEDULE_STATE_FILE}.tmp"))
}

fn read_schedule_state(app: &AppHandle) -> Result<ScheduleRuntimeState, String> {
    let path = schedule_state_path(app)?;
    read_schedule_state_from_path(&path)
}

fn read_schedule_state_from_path(path: &Path) -> Result<ScheduleRuntimeState, String> {
    if !path.exists() {
        return Ok(ScheduleRuntimeState::default());
    }

    let source = match read_bounded_text_file(path, "schedule state", MAX_APP_STATE_TEXT_FILE_BYTES)
    {
        Ok(source) => source,
        Err(error) if is_oversized_text_file_error(&error) => {
            let _quarantined_path =
                quarantine_corrupt_file(path, "schedule state").map_err(|quarantine_error| {
                    format!("failed to read schedule state: {error}; {quarantine_error}")
                })?;
            return Ok(ScheduleRuntimeState::default());
        }
        Err(error) => return Err(error),
    };

    if source.trim().is_empty() {
        return Ok(ScheduleRuntimeState::default());
    }

    match serde_json::from_str::<ScheduleRuntimeState>(&source) {
        Ok(state) => Ok(state),
        Err(error) => {
            let _quarantined_path =
                quarantine_corrupt_file(path, "schedule state").map_err(|quarantine_error| {
                    format!("failed to parse schedule state: {error}; {quarantine_error}")
                })?;
            Ok(ScheduleRuntimeState::default())
        }
    }
}

fn write_schedule_state(app: &AppHandle, state: &ScheduleRuntimeState) -> Result<(), String> {
    let path = schedule_state_path(app)?;
    let body = serde_json::to_string_pretty(state)
        .map_err(|error| format!("failed to serialize schedule state: {error}"))?;

    write_text_atomic_with_temp(&path, &schedule_state_temp_path(&path), &body)
        .map_err(|error| format!("failed to persist schedule state: {error}"))
}

fn resolve_workspace_path(workspace_path: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|current_dir| current_dir.join(path))
            .map_err(|error| format!("failed to resolve current directory: {error}"))
    }
}

fn resolve_catalog_workspace_path(workspace_path: &str) -> Result<Option<PathBuf>, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    existing_workspace_root_path(&workspace)
}

fn resolve_existing_workspace_path(workspace_path: &str) -> Result<PathBuf, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let metadata = workspace_root_metadata(&workspace)?
        .ok_or_else(|| format!("workspace does not exist: {}", workspace.display()))?;

    validate_existing_workspace_root(&workspace, &metadata)
}

fn normalize_runnable_request(request: AgentRunRequest) -> Result<AgentRunRequest, String> {
    validate_request(&request)?;
    let workspace = resolve_existing_workspace_path(&request.workspace_path)?;

    Ok(AgentRunRequest {
        workspace_path: workspace.to_string_lossy().to_string(),
        ..request
    })
}

fn workspace_root_metadata(workspace: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(workspace) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "failed to inspect workspace {}: {error}",
            workspace.display()
        )),
    }
}

fn existing_workspace_root_path(workspace: &Path) -> Result<Option<PathBuf>, String> {
    match workspace_root_metadata(workspace)? {
        Some(metadata) => validate_existing_workspace_root(workspace, &metadata).map(Some),
        None => Ok(None),
    }
}

fn validate_existing_workspace_root(
    workspace: &Path,
    metadata: &fs::Metadata,
) -> Result<PathBuf, String> {
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "workspace path must not be a symlink: {}",
            workspace.display()
        ));
    }

    if !metadata.is_dir() {
        return Err(format!(
            "workspace path exists but is not a directory: {}",
            workspace.display()
        ));
    }

    fs::canonicalize(workspace)
        .map_err(|error| format!("failed to resolve workspace path: {error}"))
}

fn prepare_workspace(workspace: &Path) -> Result<(), String> {
    if let Some(metadata) = workspace_root_metadata(workspace)? {
        validate_existing_workspace_root(workspace, &metadata)?;
    }

    fs::create_dir_all(workspace)
        .map_err(|error| format!("failed to create workspace directory: {error}"))?;
    ensure_workspace_child_dir_for_write(workspace, "skills", "skills")?;
    ensure_workspace_child_dir_for_write(workspace, "skills/build-plan", "build-plan skill")?;
    ensure_workspace_child_dir_for_write(workspace, "ontology", "ontology")?;
    ensure_workspace_child_dir_for_write(workspace, ".builder", "builder")?;

    write_text_if_missing(
        &workspace
            .join("skills")
            .join("build-plan")
            .join("skill.yaml"),
        STARTER_BUILD_PLAN_SKILL,
    )?;
    write_text_if_missing(
        &workspace
            .join("skills")
            .join("build-plan")
            .join("instructions.md"),
        STARTER_BUILD_PLAN_INSTRUCTIONS,
    )?;
    write_text_if_missing(
        &workspace.join("ontology").join("builder-gear.json"),
        STARTER_ONTOLOGY,
    )?;
    write_text_if_missing(&workspace.join(".builder").join("schedules.json"), "[]\n")?;

    Ok(())
}

fn workspace_schedules_path(workspace: &Path) -> PathBuf {
    workspace.join(".builder").join("schedules.json")
}

fn workspace_schedules_temp_path(path: &Path) -> PathBuf {
    path.with_file_name("schedules.json.tmp")
}

fn workspace_ontology_path(workspace: &Path) -> PathBuf {
    workspace.join("ontology").join("builder-gear.json")
}

fn workspace_ontology_temp_path(path: &Path) -> PathBuf {
    path.with_file_name("builder-gear.json.tmp")
}

fn skill_dir(workspace: &Path, skill_id: &str) -> PathBuf {
    workspace.join("skills").join(skill_id)
}

fn ensure_workspace_child_dir_for_write(
    workspace: &Path,
    relative_path: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let path = workspace.join(relative_path);

    match fs::symlink_metadata(&path) {
        Ok(metadata) => validate_workspace_child_dir_metadata(workspace, &path, &metadata, label)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&path)
                .map_err(|error| format!("failed to create {label} directory: {error}"))?;
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("failed to inspect {label} directory: {error}"))?;
            validate_workspace_child_dir_metadata(workspace, &path, &metadata, label)?;
        }
        Err(error) => return Err(format!("failed to inspect {label} directory: {error}")),
    }

    Ok(path)
}

fn workspace_child_dir_for_read(
    workspace: &Path,
    relative_path: &str,
    label: &str,
) -> Result<Option<PathBuf>, String> {
    let path = workspace.join(relative_path);

    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            validate_workspace_child_dir_metadata(workspace, &path, &metadata, label)?;
            Ok(Some(path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect {label} directory: {error}")),
    }
}

fn validate_workspace_child_dir_metadata(
    workspace: &Path,
    path: &Path,
    metadata: &fs::Metadata,
    label: &str,
) -> Result<(), String> {
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} directory must not be a symlink"));
    }

    if !metadata.is_dir() {
        return Err(format!("{label} path exists but is not a directory"));
    }

    ensure_canonical_path_stays_in_workspace(workspace, path, label)
}

fn ensure_canonical_path_stays_in_workspace(
    workspace: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    let workspace_root = fs::canonicalize(workspace)
        .map_err(|error| format!("failed to resolve workspace path: {error}"))?;
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| format!("failed to resolve {label} path: {error}"))?;

    if canonical_path.starts_with(&workspace_root) {
        Ok(())
    } else {
        Err(format!("{label} path must stay inside the workspace"))
    }
}

fn read_regular_text_file(path: &Path, label: &str) -> Result<String, String> {
    read_bounded_text_file(path, label, MAX_REGULAR_TEXT_FILE_BYTES)
}

fn read_bounded_text_file(path: &Path, label: &str, max_bytes: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {label} {}: {error}", path.display()))?;

    if metadata.file_type().is_symlink() {
        return Err(format!("{label} must not be a symlink: {}", path.display()));
    }

    if !metadata.is_file() {
        return Err(format!("{label} is not a file: {}", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{label} exceeds maximum size of {max_bytes} bytes: {}",
            path.display()
        ));
    }

    fs::read_to_string(path)
        .map_err(|error| format!("failed to read {label} {}: {error}", path.display()))
}

fn is_oversized_text_file_error(error: &str) -> bool {
    error.contains("exceeds maximum size of")
}

fn ensure_text_body_within_limit(label: &str, body: &str, max_bytes: u64) -> Result<(), String> {
    let byte_len = body.len() as u64;
    if byte_len > max_bytes {
        return Err(format!("{label} exceeds maximum size of {max_bytes} bytes"));
    }

    Ok(())
}

fn validate_skill_id_for_path(skill_id: &str) -> Result<(), String> {
    if skill_id.trim().is_empty() {
        return Err("skill id is required".to_string());
    }

    if !skill_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!(
            "skill id contains unsupported path characters: {skill_id}"
        ));
    }

    Ok(())
}

fn write_workspace_skill(
    workspace: &Path,
    original_id: Option<&str>,
    manifest: &SkillManifest,
    instructions: &str,
) -> Result<(), String> {
    validate_skill_id_for_path(&manifest.id)?;
    if let Some(original_id) = original_id {
        validate_skill_id_for_path(original_id)?;
    }

    let target_dir = skill_dir(workspace, &manifest.id);
    let manifest_path = target_dir.join("skill.yaml");
    validate_skill_manifest(manifest, &manifest_path)?;

    if instructions.trim().is_empty() {
        return Err("skill instructions are required".to_string());
    }
    ensure_text_body_within_limit(
        "skill instructions",
        instructions,
        MAX_REGULAR_TEXT_FILE_BYTES,
    )?;
    if let Some(original_id) = original_id {
        snapshot_existing_skill_for_backup(workspace, original_id, "skill-save")?;
    }

    prepare_skill_target_dir(workspace, original_id, &manifest.id)?;

    let instructions_path = target_dir.join(&manifest.instructions_path);
    prepare_skill_instruction_parent(&target_dir, &instructions_path)?;
    write_text_atomic_existing_parent(&instructions_path, instructions)?;
    write_text_atomic(&manifest_path, &skill_manifest_yaml(manifest)?)?;

    Ok(())
}

fn prepare_skill_target_dir(
    workspace: &Path,
    original_id: Option<&str>,
    next_id: &str,
) -> Result<(), String> {
    ensure_workspace_child_dir_for_write(workspace, "skills", "skills")?;
    let target_dir = skill_dir(workspace, next_id);

    match original_id {
        Some(original_id) if original_id == next_id => {
            ensure_workspace_child_dir_for_write(workspace, &format!("skills/{next_id}"), "skill")?;
        }
        Some(original_id) => {
            if let Some(metadata) = path_metadata_if_present(&target_dir, "target skill")? {
                if metadata.file_type().is_symlink() {
                    return Err("target skill directory must not be a symlink".to_string());
                }
                return Err(format!("skill id already exists: {next_id}"));
            }

            let old_dir = skill_dir(workspace, original_id);
            if let Some(metadata) = path_metadata_if_present(&old_dir, "source skill")? {
                validate_workspace_child_dir_metadata(
                    workspace,
                    &old_dir,
                    &metadata,
                    "source skill",
                )?;
                fs::rename(&old_dir, &target_dir)
                    .map_err(|error| format!("failed to rename skill directory: {error}"))?;
            } else {
                ensure_workspace_child_dir_for_write(
                    workspace,
                    &format!("skills/{next_id}"),
                    "skill",
                )?;
            }
        }
        None => {
            if let Some(metadata) = path_metadata_if_present(&target_dir, "skill")? {
                if metadata.file_type().is_symlink() {
                    return Err("skill directory must not be a symlink".to_string());
                }
                return Err(format!("skill id already exists: {next_id}"));
            }

            ensure_workspace_child_dir_for_write(workspace, &format!("skills/{next_id}"), "skill")?;
        }
    }

    Ok(())
}

fn prepare_skill_instruction_parent(
    skill_dir: &Path,
    instructions_path: &Path,
) -> Result<(), String> {
    let parent = instructions_path
        .parent()
        .ok_or_else(|| "skill instructions path must have a parent directory".to_string())?;
    let relative_parent = parent
        .strip_prefix(skill_dir)
        .map_err(|_| "skill instructions path must stay inside the skill directory".to_string())?;
    let mut current = skill_dir.to_path_buf();

    for component in relative_parent.components() {
        let Component::Normal(segment) = component else {
            return Err("skill instructions path must stay inside the skill directory".to_string());
        };

        current.push(segment);

        match fs::symlink_metadata(&current) {
            Ok(metadata) => validate_workspace_child_dir_metadata(
                skill_dir,
                &current,
                &metadata,
                "skill instructions",
            )?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    format!("failed to create skill instructions directory: {error}")
                })?;
                let metadata = fs::symlink_metadata(&current).map_err(|error| {
                    format!("failed to inspect skill instructions directory: {error}")
                })?;
                validate_workspace_child_dir_metadata(
                    skill_dir,
                    &current,
                    &metadata,
                    "skill instructions",
                )?;
            }
            Err(error) => {
                return Err(format!(
                    "failed to inspect skill instructions directory: {error}"
                ))
            }
        }
    }

    Ok(())
}

fn read_workspace_skill_source(workspace: &Path, skill_id: &str) -> Result<SkillSource, String> {
    validate_skill_id_for_path(skill_id)?;
    let target_dir = existing_skill_dir_for_read(workspace, skill_id)?
        .ok_or_else(|| format!("skill not found: {skill_id}"))?;
    let manifest_path = target_dir.join("skill.yaml");
    let source = read_regular_text_file(&manifest_path, "skill manifest")?;
    let manifest = parse_skill_manifest(&source, &manifest_path)?;
    let instructions_path = target_dir.join(&manifest.instructions_path);
    ensure_canonical_path_stays_in_workspace(
        &target_dir,
        &instructions_path,
        "skill instructions",
    )?;
    let instructions = read_regular_text_file(&instructions_path, "skill instructions")?;

    Ok(SkillSource {
        manifest,
        instructions,
    })
}

fn delete_workspace_skill(workspace: &Path, skill_id: &str) -> Result<(), String> {
    validate_skill_id_for_path(skill_id)?;

    if let Some(target_dir) = existing_skill_dir_for_read(workspace, skill_id)? {
        snapshot_existing_skill_dir_for_backup(workspace, &target_dir, "skill-delete")?;
        fs::remove_dir_all(&target_dir)
            .map_err(|error| format!("failed to delete skill directory: {error}"))?;
    }

    Ok(())
}

fn existing_skill_dir_for_read(
    workspace: &Path,
    skill_id: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(_skills_dir) = workspace_child_dir_for_read(workspace, "skills", "skills")? else {
        return Ok(None);
    };
    let target_dir = skill_dir(workspace, skill_id);

    match path_metadata_if_present(&target_dir, "skill")? {
        Some(metadata) => {
            validate_workspace_child_dir_metadata(workspace, &target_dir, &metadata, "skill")?;
            Ok(Some(target_dir))
        }
        None => Ok(None),
    }
}

fn path_metadata_if_present(path: &Path, label: &str) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect {label}: {error}")),
    }
}

fn skill_manifest_yaml(manifest: &SkillManifest) -> Result<String, String> {
    let value = serde_yaml::to_string(manifest)
        .map_err(|error| format!("failed to serialize skill manifest: {error}"))?;
    Ok(value)
}

fn write_text_atomic(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create directory: {error}"))?;
    }

    write_text_atomic_existing_parent(path, body)
}

fn write_text_atomic_existing_parent(path: &Path, body: &str) -> Result<(), String> {
    let temp_path = path.with_extension("tmp");
    write_text_atomic_with_temp(path, &temp_path, body)
}

fn write_text_atomic_with_temp(path: &Path, temp_path: &Path, body: &str) -> Result<(), String> {
    if path == temp_path {
        return Err("temporary file path must differ from target path".to_string());
    }

    reject_symlinked_existing_path(path, "target file")?;
    prepare_atomic_temp_path(temp_path)?;

    let mut temp_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .map_err(|error| format!("failed to create temporary file: {error}"))?;
    temp_file
        .write_all(body.as_bytes())
        .map_err(|error| format!("failed to write file: {error}"))?;
    temp_file
        .sync_all()
        .map_err(|error| format!("failed to flush file: {error}"))?;
    drop(temp_file);

    match fs::rename(temp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_error) if path.exists() => {
            replace_existing_file_with_backup(path, temp_path, "file", rename_error)
        }
        Err(error) => Err(format!("failed to persist file: {error}")),
    }
}

fn reject_symlinked_existing_path(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{label} must not be a symlink: {}", path.display()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to inspect {label} {}: {error}",
            path.display()
        )),
    }
}

fn prepare_atomic_temp_path(temp_path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(temp_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "temporary file must not be a symlink: {}",
            temp_path.display()
        )),
        Ok(metadata) if metadata.is_file() => fs::remove_file(temp_path).map_err(|error| {
            format!(
                "failed to remove stale temporary file {}: {error}",
                temp_path.display()
            )
        }),
        Ok(_) => Err(format!(
            "temporary path is not a file: {}",
            temp_path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to inspect temporary file {}: {error}",
            temp_path.display()
        )),
    }
}

fn replace_existing_file_with_backup(
    path: &Path,
    temp_path: &Path,
    kind: &str,
    first_error: std::io::Error,
) -> Result<(), String> {
    let backup_path = replacement_backup_path(path);
    fs::rename(path, &backup_path).map_err(|error| {
        format!(
            "failed to stage existing {kind} for replacement: {error}; first error: {first_error}"
        )
    })?;

    match fs::rename(temp_path, path) {
        Ok(()) => {
            let _ = fs::remove_file(&backup_path);
            Ok(())
        }
        Err(replace_error) => {
            let restore_result = fs::rename(&backup_path, path);
            match restore_result {
                Ok(()) => Err(format!(
                    "failed to replace {kind}: {replace_error}; original file was restored; first error: {first_error}"
                )),
                Err(restore_error) => Err(format!(
                    "failed to replace {kind}: {replace_error}; failed to restore original file: {restore_error}; staged backup: {}; first error: {first_error}",
                    backup_path.display()
                )),
            }
        }
    }
}

fn replacement_backup_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("builder-gear-file");
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    parent.join(format!("{file_name}.replace-{timestamp}-{nonce}"))
}

fn write_text_if_missing(path: &Path, body: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "starter file must not be a symlink: {}",
                    path.display()
                ));
            }
            if !metadata.is_file() {
                return Err(format!(
                    "starter path exists but is not a file: {}",
                    path.display()
                ));
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect starter file {}: {error}",
                path.display()
            ));
        }
    }

    write_text_atomic(path, body)
}

fn workspace_backup_dir(workspace: &Path) -> Result<PathBuf, String> {
    ensure_workspace_child_dir_for_write(workspace, ".builder", "builder")?;
    ensure_workspace_child_dir_for_write(workspace, WORKSPACE_BACKUPS_DIR, "workspace backups")
}

fn list_workspace_backups(workspace: &Path) -> Result<Vec<WorkspaceBackupSummary>, String> {
    let Some(backups_dir) =
        workspace_child_dir_for_read(workspace, WORKSPACE_BACKUPS_DIR, "workspace backups")?
    else {
        return Ok(Vec::new());
    };
    let mut summaries = Vec::new();

    for entry in fs::read_dir(&backups_dir)
        .map_err(|error| format!("failed to read workspace backups: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read workspace backup: {error}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect workspace backup {name}: {error}"))?;

        if metadata.file_type().is_symlink() {
            return Err(format!("workspace backup must not be a symlink: {name}"));
        }

        let (size_bytes, entry_count) = if metadata.is_dir() {
            summarize_backup_directory(&path)?
        } else if metadata.is_file() {
            (metadata.len(), 1)
        } else {
            return Err(format!(
                "workspace backup is not a regular file or directory: {name}"
            ));
        };

        summaries.push(WorkspaceBackupSummary {
            relative_path: workspace_relative_slash_path(workspace, &path),
            kind: workspace_backup_kind(&name),
            created_at: workspace_backup_created_at(&name),
            target_relative_path: workspace_backup_target_relative_path(
                &name,
                Some(metadata.is_dir()),
            )
            .ok(),
            name,
            size_bytes,
            entry_count,
            directory: metadata.is_dir(),
        });
    }

    summaries.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.name.cmp(&left.name))
    });
    Ok(summaries)
}

fn summarize_backup_directory(path: &Path) -> Result<(u64, usize), String> {
    let mut size_bytes = 0;
    let mut entry_count = 0;

    for entry in
        fs::read_dir(path).map_err(|error| format!("failed to read backup directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read backup entry: {error}"))?;
        let child_path = entry.path();
        let metadata = fs::symlink_metadata(&child_path).map_err(|error| {
            format!(
                "failed to inspect backup entry {}: {error}",
                child_path.display()
            )
        })?;

        if metadata.file_type().is_symlink() {
            return Err(format!(
                "workspace backup entry must not be a symlink: {}",
                child_path.display()
            ));
        }

        if metadata.is_dir() {
            let (child_size, child_count) = summarize_backup_directory(&child_path)?;
            size_bytes += child_size;
            entry_count += child_count;
        } else if metadata.is_file() {
            size_bytes += metadata.len();
            entry_count += 1;
        } else {
            return Err(format!(
                "workspace backup entry is not a regular file or directory: {}",
                child_path.display()
            ));
        }
    }

    Ok((size_bytes, entry_count))
}

fn restore_workspace_backup(
    workspace: &Path,
    backup_name: &str,
) -> Result<RestoreWorkspaceBackupResult, String> {
    validate_workspace_backup_name(backup_name)?;
    let backups = list_workspace_backups(workspace)?;
    let restored = backups
        .iter()
        .find(|backup| backup.name == backup_name)
        .cloned()
        .ok_or_else(|| format!("workspace backup not found: {backup_name}"))?;
    let target_relative_path =
        workspace_backup_target_relative_path(backup_name, Some(restored.directory))?;
    let backups_root = workspace.join(WORKSPACE_BACKUPS_DIR);
    let backup_path = backups_root.join(&restored.name);
    let target_path = workspace.join(&target_relative_path);
    let pre_restore_backup = snapshot_current_target_for_restore(workspace, &target_path)?;

    if restored.directory {
        restore_directory_backup(workspace, &backup_path, &target_path)?;
    } else {
        restore_file_backup(workspace, &backup_path, &target_path)?;
    }

    Ok(RestoreWorkspaceBackupResult {
        restored,
        target_relative_path,
        pre_restore_backup,
    })
}

fn prune_workspace_backups(
    workspace: &Path,
    keep: usize,
    dry_run: bool,
) -> Result<PruneWorkspaceBackupsResult, String> {
    let backups = list_workspace_backups(workspace)?;
    let retained = backups.iter().take(keep).cloned().collect::<Vec<_>>();
    let candidates = backups.iter().skip(keep).cloned().collect::<Vec<_>>();
    let mut pruned = Vec::new();

    if !dry_run {
        for candidate in &candidates {
            remove_workspace_backup_entry(workspace, candidate)?;
            pruned.push(candidate.clone());
        }
    }

    Ok(PruneWorkspaceBackupsResult {
        keep,
        dry_run,
        retained,
        candidates,
        pruned,
    })
}

fn snapshot_current_target_for_restore(
    workspace: &Path,
    target_path: &Path,
) -> Result<Option<WorkspaceBackupSummary>, String> {
    let metadata = match fs::symlink_metadata(target_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to inspect restore target {}: {error}",
                target_path.display()
            ))
        }
    };

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "restore target must not be a symlink: {}",
            target_path.display()
        ));
    }

    let backup_dir = workspace_backup_dir(workspace)?;
    let backup_name = workspace_backup_name(workspace, target_path, "restore-preimage");
    let backup_path = backup_dir.join(&backup_name);

    if metadata.is_dir() {
        copy_directory_for_backup(target_path, &backup_path)?;
    } else if metadata.is_file() {
        copy_file_rejecting_symlinks(target_path, &backup_path, "pre-restore backup")?;
    } else {
        return Err(format!(
            "restore target is not a regular file or directory: {}",
            target_path.display()
        ));
    }

    Ok(list_workspace_backups(workspace)?
        .into_iter()
        .find(|backup| backup.name == backup_name))
}

fn restore_file_backup(
    workspace: &Path,
    backup_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
    prepare_restore_parent(workspace, target_path)?;
    reject_symlinked_existing_path(target_path, "restore target")?;

    let temp_path = restore_temp_path(target_path, "tmp");
    let staged_path = restore_temp_path(target_path, "staged");
    let mut staged = false;

    stage_backup_file_for_restore(backup_path, &temp_path)?;

    let result = (|| -> Result<(), String> {
        if let Some(metadata) = path_metadata_if_present(target_path, "restore target")? {
            if !metadata.is_file() {
                return Err(format!(
                    "restore target is not a file: {}",
                    target_path.display()
                ));
            }
            fs::rename(target_path, &staged_path).map_err(|error| {
                format!(
                    "failed to stage restore target {}: {error}",
                    target_path.display()
                )
            })?;
            staged = true;
        }

        fs::rename(&temp_path, target_path).map_err(|error| {
            format!(
                "failed to restore backup to {}: {error}",
                target_path.display()
            )
        })?;
        if staged {
            fs::remove_file(&staged_path).map_err(|error| {
                format!(
                    "failed to remove staged restore target {}: {error}",
                    staged_path.display()
                )
            })?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&temp_path);
        if staged {
            let _ = fs::rename(&staged_path, target_path);
        }
        return Err(error);
    }

    Ok(())
}

fn stage_backup_file_for_restore(backup_path: &Path, temp_path: &Path) -> Result<(), String> {
    prepare_atomic_temp_path(temp_path)?;

    let result = copy_file_rejecting_symlinks(backup_path, temp_path, "restore temporary file")
        .map_err(|error| format!("failed to stage backup restore: {error}"));
    if let Err(error) = result {
        let _ = fs::remove_file(temp_path);
        return Err(error);
    }

    Ok(())
}

fn restore_directory_backup(
    workspace: &Path,
    backup_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
    prepare_restore_parent(workspace, target_path)?;
    ensure_backup_directory(backup_path)?;
    reject_symlinked_existing_path(target_path, "restore target")?;

    let temp_path = restore_temp_path(target_path, "tmp");
    let staged_path = restore_temp_path(target_path, "staged");
    let mut staged = false;

    copy_directory_for_backup(backup_path, &temp_path)?;

    let result = (|| -> Result<(), String> {
        if let Some(metadata) = path_metadata_if_present(target_path, "restore target")? {
            if !metadata.is_dir() {
                return Err(format!(
                    "restore target is not a directory: {}",
                    target_path.display()
                ));
            }
            fs::rename(target_path, &staged_path).map_err(|error| {
                format!(
                    "failed to stage restore target {}: {error}",
                    target_path.display()
                )
            })?;
            staged = true;
        }

        fs::rename(&temp_path, target_path).map_err(|error| {
            format!(
                "failed to restore backup to {}: {error}",
                target_path.display()
            )
        })?;
        if staged {
            fs::remove_dir_all(&staged_path).map_err(|error| {
                format!(
                    "failed to remove staged restore target {}: {error}",
                    staged_path.display()
                )
            })?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temp_path);
        if staged {
            let _ = fs::rename(&staged_path, target_path);
        }
        return Err(error);
    }

    Ok(())
}

fn prepare_restore_parent(workspace: &Path, target_path: &Path) -> Result<(), String> {
    let parent = target_path
        .parent()
        .ok_or_else(|| "restore target must have a parent directory".to_string())?;
    let relative_parent = parent
        .strip_prefix(workspace)
        .map_err(|_| "restore target must stay inside the workspace".to_string())?;

    if relative_parent.as_os_str().is_empty() {
        return Ok(());
    }

    ensure_workspace_child_dir_for_write(
        workspace,
        &relative_parent
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        "restore target parent",
    )?;
    Ok(())
}

fn open_backup_source_file(path: &Path) -> Result<fs::File, String> {
    #[cfg(unix)]
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            format!(
                "failed to open workspace backup source without following symlinks {}: {error}",
                path.display()
            )
        })?;

    #[cfg(not(unix))]
    let file = {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            format!(
                "failed to inspect workspace backup {}: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "workspace backup must not be a symlink: {}",
                path.display()
            ));
        }
        fs::File::open(path).map_err(|error| {
            format!(
                "failed to open workspace backup source {}: {error}",
                path.display()
            )
        })?
    };

    let metadata = file.metadata().map_err(|error| {
        format!(
            "failed to inspect workspace backup {}: {error}",
            path.display()
        )
    })?;

    if !metadata.is_file() {
        return Err(format!(
            "workspace backup is not a file: {}",
            path.display()
        ));
    }
    Ok(file)
}

fn copy_file_rejecting_symlinks(
    source: &Path,
    destination: &Path,
    destination_label: &str,
) -> Result<(), String> {
    let mut source_file = open_backup_source_file(source)?;
    let mut destination_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("failed to create {destination_label}: {error}"))?;

    let result = std::io::copy(&mut source_file, &mut destination_file)
        .map_err(|error| format!("failed to copy workspace backup source: {error}"))
        .and_then(|_| {
            destination_file
                .sync_all()
                .map_err(|error| format!("failed to flush {destination_label}: {error}"))
        });

    if let Err(error) = result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }

    Ok(())
}

fn ensure_backup_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "failed to inspect workspace backup {}: {error}",
            path.display()
        )
    })?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "workspace backup must not be a symlink: {}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "workspace backup is not a directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn remove_workspace_backup_entry(
    workspace: &Path,
    backup: &WorkspaceBackupSummary,
) -> Result<(), String> {
    validate_workspace_backup_name(&backup.name)?;
    let backups_root = workspace.join(WORKSPACE_BACKUPS_DIR);
    let backup_path = backups_root.join(&backup.name);

    backup_path
        .strip_prefix(&backups_root)
        .map_err(|_| format!("backup entry must stay inside {WORKSPACE_BACKUPS_DIR}"))?;
    let metadata = fs::symlink_metadata(&backup_path).map_err(|error| {
        format!(
            "failed to inspect workspace backup {}: {error}",
            backup.name
        )
    })?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "workspace backup must not be a symlink: {}",
            backup.name
        ));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(&backup_path).map_err(|error| {
            format!("failed to remove workspace backup {}: {error}", backup.name)
        })?;
    } else if metadata.is_file() {
        fs::remove_file(&backup_path).map_err(|error| {
            format!("failed to remove workspace backup {}: {error}", backup.name)
        })?;
    } else {
        return Err(format!(
            "workspace backup is not a regular file or directory: {}",
            backup.name
        ));
    }

    Ok(())
}

fn restore_temp_path(target_path: &Path, phase: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_name = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("builder-gear-restore");

    target_path.with_file_name(format!("{file_name}.restore-{phase}-{nonce}"))
}

fn snapshot_existing_file_for_backup(
    workspace: &Path,
    source: &Path,
    operation: &str,
) -> Result<Option<PathBuf>, String> {
    let metadata = match path_metadata_if_present(source, "workspace file")? {
        Some(metadata) => metadata,
        None => return Ok(None),
    };

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "workspace file must not be a symlink before backup: {}",
            source.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "workspace backup source is not a file: {}",
            source.display()
        ));
    }

    let backup_dir = workspace_backup_dir(workspace)?;
    let backup_path = backup_dir.join(workspace_backup_name(workspace, source, operation));
    copy_file_rejecting_symlinks(source, &backup_path, "workspace backup")?;

    Ok(Some(backup_path))
}

fn snapshot_existing_skill_for_backup(
    workspace: &Path,
    skill_id: &str,
    operation: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(source_dir) = existing_skill_dir_for_read(workspace, skill_id)? else {
        return Ok(None);
    };

    snapshot_existing_skill_dir_for_backup(workspace, &source_dir, operation)
}

fn snapshot_existing_skill_dir_for_backup(
    workspace: &Path,
    source_dir: &Path,
    operation: &str,
) -> Result<Option<PathBuf>, String> {
    let backup_dir = workspace_backup_dir(workspace)?;
    let backup_path = backup_dir.join(workspace_backup_name(workspace, source_dir, operation));
    copy_directory_for_backup(source_dir, &backup_path)?;

    Ok(Some(backup_path))
}

fn copy_directory_for_backup(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        format!(
            "failed to inspect backup source {}: {error}",
            source.display()
        )
    })?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "workspace backup source must not be a symlink: {}",
            source.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "workspace backup source is not a directory: {}",
            source.display()
        ));
    }

    fs::create_dir(destination)
        .map_err(|error| format!("failed to create backup directory: {error}"))?;

    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read backup source directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read backup entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            format!(
                "failed to inspect backup entry {}: {error}",
                source_path.display()
            )
        })?;

        if metadata.file_type().is_symlink() {
            return Err(format!(
                "workspace backup entry must not be a symlink: {}",
                source_path.display()
            ));
        }

        if metadata.is_dir() {
            copy_directory_for_backup(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            copy_file_rejecting_symlinks(
                &source_path,
                &destination_path,
                "workspace backup entry",
            )?;
        } else {
            return Err(format!(
                "workspace backup entry is not a regular file or directory: {}",
                source_path.display()
            ));
        }
    }

    Ok(())
}

fn workspace_backup_name(workspace: &Path, source: &Path, operation: &str) -> String {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let relative = source
        .strip_prefix(workspace)
        .unwrap_or(source)
        .to_string_lossy()
        .replace(['/', '\\'], "-");
    let safe_relative = relative
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let safe_operation = operation
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    format!(
        "{timestamp}-{nonce}-{safe_operation}-{}",
        if safe_relative.is_empty() {
            "workspace".to_string()
        } else {
            safe_relative
        }
    )
}

fn workspace_relative_slash_path(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn workspace_backup_kind(name: &str) -> String {
    parse_workspace_backup_name(name)
        .map(|parsed| parsed.kind)
        .unwrap_or_else(|_| "unknown".to_string())
}

fn workspace_backup_created_at(name: &str) -> Option<String> {
    let timestamp = name.get(..16)?;
    let parsed = chrono::NaiveDateTime::parse_from_str(timestamp, "%Y%m%dT%H%M%SZ").ok()?;
    Some(
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(parsed, chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

struct ParsedWorkspaceBackupName {
    kind: String,
    target_slug: String,
}

fn parse_workspace_backup_name(name: &str) -> Result<ParsedWorkspaceBackupName, String> {
    validate_workspace_backup_name(name)?;
    let timestamp = name
        .get(..16)
        .ok_or_else(|| format!("unsupported workspace backup name: {name}"))?;
    let separator = name
        .get(16..17)
        .ok_or_else(|| format!("unsupported workspace backup name: {name}"))?;

    if separator != "-" {
        return Err(format!("unsupported workspace backup name: {name}"));
    }
    chrono::NaiveDateTime::parse_from_str(timestamp, "%Y%m%dT%H%M%SZ")
        .map_err(|_| format!("unsupported workspace backup name: {name}"))?;

    let tail = name
        .get(17..)
        .ok_or_else(|| format!("unsupported workspace backup name: {name}"))?;
    for kind in WORKSPACE_BACKUP_KINDS {
        let marker = format!("-{kind}-");
        if let Some(marker_index) = tail.find(&marker) {
            let nonce = &tail[..marker_index];
            let target_slug = &tail[(marker_index + marker.len())..];

            if !nonce.is_empty() && !target_slug.is_empty() {
                return Ok(ParsedWorkspaceBackupName {
                    kind: (*kind).to_string(),
                    target_slug: target_slug.to_string(),
                });
            }
        }
    }

    Err(format!("unsupported workspace backup name: {name}"))
}

fn workspace_backup_target_relative_path(
    name: &str,
    directory: Option<bool>,
) -> Result<String, String> {
    let parsed = parse_workspace_backup_name(name)?;

    if parsed.target_slug == ".builder-schedules.json" && directory != Some(true) {
        return Ok(".builder/schedules.json".to_string());
    }

    if parsed.target_slug == "ontology-builder-gear.json" && directory != Some(true) {
        return Ok("ontology/builder-gear.json".to_string());
    }

    if let Some(skill_id) = parsed.target_slug.strip_prefix("skills-") {
        if !skill_id.is_empty()
            && skill_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
            && directory != Some(false)
        {
            return Ok(format!("skills/{skill_id}"));
        }
    }

    Err(format!(
        "unsupported workspace backup target: {}",
        parsed.target_slug
    ))
}

fn validate_workspace_backup_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("backup name is required".to_string());
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("backup name must not contain path separators".to_string());
    }

    Ok(())
}

fn write_workspace_ontology(workspace: &Path, ontology: &[OntologyEntity]) -> Result<(), String> {
    let mut sorted_entities = ontology.to_vec();
    sorted_entities.sort_by(|left, right| left.id.cmp(&right.id));
    let path = workspace_ontology_path(workspace);
    let mut seen_ids = std::collections::HashSet::new();

    for entity in &sorted_entities {
        validate_ontology_entity(entity, &path)?;
        if !seen_ids.insert(entity.id.clone()) {
            return Err(format!("duplicate ontology id: {}", entity.id));
        }
    }

    ensure_workspace_child_dir_for_write(workspace, "ontology", "ontology")?;
    snapshot_existing_file_for_backup(workspace, &path, "ontology-save")?;

    let temp_path = workspace_ontology_temp_path(&path);
    let body = serde_json::to_string_pretty(&sorted_entities)
        .map_err(|error| format!("failed to serialize ontology: {error}"))?;
    ensure_text_body_within_limit("ontology file", &body, MAX_REGULAR_TEXT_FILE_BYTES)?;
    write_text_atomic_with_temp(&path, &temp_path, &format!("{body}\n"))
        .map_err(|error| format!("failed to persist ontology: {error}"))
}

fn write_workspace_schedules(workspace: &Path, schedules: &[ScheduleSpec]) -> Result<(), String> {
    let mut sorted_schedules = schedules.to_vec();
    sorted_schedules.sort_by(|left, right| left.id.cmp(&right.id));
    let path = workspace_schedules_path(workspace);
    let mut seen_ids = std::collections::HashSet::new();

    for schedule in &sorted_schedules {
        validate_schedule_spec(schedule, &path)?;
        if !seen_ids.insert(schedule.id.clone()) {
            return Err(format!("duplicate schedule id: {}", schedule.id));
        }
    }

    ensure_workspace_child_dir_for_write(workspace, ".builder", "builder")?;
    snapshot_existing_file_for_backup(workspace, &path, "schedules-save")?;

    let temp_path = workspace_schedules_temp_path(&path);
    let body = serde_json::to_string_pretty(&sorted_schedules)
        .map_err(|error| format!("failed to serialize schedules: {error}"))?;
    ensure_text_body_within_limit("schedules file", &body, MAX_REGULAR_TEXT_FILE_BYTES)?;
    write_text_atomic_with_temp(&path, &temp_path, &format!("{body}\n"))
        .map_err(|error| format!("failed to persist schedules: {error}"))
}

fn schedule_state_key(workspace: &Path, schedule_id: &str) -> String {
    let workspace_key = fs::canonicalize(workspace)
        .unwrap_or_else(|_| workspace.to_path_buf())
        .to_string_lossy()
        .to_string();

    format!("{workspace_key}::{schedule_id}")
}

fn schedule_key_for_request(request: &AgentRunRequest) -> Option<String> {
    request
        .schedule_id
        .as_deref()
        .map(|schedule_id| schedule_state_key(Path::new(&request.workspace_path), schedule_id))
}

fn scheduled_run_request(schedule: &ScheduleSpec, workspace: &Path) -> AgentRunRequest {
    let mut request = schedule.run_request.clone();
    let workspace_path = request.workspace_path.trim();

    request.workspace_path = if workspace_path.is_empty() || workspace_path == "." {
        workspace.to_string_lossy().to_string()
    } else if Path::new(workspace_path).is_absolute() {
        workspace_path.to_string()
    } else {
        workspace.join(workspace_path).to_string_lossy().to_string()
    };
    request.schedule_id = Some(schedule.id.clone());
    request
}

fn record_schedule_run_success(app: &AppHandle, key: &str) -> Result<(), String> {
    let _guard = schedule_state_lock()
        .lock()
        .map_err(|_| "schedule state lock failed".to_string())?;
    let mut state = read_schedule_state(app)?;
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    record_schedule_run_success_in_state(&mut state, key, &timestamp);
    write_schedule_state(app, &state)
}

fn record_schedule_run_success_in_state(
    state: &mut ScheduleRuntimeState,
    key: &str,
    timestamp: &str,
) {
    state
        .last_run_at_by_key
        .insert(key.to_string(), timestamp.to_string());
    state
        .last_checked_at_by_key
        .insert(key.to_string(), timestamp.to_string());
}

fn schedule_action(
    schedule: &ScheduleSpec,
    state: &ScheduleRuntimeState,
    key: &str,
    now: chrono::DateTime<chrono::Utc>,
    runtime_started_at: chrono::DateTime<chrono::Utc>,
) -> ScheduleAction {
    if !schedule.enabled {
        return ScheduleAction::Idle;
    }

    let last_run_at = parse_state_time(state.last_run_at_by_key.get(key));
    let last_skipped_at = parse_state_time(state.last_skipped_at_by_key.get(key));
    let last_checked_at = parse_state_time(state.last_checked_at_by_key.get(key));
    let trigger_kind = schedule
        .trigger
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match trigger_kind {
        "interval" => interval_schedule_action(
            schedule,
            last_run_at,
            last_skipped_at,
            last_checked_at,
            now,
            runtime_started_at,
        ),
        "once" => once_schedule_action(
            schedule,
            last_run_at,
            last_skipped_at,
            last_checked_at,
            now,
            runtime_started_at,
        ),
        "cron" => cron_schedule_action(
            schedule,
            last_run_at,
            last_skipped_at,
            last_checked_at,
            now,
            runtime_started_at,
        ),
        _ => ScheduleAction::Idle,
    }
}

fn interval_schedule_action(
    schedule: &ScheduleSpec,
    last_run_at: Option<chrono::DateTime<chrono::Utc>>,
    last_skipped_at: Option<chrono::DateTime<chrono::Utc>>,
    last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
    runtime_started_at: chrono::DateTime<chrono::Utc>,
) -> ScheduleAction {
    let every_seconds = schedule
        .trigger
        .get("everySeconds")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let baseline = latest_time(&[last_run_at, last_skipped_at]);

    let Some(baseline) = baseline else {
        return if schedule.missed_run_policy == "run-on-start" {
            ScheduleAction::Run
        } else {
            ScheduleAction::SkipAndMark
        };
    };

    if now.signed_duration_since(baseline).num_seconds() < every_seconds {
        return ScheduleAction::Idle;
    }

    if is_inactive_miss(last_checked_at, baseline, runtime_started_at)
        && schedule.missed_run_policy == "skip"
    {
        ScheduleAction::SkipAndMark
    } else {
        ScheduleAction::Run
    }
}

fn once_schedule_action(
    schedule: &ScheduleSpec,
    last_run_at: Option<chrono::DateTime<chrono::Utc>>,
    last_skipped_at: Option<chrono::DateTime<chrono::Utc>>,
    last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
    runtime_started_at: chrono::DateTime<chrono::Utc>,
) -> ScheduleAction {
    if last_run_at.is_some() || last_skipped_at.is_some() {
        return ScheduleAction::Idle;
    }

    let Some(run_at) = schedule
        .trigger
        .get("runAt")
        .and_then(Value::as_str)
        .and_then(parse_time)
    else {
        return ScheduleAction::Idle;
    };

    if now < run_at {
        return ScheduleAction::Idle;
    }

    if is_inactive_miss(last_checked_at, run_at, runtime_started_at)
        && schedule.missed_run_policy == "skip"
    {
        ScheduleAction::SkipAndMark
    } else {
        ScheduleAction::Run
    }
}

fn cron_schedule_action(
    schedule: &ScheduleSpec,
    last_run_at: Option<chrono::DateTime<chrono::Utc>>,
    last_skipped_at: Option<chrono::DateTime<chrono::Utc>>,
    last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
    runtime_started_at: chrono::DateTime<chrono::Utc>,
) -> ScheduleAction {
    let baseline = latest_time(&[last_run_at, last_skipped_at]);

    let Some(baseline) = baseline else {
        return if schedule.missed_run_policy == "run-on-start" {
            ScheduleAction::Run
        } else {
            ScheduleAction::SkipAndMark
        };
    };

    let Some(expression) = schedule.trigger.get("expression").and_then(Value::as_str) else {
        return ScheduleAction::Idle;
    };
    let Some(due_at) = latest_cron_due_at_or_before(expression, &schedule.timezone, now, baseline)
    else {
        return ScheduleAction::Idle;
    };

    if is_inactive_miss(last_checked_at, due_at, runtime_started_at)
        && schedule.missed_run_policy == "skip"
    {
        ScheduleAction::SkipAndMark
    } else {
        ScheduleAction::Run
    }
}

#[derive(Debug)]
struct CronExpression {
    minute: BTreeSet<u32>,
    hour: BTreeSet<u32>,
    day_of_month: BTreeSet<u32>,
    month: BTreeSet<u32>,
    day_of_week: BTreeSet<u32>,
    day_of_month_any: bool,
    day_of_week_any: bool,
}

fn latest_cron_due_at_or_before(
    expression: &str,
    timezone: &str,
    now: chrono::DateTime<chrono::Utc>,
    after: chrono::DateTime<chrono::Utc>,
) -> Option<chrono::DateTime<chrono::Utc>> {
    let cron = parse_cron_expression(expression)?;
    let timezone = timezone.parse::<chrono_tz::Tz>().ok()?;
    let mut cursor = truncate_to_minute(now);
    let lower_bound = truncate_to_minute(after);

    for _ in 0..=MAX_CRON_LOOKBACK_MINUTES {
        if cursor <= lower_bound {
            break;
        }

        if cron_matches(&cron, cursor, timezone) {
            return Some(cursor);
        }

        cursor -= chrono::Duration::minutes(1);
    }

    None
}

fn parse_cron_expression(expression: &str) -> Option<CronExpression> {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return None;
    }

    let (minute, _) = parse_cron_field(fields[0], 0, 59, &[], false)?;
    let (hour, _) = parse_cron_field(fields[1], 0, 23, &[], false)?;
    let (day_of_month, day_of_month_any) = parse_cron_field(fields[2], 1, 31, &[], false)?;
    let (month, _) = parse_cron_field(
        fields[3],
        1,
        12,
        &[
            ("jan", 1),
            ("feb", 2),
            ("mar", 3),
            ("apr", 4),
            ("may", 5),
            ("jun", 6),
            ("jul", 7),
            ("aug", 8),
            ("sep", 9),
            ("oct", 10),
            ("nov", 11),
            ("dec", 12),
        ],
        false,
    )?;
    let (day_of_week, day_of_week_any) = parse_cron_field(
        fields[4],
        0,
        7,
        &[
            ("sun", 0),
            ("mon", 1),
            ("tue", 2),
            ("wed", 3),
            ("thu", 4),
            ("fri", 5),
            ("sat", 6),
        ],
        true,
    )?;

    Some(CronExpression {
        minute,
        hour,
        day_of_month,
        month,
        day_of_week,
        day_of_month_any,
        day_of_week_any,
    })
}

fn parse_cron_field(
    source: &str,
    min: u32,
    max: u32,
    aliases: &[(&str, u32)],
    normalize_sunday: bool,
) -> Option<(BTreeSet<u32>, bool)> {
    if source.trim().is_empty() {
        return None;
    }

    let mut values = BTreeSet::new();
    let any = source == "*";

    for raw_part in source.split(',') {
        let part = raw_part.trim().to_ascii_lowercase();
        if part.is_empty() {
            return None;
        }

        let mut step_split = part.split('/');
        let range_part = step_split.next()?;
        let step_part = step_split.next();
        if step_split.next().is_some() {
            return None;
        }

        let step = match step_part {
            Some(value) => value.parse::<u32>().ok()?,
            None => 1,
        };
        if step == 0 {
            return None;
        }

        let (start, end) = parse_cron_range(range_part, min, max, aliases, normalize_sunday)?;
        let mut value = start;
        while value <= end {
            values.insert(if normalize_sunday && value == 7 {
                0
            } else {
                value
            });
            value = value.checked_add(step)?;
        }
    }

    if values.is_empty() {
        None
    } else {
        Some((values, any))
    }
}

fn parse_cron_range(
    source: &str,
    min: u32,
    max: u32,
    aliases: &[(&str, u32)],
    normalize_sunday: bool,
) -> Option<(u32, u32)> {
    if source == "*" {
        return Some((min, max));
    }

    let parts = source.split('-').collect::<Vec<_>>();
    match parts.as_slice() {
        [single] => {
            let value = parse_cron_value(single, aliases, normalize_sunday)?;
            if value < min || value > max {
                None
            } else {
                Some((value, value))
            }
        }
        [start, end] => {
            let start = parse_cron_value(start, aliases, normalize_sunday)?;
            let end = parse_cron_value(end, aliases, normalize_sunday)?;
            if start < min || end > max || start > end {
                None
            } else {
                Some((start, end))
            }
        }
        _ => None,
    }
}

fn parse_cron_value(source: &str, aliases: &[(&str, u32)], normalize_sunday: bool) -> Option<u32> {
    if let Some((_, value)) = aliases.iter().find(|(name, _)| *name == source) {
        return Some(*value);
    }

    let value = source.parse::<u32>().ok()?;
    if normalize_sunday && value == 7 {
        Some(7)
    } else {
        Some(value)
    }
}

fn cron_matches(
    cron: &CronExpression,
    instant: chrono::DateTime<chrono::Utc>,
    timezone: chrono_tz::Tz,
) -> bool {
    let local = instant.with_timezone(&timezone);
    let day_of_month_matches = cron.day_of_month.contains(&local.day());
    let day_of_week_matches = cron
        .day_of_week
        .contains(&local.weekday().num_days_from_sunday());
    let date_matches = if cron.day_of_month_any && cron.day_of_week_any {
        true
    } else if cron.day_of_month_any {
        day_of_week_matches
    } else if cron.day_of_week_any {
        day_of_month_matches
    } else {
        day_of_month_matches || day_of_week_matches
    };

    cron.minute.contains(&local.minute())
        && cron.hour.contains(&local.hour())
        && cron.month.contains(&local.month())
        && date_matches
}

fn truncate_to_minute(value: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    value
        - chrono::Duration::seconds(value.second() as i64)
        - chrono::Duration::nanoseconds(value.nanosecond() as i64)
}

fn is_inactive_miss(
    last_checked_at: Option<chrono::DateTime<chrono::Utc>>,
    due_baseline: chrono::DateTime<chrono::Utc>,
    runtime_started_at: chrono::DateTime<chrono::Utc>,
) -> bool {
    due_baseline < runtime_started_at
        && last_checked_at
            .map(|checked_at| checked_at < runtime_started_at)
            .unwrap_or(true)
}

fn parse_state_time(value: Option<&String>) -> Option<chrono::DateTime<chrono::Utc>> {
    value.and_then(|value| parse_time(value))
}

fn parse_time(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&chrono::Utc))
}

fn latest_time(
    values: &[Option<chrono::DateTime<chrono::Utc>>],
) -> Option<chrono::DateTime<chrono::Utc>> {
    values.iter().filter_map(|value| *value).max()
}

fn discover_workspace_skills(workspace: &Path) -> Result<Vec<SkillManifest>, String> {
    let mut skills = Vec::new();
    let Some(skills_dir) = workspace_child_dir_for_read(workspace, "skills", "skills")? else {
        return Ok(skills);
    };
    collect_skill_manifests(&skills_dir, 0, skills_dir.as_path(), &mut skills)?;
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(skills)
}

fn collect_skill_manifests(
    current_dir: &Path,
    depth: usize,
    skills_root: &Path,
    skills: &mut Vec<SkillManifest>,
) -> Result<(), String> {
    if depth > 3 {
        return Ok(());
    }

    for entry in fs::read_dir(current_dir)
        .map_err(|error| format!("failed to read skills directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read skills entry: {error}"))?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect skills entry: {error}"))?;

        if file_type.is_symlink() {
            return Err(format!(
                "skill path must not be a symlink: {}",
                path.display()
            ));
        }

        if file_type.is_file() && file_name == "skill.yaml" {
            let source = read_regular_text_file(&path, "skill manifest")?;
            skills.push(parse_skill_manifest(&source, &path)?);
        } else if file_type.is_dir() && !file_name.starts_with('.') {
            ensure_canonical_path_stays_in_workspace(skills_root, &path, "skill")?;
            collect_skill_manifests(&path, depth + 1, skills_root, skills)?;
        }
    }

    Ok(())
}

fn parse_skill_manifest(source: &str, manifest_path: &Path) -> Result<SkillManifest, String> {
    let manifest = serde_yaml::from_str::<SkillManifest>(source).map_err(|error| {
        format!(
            "failed to parse skill manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    validate_skill_manifest(&manifest, manifest_path)?;
    Ok(manifest)
}

fn discover_workspace_ontology(workspace: &Path) -> Result<Vec<OntologyEntity>, String> {
    let mut entities = Vec::new();

    if let Some(root) = workspace_child_dir_for_read(workspace, "ontology", "ontology")? {
        collect_ontology_entities_from_dir(&root, &mut entities)?;
    }

    if workspace_child_dir_for_read(workspace, ".builder", "builder")?.is_some() {
        if let Some(root) =
            workspace_child_dir_for_read(workspace, ".builder/ontology", "builder ontology")?
        {
            collect_ontology_entities_from_dir(&root, &mut entities)?;
        }
    }

    entities.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(entities)
}

fn collect_ontology_entities_from_dir(
    root: &Path,
    entities: &mut Vec<OntologyEntity>,
) -> Result<(), String> {
    for entry in
        fs::read_dir(root).map_err(|error| format!("failed to read ontology directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read ontology entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect ontology entry: {error}"))?;

        if file_type.is_symlink() {
            return Err(format!(
                "ontology path must not be a symlink: {}",
                path.display()
            ));
        }

        if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            entities.extend(read_ontology_file(&path)?);
        }
    }

    Ok(())
}

fn read_ontology_file(path: &Path) -> Result<Vec<OntologyEntity>, String> {
    let source = read_regular_text_file(path, "ontology file")?;
    let parsed = serde_json::from_str::<Value>(&source)
        .map_err(|error| format!("failed to parse ontology file {}: {error}", path.display()))?;

    let entities = if parsed.is_array() {
        serde_json::from_value::<Vec<OntologyEntity>>(parsed)
    } else {
        serde_json::from_value::<OntologyEntity>(parsed).map(|entity| vec![entity])
    }
    .map_err(|error| {
        format!(
            "failed to load ontology entities {}: {error}",
            path.display()
        )
    })?;

    for entity in &entities {
        validate_ontology_entity(entity, path)?;
    }

    Ok(entities)
}

fn discover_workspace_schedules(workspace: &Path) -> Result<Vec<ScheduleSpec>, String> {
    let path = workspace.join(".builder").join("schedules.json");
    let Some(_builder_dir) = workspace_child_dir_for_read(workspace, ".builder", "builder")? else {
        return Ok(Vec::new());
    };

    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "schedules file must not be a symlink: {}",
                    path.display()
                ));
            }
            if !metadata.is_file() {
                return Err(format!("schedules path is not a file: {}", path.display()));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "failed to inspect schedules file {}: {error}",
                path.display()
            ));
        }
    }

    let source = read_regular_text_file(&path, "schedules file")?;
    let mut schedules = serde_json::from_str::<Vec<ScheduleSpec>>(&source)
        .map_err(|error| format!("failed to parse schedules file {}: {error}", path.display()))?;

    for schedule in &schedules {
        validate_schedule_spec(schedule, &path)?;
    }

    schedules.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(schedules)
}

fn validate_skill_manifest(manifest: &SkillManifest, manifest_path: &Path) -> Result<(), String> {
    let mut errors = Vec::new();

    if manifest.id.trim().is_empty() {
        errors.push("id is required");
    } else if !manifest
        .id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        errors.push("id contains unsupported path characters");
    }
    if manifest.name.trim().is_empty() {
        errors.push("name is required");
    }
    if manifest.version.trim().is_empty() {
        errors.push("version is required");
    }
    if manifest.instructions_path.trim().is_empty() {
        errors.push("instructionsPath is required");
    }
    if !is_safe_relative_instruction_path(&manifest.instructions_path) {
        errors.push("instructionsPath must stay inside the skill directory");
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "invalid skill manifest {}: {}",
            manifest_path.display(),
            errors.join("; ")
        ))
    }
}

fn is_safe_relative_instruction_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/");

    if normalized == "." || normalized.starts_with('/') || is_windows_absolute_path_like(value) {
        return false;
    }

    normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .all(|segment| segment != "." && segment != "..")
}

fn is_windows_absolute_path_like(value: &str) -> bool {
    let bytes = value.as_bytes();

    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn validate_ontology_entity(entity: &OntologyEntity, path: &Path) -> Result<(), String> {
    let allowed_types = [
        "Profession",
        "Workspace",
        "Project",
        "Goal",
        "Task",
        "Artifact",
        "Tool",
        "Skill",
        "Schedule",
        "Run",
    ];
    let mut errors = Vec::new();

    if entity.id.trim().is_empty() {
        errors.push("id is required");
    }
    if !allowed_types.contains(&entity.entity_type.as_str()) {
        errors.push("type is invalid");
    }
    if entity.label.trim().is_empty() {
        errors.push("label is required");
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "invalid ontology entity {} in {}: {}",
            entity.id,
            path.display(),
            errors.join("; ")
        ))
    }
}

fn validate_schedule_spec(schedule: &ScheduleSpec, path: &Path) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    let trigger_kind = schedule
        .trigger
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if schedule.id.trim().is_empty() {
        errors.push("id is required".to_string());
    } else {
        validate_reference_id(&mut errors, "schedule id", &schedule.id, false);
    }
    if schedule.name.trim().is_empty() {
        errors.push("name is required".to_string());
    }
    if schedule.timezone.trim().is_empty() {
        errors.push("timezone is required".to_string());
    }
    if !["run-on-start", "skip"].contains(&schedule.missed_run_policy.as_str()) {
        errors.push("missedRunPolicy is invalid".to_string());
    }
    if !["once", "interval", "cron"].contains(&trigger_kind) {
        errors.push("trigger.kind is invalid".to_string());
    }

    if let Err(error) = validate_request(&schedule.run_request) {
        errors.push(format!("runRequest is invalid: {error}"));
    }

    match trigger_kind {
        "interval" => {
            let every_seconds = schedule
                .trigger
                .get("everySeconds")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            if every_seconds < 1 {
                errors.push("interval trigger requires everySeconds >= 1".to_string());
            }
        }
        "once" => {
            if schedule
                .trigger
                .get("runAt")
                .and_then(Value::as_str)
                .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
            {
                errors.push("once trigger requires ISO runAt".to_string());
            }
        }
        "cron" => {
            if schedule
                .trigger
                .get("expression")
                .and_then(Value::as_str)
                .is_none_or(|value| parse_cron_expression(value).is_none())
            {
                errors.push("cron trigger must be a valid five-field expression".to_string());
            }
            if schedule.timezone.parse::<chrono_tz::Tz>().is_err() {
                errors.push("timezone must be a valid IANA timezone".to_string());
            }
        }
        _ => {}
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "invalid schedule {} in {}: {}",
            schedule.id,
            path.display(),
            errors.join("; ")
        ))
    }
}

fn default_version() -> String {
    "0.1.0".to_string()
}

fn default_inputs_json_schema() -> Value {
    json!({ "type": "object", "additionalProperties": true })
}

fn default_instructions_path() -> String {
    "instructions.md".to_string()
}

fn default_object() -> Value {
    json!({})
}

fn remove_run(run_id: &str) {
    if let Ok(mut registry) = run_registry().lock() {
        if registry.remove(run_id).is_some() {
            release_run_permit();
        }
    }
}

fn build_codex_args(request: &AgentRunRequest) -> Vec<String> {
    let mut args = vec![
        "--ask-for-approval".to_string(),
        request.approval_mode.clone(),
        "exec".to_string(),
        "--json".to_string(),
        "--cd".to_string(),
        request.workspace_path.clone(),
        "--sandbox".to_string(),
        request.sandbox_mode.clone(),
    ];

    if let Some(profile) = &request.profile {
        args.push("--profile".to_string());
        args.push(profile.clone());
    }

    if let Some(model) = &request.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    args.push("-".to_string());

    args
}

fn redacted_codex_invocation_preview(
    bin: String,
    args: Vec<String>,
    request: &AgentRunRequest,
) -> CodexInvocationPreview {
    CodexInvocationPreview {
        bin: redact_local_path_like_text(&bin),
        args: args
            .into_iter()
            .map(|arg| redact_local_path_like_text(&arg))
            .collect(),
        redacted: true,
        skill_ids: request.skill_ids.clone().unwrap_or_default(),
        ontology_context_ids: request.ontology_context_ids.clone().unwrap_or_default(),
        schedule_id: request.schedule_id.clone(),
        timeout_seconds: request.timeout_seconds,
    }
}

fn run_event(run_id: &str, event_type: &str, payload: Value) -> AgentRunEvent {
    AgentRunEvent {
        run_id: run_id.to_string(),
        event_type: event_type.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        payload,
    }
}

fn new_run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = RUN_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("desktop-{millis}-{sequence}")
}

fn redact_secret_like_text(input: &str) -> String {
    let mut output = input.to_string();
    let patterns = [
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            "[REDACTED_PRIVATE_KEY]",
        ),
        (r"sk-[A-Za-z0-9_-]{16,}", "[REDACTED_OPENAI_KEY]"),
        (r"sess-[A-Za-z0-9_-]{16,}", "[REDACTED_SESSION]"),
        (
            r"\b(?:gh[pousr]_[A-Za-z0-9_]{32,}|github_pat_[A-Za-z0-9_]{50,})\b",
            "[REDACTED_GITHUB_TOKEN]",
        ),
        (
            r"(?i)((?:authorization\s*:\s*)?bearer\s+)[A-Za-z0-9._~+/=-]{16,}",
            "$1[REDACTED_BEARER_TOKEN]",
        ),
        (
            r#"(?i)("?(?:access|refresh|id|api|session)_?token"?\s*[:=]\s*"?)([^"',}\s]+)("?)"#,
            "$1[REDACTED_TOKEN]$3",
        ),
        (
            r"(?i)((?:OPENAI|CODEX|ANTHROPIC|GITHUB|TAURI|APPLE|WINDOWS|BUILDER_GEAR)_[A-Z0-9_]*(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(\S+)",
            "$1[REDACTED_KEY]",
        ),
    ];

    for (pattern, replacement) in patterns {
        if let Ok(regex) = regex::Regex::new(pattern) {
            output = regex.replace_all(&output, replacement).to_string();
        }
    }

    output
}

fn redact_local_path_like_text(input: &str) -> String {
    let mut output = input.to_string();
    let patterns = [
        (r#"file:///[^"'\s)\n\r]+"#, "[LOCAL_FILE_URL]"),
        (
            r#"/(?:Users|home|tmp|var|private/var)/[^"'\s)\n\r]+"#,
            "[LOCAL_PATH]",
        ),
        (r#"(^|[\s"'(])/[^\s"')\n\r]+"#, "$1[LOCAL_PATH]"),
        (r#"[A-Za-z]:\\[^"'\s)\n\r]+"#, "[LOCAL_PATH]"),
        (r#"(^|[\s"'(])~/[^"'\s)\n\r]+"#, "$1[LOCAL_PATH]"),
    ];

    for (pattern, replacement) in patterns {
        if let Ok(regex) = regex::Regex::new(pattern) {
            output = regex.replace_all(&output, replacement).to_string();
        }
    }

    output
}

fn redact_sensitive_text(input: &str) -> String {
    redact_local_path_like_text(&redact_secret_like_text(input))
}

fn safe_buffered_event_text(input: &str, truncated_before_redaction: bool) -> String {
    let redacted = redact_sensitive_text(input);
    let mut chars = redacted.chars();
    let truncated = chars
        .by_ref()
        .take(MAX_EVENT_TEXT_CHARS)
        .collect::<String>();

    if !truncated_before_redaction && chars.next().is_none() {
        redacted
    } else {
        format!("{truncated}{TRUNCATED_EVENT_SUFFIX}")
    }
}

#[cfg(test)]
fn safe_event_text(input: &str) -> String {
    safe_buffered_event_text(input, false)
}

fn validate_request(request: &AgentRunRequest) -> Result<(), String> {
    let mut errors = Vec::new();

    if request.workspace_path.trim().is_empty() {
        errors.push("workspacePath is required".to_string());
    } else {
        validate_bounded_runtime_string(
            &mut errors,
            "workspacePath",
            &request.workspace_path,
            MAX_AGENT_WORKSPACE_PATH_CHARS,
        );

        if has_control_characters(&request.workspace_path) {
            errors.push("workspacePath must not contain control characters".to_string());
        }
    }

    if request.prompt.trim().is_empty() {
        errors.push("prompt is required".to_string());
    } else if request.prompt.chars().count() > MAX_AGENT_PROMPT_CHARS {
        errors.push(format!(
            "prompt exceeds maximum length of {MAX_AGENT_PROMPT_CHARS} characters"
        ));
    }

    if !["read-only", "workspace-write", "danger-full-access"]
        .contains(&request.sandbox_mode.as_str())
    {
        errors.push(format!("unsupported sandboxMode: {}", request.sandbox_mode));
    }

    if !["untrusted", "on-failure", "on-request", "never"].contains(&request.approval_mode.as_str())
    {
        errors.push(format!(
            "unsupported approvalMode: {}",
            request.approval_mode
        ));
    }

    if let Some(timeout_seconds) = request.timeout_seconds {
        if timeout_seconds == 0 || timeout_seconds > MAX_AGENT_RUN_TIMEOUT_SECONDS {
            errors.push(format!(
                "timeoutSeconds must be a whole number between 1 and {MAX_AGENT_RUN_TIMEOUT_SECONDS}"
            ));
        }
    }

    validate_optional_cli_token(&mut errors, "model", request.model.as_deref());
    validate_optional_cli_token(&mut errors, "profile", request.profile.as_deref());
    validate_reference_id_list(&mut errors, "skillIds", request.skill_ids.as_deref(), true);
    validate_reference_id_list(
        &mut errors,
        "ontologyContextIds",
        request.ontology_context_ids.as_deref(),
        false,
    );
    validate_optional_reference_id(
        &mut errors,
        "scheduleId",
        request.schedule_id.as_deref(),
        false,
    );

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn validate_optional_cli_token(errors: &mut Vec<String>, field: &str, value: Option<&str>) {
    let Some(value) = value else {
        return;
    };

    if value.trim().is_empty() {
        errors.push(format!("{field} must not be empty"));
        return;
    }

    validate_bounded_runtime_string(errors, field, value, MAX_AGENT_CLI_OPTION_CHARS);

    if value != value.trim()
        || value.chars().any(char::is_whitespace)
        || has_control_characters(value)
    {
        errors.push(format!(
            "{field} must not contain whitespace or control characters"
        ));
    }
}

fn validate_reference_id_list(
    errors: &mut Vec<String>,
    field: &str,
    value: Option<&[String]>,
    path_safe_only: bool,
) {
    let Some(value) = value else {
        return;
    };

    if value.len() > MAX_AGENT_REFERENCE_IDS {
        errors.push(format!(
            "{field} exceeds maximum length of {MAX_AGENT_REFERENCE_IDS}"
        ));
    }

    let mut seen = BTreeSet::new();
    for (index, item) in value.iter().enumerate() {
        validate_reference_id(errors, &format!("{field}[{index}]"), item, path_safe_only);

        if !seen.insert(item) {
            errors.push(format!("{field} contains duplicate ids"));
        }
    }
}

fn validate_optional_reference_id(
    errors: &mut Vec<String>,
    field: &str,
    value: Option<&str>,
    path_safe_only: bool,
) {
    let Some(value) = value else {
        return;
    };

    validate_reference_id(errors, field, value, path_safe_only);
}

fn validate_reference_id(errors: &mut Vec<String>, field: &str, value: &str, path_safe_only: bool) {
    if value.trim().is_empty() {
        errors.push(format!("{field} is required"));
        return;
    }

    validate_bounded_runtime_string(errors, field, value, MAX_AGENT_REFERENCE_ID_CHARS);

    if value != value.trim() || has_control_characters(value) {
        errors.push(format!(
            "{field} must not contain surrounding whitespace or control characters"
        ));
    }

    if if path_safe_only {
        !is_path_safe_id(value)
    } else {
        !is_reference_safe_id(value)
    } {
        errors.push(format!("{field} contains unsupported id characters"));
    }
}

fn validate_bounded_runtime_string(
    errors: &mut Vec<String>,
    field: &str,
    value: &str,
    max_length: usize,
) {
    if value.chars().count() > max_length {
        errors.push(format!(
            "{field} exceeds maximum length of {max_length} characters"
        ));
    }
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn is_path_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn is_reference_safe_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn codex_auth_path() -> PathBuf {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return PathBuf::from(codex_home).join("auth.json");
    }

    home_dir().join(".codex").join("auth.json")
}

fn inspect_codex_auth_path(path: &Path) -> CodexAuthInspection {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let is_symlink = metadata.file_type().is_symlink();
            let is_file = metadata.is_file();
            let readable = is_file && fs::File::open(path).is_ok();
            let (permissions_secure, mode) = auth_permissions_metadata(&metadata);

            CodexAuthInspection {
                path: path.to_path_buf(),
                exists: true,
                readable,
                is_file,
                is_symlink,
                permissions_secure,
                mode,
            }
        }
        Err(_) => CodexAuthInspection {
            path: path.to_path_buf(),
            exists: false,
            readable: false,
            is_file: false,
            is_symlink: false,
            permissions_secure: None,
            mode: None,
        },
    }
}

#[cfg(unix)]
fn auth_permissions_metadata(metadata: &fs::Metadata) -> (Option<bool>, Option<String>) {
    let mode = metadata.permissions().mode() & 0o777;
    (Some(mode & 0o077 == 0), Some(format!("0{mode:o}")))
}

#[cfg(not(unix))]
fn auth_permissions_metadata(_metadata: &fs::Metadata) -> (Option<bool>, Option<String>) {
    (None, None)
}

fn codex_bin() -> String {
    std::env::var("BUILDER_GEAR_CODEX_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CODEX_BIN.to_string())
}

fn default_workspace_path() -> PathBuf {
    let current_dir = std::env::current_dir().ok();
    let env_workspace = std::env::var_os("BUILDER_GEAR_WORKSPACE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    default_workspace_path_from(current_dir, home_dir(), env_workspace)
}

fn default_workspace_path_from(
    current_dir: Option<PathBuf>,
    home: PathBuf,
    env_workspace: Option<PathBuf>,
) -> PathBuf {
    if let Some(env_workspace) = env_workspace {
        return absolute_workspace_path(env_workspace, current_dir.as_deref());
    }

    if let Some(current_dir) = current_dir.as_deref() {
        if let Some(workspace) = nearest_builder_workspace(current_dir) {
            return workspace;
        }
    }

    home.join(DEFAULT_WORKSPACE_DIR_NAME)
}

fn absolute_workspace_path(path: PathBuf, current_dir: Option<&Path>) -> PathBuf {
    if path.is_absolute() {
        return path;
    }

    current_dir.map(|base| base.join(&path)).unwrap_or(path)
}

fn nearest_builder_workspace(start: &Path) -> Option<PathBuf> {
    let start = fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());

    for candidate in start.ancestors() {
        if looks_like_builder_workspace(candidate) {
            return Some(candidate.to_path_buf());
        }
    }

    None
}

fn looks_like_builder_workspace(path: &Path) -> bool {
    path.join("skills").is_dir() && path.join("ontology").is_dir()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            builder_cli_info,
            builder_select_workspace_directory,
            builder_codex_invocation,
            builder_load_catalog,
            builder_prepare_workspace,
            builder_health_check,
            builder_create_diagnostics_report,
            builder_create_support_bundle,
            builder_list_workspace_backups,
            builder_restore_workspace_backup,
            builder_prune_workspace_backups,
            builder_tick_schedules,
            builder_save_schedules,
            builder_save_ontology,
            builder_save_skill,
            builder_delete_skill,
            builder_load_skill_source,
            builder_run_schedule_now,
            builder_start_codex_run,
            builder_cancel_codex_run,
            builder_list_run_events,
            builder_clear_run_events
        ])
        .run(tauri::generate_context!())
        .expect("error while running Builder Gear desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    static TEST_WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);
    static RUN_PERMIT_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    static ENV_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn reset_active_run_permits_for_test(value: usize) {
        let mut active_runs = active_run_permits()
            .lock()
            .expect("active run permit lock should not be poisoned");
        *active_runs = value;
    }

    fn spawn_long_running_test_process() -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping 127.0.0.1 -n 30 > nul"]);
            command
        };

        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };

        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("long-running test process should spawn")
    }

    fn spawn_finished_test_process() -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit 0"]);
            command
        };

        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };

        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("finished test process should spawn");

        for _ in 0..50 {
            if child
                .try_wait()
                .expect("finished process status should be readable")
                .is_some()
            {
                return child;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let _ = child.kill();
        panic!("finished test process did not exit in time");
    }

    struct ChunkedReader {
        chunks: Vec<Vec<u8>>,
        index: usize,
        offset: usize,
    }

    impl ChunkedReader {
        fn new(chunks: Vec<Vec<u8>>) -> Self {
            Self {
                chunks,
                index: 0,
                offset: 0,
            }
        }
    }

    impl std::io::Read for ChunkedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.index >= self.chunks.len() {
                return Ok(0);
            }

            let chunk = &self.chunks[self.index];
            let available = &chunk[self.offset..];
            let read = available.len().min(buffer.len());
            buffer[..read].copy_from_slice(&available[..read]);
            self.offset += read;

            if self.offset >= chunk.len() {
                self.index += 1;
                self.offset = 0;
            }

            Ok(read)
        }
    }

    fn output_events_from_reader<R: std::io::Read>(
        run_id: &str,
        stream_type: &str,
        stream: R,
    ) -> Vec<AgentRunEvent> {
        let mut events = Vec::new();
        read_output_events(run_id, stream_type, stream, |event| events.push(event));
        events
    }

    fn oversized_text_body() -> String {
        "x".repeat(MAX_REGULAR_TEXT_FILE_BYTES as usize + 1)
    }

    #[test]
    fn run_permits_enforce_active_run_limit_and_release_on_drop() {
        let _guard = RUN_PERMIT_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("run permit test lock should not be poisoned");
        reset_active_run_permits_for_test(0);

        let mut permits = Vec::new();
        for _ in 0..MAX_ACTIVE_RUNS {
            permits.push(RunPermit::acquire().expect("permit should be acquired"));
        }

        let error = match RunPermit::acquire() {
            Ok(_) => panic!("permit above limit should fail"),
            Err(error) => error,
        };
        assert!(error.contains("too many active runs"));

        drop(permits.pop());
        let recovered = RunPermit::acquire().expect("released permit should be reusable");
        drop(recovered);
        drop(permits);

        assert_eq!(
            *active_run_permits()
                .lock()
                .expect("active run permit lock should not be poisoned"),
            0
        );
    }

    #[test]
    fn active_schedule_claim_rejects_duplicate_until_released() {
        let key = format!(
            "workspace::daily-plan-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be after epoch")
                .as_nanos()
        );
        release_active_schedule_run(Some(&key));

        let claim =
            ScheduleRunClaim::acquire(Some(key.clone())).expect("first claim should succeed");
        let error = match ScheduleRunClaim::acquire(Some(key.clone())) {
            Ok(_) => panic!("duplicate schedule claim should fail"),
            Err(error) => error,
        };
        assert!(error.contains("schedule already has an active run"));

        drop(claim);
        let recovered = ScheduleRunClaim::acquire(Some(key.clone()))
            .expect("released claim should be reusable");
        drop(recovered);
        release_active_schedule_run(Some(&key));
    }

    #[test]
    fn cancel_run_process_marks_running_child_cancelled_and_kills_it() {
        let mut process = RunProcess {
            child: spawn_long_running_test_process(),
            cancelled: false,
            timed_out: false,
            timeout_seconds: None,
            timeout_deadline: None,
            schedule_key: None,
        };

        cancel_run_process(&mut process).expect("running child should be cancellable");
        assert!(process.cancelled);

        let status = process
            .child
            .wait()
            .expect("cancelled process should be waitable");
        assert!(!status.success());
    }

    #[test]
    fn cancel_run_process_is_ok_when_child_already_finished() {
        let mut process = RunProcess {
            child: spawn_finished_test_process(),
            cancelled: false,
            timed_out: false,
            timeout_seconds: None,
            timeout_deadline: None,
            schedule_key: None,
        };

        cancel_run_process(&mut process).expect("finished child cancellation should be idempotent");
        assert!(process.cancelled);
    }

    #[test]
    fn due_run_timeout_marks_and_kills_process() {
        let mut process = RunProcess {
            child: spawn_long_running_test_process(),
            cancelled: false,
            timed_out: false,
            timeout_seconds: Some(1),
            timeout_deadline: Some(Instant::now() - Duration::from_millis(1)),
            schedule_key: None,
        };

        assert!(maybe_timeout_run_process(&mut process, Instant::now()));
        assert!(process.timed_out);
        assert!(!process.cancelled);

        let status = process
            .child
            .wait()
            .expect("timed out process should be waitable");
        assert!(!status.success());
    }

    #[test]
    fn new_run_id_stays_unique_during_bursty_starts() {
        let mut ids = std::collections::BTreeSet::new();

        for _ in 0..4096 {
            let run_id = new_run_id();
            assert!(
                run_id.starts_with("desktop-"),
                "run id should keep the desktop prefix"
            );
            assert!(ids.insert(run_id), "run id should be unique");
        }
    }

    fn request() -> AgentRunRequest {
        AgentRunRequest {
            workspace_path: "/tmp/workspace".to_string(),
            prompt: "Build it".to_string(),
            model: None,
            profile: None,
            sandbox_mode: "read-only".to_string(),
            approval_mode: "never".to_string(),
            timeout_seconds: None,
            skill_ids: Some(vec!["build-plan".to_string()]),
            ontology_context_ids: Some(vec!["goal-mvp".to_string()]),
            schedule_id: None,
        }
    }

    fn interval_schedule(missed_run_policy: &str) -> ScheduleSpec {
        ScheduleSpec {
            id: "daily-plan".to_string(),
            name: "Daily Plan".to_string(),
            trigger: json!({ "kind": "interval", "everySeconds": 60 }),
            timezone: "Asia/Seoul".to_string(),
            run_request: AgentRunRequest {
                workspace_path: ".".to_string(),
                prompt: "Plan".to_string(),
                model: None,
                profile: None,
                sandbox_mode: "read-only".to_string(),
                approval_mode: "never".to_string(),
                timeout_seconds: None,
                skill_ids: Some(vec!["build-plan".to_string()]),
                ontology_context_ids: Some(vec!["goal-mvp".to_string()]),
                schedule_id: None,
            },
            missed_run_policy: missed_run_policy.to_string(),
            enabled: true,
        }
    }

    fn cron_schedule() -> ScheduleSpec {
        ScheduleSpec {
            trigger: json!({ "kind": "cron", "expression": "0 9 * * 1-5" }),
            ..interval_schedule("run-on-start")
        }
    }

    fn skill_manifest(id: &str, name: &str) -> SkillManifest {
        SkillManifest {
            id: id.to_string(),
            name: name.to_string(),
            version: "0.1.0".to_string(),
            occupations: vec!["developer".to_string()],
            inputs_json_schema: json!({ "type": "object", "additionalProperties": true }),
            instructions_path: "instructions.md".to_string(),
            required_tools: vec!["codex".to_string()],
            ui_panels: vec!["runs".to_string()],
            schedule_templates: Vec::new(),
        }
    }

    fn ontology_entity(id: &str, label: &str) -> OntologyEntity {
        OntologyEntity {
            id: id.to_string(),
            entity_type: "Goal".to_string(),
            label: label.to_string(),
            properties: json!({}),
            relations: Vec::new(),
        }
    }

    fn test_workspace() -> PathBuf {
        let sequence = TEST_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let workspace = std::env::temp_dir().join(format!(
            "builder-gear-test-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&workspace).expect("workspace should be created");
        workspace
    }

    fn latest_backup_containing(workspace: &Path, needle: &str) -> Option<PathBuf> {
        let mut matches = fs::read_dir(workspace.join(WORKSPACE_BACKUPS_DIR))
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(needle))
            })
            .collect::<Vec<_>>();

        matches.sort();
        matches.pop()
    }

    fn corrupt_backups(dir: &Path, file_name: &str) -> Vec<PathBuf> {
        let prefix = format!("{file_name}.corrupt-");
        let mut paths = fs::read_dir(dir)
            .expect("backup directory should be readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    #[cfg(unix)]
    fn mock_workspace() -> PathBuf {
        test_workspace()
    }

    #[cfg(unix)]
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }

    #[cfg(unix)]
    fn create_mock_codex_script(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let script_path = root.join("mock-codex");
        let args_path = root.join("mock-codex-args.txt");
        let stdin_path = root.join("mock-codex-stdin.txt");
        let script = format!(
            r#"#!/bin/sh
printf '%s\n' "$@" > {}
cat > {}
printf '%s\n' '{{"type":"started","message":"mock stream"}}'
printf '%s\n' 'plain output'
printf '%s\n' 'OPENAI_API_KEY=sk-1234567890abcdefghijkl' >&2
"#,
            shell_quote(&args_path),
            shell_quote(&stdin_path)
        );
        fs::write(&script_path, script).expect("mock codex script should be written");
        let mut permissions = fs::metadata(&script_path)
            .expect("mock codex script metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)
            .expect("mock codex script should be executable");
        (script_path, args_path, stdin_path)
    }

    #[cfg(unix)]
    fn create_mock_codex_env_script(root: &Path) -> (PathBuf, PathBuf) {
        let script_path = root.join("mock-codex-env");
        let env_path = root.join("mock-codex-env.txt");
        let script = format!(
            r#"#!/bin/sh
{{
printf 'APPLE_PASSWORD=%s\n' "${{APPLE_PASSWORD-}}"
printf 'APPLE_CERTIFICATE=%s\n' "${{APPLE_CERTIFICATE-}}"
printf 'APPLE_KEYCHAIN_PASSWORD=%s\n' "${{APPLE_KEYCHAIN_PASSWORD-}}"
printf 'BUILDER_GEAR_CODEX_BIN=%s\n' "${{BUILDER_GEAR_CODEX_BIN-}}"
printf 'BUILDER_GEAR_UPDATER_PUBKEY=%s\n' "${{BUILDER_GEAR_UPDATER_PUBKEY-}}"
printf 'PATH=%s\n' "${{PATH-}}"
}} > {}
"#,
            shell_quote(&env_path)
        );
        fs::write(&script_path, script).expect("mock codex env script should be written");
        let mut permissions = fs::metadata(&script_path)
            .expect("mock codex env script metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)
            .expect("mock codex env script should be executable");
        (script_path, env_path)
    }

    #[cfg(unix)]
    fn create_mock_codex_version_script(root: &Path, body: &str) -> PathBuf {
        let script_path = root.join("mock-codex-version");
        fs::write(&script_path, body).expect("mock codex version script should be written");
        let mut permissions = fs::metadata(&script_path)
            .expect("mock codex version metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)
            .expect("mock codex version script should be executable");
        script_path
    }

    #[cfg(unix)]
    fn restore_env_var(key: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn builds_codex_args_without_leaking_prompt_for_preview() {
        let args = build_codex_args(&request());

        assert_eq!(
            args,
            vec![
                "--ask-for-approval",
                "never",
                "exec",
                "--json",
                "--cd",
                "/tmp/workspace",
                "--sandbox",
                "read-only",
                "-"
            ]
        );
        assert!(!args.contains(&"Build it".to_string()));
    }

    #[test]
    fn redacts_codex_invocation_preview_paths_before_returning_to_renderer() {
        let mut request = request();
        request.workspace_path = "/Users/example/private-project".to_string();
        request.profile = Some("/Users/example/codex-profile".to_string());
        request.model = Some("file:///Users/example/private-model.json".to_string());
        request.skill_ids = Some(vec!["build-plan".to_string()]);
        request.ontology_context_ids = Some(vec!["goal-mvp".to_string()]);

        let args = build_codex_args(&request);
        let preview = redacted_codex_invocation_preview(
            "/Users/example/bin/codex".to_string(),
            args,
            &request,
        );
        let source = serde_json::to_string(&preview).expect("preview should serialize");

        assert_eq!(preview.bin, "[LOCAL_PATH]");
        assert_eq!(
            preview.args[preview.args.iter().position(|arg| arg == "--cd").unwrap() + 1],
            "[LOCAL_PATH]"
        );
        assert_eq!(
            preview.args[preview
                .args
                .iter()
                .position(|arg| arg == "--profile")
                .unwrap()
                + 1],
            "[LOCAL_PATH]"
        );
        assert_eq!(
            preview.args[preview
                .args
                .iter()
                .position(|arg| arg == "--model")
                .unwrap()
                + 1],
            "[LOCAL_FILE_URL]"
        );
        assert!(preview.redacted);
        assert_eq!(preview.skill_ids, vec!["build-plan"]);
        assert_eq!(preview.ontology_context_ids, vec!["goal-mvp"]);
        assert!(!source.contains("Build it"));
        assert!(!source.contains("/Users/example"));
        assert!(!source.contains("private-project"));
        assert!(!source.contains("private-model"));
    }

    #[test]
    fn validates_bounded_run_requests_before_spawning_codex() {
        let mut valid = request();
        valid.model = Some("gpt-5".to_string());
        valid.profile = Some("builder.release".to_string());
        valid.timeout_seconds = Some(3600);
        valid.ontology_context_ids =
            Some(vec!["goal-mvp".to_string(), "crm:lead.stage-1".to_string()]);
        valid.schedule_id = Some("daily-plan".to_string());

        assert!(validate_request(&valid).is_ok());

        let mut invalid = valid;
        invalid.workspace_path = "/tmp/workspace\nother".to_string();
        invalid.prompt = "x".repeat(MAX_AGENT_PROMPT_CHARS + 1);
        invalid.model = Some("gpt-5\n--profile".to_string());
        invalid.profile = Some("x".repeat(MAX_AGENT_CLI_OPTION_CHARS + 1));
        invalid.timeout_seconds = Some(0);
        invalid.skill_ids = Some(vec![
            "build-plan".to_string(),
            "bad/skill".to_string(),
            "build-plan".to_string(),
        ]);
        invalid.ontology_context_ids = Some(vec![
            "goal good".to_string(),
            format!("g{}", "x".repeat(MAX_AGENT_REFERENCE_ID_CHARS)),
        ]);
        invalid.schedule_id = Some(" nightly ".to_string());

        let error = validate_request(&invalid).expect_err("invalid request should fail");

        assert!(error.contains("workspacePath must not contain control characters"));
        assert!(error.contains(&format!(
            "prompt exceeds maximum length of {MAX_AGENT_PROMPT_CHARS} characters"
        )));
        assert!(error.contains("model must not contain whitespace or control characters"));
        assert!(error.contains(&format!(
            "profile exceeds maximum length of {MAX_AGENT_CLI_OPTION_CHARS} characters"
        )));
        assert!(error.contains(&format!(
            "timeoutSeconds must be a whole number between 1 and {MAX_AGENT_RUN_TIMEOUT_SECONDS}"
        )));
        assert!(error.contains("skillIds[1] contains unsupported id characters"));
        assert!(error.contains("skillIds contains duplicate ids"));
        assert!(error.contains("ontologyContextIds[0] contains unsupported id characters"));
        assert!(error.contains(&format!(
            "ontologyContextIds[1] exceeds maximum length of {MAX_AGENT_REFERENCE_ID_CHARS} characters"
        )));
        assert!(error
            .contains("scheduleId must not contain surrounding whitespace or control characters"));
        assert!(error.contains("scheduleId contains unsupported id characters"));
    }

    #[test]
    fn redacts_secret_like_text() {
        let github_token = format!("ghp_{}", "a".repeat(32));
        let private_key_block = format!(
            "{}{}{}",
            "-----BEGIN PRIVATE ", "KEY-----\nprivate-key-material\n-----END PRIVATE ", "KEY-----"
        );
        let redacted = redact_secret_like_text(&format!(
            r#"OPENAI_API_KEY=sk-1234567890abcdefghijkl access_token:"abc123"
Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456
github token {github_token}
TAURI_SIGNING_PRIVATE_KEY=base64-signing-key-material
{private_key_block}"#
        ));

        assert!(redacted.contains("[REDACTED_KEY]"));
        assert!(redacted.contains("[REDACTED_TOKEN]"));
        assert!(redacted.contains("[REDACTED_BEARER_TOKEN]"));
        assert!(redacted.contains("[REDACTED_GITHUB_TOKEN]"));
        assert!(redacted.contains("[REDACTED_PRIVATE_KEY]"));
        assert!(!redacted.contains("abcdefghijkl"));
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("private-key-material"));
    }

    #[test]
    fn safe_event_text_redacts_local_paths() {
        let redacted = safe_event_text(
            "failed at /Users/example/private/App.tsx and /Volumes/ClientDrive/workspace with /workspace/private-project and file:///Users/example/private/prompt.txt with ~/.codex/auth.json",
        );

        assert!(redacted.contains("[LOCAL_PATH]"));
        assert!(redacted.contains("[LOCAL_FILE_URL]"));
        assert!(!redacted.contains("/Users/example"));
        assert!(!redacted.contains("/Volumes/ClientDrive"));
        assert!(!redacted.contains("/workspace/private-project"));
        assert!(!redacted.contains("~/.codex"));
    }

    #[test]
    fn bounded_process_output_drains_and_caps_output() {
        let input = Cursor::new(vec![b'x'; MAX_CODEX_VERSION_OUTPUT_BYTES + 1024]);
        let output = read_bounded_process_output(input, 64);

        assert_eq!(output.len(), 64);
        assert!(output.iter().all(|byte| *byte == b'x'));
    }

    #[cfg(unix)]
    #[test]
    fn codex_version_probe_caps_untrusted_output() {
        let root = test_workspace();
        let script = create_mock_codex_version_script(
            &root,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex 0.40.0 '
  head -c 16384 /dev/zero | tr '\000' 'x'
  printf '\n'
  exit 0
fi
exit 1
"#,
        );
        let version =
            detect_codex_cli_version(script.to_str().expect("script path should be utf8"))
                .expect("version should be detected");

        assert!(version.starts_with("codex 0.40.0 "));
        assert!(version.len() <= MAX_CODEX_VERSION_OUTPUT_BYTES);

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn codex_version_probe_times_out_hanging_processes() {
        let root = test_workspace();
        let script = create_mock_codex_version_script(
            &root,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  sleep 30
  exit 0
fi
exit 1
"#,
        );
        let started_at = Instant::now();
        let version = detect_codex_cli_version_with_timeout(
            script.to_str().expect("script path should be utf8"),
            Duration::from_millis(150),
        );

        assert!(version.is_none());
        assert!(started_at.elapsed() < Duration::from_secs(2));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn serializes_run_events_for_frontend_contract() {
        let event = run_event(
            "run-1",
            "queued",
            json!({ "workspaceSelected": true, "pathRedacted": true }),
        );
        let serialized = serde_json::to_value(event).expect("event should serialize");

        assert_eq!(serialized["runId"], "run-1");
        assert_eq!(serialized["type"], "queued");
        assert_eq!(serialized["payload"]["workspaceSelected"], true);
        assert_eq!(serialized["payload"]["pathRedacted"], true);
        assert!(serialized["payload"].get("workspacePath").is_none());
    }

    #[test]
    fn diagnostics_report_summarizes_without_payloads_or_prompts() {
        let root = test_workspace();
        let sensitive_workspace_name = "Secret Client Alpha";
        let workspace = root.join(sensitive_workspace_name);
        fs::create_dir_all(&workspace).expect("workspace should be created");
        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("qa-plan", "QA Plan"),
            "# QA Plan",
        )
        .expect("skill should persist");
        write_workspace_ontology(&workspace, &[ontology_entity("goal", "Goal")])
            .expect("ontology should persist");
        write_workspace_schedules(&workspace, &[interval_schedule("run-on-start")])
            .expect("schedule should persist");
        let backup_name = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
        fs::create_dir_all(workspace.join(WORKSPACE_BACKUPS_DIR))
            .expect("backup directory should exist");
        fs::write(
            workspace.join(WORKSPACE_BACKUPS_DIR).join(backup_name),
            "previous schedules",
        )
        .expect("backup should be written");
        let event = run_event(
            "run-1",
            "stdout",
            json!({
                "prompt": "Super secret prompt",
                "token": "sk-1234567890abcdefghijkl"
            }),
        );
        let report = diagnostics_report_from_parts(
            "0.1.0",
            parse_time("2026-06-24T00:00:00Z").expect("valid time"),
            CliInfo {
                codex_available: true,
                codex_version: Some("codex 0.40.0 sk-1234567890abcdefghijkl".to_string()),
                auth_path: home_dir()
                    .join(".codex/auth.json")
                    .to_string_lossy()
                    .to_string(),
                auth_exists: true,
                auth_checked: true,
                default_workspace_path: workspace.to_string_lossy().to_string(),
            },
            &workspace,
            vec![event],
        );
        let source = serde_json::to_string(&report).expect("report should serialize");

        assert_eq!(report.codex.auth_path, "codex auth file (auth.json)");
        assert_eq!(report.workspace.path, "workspace ([WORKSPACE_NAME])");
        assert_eq!(report.workspace.skill_count, 1);
        assert_eq!(report.workspace.ontology_count, 1);
        assert_eq!(report.workspace.schedule_count, 1);
        assert_eq!(report.workspace.backup_count, 1);
        assert_eq!(report.workspace.backup_size_bytes, 18);
        assert_eq!(report.run_history.event_count, 1);
        assert_eq!(report.run_history.event_types.get("stdout"), Some(&1));
        assert!(source.contains("[REDACTED_OPENAI_KEY]"));
        assert!(!source.contains(sensitive_workspace_name));
        assert!(!source.contains("Super secret prompt"));
        assert!(!source.contains("previous schedules"));
        assert!(!source.contains("abcdefghijkl"));
        assert!(!source.contains(&workspace.to_string_lossy().to_string()));
        assert!(!source.contains(&home_dir().to_string_lossy().to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn renderer_cli_info_redacts_auth_path_and_untrusted_version_text() {
        let workspace = test_workspace();
        let info = renderer_cli_info(CliInfo {
            codex_available: true,
            codex_version: Some(
                "codex 0.40.0 at /Users/example/bin/codex OPENAI_API_KEY=sk-1234567890abcdefghijkl"
                    .to_string(),
            ),
            auth_path: "/Users/example/.codex/auth.json".to_string(),
            auth_exists: true,
            auth_checked: true,
            default_workspace_path: workspace.to_string_lossy().to_string(),
        });
        let source = serde_json::to_string(&info).expect("cli info should serialize");

        assert_eq!(info.auth_path, "codex auth file (auth.json)");
        assert_eq!(
            info.codex_version.as_deref(),
            Some("codex 0.40.0 at [LOCAL_PATH] OPENAI_API_KEY=[REDACTED_KEY]")
        );
        assert!(source.contains(&workspace.to_string_lossy().to_string()));
        assert!(!source.contains("/Users/example"));
        assert!(!source.contains("abcdefghijkl"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn diagnostics_report_summarizes_catalog_errors_without_file_paths() {
        let workspace = test_workspace();
        let skill_dir = workspace.join("skills").join("broken-skill");
        fs::create_dir_all(&skill_dir).expect("skill dir should be created");
        fs::write(skill_dir.join("skill.yaml"), "id: [")
            .expect("broken manifest should be written");

        let diagnostics = diagnostics_workspace(&workspace);
        let source = serde_json::to_string(&diagnostics).expect("diagnostics should serialize");

        assert_eq!(
            diagnostics.catalog_error,
            Some("Workspace catalog has errors; run health check for local details.".to_string())
        );
        assert!(!source.contains(&workspace.to_string_lossy().to_string()));
        assert!(!source.contains("skill.yaml"));
        assert!(!source.contains("broken-skill"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn artifact_command_results_label_paths_without_returning_directories() {
        let workspace = test_workspace();
        let artifact_path = PathBuf::from(
            "/Users/example/Library/Application Support/Builder Gear/diagnostics/report.json",
        );
        let diagnostics_report = diagnostics_report_from_parts(
            "0.1.0",
            parse_time("2026-06-24T00:00:00Z").expect("valid time"),
            CliInfo {
                codex_available: false,
                codex_version: None,
                auth_path: "/Users/example/.codex/auth.json".to_string(),
                auth_exists: false,
                auth_checked: true,
                default_workspace_path: workspace.to_string_lossy().to_string(),
            },
            &workspace,
            Vec::new(),
        );
        let diagnostics = DiagnosticsReportResult {
            path: diagnostics_path_label(&artifact_path, "diagnostics report"),
            path_redacted: true,
            report: diagnostics_report,
        };
        let support = SupportBundleResult {
            path: diagnostics_path_label(&artifact_path, "support bundle"),
            path_redacted: true,
            bundle: support_bundle_from_parts(
                "0.1.0",
                parse_time("2026-06-24T00:00:00Z").expect("valid time"),
                &workspace,
                diagnostics.report,
                HealthReport {
                    generated_at: "2026-06-24T00:00:00.000Z".to_string(),
                    status: "pass".to_string(),
                    checks: Vec::new(),
                },
            ),
        };
        let source = serde_json::to_string(&(
            diagnostics.path,
            diagnostics.path_redacted,
            support.path,
            support.path_redacted,
        ))
        .expect("artifact labels should serialize");

        assert!(source.contains("diagnostics report (report.json)"));
        assert!(source.contains("support bundle (report.json)"));
        assert!(source.contains("true"));
        assert!(!source.contains("/Users/example"));
        assert!(!source.contains("Application Support"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn support_bundle_combines_diagnostics_and_redacted_health() {
        let root = test_workspace();
        let workspace = root.join("Secret Client Alpha");
        fs::create_dir_all(&workspace).expect("sensitive workspace should exist");
        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("qa-plan", "QA Plan"),
            "# QA Plan",
        )
        .expect("skill should persist");
        let event = run_event(
            "run-1",
            "stdout",
            json!({
                "prompt": "Super secret prompt",
                "token": "sk-1234567890abcdefghijkl"
            }),
        );
        let diagnostics = diagnostics_report_from_parts(
            "0.1.0",
            parse_time("2026-06-24T00:00:00Z").expect("valid time"),
            CliInfo {
                codex_available: true,
                codex_version: Some("codex 0.40.0".to_string()),
                auth_path: home_dir()
                    .join(".codex/auth.json")
                    .to_string_lossy()
                    .to_string(),
                auth_exists: true,
                auth_checked: true,
                default_workspace_path: workspace.to_string_lossy().to_string(),
            },
            &workspace,
            vec![event],
        );
        let health = HealthReport {
            generated_at: "2026-06-24T00:00:00.000Z".to_string(),
            status: "fail".to_string(),
            checks: vec![
                HealthCheck {
                    id: "workspace".to_string(),
                    title: "Workspace".to_string(),
                    status: "fail".to_string(),
                    message: format!("Workspace exists at {}", workspace.to_string_lossy()),
                    action: Some(format!(
                        "Inspect {}/skills/qa-plan/skill.yaml",
                        workspace.to_string_lossy()
                    )),
                },
                HealthCheck {
                    id: "codex-auth".to_string(),
                    title: "Codex Auth".to_string(),
                    status: "fail".to_string(),
                    message: "Auth file is present at ~/.codex/auth.json OPENAI_API_KEY=sk-1234567890abcdefghijkl".to_string(),
                    action: None,
                },
            ],
        };

        let bundle = support_bundle_from_parts(
            "0.1.0",
            parse_time("2026-06-24T01:00:00Z").expect("valid time"),
            &workspace,
            diagnostics,
            health,
        );
        let source = serde_json::to_string(&bundle).expect("bundle should serialize");

        assert_eq!(bundle.schema_version, 1);
        assert!(bundle.privacy.redacted);
        assert!(!bundle.privacy.includes_auth_contents);
        assert!(!bundle.privacy.includes_raw_prompts);
        assert!(!bundle.privacy.includes_workspace_paths);
        assert!(!bundle.privacy.includes_run_payloads);
        assert!(bundle.workspace.path_redacted);
        assert_eq!(bundle.workspace.path_fingerprint.len(), 16);
        assert!(source.contains("[WORKSPACE_PATH]"));
        assert!(source.contains("[WORKSPACE_NAME]"));
        assert!(source.contains("[LOCAL_PATH]"));
        assert!(source.contains("[REDACTED_KEY]"));
        assert!(!source.contains("Super secret prompt"));
        assert!(!source.contains("abcdefghijkl"));
        assert!(!source.contains("Secret Client Alpha"));
        assert!(!source.contains("\"basename\""));
        assert!(!source.contains(&workspace.to_string_lossy().to_string()));
        assert!(!source.contains(&home_dir().to_string_lossy().to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn support_bundle_redacts_macos_var_workspace_aliases() {
        let selected_workspace = Path::new("/var/folders/xy/builder-support/Secret Client Alpha");
        let real_workspace = "/private/var/folders/xy/builder-support/Secret Client Alpha";
        let selected_from_private =
            Path::new("/private/var/folders/xy/builder-support/Secret Client Alpha");
        let visible_workspace = "/var/folders/xy/builder-support/Secret Client Alpha";

        assert_eq!(
            redact_support_bundle_text(
                &format!("Workspace exists at {real_workspace}"),
                selected_workspace
            ),
            "Workspace exists at [WORKSPACE_PATH]"
        );
        assert_eq!(
            redact_support_bundle_text(
                &format!("Workspace exists at {visible_workspace}"),
                selected_from_private
            ),
            "Workspace exists at [WORKSPACE_PATH]"
        );
        assert_eq!(
            redact_support_bundle_text(
                "External temp path: /private/var/folders/zz/other-client",
                selected_workspace
            ),
            "External temp path: [LOCAL_PATH]"
        );
    }

    #[test]
    fn support_workspace_fingerprint_matches_core_sha256_contract() {
        assert_eq!(
            support_path_fingerprint(Path::new("/tmp/Secret Client Alpha")),
            "05ad28f04de63c95"
        );
    }

    #[test]
    fn app_data_dir_rejects_existing_file_path() {
        let root = test_workspace();
        let app_data_dir = root.join("app-data");
        fs::write(&app_data_dir, "not a directory").expect("app data file should be written");

        let error =
            prepare_app_data_dir(&app_data_dir).expect_err("app data file path should be rejected");

        assert!(error.contains("app data path exists but is not a directory"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn app_data_dir_rejects_symlinked_directory() {
        let root = test_workspace();
        let outside = test_workspace();
        let app_data_link = root.join("app-data");
        symlink(&outside, &app_data_link).expect("app data symlink should be created");

        let error =
            prepare_app_data_dir(&app_data_link).expect_err("app data symlink should be rejected");

        assert!(error.contains("app data directory must not be a symlink"));
        assert!(outside.exists());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn diagnostics_dir_rejects_existing_file_path() {
        let app_data_dir = test_workspace();
        let diagnostics_path = app_data_dir.join(DIAGNOSTICS_DIR);
        fs::write(&diagnostics_path, "not a directory")
            .expect("diagnostics file should be written");

        let error = prepare_diagnostics_dir(&app_data_dir)
            .expect_err("diagnostics file path should be rejected");

        assert!(error.contains("diagnostics path exists but is not a directory"));
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[cfg(unix)]
    #[test]
    fn diagnostics_dir_rejects_symlinked_directory() {
        let app_data_dir = test_workspace();
        let outside = test_workspace();
        let outside_diagnostics = outside.join("diagnostics-target");
        fs::create_dir_all(&outside_diagnostics).expect("outside diagnostics should exist");
        symlink(&outside_diagnostics, app_data_dir.join(DIAGNOSTICS_DIR))
            .expect("diagnostics symlink should be created");

        let error = prepare_diagnostics_dir(&app_data_dir)
            .expect_err("diagnostics symlink should be rejected");

        assert!(error.contains("diagnostics directory must not be a symlink"));
        assert!(outside_diagnostics.exists());

        let _ = fs::remove_dir_all(app_data_dir);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn diagnostics_artifact_file_names_do_not_collide_for_same_timestamp() {
        let generated_at =
            parse_time("2026-06-24T01:00:00.123456789Z").expect("valid time with nanos");
        let first = diagnostics_artifact_file_name("builder-gear-diagnostics", generated_at);
        let second = diagnostics_artifact_file_name("builder-gear-diagnostics", generated_at);

        assert_ne!(first, second);
        assert!(first.starts_with("builder-gear-diagnostics-20260624T010000.123456789Z-"));
        assert!(second.starts_with("builder-gear-diagnostics-20260624T010000.123456789Z-"));
        assert!(first.ends_with(".json"));
        assert!(second.ends_with(".json"));
    }

    #[test]
    fn default_workspace_prefers_explicit_environment_path() {
        let current = PathBuf::from("/tmp/current");
        let selected = default_workspace_path_from(
            Some(current.clone()),
            PathBuf::from("/tmp/home"),
            Some(PathBuf::from("builder-work")),
        );

        assert_eq!(selected, current.join("builder-work"));
    }

    #[test]
    fn default_workspace_discovers_nearest_builder_workspace() {
        let workspace = test_workspace();
        fs::create_dir_all(workspace.join("skills")).expect("skills directory should exist");
        fs::create_dir_all(workspace.join("ontology")).expect("ontology directory should exist");
        let nested = workspace.join("apps/desktop/src-tauri");
        fs::create_dir_all(&nested).expect("nested directory should exist");

        let selected = default_workspace_path_from(Some(nested), PathBuf::from("/tmp/home"), None);

        assert_eq!(
            selected,
            fs::canonicalize(&workspace).expect("workspace should canonicalize")
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn default_workspace_falls_back_to_builder_gear_dir_under_home() {
        let current = test_workspace();
        let home = current.join("home");
        fs::create_dir_all(&home).expect("home directory should exist");
        let selected = default_workspace_path_from(Some(current.clone()), home.clone(), None);

        assert_eq!(selected, home.join(DEFAULT_WORKSPACE_DIR_NAME));

        let _ = fs::remove_dir_all(current);
    }

    #[test]
    fn prepare_workspace_creates_starter_workspace_without_overwriting_existing_files() {
        let workspace = test_workspace();
        let custom_skill_path = workspace
            .join("skills")
            .join("build-plan")
            .join("instructions.md");
        fs::create_dir_all(
            custom_skill_path
                .parent()
                .expect("instructions parent should exist"),
        )
        .expect("skill directory should exist");
        fs::write(&custom_skill_path, "# Custom Build Plan\n")
            .expect("custom instructions should be written");

        prepare_workspace(&workspace).expect("workspace should prepare");

        assert!(workspace.join("skills/build-plan/skill.yaml").is_file());
        assert!(workspace.join("ontology/builder-gear.json").is_file());
        assert!(workspace.join(".builder/schedules.json").is_file());
        assert_eq!(
            fs::read_to_string(&custom_skill_path).expect("instructions should be readable"),
            "# Custom Build Plan\n"
        );
        assert_eq!(
            discover_workspace_skills(&workspace)
                .expect("prepared skill should load")
                .len(),
            1
        );
        assert_eq!(
            discover_workspace_ontology(&workspace)
                .expect("prepared ontology should load")
                .len(),
            2
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn prepare_workspace_rejects_existing_file_path() {
        let workspace = test_workspace();
        let file_path = workspace.join("not-a-directory");
        fs::write(&file_path, "file").expect("file should be written");
        let error = prepare_workspace(&file_path).expect_err("file path should be rejected");

        assert!(error.contains("workspace path exists but is not a directory"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_workspace_rejects_symlinked_starter_files() {
        let workspace = test_workspace();
        let outside = test_workspace();
        let starter_path = workspace.join("skills/build-plan/instructions.md");
        let outside_file = outside.join("instructions.md");
        fs::create_dir_all(starter_path.parent().expect("starter parent should exist"))
            .expect("starter parent should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        fs::write(&outside_file, "# Outside\n").expect("outside file should be written");
        symlink(&outside_file, &starter_path).expect("starter symlink should be created");

        let error =
            prepare_workspace(&workspace).expect_err("symlinked starter file should be rejected");

        assert!(error.contains("starter file must not be a symlink"));
        assert_eq!(
            fs::read_to_string(&outside_file).expect("outside file should be readable"),
            "# Outside\n"
        );

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn prepare_workspace_rejects_starter_paths_that_are_directories() {
        let workspace = test_workspace();
        fs::create_dir_all(workspace.join(".builder/schedules.json"))
            .expect("starter directory should be created");

        let error =
            prepare_workspace(&workspace).expect_err("starter directory should be rejected");

        assert!(error.contains("starter path exists but is not a file"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn existing_workspace_paths_are_canonicalized() {
        let workspace = test_workspace();
        let noncanonical = workspace.join(".");

        let resolved = resolve_existing_workspace_path(
            noncanonical
                .to_str()
                .expect("workspace path should be valid UTF-8"),
        )
        .expect("workspace should resolve");

        assert_eq!(
            resolved,
            fs::canonicalize(&workspace).expect("workspace should canonicalize")
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_workspace_roots() {
        let root = test_workspace();
        let target = root.join("target-workspace");
        let link = root.join("workspace-link");
        fs::create_dir_all(&target).expect("target workspace should be created");
        symlink(&target, &link).expect("workspace symlink should be created");
        let link_text = link
            .to_str()
            .expect("workspace link should be valid UTF-8")
            .to_string();

        assert!(resolve_existing_workspace_path(&link_text)
            .expect_err("symlinked workspace should fail")
            .contains("workspace path must not be a symlink"));
        assert!(resolve_catalog_workspace_path(&link_text)
            .expect_err("symlinked catalog workspace should fail")
            .contains("workspace path must not be a symlink"));
        assert!(prepare_workspace(&link)
            .expect_err("symlinked workspace prepare should fail")
            .contains("workspace path must not be a symlink"));

        let health = workspace_health_check(&link);
        assert_eq!(health.status, "fail");
        assert!(health
            .message
            .contains("workspace path must not be a symlink"));

        let diagnostics = diagnostics_workspace(&link);
        assert!(!diagnostics.exists);
        assert_eq!(
            diagnostics.catalog_error,
            Some("Workspace catalog has errors; run health check for local details.".to_string())
        );

        let mut request = request();
        request.workspace_path = link_text;
        assert!(normalize_runnable_request(request)
            .expect_err("symlinked run workspace should fail")
            .contains("workspace path must not be a symlink"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn health_report_includes_actionable_workspace_checks() {
        let workspace = test_workspace();
        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("qa-plan", "QA Plan"),
            "# QA Plan",
        )
        .expect("skill should persist");
        write_workspace_ontology(&workspace, &[ontology_entity("goal", "Goal")])
            .expect("ontology should persist");
        write_workspace_schedules(&workspace, &[interval_schedule("run-on-start")])
            .expect("schedule should persist");

        let report = build_health_report(&workspace);

        assert!(report
            .checks
            .iter()
            .any(|check| check.id == "skills" && check.status == "pass"));
        assert!(report
            .checks
            .iter()
            .any(|check| check.id == "ontology" && check.status == "pass"));
        assert!(report
            .checks
            .iter()
            .any(|check| check.id == "schedules" && check.status == "pass"));
        assert!(report
            .checks
            .iter()
            .any(|check| check.id == "workspace-backups" && check.status == "pass"));

        let missing_report = build_health_report(&workspace.join("missing"));
        assert_eq!(missing_report.status, "fail");
        assert!(missing_report
            .checks
            .iter()
            .any(|check| check.id == "workspace" && check.action.is_some()));
        assert!(!serde_json::to_string(&missing_report)
            .expect("missing health report should serialize")
            .contains(&workspace.to_string_lossy().to_string()));

        let external_report =
            build_health_report(Path::new("/Volumes/ClientDrive/private-project"));
        let external_source = serde_json::to_string(&external_report)
            .expect("external health report should serialize");
        assert!(external_source.contains("[LOCAL_PATH]"));
        assert!(!external_source.contains("/Volumes/ClientDrive"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn backup_health_warns_when_retention_threshold_is_exceeded() {
        let workspace = test_workspace();
        let backups_dir = workspace.join(WORKSPACE_BACKUPS_DIR);
        fs::create_dir_all(&backups_dir).expect("backup directory should be created");

        for index in 0..=BACKUP_WARN_COUNT {
            let minute = index % 60;
            let backup_name =
                format!("20260624T00{minute:02}00Z-{index}-schedules-save-.builder-schedules.json");
            fs::write(backups_dir.join(backup_name), "backup").expect("backup should be written");
        }

        let check = backup_health_check(&workspace);

        assert_eq!(check.status, "warn");
        assert!(check.message.contains("51 workspace backups"));
        assert!(check
            .action
            .as_deref()
            .is_some_and(|action| action.contains("builder backups prune --keep 50")));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn health_report_passes_for_enabled_cron_schedules() {
        let workspace = test_workspace();
        write_workspace_schedules(&workspace, &[cron_schedule()])
            .expect("cron schedule should persist");

        let report = build_health_report(&workspace);
        let schedules = report
            .checks
            .iter()
            .find(|check| check.id == "schedules")
            .expect("schedules check should be present");

        assert_eq!(schedules.status, "pass");
        assert!(schedules.message.contains("1 enabled"));
        assert!(schedules.action.is_none());

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn auth_health_rejects_symlinked_auth_file() {
        let workspace = test_workspace();
        let codex_home = workspace.join(".codex-home");
        let outside = workspace.join("outside-auth").join("auth.json");
        let auth_path = codex_home.join("auth.json");
        fs::create_dir_all(&codex_home).expect("codex home should be created");
        fs::create_dir_all(outside.parent().expect("outside auth parent should exist"))
            .expect("outside directory should be created");
        fs::write(&outside, "{}").expect("outside auth should be written");
        symlink(&outside, &auth_path).expect("auth symlink should be created");

        let check = auth_health_check_for_path(&auth_path);

        assert_eq!(check.status, "fail");
        assert!(check.message.contains("must not be a symlink"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn auth_health_rejects_open_auth_permissions() {
        let workspace = test_workspace();
        let codex_home = workspace.join(".codex-home");
        let auth_path = codex_home.join("auth.json");
        fs::create_dir_all(&codex_home).expect("codex home should be created");
        fs::write(&auth_path, "{}").expect("auth should be written");

        let mut permissions = fs::metadata(&auth_path)
            .expect("auth metadata should be readable")
            .permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&auth_path, permissions).expect("open permissions should be set");

        let open_check = auth_health_check_for_path(&auth_path);
        assert_eq!(open_check.status, "fail");
        assert!(open_check.message.contains("permissions are too open"));

        let mut permissions = fs::metadata(&auth_path)
            .expect("auth metadata should be readable")
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&auth_path, permissions).expect("secure permissions should be set");

        let secure_check = auth_health_check_for_path(&auth_path);
        assert_eq!(secure_check.status, "pass");

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn prepends_and_caps_run_history() {
        let existing = (0..MAX_STORED_RUN_EVENTS)
            .map(|index| run_event(&format!("run-{index}"), "stdout", json!({ "index": index })))
            .collect();
        let events = prepend_and_cap_history(existing, run_event("new-run", "queued", json!({})));

        assert_eq!(events.len(), MAX_STORED_RUN_EVENTS);
        assert_eq!(events[0].run_id, "new-run");
        assert_eq!(events[MAX_STORED_RUN_EVENTS - 1].run_id, "run-198");
    }

    #[test]
    fn persisted_run_history_summarizes_output_payloads_without_bodies() {
        let event = run_event(
            "run-1",
            "stdout",
            Value::String("secret prompt sk-1234567890abcdefghijkl".to_string()),
        );
        let persisted = persistable_run_event(&event);
        let source = serde_json::to_string(&persisted).expect("event should serialize");

        assert_eq!(
            persisted.payload["summary"],
            "stdout payload redacted from persisted history"
        );
        assert!(persisted.payload["byteLength"].as_u64().unwrap_or_default() > 0);
        assert!(!source.contains("secret prompt"));
        assert!(!source.contains("abcdefghijkl"));
    }

    #[test]
    fn persisted_run_history_summarizes_codex_json_without_nested_payload_values() {
        let event = run_event(
            "run-1",
            "codex_event",
            json!({
                "type": "agent_message",
                "message": "Do not persist this output",
                "token": "sk-1234567890abcdefghijkl"
            }),
        );
        let persisted = persistable_run_event(&event);
        let source = serde_json::to_string(&persisted).expect("event should serialize");

        assert_eq!(persisted.payload["codexType"], "agent_message");
        assert_eq!(
            persisted.payload["summary"],
            "Codex JSON event payload redacted from persisted history"
        );
        assert!(!source.contains("Do not persist this output"));
        assert!(!source.contains("abcdefghijkl"));
    }

    #[test]
    fn persisted_run_history_redacts_error_message_paths() {
        let event = run_event(
            "run-1",
            "error",
            json!({
                "timedOut": true,
                "message": "failed at /Volumes/ClientDrive/private-project with OPENAI_API_KEY=sk-1234567890abcdefghijkl",
            }),
        );
        let persisted = persistable_run_event(&event);
        let source = serde_json::to_string(&persisted).expect("event should serialize");

        assert_eq!(persisted.payload["timedOut"], true);
        assert!(source.contains("[LOCAL_PATH]"));
        assert!(source.contains("[REDACTED_KEY]"));
        assert!(!source.contains("/Volumes/ClientDrive"));
        assert!(!source.contains("abcdefghijkl"));
    }

    #[test]
    fn persisted_run_history_omits_workspace_paths_from_queued_events() {
        let event = run_event(
            "run-1",
            "queued",
            json!({
                "workspacePath": "/Users/example/private-project",
                "sandboxMode": "workspace-write",
                "approvalMode": "never",
                "timeoutSeconds": 3600,
                "skillIds": ["build-plan"],
                "ontologyContextIds": ["goal-first-run"],
                "scheduleId": null
            }),
        );
        let persisted = persistable_run_event(&event);
        let source = serde_json::to_string(&persisted).expect("event should serialize");

        assert_eq!(persisted.payload["sandboxMode"], "workspace-write");
        assert_eq!(persisted.payload["timeoutSeconds"], 3600);
        assert_eq!(persisted.payload["skillCount"], 1);
        assert_eq!(persisted.payload["ontologyContextCount"], 1);
        assert!(persisted.payload.get("workspacePath").is_none());
        assert!(!source.contains("private-project"));
    }

    #[test]
    fn corrupt_run_history_is_quarantined_and_resets() {
        let workspace = test_workspace();
        let path = workspace.join(RUN_HISTORY_FILE);
        fs::write(&path, "{ not json").expect("corrupt run history should be written");

        let events = read_run_history_from_path(&path).expect("corrupt history should recover");
        let backups = corrupt_backups(&workspace, RUN_HISTORY_FILE);

        assert!(events.is_empty());
        assert!(!path.exists());
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read_to_string(&backups[0]).expect("backup should be readable"),
            "{ not json"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn oversized_run_history_is_quarantined_and_resets() {
        let workspace = test_workspace();
        let path = workspace.join(RUN_HISTORY_FILE);
        fs::write(&path, oversized_text_body()).expect("oversized run history should be written");

        let events = read_run_history_from_path(&path).expect("oversized history should recover");
        let backups = corrupt_backups(&workspace, RUN_HISTORY_FILE);

        assert!(events.is_empty());
        assert!(!path.exists());
        assert_eq!(backups.len(), 1);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn app_state_file_removal_deletes_regular_files() {
        let workspace = test_workspace();
        let path = workspace.join(RUN_HISTORY_FILE);
        fs::write(&path, "[]\n").expect("run history should be written");

        remove_app_state_file_if_present(&path, "run history")
            .expect("regular app state file should be removed");

        assert!(!path.exists());
        remove_app_state_file_if_present(&path, "run history").expect("missing file should be ok");

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn app_state_file_removal_rejects_symlinked_targets_without_deleting_target() {
        let workspace = test_workspace();
        let outside = test_workspace();
        let target = outside.join("outside-history.json");
        let link = workspace.join(RUN_HISTORY_FILE);
        fs::write(&target, "outside").expect("outside history should be written");
        symlink(&target, &link).expect("run history symlink should be created");

        let error = remove_app_state_file_if_present(&link, "run history")
            .expect_err("symlinked app state file should be rejected");

        assert!(error.contains("run history must not be a symlink"));
        assert!(fs::symlink_metadata(&link).is_ok());
        assert_eq!(
            fs::read_to_string(&target).expect("outside history should remain readable"),
            "outside"
        );

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn app_state_file_removal_rejects_directories() {
        let workspace = test_workspace();
        let path = workspace.join(RUN_HISTORY_FILE);
        fs::create_dir(&path).expect("directory should be created at run history path");

        let error = remove_app_state_file_if_present(&path, "run history")
            .expect_err("directory app state path should be rejected");

        assert!(error.contains("run history is not a file"));
        assert!(path.is_dir());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn corrupt_schedule_state_is_quarantined_and_defaults() {
        let workspace = test_workspace();
        let path = workspace.join(SCHEDULE_STATE_FILE);
        fs::write(&path, "{ not json").expect("corrupt schedule state should be written");

        let state =
            read_schedule_state_from_path(&path).expect("corrupt schedule state should recover");
        let backups = corrupt_backups(&workspace, SCHEDULE_STATE_FILE);

        assert!(state.last_run_at_by_key.is_empty());
        assert!(state.last_skipped_at_by_key.is_empty());
        assert!(state.last_checked_at_by_key.is_empty());
        assert!(!path.exists());
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read_to_string(&backups[0]).expect("backup should be readable"),
            "{ not json"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn oversized_schedule_state_is_quarantined_and_defaults() {
        let workspace = test_workspace();
        let path = workspace.join(SCHEDULE_STATE_FILE);
        fs::write(&path, oversized_text_body())
            .expect("oversized schedule state should be written");

        let state =
            read_schedule_state_from_path(&path).expect("oversized schedule state should recover");
        let backups = corrupt_backups(&workspace, SCHEDULE_STATE_FILE);

        assert!(state.last_run_at_by_key.is_empty());
        assert!(state.last_skipped_at_by_key.is_empty());
        assert!(state.last_checked_at_by_key.is_empty());
        assert!(!path.exists());
        assert_eq!(backups.len(), 1);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn parses_workspace_skill_manifest_yaml() {
        let manifest = parse_skill_manifest(
            r#"
id: build-plan
name: Build Plan
version: 0.1.0
occupations:
  - developer
inputsJsonSchema:
  type: object
instructionsPath: instructions.md
requiredTools:
  - codex
"#,
            Path::new("/tmp/skill.yaml"),
        )
        .expect("skill manifest should parse");

        assert_eq!(manifest.id, "build-plan");
        assert_eq!(manifest.required_tools, vec!["codex"]);
        assert_eq!(manifest.instructions_path, "instructions.md");
    }

    #[test]
    fn run_on_start_interval_schedule_runs_without_history() {
        let schedule = interval_schedule("run-on-start");
        let state = ScheduleRuntimeState::default();
        let now = parse_time("2026-06-24T00:00:00Z").expect("valid time");

        assert_eq!(
            schedule_action(&schedule, &state, "workspace::daily-plan", now, now),
            ScheduleAction::Run
        );
    }

    #[test]
    fn last_checked_without_successful_run_does_not_satisfy_run_on_start_interval() {
        let mut state = ScheduleRuntimeState::default();
        let key = "workspace::daily-plan";
        state
            .last_checked_at_by_key
            .insert(key.to_string(), "2026-06-24T00:00:00.000Z".to_string());

        let schedule = interval_schedule("run-on-start");
        let now = parse_time("2026-06-24T00:01:01Z").expect("valid time");
        let runtime_started_at = parse_time("2026-06-24T00:00:00Z").expect("valid time");

        assert_eq!(
            schedule_action(&schedule, &state, key, now, runtime_started_at),
            ScheduleAction::Run
        );
    }

    #[test]
    fn successful_schedule_completion_records_last_run() {
        let mut state = ScheduleRuntimeState::default();
        let key = "workspace::daily-plan";

        record_schedule_run_success_in_state(&mut state, key, "2026-06-24T00:01:00.000Z");

        assert_eq!(
            state.last_run_at_by_key.get(key),
            Some(&"2026-06-24T00:01:00.000Z".to_string())
        );
        assert_eq!(
            state.last_checked_at_by_key.get(key),
            Some(&"2026-06-24T00:01:00.000Z".to_string())
        );
    }

    #[test]
    fn skip_interval_schedule_marks_without_running_first_missed_job() {
        let schedule = interval_schedule("skip");
        let state = ScheduleRuntimeState::default();
        let now = parse_time("2026-06-24T00:00:00Z").expect("valid time");

        assert_eq!(
            schedule_action(&schedule, &state, "workspace::daily-plan", now, now),
            ScheduleAction::SkipAndMark
        );
    }

    #[test]
    fn active_skip_interval_runs_after_its_next_due_time() {
        let schedule = interval_schedule("skip");
        let mut state = ScheduleRuntimeState::default();
        let key = "workspace::daily-plan";
        state
            .last_skipped_at_by_key
            .insert(key.to_string(), "2026-06-24T00:00:00.000Z".to_string());
        state
            .last_checked_at_by_key
            .insert(key.to_string(), "2026-06-24T00:00:40.000Z".to_string());
        let now = parse_time("2026-06-24T00:01:01Z").expect("valid time");
        let runtime_started_at = parse_time("2026-06-23T23:59:00Z").expect("valid time");

        assert_eq!(
            schedule_action(&schedule, &state, key, now, runtime_started_at),
            ScheduleAction::Run
        );
    }

    #[test]
    fn cron_schedule_runs_in_configured_timezone() {
        let mut schedule = cron_schedule();
        schedule.missed_run_policy = "skip".to_string();
        let mut state = ScheduleRuntimeState::default();
        let key = "workspace::daily-plan";
        state
            .last_run_at_by_key
            .insert(key.to_string(), "2026-06-23T00:00:30.000Z".to_string());
        let now = parse_time("2026-06-24T00:00:30Z").expect("valid time");
        let runtime_started_at = parse_time("2026-06-24T00:00:00Z").expect("valid time");

        assert_eq!(
            schedule_action(&schedule, &state, key, now, runtime_started_at),
            ScheduleAction::Run
        );
    }

    #[test]
    fn cron_schedule_does_not_run_twice_in_same_minute() {
        let mut schedule = cron_schedule();
        schedule.missed_run_policy = "skip".to_string();
        let mut state = ScheduleRuntimeState::default();
        let key = "workspace::daily-plan";
        state
            .last_run_at_by_key
            .insert(key.to_string(), "2026-06-24T00:00:10.000Z".to_string());
        let now = parse_time("2026-06-24T00:00:45Z").expect("valid time");
        let runtime_started_at = parse_time("2026-06-24T00:00:00Z").expect("valid time");

        assert_eq!(
            schedule_action(&schedule, &state, key, now, runtime_started_at),
            ScheduleAction::Idle
        );
    }

    #[test]
    fn invalid_cron_schedule_fails_validation() {
        let mut schedule = cron_schedule();
        schedule.trigger = json!({ "kind": "cron", "expression": "61 9 * * *" });

        assert!(
            validate_schedule_spec(&schedule, Path::new("schedules.json"))
                .expect_err("invalid cron should fail")
                .contains("cron trigger must be a valid five-field expression")
        );

        schedule.trigger = json!({ "kind": "cron", "expression": "0 9 * * *" });
        schedule.timezone = "Not/AZone".to_string();
        assert!(
            validate_schedule_spec(&schedule, Path::new("schedules.json"))
                .expect_err("invalid timezone should fail")
                .contains("timezone must be a valid IANA timezone")
        );
    }

    #[test]
    fn unsafe_schedule_ids_fail_validation() {
        let mut schedule = interval_schedule("run-on-start");
        schedule.id = "nightly plan".to_string();

        assert!(
            validate_schedule_spec(&schedule, Path::new("schedules.json"))
                .expect_err("unsafe schedule id should fail")
                .contains("schedule id contains unsupported id characters")
        );
    }

    #[test]
    fn relative_schedule_workspace_resolves_against_selected_workspace() {
        let schedule = interval_schedule("run-on-start");
        let request = scheduled_run_request(&schedule, Path::new("/tmp/builder-workspace"));

        assert_eq!(request.workspace_path, "/tmp/builder-workspace");
        assert_eq!(request.schedule_id, Some("daily-plan".to_string()));
    }

    #[test]
    fn writes_workspace_schedules_as_sorted_json() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let mut second = interval_schedule("skip");
        second.id = "alpha".to_string();

        write_workspace_schedules(&workspace, &[interval_schedule("run-on-start"), second])
            .expect("schedules should persist");

        let source = fs::read_to_string(workspace_schedules_path(&workspace))
            .expect("schedules file should be readable");
        let schedules =
            serde_json::from_str::<Vec<ScheduleSpec>>(&source).expect("schedules should parse");

        assert_eq!(schedules[0].id, "alpha");
        assert_eq!(schedules[1].id, "daily-plan");
        assert!(!workspace_schedules_temp_path(&workspace_schedules_path(&workspace)).exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_duplicate_schedule_ids_before_save() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let result = write_workspace_schedules(
            &workspace,
            &[interval_schedule("skip"), interval_schedule("skip")],
        );

        assert!(result
            .expect_err("duplicate schedule ids should fail")
            .contains("duplicate schedule id"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_oversized_schedules_before_save() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let mut schedule = interval_schedule("run-on-start");
        schedule.name = oversized_text_body();

        let result = write_workspace_schedules(&workspace, &[schedule]);

        assert!(result
            .expect_err("oversized schedules should fail")
            .contains("schedules file exceeds maximum size"));
        assert!(!workspace_schedules_path(&workspace).exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn writes_workspace_ontology_as_sorted_json() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");

        write_workspace_ontology(
            &workspace,
            &[
                ontology_entity("z-goal", "Z Goal"),
                ontology_entity("a-goal", "A Goal"),
            ],
        )
        .expect("ontology should persist");

        let source = fs::read_to_string(workspace_ontology_path(&workspace))
            .expect("ontology file should be readable");
        let entities =
            serde_json::from_str::<Vec<OntologyEntity>>(&source).expect("ontology should parse");

        assert_eq!(entities[0].id, "a-goal");
        assert_eq!(entities[1].id, "z-goal");
        assert!(!workspace_ontology_temp_path(&workspace_ontology_path(&workspace)).exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_oversized_ontology_before_save() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let mut entity = ontology_entity("large-goal", "Large Goal");
        entity.properties = json!({ "body": oversized_text_body() });

        let result = write_workspace_ontology(&workspace, &[entity]);

        assert!(result
            .expect_err("oversized ontology should fail")
            .contains("ontology file exceeds maximum size"));
        assert!(!workspace_ontology_path(&workspace).exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn atomic_replace_restores_existing_file_when_replacement_fails() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let path = workspace.join("settings.json");
        let missing_temp_path = workspace.join("settings.json.tmp");
        fs::write(&path, "stable").expect("existing file should be written");

        let error = replace_existing_file_with_backup(
            &path,
            &missing_temp_path,
            "settings",
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "simulated rename failure",
            ),
        )
        .expect_err("missing temp file should fail replacement");

        assert!(error.contains("original file was restored"));
        assert_eq!(
            fs::read_to_string(&path).expect("existing file should be restored"),
            "stable"
        );
        assert!(fs::read_dir(&workspace)
            .expect("workspace should be readable")
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".replace-")));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_symlinked_target_without_replacing_it() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        let outside_file = outside.join("settings.json");
        let target_link = workspace.join("settings.json");
        fs::write(&outside_file, "outside").expect("outside file should be written");
        symlink(&outside_file, &target_link).expect("target symlink should be created");

        let error = write_text_atomic(&target_link, "replacement")
            .expect_err("symlinked target should fail");

        assert!(error.contains("target file must not be a symlink"));
        assert_eq!(
            fs::read_to_string(&outside_file).expect("outside file should be readable"),
            "outside"
        );
        assert!(fs::symlink_metadata(&target_link)
            .expect("target should still exist")
            .file_type()
            .is_symlink());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_symlinked_temp_without_following_it() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        let target = workspace.join("settings.json");
        let temp_link = workspace.join("settings.json.tmp");
        let outside_file = outside.join("temp-target.json");
        fs::write(&outside_file, "outside").expect("outside file should be written");
        symlink(&outside_file, &temp_link).expect("temporary symlink should be created");

        let error = write_text_atomic_with_temp(&target, &temp_link, "replacement")
            .expect_err("symlinked temp should fail");

        assert!(error.contains("temporary file must not be a symlink"));
        assert_eq!(
            fs::read_to_string(&outside_file).expect("outside file should be readable"),
            "outside"
        );
        assert!(!target.exists());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn restore_file_staging_rejects_symlinked_temp_without_following_it() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        let backup = workspace.join("backup.json");
        let temp_link = workspace.join("restore.tmp");
        let outside_file = outside.join("temp-target.json");
        fs::write(&backup, "backup").expect("backup should be written");
        fs::write(&outside_file, "outside").expect("outside file should be written");
        symlink(&outside_file, &temp_link).expect("temporary symlink should be created");

        let error = stage_backup_file_for_restore(&backup, &temp_link)
            .expect_err("symlinked restore temp should fail");

        assert!(error.contains("temporary file must not be a symlink"));
        assert_eq!(
            fs::read_to_string(&outside_file).expect("outside file should be readable"),
            "outside"
        );
        assert_eq!(
            fs::read_to_string(&backup).expect("backup should remain readable"),
            "backup"
        );

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn restore_file_staging_rejects_symlinked_backup_source_without_following_it() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        let backup_link = workspace.join("backup-link.json");
        let temp_path = workspace.join("restore.tmp");
        let outside_file = outside.join("outside.json");
        fs::write(&outside_file, "outside").expect("outside file should be written");
        symlink(&outside_file, &backup_link).expect("backup symlink should be created");

        let error = stage_backup_file_for_restore(&backup_link, &temp_path)
            .expect_err("symlinked backup source should fail");

        assert!(error.contains("without following symlinks"));
        assert!(!temp_path.exists());
        assert_eq!(
            fs::read_to_string(&outside_file).expect("outside file should be readable"),
            "outside"
        );

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn rejects_duplicate_ontology_ids_before_save() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let result = write_workspace_ontology(
            &workspace,
            &[
                ontology_entity("goal", "Goal"),
                ontology_entity("goal", "Duplicate Goal"),
            ],
        );

        assert!(result
            .expect_err("duplicate ontology ids should fail")
            .contains("duplicate ontology id"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn workspace_mutations_keep_recoverable_backups() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let initial_schedule = interval_schedule("run-on-start");
        let mut second_schedule = interval_schedule("run-on-start");
        second_schedule.id = "second-plan".to_string();
        second_schedule.name = "Second Plan".to_string();

        write_workspace_schedules(&workspace, std::slice::from_ref(&initial_schedule))
            .expect("initial schedules should persist");
        write_workspace_schedules(&workspace, &[initial_schedule.clone(), second_schedule])
            .expect("updated schedules should persist");
        let schedule_backup = latest_backup_containing(&workspace, "schedules-save")
            .expect("schedule backup should exist");
        let schedule_backup_source =
            fs::read_to_string(schedule_backup).expect("schedule backup should be readable");
        assert!(schedule_backup_source.contains("\"id\": \"daily-plan\""));
        assert!(!schedule_backup_source.contains("second-plan"));

        write_workspace_ontology(&workspace, &[ontology_entity("goal-first", "First Goal")])
            .expect("initial ontology should persist");
        write_workspace_ontology(
            &workspace,
            &[
                ontology_entity("goal-first", "First Goal"),
                ontology_entity("goal-second", "Second Goal"),
            ],
        )
        .expect("updated ontology should persist");
        let ontology_backup = latest_backup_containing(&workspace, "ontology-save")
            .expect("ontology backup should exist");
        let ontology_backup_source =
            fs::read_to_string(ontology_backup).expect("ontology backup should be readable");
        assert!(ontology_backup_source.contains("goal-first"));
        assert!(!ontology_backup_source.contains("goal-second"));

        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("qa-plan", "QA Plan"),
            "original instructions",
        )
        .expect("initial skill should persist");
        write_workspace_skill(
            &workspace,
            Some("qa-plan"),
            &skill_manifest("qa-plan", "QA Plan"),
            "updated instructions",
        )
        .expect("updated skill should persist");
        let skill_backup =
            latest_backup_containing(&workspace, "skill-save").expect("skill backup should exist");
        assert_eq!(
            fs::read_to_string(skill_backup.join("instructions.md"))
                .expect("skill backup instructions should be readable"),
            "original instructions"
        );

        delete_workspace_skill(&workspace, "qa-plan").expect("skill should delete");
        let delete_backup = latest_backup_containing(&workspace, "skill-delete")
            .expect("skill delete backup should exist");
        assert_eq!(
            fs::read_to_string(delete_backup.join("instructions.md"))
                .expect("delete backup instructions should be readable"),
            "updated instructions"
        );
        let summaries = list_workspace_backups(&workspace).expect("backups should list");
        let serialized = serde_json::to_string(&summaries).expect("summaries should serialize");

        assert!(summaries.len() >= 4);
        assert!(summaries
            .iter()
            .any(|backup| backup.kind == "schedules-save" && !backup.directory));
        assert!(summaries
            .iter()
            .any(|backup| backup.kind == "ontology-save" && !backup.directory));
        assert!(summaries
            .iter()
            .any(|backup| backup.kind == "skill-save" && backup.directory));
        assert!(summaries
            .iter()
            .any(|backup| backup.kind == "skill-delete" && backup.directory));
        assert!(summaries
            .iter()
            .all(|backup| backup.relative_path.starts_with(".builder/backups/")));
        assert!(!serialized.contains(&workspace.to_string_lossy().to_string()));
        assert!(!serialized.contains("original instructions"));
        assert!(!serialized.contains("updated instructions"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn restores_workspace_backup_and_preserves_pre_restore_target() {
        let workspace = test_workspace();
        let backups_dir = workspace.join(WORKSPACE_BACKUPS_DIR);
        fs::create_dir_all(&backups_dir).expect("backups directory should be created");
        fs::create_dir_all(workspace.join(".builder")).expect("builder directory should exist");
        let backup_name = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
        fs::write(backups_dir.join(backup_name), "previous schedules")
            .expect("backup should be written");
        fs::write(workspace_schedules_path(&workspace), "current schedules")
            .expect("current schedules should be written");

        let listed = list_workspace_backups(&workspace).expect("backups should list");
        assert_eq!(
            listed
                .iter()
                .find(|backup| backup.name == backup_name)
                .and_then(|backup| backup.target_relative_path.as_deref()),
            Some(".builder/schedules.json")
        );

        let result =
            restore_workspace_backup(&workspace, backup_name).expect("backup should restore");

        assert_eq!(result.target_relative_path, ".builder/schedules.json");
        assert_eq!(result.restored.name, backup_name);
        assert_eq!(
            fs::read_to_string(workspace_schedules_path(&workspace))
                .expect("restored schedules should be readable"),
            "previous schedules"
        );
        let pre_restore_backup = result
            .pre_restore_backup
            .expect("pre-restore backup should be created");
        assert_eq!(pre_restore_backup.kind, "restore-preimage");
        assert_eq!(
            fs::read_to_string(workspace.join(pre_restore_backup.relative_path))
                .expect("pre-restore backup should be readable"),
            "current schedules"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn prunes_workspace_backups_only_after_confirmation() {
        let workspace = test_workspace();
        let backups_dir = workspace.join(WORKSPACE_BACKUPS_DIR);
        fs::create_dir_all(&backups_dir).expect("backups directory should be created");
        let newest = "20260624T030000Z-3-schedules-save-.builder-schedules.json";
        let middle = "20260624T020000Z-2-schedules-save-.builder-schedules.json";
        let oldest = "20260624T010000Z-1-schedules-save-.builder-schedules.json";
        fs::write(backups_dir.join(newest), "newest").expect("newest backup should be written");
        fs::write(backups_dir.join(middle), "middle").expect("middle backup should be written");
        fs::write(backups_dir.join(oldest), "oldest").expect("oldest backup should be written");

        let preview =
            prune_workspace_backups(&workspace, 1, true).expect("prune preview should work");
        assert!(preview.dry_run);
        assert_eq!(
            preview
                .candidates
                .iter()
                .map(|backup| backup.name.as_str())
                .collect::<Vec<_>>(),
            vec![middle, oldest]
        );
        assert!(backups_dir.join(middle).exists());
        assert!(backups_dir.join(oldest).exists());

        let confirmed =
            prune_workspace_backups(&workspace, 1, false).expect("confirmed prune should work");
        assert!(!confirmed.dry_run);
        assert_eq!(
            confirmed
                .pruned
                .iter()
                .map(|backup| backup.name.as_str())
                .collect::<Vec<_>>(),
            vec![middle, oldest]
        );
        assert!(backups_dir.join(newest).exists());
        assert!(!backups_dir.join(middle).exists());
        assert!(!backups_dir.join(oldest).exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn writes_and_deletes_workspace_skill_files() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let manifest = skill_manifest("qa-plan", "QA Plan");

        write_workspace_skill(
            &workspace,
            None,
            &manifest,
            "# QA Plan\n\nVerify the build.",
        )
        .expect("skill should persist");

        let source = read_workspace_skill_source(&workspace, "qa-plan")
            .expect("written skill source should load");
        assert_eq!(source.manifest.id, "qa-plan");
        assert!(source.instructions.contains("Verify the build"));

        let manifest_path = skill_dir(&workspace, "qa-plan").join("skill.yaml");
        let loaded = parse_skill_manifest(
            &fs::read_to_string(&manifest_path).expect("written skill manifest should be readable"),
            &manifest_path,
        )
        .expect("written skill should load");
        assert_eq!(loaded.id, "qa-plan");
        assert!(skill_dir(&workspace, "qa-plan")
            .join("instructions.md")
            .exists());

        delete_workspace_skill(&workspace, "qa-plan").expect("skill should delete");
        assert!(!skill_dir(&workspace, "qa-plan").exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_skill_create_that_would_overwrite_existing_skill() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let manifest = skill_manifest("qa-plan", "QA Plan");

        write_workspace_skill(&workspace, None, &manifest, "original instructions")
            .expect("initial skill should persist");

        let error = write_workspace_skill(&workspace, None, &manifest, "overwritten instructions")
            .expect_err("duplicate create should fail");

        assert!(error.contains("skill id already exists"));
        let source = read_workspace_skill_source(&workspace, "qa-plan")
            .expect("existing skill should still load");
        assert_eq!(source.instructions, "original instructions");

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_skill_rename_that_would_overwrite_existing_skill() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("source-plan", "Source Plan"),
            "source instructions",
        )
        .expect("source skill should persist");
        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("target-plan", "Target Plan"),
            "target instructions",
        )
        .expect("target skill should persist");

        let error = write_workspace_skill(
            &workspace,
            Some("source-plan"),
            &skill_manifest("target-plan", "Renamed Plan"),
            "renamed instructions",
        )
        .expect_err("rename onto existing target should fail");

        assert!(error.contains("skill id already exists"));
        assert_eq!(
            read_workspace_skill_source(&workspace, "source-plan")
                .expect("source skill should remain")
                .instructions,
            "source instructions"
        );
        assert_eq!(
            read_workspace_skill_source(&workspace, "target-plan")
                .expect("target skill should remain")
                .instructions,
            "target instructions"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn renaming_skill_preserves_existing_skill_directory_files() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("qa-plan", "QA Plan"),
            "original instructions",
        )
        .expect("initial skill should persist");
        fs::write(skill_dir(&workspace, "qa-plan").join("notes.md"), "keep me")
            .expect("extra skill file should be written");

        write_workspace_skill(
            &workspace,
            Some("qa-plan"),
            &skill_manifest("qa-review", "QA Review"),
            "renamed instructions",
        )
        .expect("skill rename should persist");

        assert!(!skill_dir(&workspace, "qa-plan").exists());
        assert_eq!(
            read_workspace_skill_source(&workspace, "qa-review")
                .expect("renamed skill should load")
                .instructions,
            "renamed instructions"
        );
        assert_eq!(
            fs::read_to_string(skill_dir(&workspace, "qa-review").join("notes.md"))
                .expect("extra skill file should be preserved"),
            "keep me"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skills_directory_before_writing_skill() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        symlink(&outside, workspace.join("skills")).expect("skills symlink should be created");

        let error = write_workspace_skill(
            &workspace,
            None,
            &skill_manifest("qa-plan", "QA Plan"),
            "instructions",
        )
        .expect_err("symlinked skills directory should fail");

        assert!(error.contains("skills directory must not be a symlink"));
        assert!(!outside.join("qa-plan").exists());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_directory_before_deleting_skill() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(workspace.join("skills")).expect("skills directory should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        fs::write(outside.join("keep.txt"), "keep").expect("outside file should be written");
        symlink(&outside, skill_dir(&workspace, "qa-plan"))
            .expect("skill symlink should be created");

        let error = delete_workspace_skill(&workspace, "qa-plan")
            .expect_err("symlinked skill directory should fail");

        assert!(error.contains("skill directory must not be a symlink"));
        assert!(outside.join("keep.txt").exists());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_directory_during_discovery() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(workspace.join("skills")).expect("skills directory should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        fs::write(
            outside.join("skill.yaml"),
            "id: outside\nname: Outside\nversion: 0.1.0\ninstructionsPath: instructions.md\n",
        )
        .expect("outside manifest should be written");
        symlink(&outside, workspace.join("skills").join("outside"))
            .expect("skill symlink should be created");

        let error = discover_workspace_skills(&workspace)
            .expect_err("symlinked skill directory should fail catalog loading");

        assert!(error.contains("skill path must not be a symlink"));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_instruction_parent_before_reading() {
        let workspace = test_workspace();
        let outside = test_workspace();
        let skill_dir = skill_dir(&workspace, "qa-plan");
        fs::create_dir_all(&skill_dir).expect("skill directory should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        fs::write(outside.join("instructions.md"), "outside instructions")
            .expect("outside instructions should be written");
        fs::write(
            skill_dir.join("skill.yaml"),
            "id: qa-plan\nname: QA Plan\nversion: 0.1.0\ninstructionsPath: nested/instructions.md\n",
        )
        .expect("skill manifest should be written");
        symlink(&outside, skill_dir.join("nested"))
            .expect("instruction parent symlink should be created");

        let error = read_workspace_skill_source(&workspace, "qa-plan")
            .expect_err("symlinked instruction parent should fail");

        assert!(error.contains("skill instructions path must stay inside the workspace"));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_instruction_parent_before_writing() {
        let workspace = test_workspace();
        let outside = test_workspace();
        let skill_dir = skill_dir(&workspace, "qa-plan");
        fs::create_dir_all(&skill_dir).expect("skill directory should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        symlink(&outside, skill_dir.join("nested"))
            .expect("instruction parent symlink should be created");

        let error =
            prepare_skill_instruction_parent(&skill_dir, &skill_dir.join("nested/instructions.md"))
                .expect_err("symlinked instruction parent should fail");

        assert!(error.contains("skill instructions directory must not be a symlink"));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn failed_skill_instruction_parent_prepare_preserves_existing_manifest() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let mut manifest = skill_manifest("qa-plan", "QA Plan");
        write_workspace_skill(&workspace, None, &manifest, "original instructions")
            .expect("initial skill should persist");
        fs::write(
            skill_dir(&workspace, "qa-plan").join("nested"),
            "not a directory",
        )
        .expect("blocking file should be written");

        manifest.instructions_path = "nested/instructions.md".to_string();
        let error =
            write_workspace_skill(&workspace, Some("qa-plan"), &manifest, "new instructions")
                .expect_err("file parent should fail");

        assert!(error.contains("skill instructions path exists but is not a directory"));
        let manifest_source =
            fs::read_to_string(skill_dir(&workspace, "qa-plan").join("skill.yaml"))
                .expect("manifest should remain readable");
        assert!(manifest_source.contains("instructionsPath: instructions.md"));
        assert!(!manifest_source.contains("nested/instructions.md"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_ontology_directory_before_save() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        symlink(&outside, workspace.join("ontology")).expect("ontology symlink should be created");

        let error = write_workspace_ontology(&workspace, &[ontology_entity("goal", "Goal")])
            .expect_err("symlinked ontology directory should fail");

        assert!(error.contains("ontology directory must not be a symlink"));
        assert!(!outside.join("builder-gear.json").exists());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_schedules_file_during_discovery() {
        let workspace = test_workspace();
        let outside = test_workspace();
        fs::create_dir_all(workspace.join(".builder"))
            .expect("builder directory should be created");
        fs::create_dir_all(&outside).expect("outside directory should be created");
        fs::write(outside.join("schedules.json"), "[]\n")
            .expect("outside schedules should be written");
        symlink(
            outside.join("schedules.json"),
            workspace.join(".builder").join("schedules.json"),
        )
        .expect("schedules symlink should be created");

        let error = discover_workspace_schedules(&workspace)
            .expect_err("symlinked schedules file should fail catalog loading");

        assert!(error.contains("schedules file must not be a symlink"));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn rejects_unsafe_skill_paths_before_save() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let mut manifest = skill_manifest("../bad", "Bad Skill");

        assert!(
            write_workspace_skill(&workspace, None, &manifest, "instructions")
                .expect_err("unsafe id should fail")
                .contains("unsupported path characters")
        );

        for instructions_path in [
            ".",
            "../outside.md",
            "nested/../outside.md",
            "./instructions.md",
            "nested/./instructions.md",
            "/tmp/outside.md",
            "\\Users\\example\\outside.md",
            "C:\\Users\\example\\outside.md",
            "C:/Users/example/outside.md",
        ] {
            manifest = skill_manifest("safe", "Bad Path");
            manifest.instructions_path = instructions_path.to_string();
            assert!(
                write_workspace_skill(&workspace, None, &manifest, "instructions")
                    .expect_err("unsafe instructions path should fail")
                    .contains("inside the skill directory"),
                "expected unsafe instructionsPath to fail: {instructions_path}"
            );
        }

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_oversized_skill_instructions_before_save() {
        let workspace = test_workspace();
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let manifest = skill_manifest("large-skill", "Large Skill");

        let error = write_workspace_skill(&workspace, None, &manifest, &oversized_text_body())
            .expect_err("oversized instructions should fail");

        assert!(error.contains("skill instructions exceeds maximum size"));
        assert!(!skill_dir(&workspace, "large-skill").exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn unsafe_skill_manifest_id_fails_catalog_loading() {
        let workspace = mock_workspace();
        let skill_dir = workspace.join("skills").join("unsafe");
        fs::create_dir_all(&skill_dir).expect("skill directory should be created");
        fs::write(
            skill_dir.join("skill.yaml"),
            "id: ../outside\nname: Unsafe Skill\nversion: 0.1.0\ninstructionsPath: instructions.md\n",
        )
        .expect("unsafe skill manifest should be written");

        let error = discover_workspace_skills(&workspace)
            .expect_err("unsafe skill manifest should fail catalog loading");
        assert!(error.contains("id contains unsupported path characters"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_skill_manifest_fails_catalog_loading() {
        let workspace = mock_workspace();
        let skill_dir = workspace.join("skills").join("broken");
        fs::create_dir_all(&skill_dir).expect("skill directory should be created");
        fs::write(
            skill_dir.join("skill.yaml"),
            "name: Broken Skill\ninstructionsPath: instructions.md\n",
        )
        .expect("invalid skill manifest should be written");

        let error = discover_workspace_skills(&workspace)
            .expect_err("invalid skill manifest should fail catalog loading");
        assert!(
            error.contains("failed to parse skill manifest")
                || error.contains("invalid skill manifest")
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn oversized_skill_manifest_fails_catalog_loading() {
        let workspace = mock_workspace();
        let skill_dir = workspace.join("skills").join("oversized");
        fs::create_dir_all(&skill_dir).expect("skill directory should be created");
        fs::write(skill_dir.join("skill.yaml"), oversized_text_body())
            .expect("oversized manifest should be written");

        let error = discover_workspace_skills(&workspace)
            .expect_err("oversized skill manifest should fail catalog loading");
        assert!(error.contains("skill manifest exceeds maximum size"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_ontology_json_fails_catalog_loading() {
        let workspace = mock_workspace();
        let ontology_dir = workspace.join("ontology");
        fs::create_dir_all(&ontology_dir).expect("ontology directory should be created");
        fs::write(ontology_dir.join("broken.json"), "{ not json")
            .expect("invalid ontology should be written");

        let error = discover_workspace_ontology(&workspace)
            .expect_err("invalid ontology should fail catalog loading");
        assert!(error.contains("failed to parse ontology file"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_schedule_json_fails_catalog_loading() {
        let workspace = mock_workspace();
        let builder_dir = workspace.join(".builder");
        fs::create_dir_all(&builder_dir).expect("builder directory should be created");
        fs::write(builder_dir.join("schedules.json"), "{ not json")
            .expect("invalid schedules should be written");

        let error = discover_workspace_schedules(&workspace)
            .expect_err("invalid schedules should fail catalog loading");
        assert!(error.contains("failed to parse schedules file"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn parses_streaming_output_lines() {
        let json_event = event_for_output_line("run-1", "stdout", r#"{"type":"started"}"#)
            .expect("json stdout should produce an event");
        let text_event = event_for_output_line("run-1", "stdout", "plain output")
            .expect("text stdout should produce an event");
        let stderr_event = event_for_output_line(
            "run-1",
            "stderr",
            "OPENAI_API_KEY=sk-1234567890abcdefghijkl",
        )
        .expect("stderr should produce an event");

        assert_eq!(json_event.event_type, "codex_event");
        assert_eq!(json_event.payload["type"], "started");
        assert_eq!(text_event.event_type, "stdout");
        assert_eq!(stderr_event.event_type, "stderr");
        assert!(stderr_event
            .payload
            .as_str()
            .expect("stderr payload should be a string")
            .contains("[REDACTED_KEY]"));
    }

    #[test]
    fn oversized_streaming_output_is_redacted_and_truncated() {
        let oversized = format!(
            "{} OPENAI_API_KEY=sk-1234567890abcdefghijkl",
            "x".repeat(17_000)
        );
        let event = event_for_output_line("run-1", "stderr", &oversized)
            .expect("oversized stderr should produce an event");
        let payload = event
            .payload
            .as_str()
            .expect("stderr payload should be a string");

        assert!(payload.len() < oversized.len());
        assert!(payload.contains("[truncated]"));
        assert!(!payload.contains("abcdefghijkl"));
    }

    #[test]
    fn bounded_reader_redacts_secrets_split_across_chunks() {
        let reader = ChunkedReader::new(vec![
            b"OPENAI_API_KEY=sk-1234567890".to_vec(),
            b"abcdefghijkl at /Users/example/private".to_vec(),
            b"/source.ts and Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n".to_vec(),
        ]);
        let events = output_events_from_reader("run-1", "stderr", reader);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "stderr");
        let payload = events[0]
            .payload
            .as_str()
            .expect("stderr payload should be a string");
        assert!(payload.contains("[REDACTED_KEY]"));
        assert!(payload.contains("[REDACTED_BEARER_TOKEN]"));
        assert!(payload.contains("[LOCAL_PATH]"));
        assert!(!payload.contains("sk-1234567890"));
        assert!(!payload.contains("abcdefghijkl"));
        assert!(!payload.contains("/Users/example"));
        assert!(!payload.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn bounded_reader_caps_stdout_without_newline() {
        let oversized = format!(
            "OPENAI_API_KEY=sk-1234567890abcdefghijkl {}",
            "x".repeat(70_000)
        );
        let events = output_events_from_reader("run-1", "stdout", Cursor::new(oversized));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "stdout");
        let payload = events[0]
            .payload
            .as_str()
            .expect("stdout payload should be a string");
        assert!(payload.len() <= MAX_EVENT_TEXT_CHARS + TRUNCATED_EVENT_SUFFIX.len());
        assert!(payload.contains("[REDACTED_KEY]"));
        assert!(payload.contains("[truncated]"));
        assert!(!payload.contains("abcdefghijkl"));
    }

    #[test]
    fn bounded_reader_caps_stderr_without_newline() {
        let oversized = format!(
            "CODEX_API_KEY=sk-1234567890abcdefghijkl {}",
            "x".repeat(70_000)
        );
        let events = output_events_from_reader("run-1", "stderr", Cursor::new(oversized));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "stderr");
        let payload = events[0]
            .payload
            .as_str()
            .expect("stderr payload should be a string");
        assert!(payload.len() <= MAX_EVENT_TEXT_CHARS + TRUNCATED_EVENT_SUFFIX.len());
        assert!(payload.contains("[REDACTED_KEY]"));
        assert!(payload.contains("[truncated]"));
        assert!(!payload.contains("abcdefghijkl"));
    }

    #[cfg(unix)]
    #[test]
    fn spawned_mock_codex_stream_parses_process_pipes() {
        let workspace = mock_workspace();
        let (mock_codex, args_path, stdin_path) = create_mock_codex_script(&workspace);
        let mut request = request();
        request.workspace_path = workspace.to_string_lossy().to_string();
        let args = build_codex_args(&request);
        let mut child = spawn_codex_process_with_bin(
            mock_codex
                .to_str()
                .expect("mock codex path should be valid UTF-8"),
            &request.workspace_path,
            &args,
        )
        .expect("mock codex process should spawn");
        write_prompt_to_child_stdin(&mut child, &request.prompt)
            .expect("prompt should be written to mock codex stdin");

        let stdout = child.stdout.take().expect("stdout should be piped");
        let stderr = child.stderr.take().expect("stderr should be piped");
        let stdout_events = output_events_from_reader("run-1", "stdout", stdout);
        let stderr_events = output_events_from_reader("run-1", "stderr", stderr);
        let status = child.wait().expect("mock codex process should exit");

        assert!(status.success());
        let captured_args =
            fs::read_to_string(&args_path).expect("mock codex args should be captured");
        let captured_stdin =
            fs::read_to_string(&stdin_path).expect("mock codex stdin should be captured");
        assert!(captured_args.lines().any(|line| line == "-"));
        assert!(!captured_args.contains(&request.prompt));
        assert_eq!(captured_stdin, request.prompt);
        assert!(stdout_events
            .iter()
            .any(|event| event.event_type == "codex_event"));
        assert!(stdout_events
            .iter()
            .any(|event| event.event_type == "stdout"));
        assert!(stderr_events.iter().any(|event| {
            event.event_type == "stderr"
                && event
                    .payload
                    .as_str()
                    .is_some_and(|value| value.contains("[REDACTED_KEY]"))
        }));

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn spawned_codex_process_removes_builder_gear_release_env() {
        let _guard = ENV_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("environment test lock should not be poisoned");
        let workspace = mock_workspace();
        let (mock_codex, env_path) = create_mock_codex_env_script(&workspace);
        let previous_apple_password = std::env::var_os("APPLE_PASSWORD");
        let previous_apple_certificate = std::env::var_os("APPLE_CERTIFICATE");
        let previous_apple_keychain_password = std::env::var_os("APPLE_KEYCHAIN_PASSWORD");
        let previous_updater_pubkey = std::env::var_os("BUILDER_GEAR_UPDATER_PUBKEY");
        let previous_path = std::env::var_os("PATH");

        std::env::set_var("APPLE_PASSWORD", "super-secret-password");
        std::env::set_var("APPLE_CERTIFICATE", "base64-certificate-secret");
        std::env::set_var("APPLE_KEYCHAIN_PASSWORD", "keychain-secret");
        std::env::set_var("BUILDER_GEAR_UPDATER_PUBKEY", "updater-public-key");

        let result = std::panic::catch_unwind(|| {
            let mut child = spawn_codex_process_with_bin(
                mock_codex
                    .to_str()
                    .expect("mock codex env path should be valid UTF-8"),
                workspace
                    .to_str()
                    .expect("workspace path should be valid UTF-8"),
                &[],
            )
            .expect("mock codex env process should spawn");
            let status = child
                .wait()
                .expect("mock codex env process should be waitable");
            assert!(status.success());

            let captured =
                fs::read_to_string(&env_path).expect("mock codex env should be captured");
            assert!(captured.contains("APPLE_PASSWORD=\n"));
            assert!(captured.contains("APPLE_CERTIFICATE=\n"));
            assert!(captured.contains("APPLE_KEYCHAIN_PASSWORD=\n"));
            assert!(captured.contains("BUILDER_GEAR_CODEX_BIN=\n"));
            assert!(captured.contains("BUILDER_GEAR_UPDATER_PUBKEY=\n"));
            assert!(captured.contains("PATH="));
            assert!(!captured.contains("super-secret-password"));
            assert!(!captured.contains("base64-certificate-secret"));
            assert!(!captured.contains("keychain-secret"));
            assert!(!captured.contains("updater-public-key"));
        });

        restore_env_var("APPLE_PASSWORD", previous_apple_password);
        restore_env_var("APPLE_CERTIFICATE", previous_apple_certificate);
        restore_env_var("APPLE_KEYCHAIN_PASSWORD", previous_apple_keychain_password);
        restore_env_var("BUILDER_GEAR_UPDATER_PUBKEY", previous_updater_pubkey);
        restore_env_var("PATH", previous_path);
        let _ = fs::remove_dir_all(workspace);

        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
