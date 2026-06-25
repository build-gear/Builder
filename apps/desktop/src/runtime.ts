export function hasNativeBridge(target: unknown = currentWindow()): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(target, "__TAURI_INTERNALS__") ||
    Object.prototype.hasOwnProperty.call(target, "__TAURI__");
}

export function isBrowserPreviewRuntime(target: unknown = currentWindow()): boolean {
  return !hasNativeBridge(target);
}

function currentWindow(): unknown {
  return typeof window === "undefined" ? undefined : window;
}
