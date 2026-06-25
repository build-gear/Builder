import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexAuthInspection {
  codexHome: string;
  authPath: string;
  exists: boolean;
  readable: boolean;
  isFile?: boolean;
  isSymlink?: boolean;
  permissionsSecure?: boolean;
  mode?: string;
  sizeBytes?: number;
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_HOME && env.CODEX_HOME.trim().length > 0) {
    return path.resolve(env.CODEX_HOME);
  }

  return path.join(os.homedir(), ".codex");
}

export function getCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getCodexHome(env), "auth.json");
}

export async function inspectCodexAuth(env: NodeJS.ProcessEnv = process.env): Promise<CodexAuthInspection> {
  const codexHome = getCodexHome(env);
  const authPath = path.join(codexHome, "auth.json");

  try {
    const fileStat = await lstat(authPath);
    const isSymlink = fileStat.isSymbolicLink();
    const isFile = fileStat.isFile();
    let readable = false;

    if (isFile) {
      try {
        await access(authPath, constants.R_OK);
        readable = true;
      } catch {
        readable = false;
      }
    }

    return {
      codexHome,
      authPath,
      exists: true,
      readable,
      isFile,
      isSymlink,
      permissionsSecure: process.platform === "win32" ? undefined : (fileStat.mode & 0o077) === 0,
      mode: `0${(fileStat.mode & 0o777).toString(8)}`,
      sizeBytes: fileStat.size
    };
  } catch {
    return {
      codexHome,
      authPath,
      exists: false,
      readable: false
    };
  }
}

export function redactSecretLikeText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/sess-[A-Za-z0-9_-]{16,}/g, "[REDACTED_SESSION]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{32,}|github_pat_[A-Za-z0-9_]{50,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/((?:authorization\s*:\s*)?bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED_BEARER_TOKEN]")
    .replace(/("?(?:access|refresh|id|api|session)_?token"?\s*[:=]\s*"?)([^"',}\s]+)("?)/gi, "$1[REDACTED_TOKEN]$3")
    .replace(/((?:OPENAI|CODEX|ANTHROPIC|GITHUB|TAURI|APPLE|WINDOWS|BUILDER_GEAR)_[A-Z0-9_]*(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(\S+)/gi, "$1[REDACTED_KEY]");
}

export function redactLocalPathLikeText(input: string): string {
  return input
    .replace(/file:\/\/\/?[^"'\s)\n\r]+/g, "[LOCAL_FILE_URL]")
    .replace(/\/(?:Users|home|tmp|var|private\/var)\/[^"'\s)\n\r]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s"'(])\/[^"'\s)\n\r]+/g, "$1[LOCAL_PATH]")
    .replace(/[A-Za-z]:\\[^"'\s)\n\r]+/g, "[LOCAL_PATH]")
    .replace(/(^|[\s"'(])~\/[^"'\s)\n\r]+/g, "$1[LOCAL_PATH]");
}
