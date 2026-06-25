import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodexAuthPath, inspectCodexAuth, redactLocalPathLikeText, redactSecretLikeText } from "../auth.js";

describe("codex auth inspection", () => {
  it("resolves auth path from CODEX_HOME", () => {
    expect(getCodexAuthPath({ CODEX_HOME: "/tmp/custom-codex" })).toBe(path.join("/tmp/custom-codex", "auth.json"));
  });

  it("reports metadata without returning file contents", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "builder-codex-home-"));
    const authPath = path.join(codexHome, "auth.json");
    await writeFile(authPath, '{"access_token":"secret-value"}', { mode: 0o600 });

    const result = await inspectCodexAuth({ CODEX_HOME: codexHome });

    expect(result.exists).toBe(true);
    expect(result.readable).toBe(true);
    expect(result.authPath).toBe(authPath);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("rejects symlinked auth files without following the target", async () => {
    if (process.platform === "win32") {
      return;
    }

    const codexHome = await mkdtemp(path.join(os.tmpdir(), "builder-codex-home-symlink-"));
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "builder-codex-outside-")), "auth.json");
    await writeFile(outside, '{"access_token":"secret-value"}', { mode: 0o600 });
    await symlink(outside, path.join(codexHome, "auth.json"));

    const result = await inspectCodexAuth({ CODEX_HOME: codexHome });

    expect(result.exists).toBe(true);
    expect(result.readable).toBe(false);
    expect(result.isSymlink).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("reports open POSIX permissions without reading auth contents", async () => {
    if (process.platform === "win32") {
      return;
    }

    const codexHome = await mkdtemp(path.join(os.tmpdir(), "builder-codex-home-mode-"));
    const authPath = path.join(codexHome, "auth.json");
    await writeFile(authPath, '{"access_token":"secret-value"}');
    await chmod(authPath, 0o644);

    const openResult = await inspectCodexAuth({ CODEX_HOME: codexHome });
    expect(openResult.permissionsSecure).toBe(false);
    expect(openResult.mode).toBe("0644");

    await chmod(authPath, 0o600);
    await expect(inspectCodexAuth({ CODEX_HOME: codexHome })).resolves.toMatchObject({
      permissionsSecure: true,
      mode: "0600"
    });
  });

  it("redacts common secret shapes", () => {
    const githubToken = `ghp_${"a".repeat(32)}`;
    const privateKeyBlock = "-----BEGIN PRIVATE " +
      "KEY-----\nprivate-key-material\n-----END PRIVATE " +
      "KEY-----";
    const redacted = redactSecretLikeText([
      'OPENAI_API_KEY=sk-1234567890abcdefghijkl access_token:"abc123"',
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      `github token ${githubToken}`,
      "TAURI_SIGNING_PRIVATE_KEY=base64-signing-key-material",
      privateKeyBlock
    ].join("\n"));

    expect(redacted).toContain("[REDACTED_KEY]");
    expect(redacted).toContain("[REDACTED_TOKEN]");
    expect(redacted).toContain("[REDACTED_BEARER_TOKEN]");
    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
    expect(redacted).not.toContain("abcdefghijkl");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("private-key-material");
  });

  it("redacts local path shapes without reading the files", () => {
    const redacted = redactLocalPathLikeText([
      "workspace path must not be a symlink: /Users/example/private workspace",
      "external workspace failed: /Volumes/Client Drive/builder/workspace",
      "container workspace failed: /workspace/private/project",
      "prompt file is missing: file:///Users/example/private/prompt.txt",
      "windows path failed: C:\\Users\\example\\AppData\\Local\\Builder\\auth.json",
      "home path failed: ~/.codex/auth.json"
    ].join("\n"));

    expect(redacted).toContain("[LOCAL_PATH]");
    expect(redacted).toContain("[LOCAL_FILE_URL]");
    expect(redacted).not.toContain("/Users/example");
    expect(redacted).not.toContain("/Volumes/Client");
    expect(redacted).not.toContain("/workspace/private");
    expect(redacted).not.toContain("C:\\Users\\example");
    expect(redacted).not.toContain("~/.codex");
  });
});
