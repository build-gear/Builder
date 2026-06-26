import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareStableUpdaterFeeds } from "../release-check.js";
import { spawnTsx } from "./script-test-utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptFixtureDir = path.join(rootDir, "apps/desktop/src-tauri/target/release-updater-script-test");

describe("stable updater verification script", () => {
  afterEach(() => {
    rmSync(scriptFixtureDir, { recursive: true, force: true });
  });

  it("compares hosted updater feeds by semantic fields instead of JSON key order", () => {
    expect(compareStableUpdaterFeeds({
      endpoint: "https://updates.buildergear.app/builder-gear-updater-latest.json",
      localFeed: {
        version: "0.1.0",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
          },
          "linux-x86_64": {
            signature: "linux-signed",
            url: "https://updates.buildergear.app/Builder%20Gear.AppImage"
          }
        }
      },
      hostedFeed: {
        pub_date: "2026-06-24T00:00:00.000Z",
        notes: "Builder Gear 0.1.0",
        version: "0.1.0",
        platforms: {
          "linux-x86_64": {
            url: "https://updates.buildergear.app/Builder%20Gear.AppImage",
            signature: "linux-signed"
          },
          "darwin-aarch64": {
            url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz",
            signature: "signed"
          }
        }
      }
    })).toEqual([]);
  });

  it("reports updater feed field and platform mismatches", () => {
    expect(compareStableUpdaterFeeds({
      endpoint: "https://updates.buildergear.app/builder-gear-updater-latest.json",
      localFeed: {
        version: "0.1.0",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
          }
        }
      },
      hostedFeed: {
        version: "0.1.1",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        platforms: {
          "linux-x86_64": {
            signature: "linux-signed",
            url: "https://updates.buildergear.app/Builder%20Gear.AppImage"
          }
        }
      }
    })).toEqual([
      "hosted stable updater feed field mismatch version: https://updates.buildergear.app/builder-gear-updater-latest.json",
      "hosted stable updater feed is missing platform entry darwin-aarch64: https://updates.buildergear.app/builder-gear-updater-latest.json",
      "hosted stable updater feed has unexpected platform entry linux-x86_64: https://updates.buildergear.app/builder-gear-updater-latest.json"
    ]);
  });

  it("rejects unexpected hosted updater feed fields", () => {
    expect(compareStableUpdaterFeeds({
      endpoint: "https://updates.buildergear.app/builder-gear-updater-latest.json",
      localFeed: {
        version: "0.1.0",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
          }
        }
      },
      hostedFeed: {
        version: "0.1.0",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        channel: "stable",
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            size: 12345,
            url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
          }
        }
      } as unknown as Parameters<typeof compareStableUpdaterFeeds>[0]["hostedFeed"]
    })).toEqual([
      "hosted stable updater feed has unexpected field channel: https://updates.buildergear.app/builder-gear-updater-latest.json",
      "hosted stable updater feed platform darwin-aarch64 has unexpected field size: https://updates.buildergear.app/builder-gear-updater-latest.json"
    ]);
  });

  it("reports malformed updater feed objects without throwing", () => {
    expect(compareStableUpdaterFeeds({
      endpoint: "https://updates.buildergear.app/builder-gear-updater-latest.json",
      localFeed: {
        version: "0.1.0",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
          }
        }
      },
      hostedFeed: {
        version: "0.1.0",
        notes: "Builder Gear 0.1.0",
        pub_date: "2026-06-24T00:00:00.000Z",
        platforms: {
          "darwin-aarch64": []
        }
      } as unknown as Parameters<typeof compareStableUpdaterFeeds>[0]["hostedFeed"]
    })).toEqual(expect.arrayContaining([
      "hosted stable updater feed platform darwin-aarch64 must be an object: https://updates.buildergear.app/builder-gear-updater-latest.json",
      "hosted stable updater feed field mismatch platforms.darwin-aarch64.url: https://updates.buildergear.app/builder-gear-updater-latest.json",
      "hosted stable updater feed field mismatch platforms.darwin-aarch64.signature: https://updates.buildergear.app/builder-gear-updater-latest.json"
    ]));
  });

  it("rejects symlinked release manifests before reading the target", () => {
    if (process.platform === "win32") {
      return;
    }

    mkdirSync(scriptFixtureDir, { recursive: true });
    const targetPath = path.join(scriptFixtureDir, "secret-target.json");
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(targetPath, "{\"secret\":\"super-secret-updater-target\"}\n");
    symlinkSync(targetPath, manifestPath);

    const result = spawnTsx(["scripts/verify-stable-updater.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release manifest must not be a symlink");
    expect(output).not.toContain("super-secret-updater-target");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("at ");
  });

  it("requires a stable distribution manifest", () => {
    mkdirSync(scriptFixtureDir, { recursive: true });
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      mode: "debug",
      channel: undefined,
      includeBundle: false,
      buildInputs: {},
      artifacts: []
    }));

    const result = spawnTsx(["scripts/verify-stable-updater.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("release manifest must be a stable distribution manifest");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("verifies the local updater feed hash before network checks", () => {
    mkdirSync(scriptFixtureDir, { recursive: true });
    const feedPath = path.join(scriptFixtureDir, "builder-gear-updater-latest.json");
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    writeFileSync(feedPath, JSON.stringify({
      version: "0.1.0",
      notes: "Builder Gear 0.1.0",
      pub_date: "2026-06-24T00:00:00.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "signed",
          url: "https://updates.buildergear.app/Builder%20Gear.app.tar.gz"
        }
      }
    }));
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      mode: "distribution",
      channel: "stable",
      platform: "macos",
      arch: "aarch64",
      includeBundle: true,
      buildInputs: {
        stableUpdater: {
          endpoints: [
            "https://updates.buildergear.app/builder-gear-updater-latest.json"
          ]
        }
      },
      artifacts: [
        {
          path: repoRelativePath(feedPath),
          sha256: "a".repeat(64)
        }
      ]
    }));

    const result = spawnTsx(["scripts/verify-stable-updater.ts", repoRelativePath(manifestPath)], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain(`local stable updater feed sha256 mismatch: ${repoRelativePath(feedPath)}`);
    expect(output).not.toContain("getaddrinfo");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("at ");
  });

  it("rejects hosted updater payload URLs that target non-public hosts before download", () => {
    mkdirSync(scriptFixtureDir, { recursive: true });
    const feedPath = path.join(scriptFixtureDir, "builder-gear-updater-latest.json");
    const manifestPath = path.join(scriptFixtureDir, "builder-gear-release-manifest.json");
    const fetchLogPath = path.join(scriptFixtureDir, "fetch.log");
    const fetchMockPath = path.join(scriptFixtureDir, "mock-fetch.mjs");
    const feed = {
      version: "0.1.0",
      notes: "Builder Gear 0.1.0",
      pub_date: "2026-06-24T00:00:00.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "signed",
          url: "https://127.0.0.1/Builder%20Gear.app.tar.gz"
        }
      }
    };
    const feedText = `${JSON.stringify(feed)}\n`;

    writeFileSync(feedPath, feedText);
    writeFileSync(fetchMockPath, [
      "import { appendFileSync } from 'node:fs';",
      "globalThis.fetch = async (url) => {",
      "  appendFileSync(process.env.BUILDER_GEAR_FETCH_LOG, String(url) + '\\n');",
      "  return new Response(process.env.BUILDER_GEAR_HOSTED_FEED, {",
      "    status: 200,",
      "    headers: { 'content-type': 'application/json' }",
      "  });",
      "};"
    ].join("\n"));
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      mode: "distribution",
      channel: "stable",
      platform: "macos",
      arch: "aarch64",
      includeBundle: true,
      buildInputs: {
        stableUpdater: {
          endpoints: [
            "https://updates.buildergear.app/builder-gear-updater-latest.json"
          ]
        }
      },
      artifacts: [
        {
          path: repoRelativePath(feedPath),
          sha256: sha256(feedText)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/macos/Builder Gear.app.tar.gz",
          sha256: "b".repeat(64)
        }
      ]
    }));

    const result = spawnTsx([
      "scripts/verify-stable-updater.ts",
      repoRelativePath(manifestPath),
      "--verify-downloads"
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        BUILDER_GEAR_FETCH_LOG: fetchLogPath,
        BUILDER_GEAR_HOSTED_FEED: JSON.stringify(feed),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(fetchMockPath).href}`.trim()
      }
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("stable updater payload URL must not point at localhost or a loopback address");
    expect(output).not.toContain(rootDir);
    expect(output).not.toMatch(/\n\s+at\s+\S/);
    expect(readFileSync(fetchLogPath, "utf8").trim().split("\n")).toEqual([
      "https://updates.buildergear.app/builder-gear-updater-latest.json"
    ]);
  });

  it("rejects duplicate download verification options before network checks", () => {
    const result = spawnTsx([
      "scripts/verify-stable-updater.ts",
      "missing.json",
      "--verify-downloads",
      "--verify-downloads"
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("duplicate option: --verify-downloads");
    expect(output).toContain("Usage: pnpm release:verify-updater -- [--artifact-root <path>] <path/to/builder-gear-release-manifest.json> [--verify-downloads]");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("getaddrinfo");
    expect(output).not.toContain("at ");
  });

  it("rejects unsafe artifact roots before updater network checks", () => {
    const result = spawnTsx([
      "scripts/verify-stable-updater.ts",
      "--artifact-root",
      "../outside",
      "builder-gear-release-manifest.json"
    ], {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("artifact root must be repository-relative");
    expect(output).not.toContain(rootDir);
    expect(output).not.toContain("getaddrinfo");
    expect(output).not.toContain("at ");
  });
});

function repoRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
