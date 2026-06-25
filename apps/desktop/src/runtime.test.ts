import { describe, expect, it } from "vitest";
import { hasNativeBridge, isBrowserPreviewRuntime } from "./runtime.js";

describe("desktop runtime detection", () => {
  it("treats missing browser globals as preview mode", () => {
    expect(hasNativeBridge(undefined)).toBe(false);
    expect(hasNativeBridge({})).toBe(false);
    expect(isBrowserPreviewRuntime({})).toBe(true);
  });

  it("treats present Tauri internals as native even when bridge calls are failing", () => {
    expect(hasNativeBridge({ __TAURI_INTERNALS__: undefined })).toBe(true);
    expect(hasNativeBridge({ __TAURI_INTERNALS__: { invoke: undefined } })).toBe(true);
    expect(isBrowserPreviewRuntime({ __TAURI_INTERNALS__: { invoke: undefined } })).toBe(false);
  });

  it("supports the global Tauri object when withGlobalTauri is enabled", () => {
    expect(hasNativeBridge({ __TAURI__: { core: {} } })).toBe(true);
    expect(isBrowserPreviewRuntime({ __TAURI__: { core: {} } })).toBe(false);
  });

  it("does not trust inherited bridge markers", () => {
    const host = Object.create({ __TAURI_INTERNALS__: {} }) as object;

    expect(hasNativeBridge(host)).toBe(false);
    expect(isBrowserPreviewRuntime(host)).toBe(true);
  });
});
