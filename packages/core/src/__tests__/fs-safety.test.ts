import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REGULAR_TEXT_FILE_BYTES, readRegularTextFile } from "../fs-safety.js";

describe("filesystem safety", () => {
  it("reads regular text files within the configured byte limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-fs-"));
    const file = path.join(root, "input.txt");
    await writeFile(file, "safe input");

    await expect(readRegularTextFile(file, "input")).resolves.toBe("safe input");
  });

  it("rejects oversized text files before reading them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-fs-large-"));
    const file = path.join(root, "large.txt");
    await writeFile(file, "x".repeat(MAX_REGULAR_TEXT_FILE_BYTES + 1));

    await expect(readRegularTextFile(file, "input")).rejects.toThrow(
      `input exceeds maximum size of ${MAX_REGULAR_TEXT_FILE_BYTES} bytes`
    );
  });

  it("honors custom byte limits on the file-handle read path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "builder-fs-limit-"));
    const file = path.join(root, "input.txt");
    await writeFile(file, "123456");

    await expect(readRegularTextFile(file, "input", { maxBytes: 5 })).rejects.toThrow(
      "input exceeds maximum size of 5 bytes"
    );
    await expect(readRegularTextFile(file, "input", { maxBytes: 6 })).resolves.toBe("123456");
  });

  it("rejects symlinked text files before following them", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "builder-fs-symlink-"));
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await writeFile(target, "hidden");
    await symlink(target, link);

    await expect(readRegularTextFile(link, "input")).rejects.toThrow("input must not be a symlink");
  });
});
