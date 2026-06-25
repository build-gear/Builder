import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createScheduleRunRequest,
  getDueSchedules,
  InMemoryScheduleStore,
  SCHEDULE_RUN_CLAIM_TTL_MS,
  scheduleRunClaimTtlMs,
  SqliteScheduleStore
} from "../scheduler.js";
import type { ScheduleSpec } from "../types.js";

const schedule: ScheduleSpec = {
  id: "morning-plan",
  name: "Morning Plan",
  trigger: { kind: "interval", everySeconds: 60 },
  timezone: "Asia/Seoul",
  missedRunPolicy: "run-on-start",
  enabled: true,
  runRequest: {
    workspacePath: "/workspace",
    prompt: "Plan today",
    sandboxMode: "read-only",
    approvalMode: "never"
  }
};

describe("scheduler", () => {
  it("defaults missed runs to run-on-start", () => {
    const store = new InMemoryScheduleStore();
    store.upsert(schedule);

    const due = getDueSchedules(store.list(), new Date("2026-06-23T01:00:00.000Z"), new Date("2026-06-23T00:00:00.000Z"));

    expect(due.map((item) => item.spec.id)).toEqual(["morning-plan"]);
  });

  it("persists schedules in SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);

    store.upsert(schedule);
    store.markRun(schedule.id, "2026-06-23T01:00:00.000Z");

    expect(store.get(schedule.id)?.lastRunAt).toBe("2026-06-23T01:00:00.000Z");
    expect(createScheduleRunRequest(schedule).scheduleId).toBe("morning-plan");

    store.close();
  });

  it("claims active SQLite schedule runs and releases them on terminal outcomes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-claim-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    const startedAt = "2026-06-23T01:00:00.000Z";
    const staleBefore = "2026-06-22T01:00:00.000Z";

    store.upsert(schedule);
    expect(store.tryClaimRun(schedule.id, startedAt, scheduleRunClaimTtlMs(schedule), staleBefore)).toBe(true);
    expect(store.get(schedule.id)?.runningTimeoutMs).toBe(SCHEDULE_RUN_CLAIM_TTL_MS);
    expect(store.tryClaimRun(schedule.id, "2026-06-23T01:00:01.000Z", scheduleRunClaimTtlMs(schedule), staleBefore)).toBe(false);
    expect(getDueSchedules(
      store.list(),
      new Date("2026-06-23T01:00:02.000Z"),
      new Date("2026-06-23T00:00:00.000Z")
    )).toEqual([]);

    store.clearRunClaim(schedule.id);
    expect(store.tryClaimRun(schedule.id, "2026-06-23T01:00:03.000Z", scheduleRunClaimTtlMs(schedule), staleBefore)).toBe(true);
    store.markRun(schedule.id, "2026-06-23T01:01:00.000Z");
    expect(store.get(schedule.id)?.runningStartedAt).toBeUndefined();
    expect(store.get(schedule.id)?.runningTimeoutMs).toBeUndefined();
    expect(store.get(schedule.id)?.lastRunAt).toBe("2026-06-23T01:01:00.000Z");

    store.close();
  });

  it("treats stale schedule run claims as reclaimable", () => {
    const store = new InMemoryScheduleStore();
    const now = new Date("2026-06-23T01:00:00.000Z");
    const staleStartedAt = new Date(now.getTime() - SCHEDULE_RUN_CLAIM_TTL_MS - 1000).toISOString();

    store.upsert(schedule);
    expect(store.tryClaimRun(schedule.id, staleStartedAt, scheduleRunClaimTtlMs(schedule), "2026-06-22T00:00:00.000Z")).toBe(true);
    expect(getDueSchedules(store.list(), now, new Date("2026-06-23T00:00:00.000Z")).map((item) => item.spec.id)).toEqual([schedule.id]);
    expect(store.tryClaimRun(
      schedule.id,
      now.toISOString(),
      scheduleRunClaimTtlMs(schedule),
      new Date(now.getTime() - SCHEDULE_RUN_CLAIM_TTL_MS).toISOString()
    )).toBe(true);
    expect(store.get(schedule.id)?.runningStartedAt).toBe(now.toISOString());
  });

  it("uses schedule timeoutSeconds for stale run claim detection", () => {
    const store = new InMemoryScheduleStore();
    const timedSchedule: ScheduleSpec = {
      ...schedule,
      id: "short-timeout-plan",
      runRequest: {
        ...schedule.runRequest,
        timeoutSeconds: 2
      }
    };
    const startedAt = new Date("2026-06-23T01:00:00.000Z");

    store.upsert(timedSchedule);
    expect(scheduleRunClaimTtlMs(timedSchedule)).toBe(2000);
    expect(store.tryClaimRun(
      timedSchedule.id,
      startedAt.toISOString(),
      scheduleRunClaimTtlMs(timedSchedule),
      "2026-06-23T00:59:58.000Z"
    )).toBe(true);

    expect(getDueSchedules(
      store.list(),
      new Date("2026-06-23T01:00:01.999Z"),
      new Date("2026-06-23T00:00:00.000Z")
    )).toEqual([]);
    expect(getDueSchedules(
      store.list(),
      new Date("2026-06-23T01:00:02.000Z"),
      new Date("2026-06-23T00:00:00.000Z")
    ).map((item) => item.spec.id)).toEqual([timedSchedule.id]);
  });

  it("rejects invalid last run timestamps before persistence", async () => {
    const memoryStore = new InMemoryScheduleStore();
    memoryStore.upsert(schedule);
    expect(() => memoryStore.markRun(schedule.id, "not-a-time")).toThrow("last_run_at is not an ISO timestamp");
    expect(() => memoryStore.markRun(schedule.id, "2026/06/23 01:00:00")).toThrow("last_run_at is not an ISO timestamp");

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-markrun-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.upsert(schedule);
    expect(() => store.markRun(schedule.id, "not-a-time")).toThrow("last_run_at is not an ISO timestamp");
    expect(() => store.markRun(schedule.id, "2026/06/23 01:00:00")).toThrow("last_run_at is not an ISO timestamp");
    expect(store.get(schedule.id)?.lastRunAt).toBeUndefined();
    store.close();
  });

  it("rejects non-canonical schedule claim timestamps before SQLite string comparison", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-claim-timestamp-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);

    store.upsert(schedule);
    expect(() => store.tryClaimRun(
      schedule.id,
      "2026/06/23 01:00:00",
      scheduleRunClaimTtlMs(schedule),
      "2026-06-22T01:00:00.000Z"
    )).toThrow("running_started_at is not an ISO timestamp");
    expect(() => store.tryClaimRun(
      schedule.id,
      "2026-06-23T01:00:00.000Z",
      scheduleRunClaimTtlMs(schedule),
      "2026/06/22 01:00:00"
    )).toThrow("stale_before is not an ISO timestamp");
    expect(store.get(schedule.id)?.runningStartedAt).toBeUndefined();
    store.close();
  });

  it("rejects symlinked SQLite database paths in the core store", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-outside-"));
    const outsideDb = path.join(outside, "schedules.sqlite");
    const dbLink = path.join(root, "schedules.sqlite");
    await writeFile(outsideDb, "");
    await symlink(outsideDb, dbLink);

    expect(() => new SqliteScheduleStore(dbLink)).toThrow("SQLite schedule database must not be a symlink");
  });

  it("rejects non-file SQLite database paths in the core store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-dir-"));
    const dbPath = path.join(root, "schedules.sqlite");
    await mkdir(dbPath);

    expect(() => new SqliteScheduleStore(dbPath)).toThrow("SQLite schedule database path exists but is not a file");
  });

  it("runs cron schedules in their configured timezone", () => {
    const cronSchedule: ScheduleSpec = {
      ...schedule,
      id: "weekday-cron",
      trigger: { kind: "cron", expression: "0 9 * * MON-FRI" },
      timezone: "Asia/Seoul",
      missedRunPolicy: "skip"
    };
    const store = new InMemoryScheduleStore();
    store.upsert(cronSchedule);
    store.markRun(cronSchedule.id, "2026-06-23T00:00:30.000Z");

    const due = getDueSchedules(
      store.list(),
      new Date("2026-06-24T00:00:30.000Z"),
      new Date("2026-06-24T00:00:00.000Z")
    );

    expect(due.map((item) => item.spec.id)).toEqual(["weekday-cron"]);
  });

  it("does not run a cron schedule twice in the same local minute", () => {
    const cronSchedule: ScheduleSpec = {
      ...schedule,
      id: "same-minute-cron",
      trigger: { kind: "cron", expression: "0 9 * * *" },
      timezone: "Asia/Seoul",
      missedRunPolicy: "skip"
    };
    const store = new InMemoryScheduleStore();
    store.upsert(cronSchedule);
    store.markRun(cronSchedule.id, "2026-06-24T00:00:10.000Z");

    const due = getDueSchedules(
      store.list(),
      new Date("2026-06-24T00:00:45.000Z"),
      new Date("2026-06-24T00:00:00.000Z")
    );

    expect(due).toEqual([]);
  });

  it("rejects invalid cron expressions and timezones", () => {
    const store = new InMemoryScheduleStore();

    expect(() => store.upsert({
      ...schedule,
      trigger: { kind: "cron", expression: "61 9 * * *" }
    })).toThrow("cron trigger must be a valid five-field expression");

    expect(() => store.upsert({
      ...schedule,
      trigger: { kind: "cron", expression: "0 9 * * *" },
      timezone: "Not/AZone"
    })).toThrow("timezone must be a valid IANA timezone");
  });

  it("rejects schedules with invalid run requests", () => {
    const store = new InMemoryScheduleStore();

    expect(() => store.upsert({
      ...schedule,
      runRequest: {
        ...schedule.runRequest,
        prompt: "",
        sandboxMode: "invalid" as ScheduleSpec["runRequest"]["sandboxMode"]
      }
    })).toThrow("runRequest is invalid: prompt is required");
  });

  it("rejects unsafe schedule ids before persistence", () => {
    const store = new InMemoryScheduleStore();

    expect(() => store.upsert({
      ...schedule,
      id: "nightly plan"
    })).toThrow("schedule id contains unsupported id characters");
  });

  it("reports corrupt SQLite schedule rows by id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-corrupt-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, null)")
      .run("broken-schedule", "{ not json");
    db.close();

    const reopened = new SqliteScheduleStore(dbPath);
    expect(() => reopened.list()).toThrow("stored schedule broken-schedule is invalid");
    reopened.close();
  });

  it("lists valid SQLite schedules while reporting invalid row diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-diagnostics-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, null)")
      .run("broken-schedule", "{ not json");
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, null)")
      .run(schedule.id, JSON.stringify(schedule));
    db.close();

    const reopened = new SqliteScheduleStore(dbPath);
    const diagnostics = reopened.listWithDiagnostics();

    expect(diagnostics.schedules.map((stored) => stored.spec.id)).toEqual([schedule.id]);
    expect(diagnostics.invalidRows).toEqual([
      expect.objectContaining({
        id: "broken-schedule",
        message: expect.stringContaining("stored schedule broken-schedule is invalid")
      })
    ]);
    expect(() => reopened.list()).toThrow("stored schedule broken-schedule is invalid");
    reopened.close();
  });

  it("redacts secret-shaped values from invalid SQLite row diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-diagnostics-redaction-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.close();
    const secret = "OPENAI_API_KEY=sk-1234567890abcdefghijkl";

    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, null)")
      .run("secret-shaped-error", JSON.stringify({
        ...schedule,
        id: "secret-shaped-error",
        runRequest: {
          ...schedule.runRequest,
          sandboxMode: secret
        }
      }));
    db.close();

    const reopened = new SqliteScheduleStore(dbPath);
    const diagnostics = reopened.listWithDiagnostics();

    expect(diagnostics.schedules).toEqual([]);
    expect(diagnostics.invalidRows[0]?.message).toContain("OPENAI_API_KEY=[REDACTED_KEY]");
    expect(diagnostics.invalidRows[0]?.message).not.toContain("abcdefghijkl");
    reopened.close();
  });

  it("rejects SQLite schedule rows whose primary id differs from the spec id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-id-mismatch-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, null)")
      .run("stored-id", JSON.stringify({ ...schedule, id: "embedded-id" }));
    db.close();

    const reopened = new SqliteScheduleStore(dbPath);
    expect(() => reopened.list()).toThrow("row id stored-id does not match spec id embedded-id");
    reopened.close();
  });

  it("rejects SQLite schedule rows with invalid last run timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-bad-time-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at) values (?, ?, ?)")
      .run(schedule.id, JSON.stringify(schedule), "not-a-time");
    db.close();

    const reopened = new SqliteScheduleStore(dbPath);
    expect(() => reopened.list()).toThrow("last_run_at is not an ISO timestamp");
    reopened.close();
  });

  it("rejects SQLite schedule rows with non-canonical running claim timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-schedules-bad-claim-time-"));
    const dbPath = path.join(root, "schedules.sqlite");
    const store = new SqliteScheduleStore(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("insert into schedules (id, spec_json, last_run_at, running_started_at) values (?, ?, null, ?)")
      .run(schedule.id, JSON.stringify(schedule), "2026/06/23 01:00:00");
    db.close();

    const reopened = new SqliteScheduleStore(dbPath);
    const diagnostics = reopened.listWithDiagnostics();

    expect(diagnostics.schedules).toEqual([]);
    expect(diagnostics.invalidRows[0]?.message).toContain("running_started_at is not an ISO timestamp");
    expect(() => reopened.list()).toThrow("running_started_at is not an ISO timestamp");
    reopened.close();
  });
});
