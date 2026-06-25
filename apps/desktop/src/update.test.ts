import { describe, expect, it, vi } from "vitest";
import {
  isUpdaterConfigurationError,
  runUpdaterFlow,
  updaterErrorMessage,
  updaterMetadataText,
  type UpdaterArtifactPayload
} from "./update.js";

describe("updater error classification", () => {
  it("recognizes updater builds without configured endpoints", () => {
    expect(isUpdaterConfigurationError(new Error("updater endpoint is not configured"))).toBe(true);
    expect(isUpdaterConfigurationError("bundle.updater configuration missing")).toBe(true);
  });

  it("recognizes missing updater public key errors", () => {
    expect(isUpdaterConfigurationError({ message: "missing updater pubkey" })).toBe(true);
    expect(isUpdaterConfigurationError("Updater public key is required")).toBe(true);
  });

  it("does not hide runtime update failures as configuration gaps", () => {
    expect(isUpdaterConfigurationError(new Error("updater request timed out"))).toBe(false);
    expect(isUpdaterConfigurationError(new Error("failed to connect to update endpoint"))).toBe(false);
    expect(isUpdaterConfigurationError(new Error("download signature verification failed"))).toBe(false);
  });

  it("extracts a stable display message from thrown values", () => {
    expect(updaterErrorMessage(new Error("boom"))).toBe("boom");
    expect(updaterErrorMessage("plain")).toBe("plain");
    expect(updaterErrorMessage({ code: "missing", message: "missing updater pubkey" })).toContain(
      "missing updater pubkey"
    );
  });

  it("redacts secrets and local paths before returning updater errors", () => {
    const message = updaterErrorMessage([
      "updater failed OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      "    at update (file:///Users/example/private/update.ts:1:1)",
      "    at windows (C:\\Users\\example\\AppData\\Local\\Builder\\update.ts:1:1)"
    ].join("\n"));

    expect(message).toContain("[REDACTED_KEY]");
    expect(message).toContain("[LOCAL_FILE_URL]");
    expect(message).toContain("[LOCAL_PATH]");
    expect(message).not.toContain("/Users/example");
    expect(message).not.toContain("C:\\Users\\example");
    expect(message).not.toContain("abcdefghijkl");
  });

  it("redacts and bounds updater metadata before display", () => {
    const version = updaterMetadataText(
      "2.0.0 OPENAI_API_KEY=sk-1234567890abcdefghijkl at /Users/example/private/update.json",
      "unknown",
      80
    );

    expect(version).toContain("[REDACTED_KEY]");
    expect(version).toContain("[LOCAL_PATH]");
    expect(version.length).toBeLessThanOrEqual(83);
    expect(version).not.toContain("/Users/example");
    expect(version).not.toContain("abcdefghijkl");
    expect(updaterMetadataText({ version: "2.0.0" }, "unknown")).toBe("unknown");
  });

  it("does not install an available update until the user confirms", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const artifacts: UpdaterArtifactPayload[] = [];
    const result = await runUpdaterFlow({
      check: async () => ({
        version: "2.0.0",
        date: "2026-06-25",
        downloadAndInstall
      }),
      currentVersion: "0.1.0",
      confirmInstall: (message) => {
        expect(message).toBe("Install Builder Gear update 2.0.0?");
        return false;
      },
      onArtifact: (payload) => artifacts.push(payload)
    });

    expect(result).toEqual({ status: "Update 2.0.0 available" });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(artifacts).toEqual([
      {
        kind: "update_available",
        available: true,
        version: "2.0.0",
        date: "2026-06-25"
      }
    ]);
  });

  it("installs only after confirmation and emits install progress", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const artifacts: UpdaterArtifactPayload[] = [];
    const statuses: string[] = [];
    const result = await runUpdaterFlow({
      check: async () => ({
        version: "2.0.1",
        date: "2026-06-25",
        downloadAndInstall
      }),
      currentVersion: "0.1.0",
      confirmInstall: () => true,
      onArtifact: (payload) => artifacts.push(payload),
      onStatus: (status) => statuses.push(status)
    });

    expect(result).toEqual({ status: "Update installed; restart app" });
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["Installing update"]);
    expect(artifacts).toEqual([
      {
        kind: "update_available",
        available: true,
        version: "2.0.1",
        date: "2026-06-25"
      },
      {
        kind: "update_installed",
        version: "2.0.1"
      }
    ]);
  });

  it("rejects non-upgrade candidates before asking for install confirmation", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const confirmInstall = vi.fn(() => true);
    const artifacts: UpdaterArtifactPayload[] = [];
    const result = await runUpdaterFlow({
      check: async () => ({
        version: "0.1.0",
        date: "2026-06-25",
        downloadAndInstall
      }),
      currentVersion: "0.1.0",
      confirmInstall,
      onArtifact: (payload) => artifacts.push(payload)
    });

    expect(result).toEqual({ status: "Update version is not newer" });
    expect(confirmInstall).not.toHaveBeenCalled();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(artifacts).toEqual([
      {
        kind: "update_available",
        available: true,
        version: "0.1.0",
        date: "2026-06-25"
      },
      {
        kind: "update_rejected",
        available: true,
        reason: "not_newer",
        version: "0.1.0",
        currentVersion: "0.1.0"
      }
    ]);
  });

  it("rejects malformed update versions before asking for install confirmation", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const confirmInstall = vi.fn(() => true);
    const artifacts: UpdaterArtifactPayload[] = [];
    const result = await runUpdaterFlow({
      check: async () => ({
        version: "latest",
        date: "2026-06-25",
        downloadAndInstall
      }),
      currentVersion: "0.1.0",
      confirmInstall,
      onArtifact: (payload) => artifacts.push(payload)
    });

    expect(result).toEqual({ status: "Update version invalid" });
    expect(confirmInstall).not.toHaveBeenCalled();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(artifacts.at(-1)).toEqual({
      kind: "update_rejected",
      available: true,
      reason: "invalid_version",
      version: "latest",
      currentVersion: "0.1.0"
    });
  });

  it("uses semantic prerelease ordering for update candidates", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const result = await runUpdaterFlow({
      check: async () => ({
        version: "1.0.0",
        date: "2026-06-25",
        downloadAndInstall
      }),
      currentVersion: "1.0.0-rc.2",
      confirmInstall: () => true
    });

    expect(result).toEqual({ status: "Update installed; restart app" });
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable updater configuration without treating it as a runtime failure", async () => {
    const artifacts: UpdaterArtifactPayload[] = [];
    const result = await runUpdaterFlow({
      check: async () => {
        throw new Error("bundle.updater configuration missing");
      },
      confirmInstall: () => {
        throw new Error("confirm should not be called");
      },
      onArtifact: (payload) => artifacts.push(payload)
    });

    expect(result).toEqual({ status: "Updates not configured" });
    expect(artifacts).toEqual([
      {
        kind: "update_unavailable",
        available: false,
        reason: "not_configured"
      }
    ]);
  });

  it("reports install failures separately while keeping update availability evidence", async () => {
    const artifacts: UpdaterArtifactPayload[] = [];
    const result = await runUpdaterFlow({
      check: async () => ({
        version: "2.0.2",
        date: "2026-06-25",
        downloadAndInstall: async () => {
          throw new Error("download signature verification failed at /Users/example/update.sig");
        }
      }),
      confirmInstall: () => true,
      onArtifact: (payload) => artifacts.push(payload)
    });

    expect(result.status).toBe("Update install failed");
    expect(result.error).toContain("download signature verification failed");
    expect(result.error).toContain("[LOCAL_PATH]");
    expect(result.error).not.toContain("/Users/example");
    expect(artifacts).toEqual([
      {
        kind: "update_available",
        available: true,
        version: "2.0.2",
        date: "2026-06-25"
      }
    ]);
  });
});
