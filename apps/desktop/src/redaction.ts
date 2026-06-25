export function redactSensitiveText(value: string): string {
  return redactLocalPaths(redactSecretLikeText(value));
}

export function redactSecretLikeText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/sess-[A-Za-z0-9_-]{16,}/g, "[REDACTED_SESSION]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{32,}|github_pat_[A-Za-z0-9_]{50,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/((?:authorization\s*:\s*)?bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED_BEARER_TOKEN]")
    .replace(/("?(?:access|refresh|id|api|session)_?token"?\s*[:=]\s*"?)([^"',}\s]+)("?)/gi, "$1[REDACTED_TOKEN]$3")
    .replace(/((?:OPENAI|CODEX|ANTHROPIC|GITHUB|TAURI|APPLE|WINDOWS|BUILDER_GEAR)_[A-Z0-9_]*(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)\S+/gi, "$1[REDACTED_KEY]");
}

export function redactLocalPaths(value: string): string {
  return value
    .replace(/file:\/\/\/[^"\s)]+/g, "[LOCAL_FILE_URL]")
    .replace(/\/(?:Users|home|tmp|var|private\/var)\/[^"\n\r\s)]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s"'(])\/[^"'\s)\n\r]+/g, "$1[LOCAL_PATH]")
    .replace(/[A-Za-z]:\\[^"\n\r)]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s"'(])~\/[^"'\s)\n\r]+/g, "$1[LOCAL_PATH]");
}

export function truncateText(value: string, maxLength: number): string {
  const truncated = Array.from(value).slice(0, maxLength).join("");
  return truncated.length === value.length ? truncated : `${truncated}...`;
}
