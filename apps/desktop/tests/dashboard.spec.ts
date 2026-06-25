import { expect, test } from "@playwright/test";

test("starts at the run dashboard and queues a local run", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByText("Preview scheduler")).toBeVisible();
  await page.getByLabel("Prompt").fill("Create the weekly build plan");
  await page.getByRole("button", { name: "Queue run" }).click();
  await expect(page.getByText("queued", { exact: true })).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Clear run event history?");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Clear events" }).click();
  await expect(page.getByText("History clear cancelled")).toBeVisible();
  await expect(page.getByText("queued", { exact: true })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Clear run event history?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Clear events" }).click();
  await expect(page.getByText("No events")).toBeVisible();
});

test("does not hide failing native bridge commands behind browser preview fallbacks", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "__builderInvokedCommands", {
      configurable: true,
      value: [],
      writable: true
    });
    const originalSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      if (timeout === 60_000 && typeof handler === "function") {
        window.setTimeout(handler, 0);
        window.setTimeout(handler, 5);
        return 1;
      }

      return originalSetInterval(handler, timeout);
    }) as typeof window.setInterval;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          (window as Window & { __builderInvokedCommands?: string[] }).__builderInvokedCommands?.push(command);
          throw new Error(`native command failed: ${command} at /Volumes/ClientDrive/private-project/skill.yaml`);
        },
        transformCallback: () => 1,
        unregisterCallback: () => undefined
      }
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: {
        unregisterListener: () => undefined
      }
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByText("Catalog error", { exact: true })).toBeVisible();
  await expect(page.getByText("/Volumes/ClientDrive")).toHaveCount(0);
  await expect(page.getByText("Scheduler offline")).toBeVisible();
  await expect(page.getByText("Browser preview")).toHaveCount(0);
  await expect(page.getByText("Preview catalog")).toHaveCount(0);
  await expect(page.getByText("Preview scheduler")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Morning Build Plan" })).toHaveCount(0);
  await page.getByRole("button", { name: "Marketplace" }).click();
  await expect(page.locator(".catalog-error pre").filter({ hasText: "[LOCAL_PATH]" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Builder Gear" }).click();
  await expect(page.locator(".event-row").filter({ hasText: "native command failed" }).first()).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "/Volumes/ClientDrive" })).toHaveCount(0);
  await expect(page.locator(".event-row").filter({ hasText: "event-bridge" }).first()).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "plugin:event|listen" }).first()).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "builder_tick_schedules" })).toHaveCount(1);
  await page.getByRole("button", { name: "Preview Invocation" }).click();
  await expect(page.getByText("Invocation preview failed")).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "builder_codex_invocation" }).first()).toBeVisible();
  await expect(page.getByText("queued", { exact: true })).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Clear run event history?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Clear events" }).click();
  await expect(page.getByText("History clear failed")).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "builder_clear_run_events" }).first()).toBeVisible();
  await page.getByLabel("Prompt").fill("Create the weekly build plan");
  await page.getByRole("button", { name: "Queue run" }).click();
  await expect(page.getByText("Event bridge unavailable")).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "unobservable run" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __builderInvokedCommands?: string[] }
  ).__builderInvokedCommands?.includes("builder_start_codex_run") ?? false)).toBe(false);
});

test("omits local paths from visible queued run event payloads", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await page.getByRole("textbox", { name: "Workspace" }).fill("/Users/example/private-project");
  await page.getByLabel("Prompt").fill("Create the weekly build plan");
  await page.getByRole("button", { name: "Queue run" }).click();

  const payload = page.locator(".event-row pre").first();
  await expect(payload).toContainText("pathRedacted");
  await expect(payload).not.toContainText("workspacePath");
  await expect(payload).not.toContainText("[LOCAL_PATH]");
  await expect(payload).not.toContainText("private-project");
});

test("surfaces redacted global runtime errors in the event log", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.evaluate(() => {
    const error = new Error("Global failure OPENAI_API_KEY=sk-1234567890abcdefghijkl");
    error.stack = [
      "Error: Global failure OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      "    at render (/Users/example/private/App.tsx:12:3)"
    ].join("\n");
    window.dispatchEvent(new ErrorEvent("error", {
      error,
      message: error.message
    }));
  });

  await expect(page.getByText("Runtime warning")).toBeVisible();
  const payload = page.locator(".event-row pre").first();
  await expect(payload).toContainText("[REDACTED_KEY]");
  await expect(payload).toContainText("[LOCAL_PATH]");
  await expect(payload).not.toContainText("abcdefghijkl");
  await expect(payload).not.toContainText("/Users/example");
});

test("recovers from malformed persisted browser state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("builder-gear.events.v1", JSON.stringify({ not: "an event array" }));
    window.localStorage.setItem("builder-gear.layout.v1", JSON.stringify({
      id: "broken",
      name: "Broken",
      version: 999,
      panels: [
        { id: "logs", visible: false },
        { id: "unknown-panel", visible: false }
      ]
    }));
    window.localStorage.setItem("builder-gear.request.v1", JSON.stringify({
      workspacePath: "/tmp/builder-workspace",
      prompt: "must not be restored",
      sandboxMode: "invalid",
      approvalMode: "on-request",
      skillIds: "invalid"
    }));
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Workspace" })).toHaveValue(".");
  await expect(page.getByRole("button", { name: "Queue run" })).toBeVisible();
  await expect(page.getByText("No events")).toBeVisible();
});

test("drops oversized persisted browser state before parsing", async ({ page }) => {
  await page.addInitScript(() => {
    const oversized = "x".repeat(600_000);
    window.localStorage.setItem("builder-gear.events.v1", JSON.stringify([{
      runId: "run-1",
      type: "stdout",
      timestamp: "2026-06-24T00:00:00.000Z",
      payload: oversized
    }]));
    window.localStorage.setItem("builder-gear.layout.v1", oversized);
    window.localStorage.setItem("builder-gear.request.v1", JSON.stringify({
      workspacePath: "/Users/example/private-client",
      prompt: oversized,
      approvalMode: "on-request"
    }));
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Workspace" })).toHaveValue(".");
  await expect(page.getByText("No events")).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("builder-gear.events.v1"))).toBe("[]");
  const storedRequest = await page.evaluate(() => window.localStorage.getItem("builder-gear.request.v1") ?? "");
  const storedLayout = await page.evaluate(() => window.localStorage.getItem("builder-gear.layout.v1") ?? "");

  expect(storedRequest).not.toContain("private-client");
  expect(storedRequest).not.toContain("x".repeat(1024));
  expect(storedLayout.length).toBeLessThan(600_000);
});

test("does not persist prompt or workspace paths in browser request storage", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByLabel("Prompt").fill("Do not persist this customer prompt");
  await page.getByRole("textbox", { name: "Workspace" }).fill("/Users/example/private-client");
  await page.getByRole("button", { name: "Queue run" }).click();
  await page.getByRole("button", { name: "Create diagnostics report" }).click();

  await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("builder-gear.request.v1") ?? "")).toContain("approvalMode");
  const storedRequest = await page.evaluate(() => window.localStorage.getItem("builder-gear.request.v1") ?? "");
  const storedEvents = await page.evaluate(() => window.localStorage.getItem("builder-gear.events.v1") ?? "");

  expect(storedRequest).not.toContain("Do not persist this customer prompt");
  expect(storedRequest).not.toContain("/Users/example/private-client");
  expect(JSON.parse(storedRequest)).not.toHaveProperty("workspacePath");
  expect(JSON.parse(storedRequest)).not.toHaveProperty("prompt");
  expect(storedEvents).not.toContain("Do not persist this customer prompt");
  expect(storedEvents).not.toContain("/Users/example/private-client");
});

test("surfaces local persistence failures without blocking the workbench", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("storage quota blocked");
      }
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByText("Local state not persisted")).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "Browser storage rejected local state persistence" })).toHaveCount(1);
  await page.getByLabel("Prompt").fill("Create the weekly build plan");
  await page.getByRole("button", { name: "Queue run" }).click();
  await expect(page.getByText("queued", { exact: true })).toBeVisible();
});

test("surfaces event history persistence failures when only event storage is rejected", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const originalSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(this: Storage, key: string, value: string) {
        if (key === "builder-gear.events.v1") {
          throw new Error("event history quota blocked");
        }

        return originalSetItem.call(this, key, value);
      }
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByText("Local state not persisted")).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "Browser storage rejected local state persistence" })).toHaveCount(1);
  await page.getByLabel("Prompt").fill("Create the weekly build plan");
  await page.getByRole("button", { name: "Queue run" }).click();
  await expect(page.getByText("queued", { exact: true })).toBeVisible();
});

test("applies layout panel visibility to the workbench", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Artifacts" })).toBeVisible();
  await page.getByRole("button", { name: "Create diagnostics report" }).click();
  await expect(page.getByLabel("Artifacts").getByText("diagnostics_preview", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Layout" }).click();
  await page.locator(".toggle-row").filter({ hasText: "Logs" }).getByRole("checkbox").click();
  await page.locator(".toggle-row").filter({ hasText: "Artifacts" }).getByRole("checkbox").click();
  await page.getByRole("button", { name: "New Agent" }).click();

  await expect(page.getByRole("heading", { name: "Artifacts" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Events" })).toHaveCount(0);
  await expect(page.getByLabel("Prompt")).toBeVisible();

  await page.getByRole("button", { name: "Layout" }).click();
  await page.locator(".toggle-row").filter({ hasText: "Runs" }).getByRole("checkbox").click();
  await page.getByRole("button", { name: "New Agent" }).click();

  await expect(page.getByText("Runs panel hidden")).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
});

test("opens workspace editing from the sidebar", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  page.once("dialog", async (dialog) => {
    await dialog.accept("/tmp/builder-workspace");
  });
  await page.getByRole("button", { name: "Open Workspace" }).click();
  await expect(page.getByRole("textbox", { name: "Workspace" })).toHaveValue("/tmp/builder-workspace");
});

test("does not fall back to browser prompt when the native workspace dialog fails", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          throw new Error(`native command failed: ${command}`);
        },
        transformCallback: () => 1,
        unregisterCallback: () => undefined
      }
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: {
        unregisterListener: () => undefined
      }
    });
    Object.defineProperty(window, "__builderPromptCalled", {
      configurable: true,
      value: false,
      writable: true
    });
    window.prompt = () => {
      (window as Window & { __builderPromptCalled?: boolean }).__builderPromptCalled = true;
      return "/tmp/should-not-be-used";
    };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Workspace" }).click();

  await expect(page.getByText("Workspace dialog failed")).toBeVisible();
  await expect(page.locator(".event-row").filter({ hasText: "native command failed" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean((
    window as Window & { __builderPromptCalled?: boolean }
  ).__builderPromptCalled))).toBe(false);
  await expect(page.getByRole("textbox", { name: "Workspace" })).not.toHaveValue("/tmp/should-not-be-used");
});

test("prepares the selected workspace from the desktop surface", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await page.getByRole("button", { name: "Prepare workspace" }).click();
  await expect(page.getByText("Workspace prepared")).toBeVisible();
  await page.getByRole("button", { name: "Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Build Plan" })).toBeVisible();
});

test("creates a diagnostics preview from the toolbar", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Create diagnostics report" }).click();
  await expect(page.getByText("Diagnostics preview created")).toBeVisible();
  await expect(page.getByText("diagnostics_preview", { exact: true })).toBeVisible();
});

test("runs a health preview from the toolbar", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Run health check" }).click();
  await expect(page.getByText("Health pass")).toBeVisible();
  await expect(page.getByText("health_preview", { exact: true })).toBeVisible();
});

test("creates a support bundle preview from the toolbar", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Create support bundle" }).click();
  await expect(page.getByText("Support bundle preview created")).toBeVisible();
  await expect(page.getByText("support_bundle_preview", { exact: true })).toBeVisible();
  await expect(page.getByText("includesRawPrompts")).toBeVisible();
});

test("checks for updates from the toolbar without installing in browser preview", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("No update available")).toBeVisible();
  await expect(page.getByText("update_check_preview", { exact: true })).toBeVisible();
});

test("lists workspace backup previews from the toolbar", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "List workspace backups" }).click();
  await expect(page.getByRole("heading", { name: "Backups", exact: true })).toBeVisible();
  await expect(page.getByText("0 backups found")).toBeVisible();
  await expect(page.getByText("No workspace backups found")).toBeVisible();
  await expect(page.getByText("0 backups loaded")).toBeVisible();
});

test("previews backup pruning from the desktop surface", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Backups", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Backups", exact: true })).toBeVisible();
  await expect(page.getByText("No workspace backups found")).toBeVisible();
  await page.getByRole("textbox", { name: "Keep newest" }).fill("1");
  await page.getByRole("button", { name: "Preview prune" }).click();
  await expect(page.locator(".backup-summary").getByText("0 prune candidates")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm prune" })).toBeDisabled();
});

test("manages schedules from the desktop surface", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await page.getByRole("button", { name: "Schedules" }).click();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Morning Build Plan" })).toBeVisible();

  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText("Schedule disabled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete schedule Morning Build Plan?");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Schedule delete cancelled")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Morning Build Plan" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete schedule Morning Build Plan?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No schedules found")).toBeVisible();
});

test("creates edits and deletes schedules", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Schedules" }).click();
  await page.getByRole("textbox", { name: "ID" }).fill("qa-schedule");
  await page.getByRole("textbox", { name: "Name" }).fill("QA Schedule");
  await page.getByRole("textbox", { name: "Every seconds" }).fill("120");
  await page.getByRole("textbox", { name: "Prompt" }).fill("Run the scheduled QA plan.");
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText("Schedule created", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "QA Schedule" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).last().click();
  await page.getByRole("textbox", { name: "Name" }).fill("QA Schedule Updated");
  await page.getByRole("textbox", { name: "Every seconds" }).fill("300");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Schedule updated", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "QA Schedule Updated" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete schedule QA Schedule Updated?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Delete" }).last().click();
  await expect(page.getByText("Schedule deleted", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "QA Schedule Updated" })).toHaveCount(0);
});

test("creates cron schedules from the desktop surface", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Schedules" }).click();
  await page.getByRole("textbox", { name: "ID" }).fill("weekday-cron");
  await page.getByRole("textbox", { name: "Name" }).fill("Weekday Cron");
  await page.getByRole("combobox", { name: "Trigger" }).selectOption("cron");
  await page.getByRole("textbox", { name: "Cron expression" }).fill("0 9 * * MON-FRI");
  await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Seoul");
  await page.getByRole("textbox", { name: "Prompt" }).fill("Run the weekday cron plan.");
  await page.getByRole("button", { name: "Create schedule" }).click();

  await expect(page.getByText("Schedule created", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Weekday Cron" })).toBeVisible();
  await expect(page.getByText("0 9 * * MON-FRI")).toBeVisible();
});

test("attaches skills and ontology context to the run request", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  await page.getByRole("button", { name: "Attach" }).first().click();
  await expect(page.getByText("Skill attached")).toBeVisible();

  await page.getByRole("button", { name: "New Agent" }).click();
  await expect(page.getByRole("button", { name: "Remove research-brief" })).toBeVisible();
  await page.getByRole("button", { name: "Remove research-brief" }).click();
  await expect(page.getByText("Skill detached")).toBeVisible();

  await page.getByRole("button", { name: "Ontology" }).click();
  await expect(page.getByRole("heading", { name: "Ontology", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use context" }).first().click();
  await expect(page.getByText("Context attached")).toBeVisible();

  await page.getByRole("button", { name: "New Agent" }).click();
  await expect(page.getByRole("button", { name: "Remove profession-builder" })).toBeVisible();
  await page.getByRole("button", { name: "Remove profession-builder" }).click();
  await expect(page.getByText("Context detached")).toBeVisible();
});

test("creates edits and deletes skills", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Marketplace" }).click();
  await page.getByRole("textbox", { name: "ID" }).fill("qa-plan");
  await page.getByRole("textbox", { name: "Name" }).fill("QA Plan");
  await page.getByRole("textbox", { name: "Occupations" }).fill("developer, tester");
  await page.getByRole("textbox", { name: "Required tools" }).fill("codex, git");
  await page.getByLabel("Instructions").fill("# QA Plan\n\nVerify the Builder Gear release.");
  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByText("Skill created")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QA Plan" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).last().click();
  await page.getByRole("textbox", { name: "Name" }).fill("QA Plan Updated");
  await page.getByRole("button", { name: "Save skill" }).click();
  await expect(page.getByText("Skill updated")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QA Plan Updated" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete skill QA Plan Updated?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Delete" }).last().click();
  await expect(page.getByText("Skill deleted")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QA Plan Updated" })).toHaveCount(0);
});

test("creates edits and deletes ontology entities", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Ontology" }).click();
  await page.getByRole("textbox", { name: "ID" }).fill("goal-service-ready");
  await page.getByRole("textbox", { name: "Label" }).fill("Service Ready Goal");
  await page.getByRole("button", { name: "Create entity" }).click();
  await expect(page.getByText("Ontology created")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Service Ready Goal" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).last().click();
  await page.getByRole("textbox", { name: "Label" }).fill("Service Ready Goal Updated");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Ontology updated")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Service Ready Goal Updated" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete ontology entity Service Ready Goal Updated?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Delete" }).last().click();
  await expect(page.getByText("Ontology deleted")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Service Ready Goal Updated" })).toHaveCount(0);
});
