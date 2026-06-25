import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface TauriConfig {
  app?: {
    security?: {
      csp?: string | null;
      devCsp?: string | null;
      freezePrototype?: boolean;
    };
  };
}

interface TauriCapability {
  permissions?: unknown[];
}

describe("desktop security configuration", () => {
  it("ships with an explicit production CSP", () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.resolve(dirname, "../src-tauri/tauri.conf.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as TauriConfig;
    const csp = config.app?.security?.csp;
    const devCsp = config.app?.security?.devCsp;

    expect(typeof csp).toBe("string");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("default-src *");
    expect(csp).not.toContain("http://127.0.0.1");
    expect(csp).not.toContain("ws://127.0.0.1");
    expect(devCsp).toContain("http://127.0.0.1:1420");
    expect(devCsp).toContain("ws://127.0.0.1:1420");
    expect(config.app?.security?.freezePrototype).toBe(true);
  });

  it("keeps Tauri frontend capabilities on least-privilege permissions", () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const capabilityPath = path.resolve(dirname, "../src-tauri/capabilities/default.json");
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as TauriCapability;

    expect(capability.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "updater:allow-check",
      "updater:allow-download-and-install"
    ]);
    expect(capability.permissions).not.toContain("core:default");
    expect(capability.permissions).not.toContain("dialog:default");
    expect(capability.permissions).not.toContain("updater:default");
    expect(capability.permissions).not.toContain("dialog:allow-open");
    expect(capability.permissions).not.toContain("dialog:allow-save");
    expect(capability.permissions).not.toContain("dialog:allow-message");
  });

  it("does not ship developer-machine workspace paths in frontend defaults", () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const appSource = readFileSync(path.resolve(dirname, "App.tsx"), "utf8");

    expect(appSource).not.toContain("/Users/");
    expect(appSource).not.toContain("C:\\Users\\");
  });

  it("does not expose the deprecated synchronous Codex run IPC command", () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const backendSource = readFileSync(path.resolve(dirname, "../src-tauri/src/main.rs"), "utf8");

    expect(backendSource).not.toContain("builder_run_codex");
    expect(backendSource).not.toContain("run_codex_once");
    expect(backendSource).toContain("builder_start_codex_run");
    expect(backendSource).toContain("builder_cancel_codex_run");
  });

  it("initializes the updater plugin without broad updater capabilities", () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const backendSource = readFileSync(path.resolve(dirname, "../src-tauri/src/main.rs"), "utf8");
    const cargoToml = readFileSync(path.resolve(dirname, "../src-tauri/Cargo.toml"), "utf8");
    const capabilityPath = path.resolve(dirname, "../src-tauri/capabilities/default.json");
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as TauriCapability;

    expect(cargoToml).toContain("tauri-plugin-updater");
    expect(backendSource).toContain("tauri_plugin_updater::Builder::new().build()");
    expect(capability.permissions).toContain("updater:allow-check");
    expect(capability.permissions).toContain("updater:allow-download-and-install");
    expect(capability.permissions).not.toContain("updater:default");
    expect(capability.permissions).not.toContain("updater:allow-download");
    expect(capability.permissions).not.toContain("updater:allow-install");
  });

  it("passes the package version into updater install policy checks", () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const appSource = readFileSync(path.resolve(dirname, "App.tsx"), "utf8");
    const viteConfig = readFileSync(path.resolve(dirname, "../vite.config.ts"), "utf8");

    expect(viteConfig).toContain("__BUILDER_GEAR_APP_VERSION__");
    expect(viteConfig).toContain("packageJson.version");
    expect(appSource).toContain("currentVersion: __BUILDER_GEAR_APP_VERSION__");
  });
});
