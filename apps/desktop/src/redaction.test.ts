import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactSecretLikeText } from "./redaction.js";

describe("desktop redaction", () => {
  it("redacts common production secret shapes", () => {
    const githubToken = `ghp_${"a".repeat(32)}`;
    const privateKeyBlock = "-----BEGIN PRIVATE " +
      "KEY-----\nprivate-key-material\n-----END PRIVATE " +
      "KEY-----";
    const redacted = redactSecretLikeText([
      "OPENAI_API_KEY=sk-1234567890abcdefghijkl",
      'access_token:"abc123"',
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

  it("redacts local paths with secret-shaped values in one pass", () => {
    const redacted = redactSensitiveText([
      "failed at /Users/example/private/App.tsx with Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "external workspace /Volumes/ClientDrive/private-project",
      "container workspace /workspace/private-project",
      "home config ~/.codex/auth.json",
      "windows C:\\Users\\example\\AppData\\Local\\Builder\\auth.json"
    ].join("\n"));

    expect(redacted).toContain("[LOCAL_PATH]");
    expect(redacted).toContain("[REDACTED_BEARER_TOKEN]");
    expect(redacted).not.toContain("/Users/example");
    expect(redacted).not.toContain("/Volumes/ClientDrive");
    expect(redacted).not.toContain("/workspace/private-project");
    expect(redacted).not.toContain("~/.codex");
    expect(redacted).not.toContain("C:\\Users\\example");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
