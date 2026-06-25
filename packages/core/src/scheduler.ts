import Database from "better-sqlite3";
import { lstatSync } from "node:fs";
import { redactLocalPathLikeText, redactSecretLikeText } from "./auth.js";
import type { AgentRunRequest, ScheduleSpec } from "./types.js";
import { MAX_AGENT_RUN_TIMEOUT_SECONDS, validateAgentReferenceId, validateAgentRunRequest } from "./validation.js";

const MAX_CRON_LOOKBACK_MINUTES = 366 * 24 * 60;
export const SCHEDULE_RUN_CLAIM_TTL_MS = MAX_AGENT_RUN_TIMEOUT_SECONDS * 1000;

export interface StoredSchedule {
  spec: ScheduleSpec;
  lastRunAt?: string;
  runningStartedAt?: string;
  runningTimeoutMs?: number;
}

export interface InvalidStoredScheduleRow {
  id: string;
  message: string;
}

export interface ScheduleListDiagnostics {
  schedules: StoredSchedule[];
  invalidRows: InvalidStoredScheduleRow[];
}

export interface ScheduleStore {
  upsert(spec: ScheduleSpec): Promise<void> | void;
  get(id: string): Promise<StoredSchedule | undefined> | StoredSchedule | undefined;
  list(): Promise<StoredSchedule[]> | StoredSchedule[];
  remove(id: string): Promise<void> | void;
  markRun(id: string, runAt: string): Promise<void> | void;
  tryClaimRun(id: string, startedAt: string, timeoutMs: number, staleBefore: string): Promise<boolean> | boolean;
  clearRunClaim(id: string): Promise<void> | void;
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, StoredSchedule>();

  upsert(spec: ScheduleSpec): void {
    validateScheduleSpec(spec);
    const existing = this.schedules.get(spec.id);
    this.schedules.set(spec.id, {
      spec,
      lastRunAt: existing?.lastRunAt,
      runningStartedAt: existing?.runningStartedAt,
      runningTimeoutMs: existing?.runningTimeoutMs
    });
  }

  get(id: string): StoredSchedule | undefined {
    return this.schedules.get(id);
  }

  list(): StoredSchedule[] {
    return [...this.schedules.values()].sort((left, right) => left.spec.id.localeCompare(right.spec.id));
  }

  remove(id: string): void {
    this.schedules.delete(id);
  }

  markRun(id: string, runAt: string): void {
    validateRunTimestamp(runAt, "last_run_at");
    const existing = this.schedules.get(id);
    if (existing) {
      this.schedules.set(id, {
        ...existing,
        lastRunAt: runAt,
        runningStartedAt: undefined,
        runningTimeoutMs: undefined
      });
    }
  }

  tryClaimRun(id: string, startedAt: string, timeoutMs: number, staleBefore: string): boolean {
    validateRunTimestamp(startedAt, "running_started_at");
    validateRunClaimTimeout(timeoutMs);
    validateRunTimestamp(staleBefore, "stale_before");
    const existing = this.schedules.get(id);
    if (!existing) {
      return false;
    }
    if (existing.runningStartedAt && Date.parse(existing.runningStartedAt) >= Date.parse(staleBefore)) {
      return false;
    }

    this.schedules.set(id, { ...existing, runningStartedAt: startedAt, runningTimeoutMs: timeoutMs });
    return true;
  }

  clearRunClaim(id: string): void {
    const existing = this.schedules.get(id);
    if (existing) {
      this.schedules.set(id, { ...existing, runningStartedAt: undefined, runningTimeoutMs: undefined });
    }
  }
}

export class SqliteScheduleStore implements ScheduleStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    validateSqliteScheduleDatabasePath(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      create table if not exists schedules (
        id text primary key,
        spec_json text not null,
        last_run_at text,
        running_started_at text,
        running_timeout_ms integer
      )
    `);
    this.ensureColumn("running_started_at", "text");
    this.ensureColumn("running_timeout_ms", "integer");
  }

  upsert(spec: ScheduleSpec): void {
    validateScheduleSpec(spec);
    this.db
      .prepare(
        `insert into schedules (id, spec_json, last_run_at, running_started_at, running_timeout_ms)
         values (@id, @specJson, null, null, null)
         on conflict(id) do update set spec_json = excluded.spec_json`
      )
      .run({ id: spec.id, specJson: JSON.stringify(spec) });
  }

  get(id: string): StoredSchedule | undefined {
    const row = this.db.prepare("select id, spec_json, last_run_at, running_started_at, running_timeout_ms from schedules where id = ?").get(id) as
      | ScheduleRow
      | undefined;

    return row ? storedScheduleFromRow(row) : undefined;
  }

  list(): StoredSchedule[] {
    const rows = this.db.prepare("select id, spec_json, last_run_at, running_started_at, running_timeout_ms from schedules order by id asc").all() as ScheduleRow[];

    return rows.map(storedScheduleFromRow);
  }

  listWithDiagnostics(): ScheduleListDiagnostics {
    const rows = this.db.prepare("select id, spec_json, last_run_at, running_started_at, running_timeout_ms from schedules order by id asc").all() as ScheduleRow[];
    const schedules: StoredSchedule[] = [];
    const invalidRows: InvalidStoredScheduleRow[] = [];

    for (const row of rows) {
      try {
        schedules.push(storedScheduleFromRow(row));
      } catch (error) {
        invalidRows.push({
          id: String(row.id),
          message: safeStoredScheduleErrorMessage(error)
        });
      }
    }

    return { schedules, invalidRows };
  }

  remove(id: string): void {
    this.db.prepare("delete from schedules where id = ?").run(id);
  }

  markRun(id: string, runAt: string): void {
    validateRunTimestamp(runAt, "last_run_at");
    this.db.prepare("update schedules set last_run_at = ?, running_started_at = null, running_timeout_ms = null where id = ?").run(runAt, id);
  }

  tryClaimRun(id: string, startedAt: string, timeoutMs: number, staleBefore: string): boolean {
    validateRunTimestamp(startedAt, "running_started_at");
    validateRunClaimTimeout(timeoutMs);
    validateRunTimestamp(staleBefore, "stale_before");
    const result = this.db
      .prepare(
        `update schedules
         set running_started_at = ?,
             running_timeout_ms = ?
         where id = ?
           and (running_started_at is null or running_started_at < ?)`
      )
      .run(startedAt, timeoutMs, id, staleBefore);

    return result.changes === 1;
  }

  clearRunClaim(id: string): void {
    this.db.prepare("update schedules set running_started_at = null, running_timeout_ms = null where id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(name: string, kind: string): void {
    const columns = this.db.prepare("pragma table_info(schedules)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`alter table schedules add column ${name} ${kind}`);
    }
  }
}

interface ScheduleRow {
  id: string;
  spec_json: string;
  last_run_at?: string | null;
  running_started_at?: string | null;
  running_timeout_ms?: number | null;
}

function storedScheduleFromRow(row: ScheduleRow): StoredSchedule {
  try {
    const spec = JSON.parse(row.spec_json) as ScheduleSpec;
    validateScheduleSpec(spec);
    if (spec.id !== row.id) {
      throw new Error(`row id ${row.id} does not match spec id ${spec.id}`);
    }
    if (row.last_run_at) {
      validateRunTimestamp(row.last_run_at, "last_run_at");
    }
    if (row.running_started_at) {
      validateRunTimestamp(row.running_started_at, "running_started_at");
    }
    if (row.running_timeout_ms !== null && row.running_timeout_ms !== undefined) {
      validateRunClaimTimeout(row.running_timeout_ms);
    }

    return {
      spec,
      lastRunAt: row.last_run_at ?? undefined,
      runningStartedAt: row.running_started_at ?? undefined,
      runningTimeoutMs: row.running_timeout_ms ?? undefined
    };
  } catch (error) {
    throw new Error(`stored schedule ${row.id} is invalid: ${errorMessage(error)}`);
  }
}

function validateRunTimestamp(runAt: string, label: string): void {
  if (!isCanonicalIsoTimestamp(runAt)) {
    throw new Error(`${label} is not an ISO timestamp: ${runAt}`);
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validateRunClaimTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCHEDULE_RUN_CLAIM_TTL_MS) {
    throw new Error(`running_timeout_ms must be a whole number between 1 and ${SCHEDULE_RUN_CLAIM_TTL_MS}`);
  }
}

function validateSqliteScheduleDatabasePath(dbPath: string): void {
  try {
    const metadata = lstatSync(dbPath);

    if (metadata.isSymbolicLink()) {
      throw new Error(`SQLite schedule database must not be a symlink: ${dbPath}`);
    }

    if (!metadata.isFile()) {
      throw new Error(`SQLite schedule database path exists but is not a file: ${dbPath}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

export function validateScheduleSpec(spec: ScheduleSpec): void {
  const errors: string[] = [];
  const candidate = asRecord(spec);

  if (!candidate) {
    throw new Error("schedule spec must be an object");
  }

  const id = stringValue(candidate.id);
  const name = stringValue(candidate.name);
  const timezone = stringValue(candidate.timezone);
  const missedRunPolicy = stringValue(candidate.missedRunPolicy);
  const trigger = asRecord(candidate.trigger);
  const triggerKind = stringValue(trigger?.kind);
  const runRequest = asRecord(candidate.runRequest);

  if (!id.trim()) errors.push("schedule id is required");
  else errors.push(...validateAgentReferenceId("schedule id", id));
  if (!name.trim()) errors.push("schedule name is required");
  if (!timezone.trim()) errors.push("timezone is required");
  if (!["run-on-start", "skip"].includes(missedRunPolicy)) errors.push("missedRunPolicy is invalid");
  if (!runRequest) {
    errors.push("runRequest is required");
  } else {
    errors.push(...validateAgentRunRequest(candidate.runRequest as AgentRunRequest).map((error) => `runRequest is invalid: ${error}`));
  }

  if (!["once", "interval", "cron"].includes(triggerKind)) {
    errors.push("trigger.kind is invalid");
  } else if (triggerKind === "interval") {
    const everySeconds = numberValue(trigger?.everySeconds);

    if (!Number.isInteger(everySeconds) || everySeconds < 1) {
      errors.push("interval trigger requires everySeconds >= 1");
    }
  } else if (triggerKind === "once") {
    const runAt = stringValue(trigger?.runAt);

    if (!runAt || Number.isNaN(Date.parse(runAt))) {
      errors.push("once trigger requires an ISO runAt");
    }
  } else if (triggerKind === "cron") {
    const expression = stringValue(trigger?.expression);

    if (!parseCronExpression(expression)) {
      errors.push("cron trigger must be a valid five-field expression");
    }
    if (!isValidTimeZone(timezone)) {
      errors.push("timezone must be a valid IANA timezone");
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeStoredScheduleErrorMessage(error: unknown): string {
  return redactLocalPathLikeText(redactSecretLikeText(errorMessage(error)));
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function createScheduleRunRequest(spec: ScheduleSpec): AgentRunRequest {
  return {
    ...spec.runRequest,
    scheduleId: spec.id
  };
}

export function isScheduleDue(stored: StoredSchedule, now: Date, runtimeStartedAt: Date): boolean {
  const { spec, lastRunAt } = stored;
  if (!spec.enabled) {
    return false;
  }
  if (hasActiveRunClaim(stored.runningStartedAt, now, stored.runningTimeoutMs ?? scheduleRunClaimTtlMs(spec))) {
    return false;
  }

  if (!lastRunAt && spec.missedRunPolicy === "run-on-start") {
    return true;
  }

  if (spec.trigger.kind === "once") {
    return Date.parse(spec.trigger.runAt) <= now.getTime() && !lastRunAt;
  }

  if (spec.trigger.kind === "interval") {
    const baseline = lastRunAt ? Date.parse(lastRunAt) : runtimeStartedAt.getTime();
    return now.getTime() - baseline >= spec.trigger.everySeconds * 1000;
  }

  if (spec.trigger.kind === "cron") {
    const baseline = lastRunAt ? Date.parse(lastRunAt) : runtimeStartedAt.getTime();
    const dueAt = latestCronDueAtOrBefore(spec.trigger.expression, now, spec.timezone, new Date(baseline));

    if (!dueAt) {
      return false;
    }

    return !(spec.missedRunPolicy === "skip" && dueAt.getTime() < runtimeStartedAt.getTime());
  }

  return false;
}

export function getDueSchedules(storedSchedules: StoredSchedule[], now = new Date(), runtimeStartedAt = new Date()): StoredSchedule[] {
  return storedSchedules.filter((stored) => isScheduleDue(stored, now, runtimeStartedAt));
}

export function scheduleRunClaimTtlMs(spec: ScheduleSpec, overrideTimeoutMs?: number): number {
  const timeoutMs = overrideTimeoutMs ?? (
    spec.runRequest.timeoutSeconds === undefined
      ? SCHEDULE_RUN_CLAIM_TTL_MS
      : spec.runRequest.timeoutSeconds * 1000
  );
  validateRunClaimTimeout(timeoutMs);
  return timeoutMs;
}

function hasActiveRunClaim(runningStartedAt: string | undefined, now: Date, timeoutMs: number): boolean {
  if (!runningStartedAt) {
    return false;
  }

  return now.getTime() - Date.parse(runningStartedAt) < timeoutMs;
}

interface CronExpression {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthAny: boolean;
  dayOfWeekAny: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

function latestCronDueAtOrBefore(expression: string, now: Date, timeZone: string, after: Date): Date | undefined {
  const cron = parseCronExpression(expression);
  if (!cron || !isValidTimeZone(timeZone)) {
    return undefined;
  }

  let cursor = truncateToUtcMinute(now);
  const lowerBound = truncateToUtcMinute(after);

  for (let checked = 0; checked <= MAX_CRON_LOOKBACK_MINUTES && cursor.getTime() > lowerBound.getTime(); checked += 1) {
    if (cronMatches(cron, cursor, timeZone)) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() - 60_000);
  }

  return undefined;
}

function parseCronExpression(expression: string): CronExpression | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return undefined;
  }

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12, MONTH_NAMES);
  const dayOfWeek = parseCronField(fields[4], 0, 7, DAY_NAMES, true);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthAny: dayOfMonth.any,
    dayOfWeekAny: dayOfWeek.any
  };
}

function parseCronField(
  source: string | undefined,
  min: number,
  max: number,
  aliases: Record<string, number> = {},
  normalizeSunday = false
): { values: Set<number>; any: boolean } | undefined {
  if (!source?.trim()) {
    return undefined;
  }

  const values = new Set<number>();
  const any = source === "*";

  for (const rawPart of source.split(",")) {
    const part = rawPart.trim().toLowerCase();
    if (!part) {
      return undefined;
    }

    const [rangePart, stepPart] = part.split("/");
    if (part.split("/").length > 2) {
      return undefined;
    }

    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      return undefined;
    }

    const range = parseCronRange(rangePart, min, max, aliases, normalizeSunday);
    if (!range) {
      return undefined;
    }

    for (let value = range.start; value <= range.end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }

  return values.size > 0 ? { values, any } : undefined;
}

function parseCronRange(
  source: string | undefined,
  min: number,
  max: number,
  aliases: Record<string, number>,
  normalizeSunday: boolean
): { start: number; end: number } | undefined {
  if (!source) {
    return undefined;
  }

  if (source === "*") {
    return { start: min, end: max };
  }

  const rangeParts = source.split("-");
  if (rangeParts.length === 1) {
    const value = parseCronValue(rangeParts[0], aliases, normalizeSunday);
    return value !== undefined && value >= min && value <= max ? { start: value, end: value } : undefined;
  }

  if (rangeParts.length !== 2) {
    return undefined;
  }

  const start = parseCronValue(rangeParts[0], aliases, normalizeSunday);
  const end = parseCronValue(rangeParts[1], aliases, normalizeSunday);
  if (start === undefined || end === undefined || start < min || end > max || start > end) {
    return undefined;
  }

  return { start, end };
}

function parseCronValue(source: string | undefined, aliases: Record<string, number>, normalizeSunday: boolean): number | undefined {
  if (!source) {
    return undefined;
  }

  const aliased = aliases[source];
  const value = aliased ?? Number(source);
  if (!Number.isInteger(value)) {
    return undefined;
  }

  return normalizeSunday && value === 7 ? 7 : value;
}

function cronMatches(cron: CronExpression, instant: Date, timeZone: string): boolean {
  const parts = zonedParts(instant, timeZone);
  if (!parts) {
    return false;
  }

  const dayOfMonthMatches = cron.dayOfMonth.has(parts.day);
  const dayOfWeekMatches = cron.dayOfWeek.has(parts.dayOfWeek);
  const dateMatches = cron.dayOfMonthAny && cron.dayOfWeekAny
    ? true
    : cron.dayOfMonthAny
      ? dayOfWeekMatches
      : cron.dayOfWeekAny
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches;

  return cron.minute.has(parts.minute) &&
    cron.hour.has(parts.hour) &&
    cron.month.has(parts.month) &&
    dateMatches;
}

function zonedParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const year = value("year");
    const month = value("month");
    const day = value("day");
    const hour = value("hour");
    const minute = value("minute");

    if ([year, month, day, hour, minute].some((item) => !Number.isInteger(item))) {
      return undefined;
    }

    return {
      year,
      month,
      day,
      hour: hour === 24 ? 0 : hour,
      minute,
      dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    };
  } catch {
    return undefined;
  }
}

function truncateToUtcMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 60_000) * 60_000);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
