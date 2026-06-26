import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashReleaseArtifactPath,
  loadReleaseEnvFileFromArgv,
  parseReleaseCliChoice,
  parseReleaseEnvFile,
  macOSDistributionVerificationCommands,
  releaseArtifactProfile,
  releaseCheckCommandEnvironment,
  releaseCheckCommands,
  releaseCandidateGitHubEnvironmentRequirements,
  releaseEnvironmentExamplePaths,
  releaseSensitiveEnvironmentNames,
  renderStableUpdaterFeed,
  renderCycloneDxSbom,
  renderThirdPartyNotices,
  requiredDistributionEnvironment,
  stableUpdaterPlatformKey,
  resolveReleaseArtifactPath,
  validateDependencyLicenses,
  validateLicensePolicy,
  validateDistributionPreflightEnvironment,
  validateReleaseInventory,
  validateReleaseManifest,
  validateReleaseMetadata,
  validateReleaseProvenance,
  validateRepositoryPrivacyScanCoverage,
  validateRepositorySourceTree,
  validateDistributionPreflightArgv,
  validateReleaseCheckArgv,
  validateReleaseCandidateGitHubSecretInventory,
  validateReleaseGitState,
  validateWorkflowActionRefs,
  verifyMacOSAppBundle,
  verifyReleaseInventoryEntries,
  verifyReleaseManifestArtifacts,
  verifyReleaseProvenanceArtifacts,
  type ReleaseManifest,
  type ReleaseProvenance
} from "../release-check.js";

const validMetadata = {
  rootPackage: {
    version: "0.1.0",
    packageManager: "pnpm@10.26.1",
    scripts: {
      typecheck: "pnpm -r typecheck",
      lint: "pnpm -r lint",
      test: "pnpm -r test",
      build: "pnpm -r build",
      "ci:policy": "tsx scripts/ci-policy.ts",
      "license:policy": "tsx scripts/license-policy.ts",
      "license:notices": "tsx scripts/license-notices.ts",
      "license:notices:check": "tsx scripts/license-notices.ts --check",
      "sbom:generate": "tsx scripts/sbom.ts",
      "sbom:check": "tsx scripts/sbom.ts --check",
      "security:audit": "pnpm audit --audit-level low",
      "privacy:scan": "tsx scripts/privacy-scan.ts",
      "icons:generate": "tsx scripts/generate-app-icons.ts",
      "release:check": "tsx scripts/release-check.ts",
      "release:check:distribution": "tsx scripts/release-check.ts --distribution --channel internal",
      "release:check:stable": "tsx scripts/release-check.ts --distribution --channel stable",
      "release:preflight": "tsx scripts/distribution-preflight.ts",
      "release:github-setup": "tsx scripts/github-release-setup.ts",
      "release:github-preflight": "tsx scripts/github-release-preflight.ts",
      "release:smoke-bundle": "tsx scripts/desktop-bundle-smoke.ts",
      "release:stage-upload": "tsx scripts/stage-release-upload.ts",
      "release:verify": "tsx scripts/verify-release-manifest.ts",
      "release:verify-updater": "tsx scripts/verify-stable-updater.ts",
      "service:readiness": "tsx scripts/service-readiness.ts"
    }
  },
  corePackage: {
    name: "@builder/core",
    version: "0.1.0"
  },
  cliPackage: {
    name: "@builder/cli",
    version: "0.1.0"
  },
  desktopPackage: {
    version: "0.1.0",
    dependencies: {
      "@tauri-apps/api": "^2.2.0",
      "@tauri-apps/plugin-updater": "^2.10.1"
    },
    scripts: {
      typecheck: "tsc --noEmit",
      test: "vitest run src",
      "test:e2e": "playwright test",
      build: "tsc --noEmit && vite build",
      tauri: "tauri"
    }
  },
  cargoPackage: {
    name: "builder-gear-desktop",
    version: "0.1.0"
  },
  cliEntryText: [
    "const CLI_VERSION = \"0.1.0\";",
    "program.version(CLI_VERSION);",
    "createSupportBundle({ appVersion: CLI_VERSION });"
  ].join("\n"),
  tauriConfig: {
    productName: "Builder Gear",
    version: "0.1.0",
    identifier: "com.buildergear.desktop",
    build: {
      beforeDevCommand: "pnpm dev",
      devUrl: "http://127.0.0.1:1420",
      beforeBuildCommand: "pnpm build",
      frontendDist: "../dist"
    },
    app: {
      security: {
        csp: "default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; form-action 'none'",
        devCsp: "default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost http://127.0.0.1:1420 ws://127.0.0.1:1420; object-src 'none'; form-action 'none'",
        freezePrototype: true
      }
    },
    bundle: {
      active: true,
      publisher: "Builder Gear",
      category: "DeveloperTool",
      license: "Proprietary",
      copyright: "Copyright (c) 2026 Builder Gear",
      icon: [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.png",
        "icons/icon.icns",
        "icons/icon.ico"
      ],
      createUpdaterArtifacts: false,
      macOS: {
        minimumSystemVersion: "12.0",
        hardenedRuntime: true,
        entitlements: "entitlements.plist"
      }
    }
  },
  tauriCapability: {
    identifier: "default",
    windows: ["main"],
    permissions: [
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "updater:allow-check",
      "updater:allow-download-and-install"
    ]
  },
  distributionPolicy: {
    schemaVersion: 1,
    artifactName: "Builder Gear.app",
    bundleTargets: ["app", "dmg"],
    channels: [
      {
        id: "internal",
        requiresCodeSigning: true,
        requiresNotarization: true,
        requiresUpdaterArtifacts: false,
        requiredEnvironment: []
      },
      {
        id: "stable",
        requiresCodeSigning: true,
        requiresNotarization: true,
        requiresUpdaterArtifacts: true,
        requiredEnvironment: [
          "TAURI_SIGNING_PRIVATE_KEY",
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
          "BUILDER_GEAR_UPDATER_PUBKEY",
          "BUILDER_GEAR_UPDATE_ENDPOINT"
        ]
      }
    ],
    macOS: {
      minimumSystemVersion: "12.0",
      hardenedRuntime: true,
      entitlements: "apps/desktop/src-tauri/entitlements.plist",
      requiredEnvironment: [
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_PASSWORD",
        "APPLE_TEAM_ID"
      ]
    },
    windows: {
      bundleTargets: ["msi", "nsis"],
      requiredEnvironment: [
        "WINDOWS_SIGNING_CERTIFICATE",
        "WINDOWS_SIGNING_PASSWORD"
      ]
    },
    linux: {
      bundleTargets: ["appimage", "deb", "rpm"],
      requiredEnvironment: []
    }
  },
  repositoryFiles: [
    ".gitignore",
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/release-candidate.yml",
    ".github/workflows/verify-stable-updater.yml",
    "apps/desktop/src-tauri/capabilities/default.json",
    "apps/desktop/src-tauri/entitlements.plist",
    "apps/desktop/src-tauri/icons/32x32.png",
    "apps/desktop/src-tauri/icons/128x128.png",
    "apps/desktop/src-tauri/icons/128x128@2x.png",
    "apps/desktop/src-tauri/icons/icon.png",
    "apps/desktop/src-tauri/icons/icon.icns",
    "apps/desktop/src-tauri/icons/icon.ico",
    ...releaseEnvironmentExamplePaths(),
    "release/SBOM.cdx.json",
    "release/THIRD_PARTY_NOTICES.md",
    "release/license-policy.json",
    "release/tauri.stable.conf.json",
    "scripts/ci-policy.ts",
    "scripts/cli-smoke.ts",
    "scripts/desktop-bundle-smoke.ts",
    "scripts/distribution-preflight.ts",
    "scripts/github-release-preflight.ts",
    "scripts/github-release-setup.ts",
    "scripts/license-data.ts",
    "scripts/license-notices.ts",
    "scripts/license-policy.ts",
    "scripts/privacy-scan.ts",
    "scripts/release-check.ts",
    "scripts/sbom.ts",
    "scripts/release-script-args.ts",
    "scripts/service-readiness.ts",
    "scripts/script-file-safety.ts",
    "scripts/stage-release-upload.ts",
    "scripts/verify-stable-updater.ts",
    "scripts/verify-release-manifest.ts",
    "README.md",
    "PRIVACY.md",
    "SECURITY.md"
  ],
  gitignoreText: [
    ".builder/",
    "node_modules",
    "dist",
    "coverage",
    "test-results",
    "playwright-report",
    "release-candidate-artifact/",
    ".turbo",
    ".DS_Store",
    "*.log",
    "*.tgz",
    "apps/desktop/src-tauri/target",
    "apps/desktop/dist",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal"
  ].join("\n"),
  dependabotConfigText: [
    "version: 2",
    "updates:",
    "  - package-ecosystem: npm",
    "    directory: /",
    "    schedule:",
    "      interval: weekly",
    "    open-pull-requests-limit: 5",
    "  - package-ecosystem: cargo",
    "    directory: /apps/desktop/src-tauri",
    "    schedule:",
    "      interval: weekly",
    "    open-pull-requests-limit: 5",
    "  - package-ecosystem: github-actions",
    "    directory: /",
    "    schedule:",
    "      interval: weekly",
    "    open-pull-requests-limit: 5"
  ].join("\n"),
  releaseCandidateWorkflowText: [
    "env:",
    "  APPLE_SIGNING_IDENTITY: ${{ inputs.platform == 'macos' && secrets.APPLE_SIGNING_IDENTITY || '' }}",
    "  APPLE_ID: ${{ inputs.platform == 'macos' && secrets.APPLE_ID || '' }}",
    "  APPLE_PASSWORD: ${{ inputs.platform == 'macos' && secrets.APPLE_PASSWORD || '' }}",
    "  APPLE_TEAM_ID: ${{ inputs.platform == 'macos' && secrets.APPLE_TEAM_ID || '' }}",
    "  WINDOWS_SIGNING_CERTIFICATE: ${{ inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_CERTIFICATE || '' }}",
    "  WINDOWS_SIGNING_PASSWORD: ${{ inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_PASSWORD || '' }}",
    "  TAURI_SIGNING_PRIVATE_KEY: ${{ inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY || '' }}",
    "  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' }}",
    "  BUILDER_GEAR_UPDATER_PUBKEY: ${{ inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATER_PUBKEY || '' }}",
    "  BUILDER_GEAR_UPDATE_ENDPOINT: ${{ inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATE_ENDPOINT || '' }}"
  ].join("\n"),
  releaseEnvExampleTexts: validReleaseEnvExampleTexts(),
  readmeText: [
    "Builder Gear release metadata verifies the default Tauri capability stays scoped to the main window.",
    "The renderer capability includes only event listen/unlisten and explicit updater check/download-install permissions.",
    "Workspace folder selection is mediated by a Rust command instead of exposing generic renderer dialog permissions."
  ].join("\n"),
  securityText: [
    "Builder Gear does not read, copy, edit, print, upload, or persist auth file contents.",
    "Codex runs use codex exec and deliver prompts over stdin instead of argv.",
    "Run pnpm release:preflight before distribution and pnpm release:verify-updater after stable updater publication.",
    "Diagnostics and support bundles exclude prompts, workspace paths, and Codex auth contents."
  ].join("\n"),
  privacyText: [
    "Builder Gear is a local-first desktop and CLI tool.",
    "Builder Gear does not read, copy, edit, print, upload, or persist auth file contents.",
    "Prompts are delivered over stdin instead of command-line arguments.",
    "Diagnostics exclude prompts, event payload bodies, workspace paths, and Codex auth contents.",
    "Support bundles exclude raw prompts and workspace paths.",
    "The Network section states Builder Gear does not add a separate cloud service."
  ].join("\n")
};

function validReleaseEnvExampleTexts(): Record<string, string> {
  return {
    "release/macos.internal.env.example": [
      "APPLE_SIGNING_IDENTITY=\"<DEVELOPER_ID_APPLICATION_IDENTITY>\"",
      "APPLE_ID=\"<APPLE_ID_EMAIL>\"",
      "APPLE_PASSWORD=\"<APPLE_APP_SPECIFIC_PASSWORD_OR_KEYCHAIN_PROFILE>\"",
      "APPLE_TEAM_ID=\"<APPLE_TEAM_ID>\""
    ].join("\n"),
    "release/macos.stable.env.example": [
      "APPLE_SIGNING_IDENTITY=\"<DEVELOPER_ID_APPLICATION_IDENTITY>\"",
      "APPLE_ID=\"<APPLE_ID_EMAIL>\"",
      "APPLE_PASSWORD=\"<APPLE_APP_SPECIFIC_PASSWORD_OR_KEYCHAIN_PROFILE>\"",
      "APPLE_TEAM_ID=\"<APPLE_TEAM_ID>\"",
      "TAURI_SIGNING_PRIVATE_KEY=\"<TAURI_UPDATER_PRIVATE_KEY_FILE_OR_CONTENT>\"",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\"<TAURI_UPDATER_PRIVATE_KEY_PASSWORD>\"",
      "BUILDER_GEAR_UPDATER_PUBKEY=\"<TAURI_UPDATER_PUBLIC_KEY_CONTENT>\"",
      "BUILDER_GEAR_UPDATE_ENDPOINT=\"<PRODUCTION_HTTPS_STATIC_UPDATER_JSON_URL>\""
    ].join("\n"),
    "release/windows.internal.env.example": [
      "WINDOWS_SIGNING_CERTIFICATE=\"<WINDOWS_PFX_FILE_OR_BASE64_PFX>\"",
      "WINDOWS_SIGNING_PASSWORD=\"<WINDOWS_PFX_PASSWORD>\""
    ].join("\n"),
    "release/windows.stable.env.example": [
      "WINDOWS_SIGNING_CERTIFICATE=\"<WINDOWS_PFX_FILE_OR_BASE64_PFX>\"",
      "WINDOWS_SIGNING_PASSWORD=\"<WINDOWS_PFX_PASSWORD>\"",
      "TAURI_SIGNING_PRIVATE_KEY=\"<TAURI_UPDATER_PRIVATE_KEY_FILE_OR_CONTENT>\"",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\"<TAURI_UPDATER_PRIVATE_KEY_PASSWORD>\"",
      "BUILDER_GEAR_UPDATER_PUBKEY=\"<TAURI_UPDATER_PUBLIC_KEY_CONTENT>\"",
      "BUILDER_GEAR_UPDATE_ENDPOINT=\"<PRODUCTION_HTTPS_STATIC_UPDATER_JSON_URL>\""
    ].join("\n"),
    "release/linux.internal.env.example": "# no platform signing env required",
    "release/linux.stable.env.example": [
      "TAURI_SIGNING_PRIVATE_KEY=\"<TAURI_UPDATER_PRIVATE_KEY_FILE_OR_CONTENT>\"",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\"<TAURI_UPDATER_PRIVATE_KEY_PASSWORD>\"",
      "BUILDER_GEAR_UPDATER_PUBKEY=\"<TAURI_UPDATER_PUBLIC_KEY_CONTENT>\"",
      "BUILDER_GEAR_UPDATE_ENDPOINT=\"<PRODUCTION_HTTPS_STATIC_UPDATER_JSON_URL>\""
    ].join("\n")
  };
}

function stableUpdaterConfig() {
  return {
    plugins: {
      updater: {
        pubkey: `tauri-updater-public-key-${"a".repeat(80)}`,
        endpoints: [
          "https://updates.buildergear.app/builder-gear-updater-latest.json"
        ]
      }
    }
  };
}

function stableReadyTauriConfig() {
  return {
    ...validMetadata.tauriConfig,
    ...stableUpdaterConfig(),
    bundle: {
      ...validMetadata.tauriConfig.bundle,
      createUpdaterArtifacts: true
    }
  };
}

function fakePfxBase64() {
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x02, 0x10]),
    Buffer.alloc(528, 1)
  ]).toString("base64");
}

describe("release readiness checks", () => {
  it("runs every service-readiness gate in a stable order", () => {
    expect(releaseCheckCommands().map((command) => command.id)).toEqual([
      "typecheck",
      "lint",
      "unit-tests",
      "security-audit",
      "privacy-scan",
      "license-policy",
      "license-notices",
      "sbom",
      "ci-policy",
      "rust-format",
      "rust-clippy",
      "rust-tests",
      "desktop-e2e",
      "workspace-build",
      "cli-smoke",
      "desktop-bundle",
      "desktop-bundle-smoke"
    ]);
  });

  it("rejects repository source symlinks before release packaging", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-source-tree-"));

    try {
      writeFileSync(path.join(root, "outside-secret.txt"), "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n");
      symlinkSync(path.join(root, "outside-secret.txt"), path.join(root, "linked-secret.txt"));

      expect(validateRepositorySourceTree(root)).toEqual([
        "repository source must not contain symlinks: linked-secret.txt"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized text files that privacy scan would otherwise skip", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-privacy-coverage-"));

    try {
      writeFileSync(path.join(root, "large-config.json"), `${"x".repeat(128)}\n`);
      writeFileSync(path.join(root, "large-icon.png"), Buffer.alloc(128));

      expect(validateRepositoryPrivacyScanCoverage(root, { maxScannedBytes: 64 })).toEqual([
        "repository text file exceeds privacy scan size limit: large-config.json"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can skip the slow bundle gate for fast local checks", () => {
    expect(releaseCheckCommands({ includeBundle: false }).map((command) => command.id)).not.toContain("desktop-bundle");
  });

  it("uses a release app and dmg bundle in distribution mode", () => {
    expect(releaseCheckCommands({ distribution: true }).map((command) => command.id)).toEqual([
      "distribution-preflight",
      "typecheck",
      "lint",
      "unit-tests",
      "security-audit",
      "privacy-scan",
      "license-policy",
      "license-notices",
      "sbom",
      "ci-policy",
      "rust-format",
      "rust-clippy",
      "rust-tests",
      "desktop-e2e",
      "workspace-build",
      "cli-smoke",
      "desktop-bundle",
      "desktop-bundle-smoke"
    ]);
    expect(releaseCheckCommands({ distribution: true }).at(0)).toMatchObject({
      id: "distribution-preflight",
      args: ["scripts/distribution-preflight.ts", "--platform", "macos", "--channel", "internal"]
    });
    expect(releaseCheckCommands({ distribution: true, channel: "stable" }).at(0)).toMatchObject({
      id: "distribution-preflight",
      args: ["scripts/distribution-preflight.ts", "--platform", "macos", "--channel", "stable"]
    });
    expect(releaseCheckCommands({ distribution: true, channel: "stable" }).find((command) => command.id === "desktop-bundle")).toMatchObject({
      id: "desktop-bundle",
      args: ["--filter", "@builder/desktop", "tauri", "build", "--bundles", "app,dmg", "--config", "../../release/tauri.stable.conf.json"]
    });
    expect(releaseCheckCommands({
      distribution: true,
      channel: "stable",
      stableTauriConfigPath: "src-tauri/target/release-config/tauri.stable.generated.conf.json"
    }).find((command) => command.id === "desktop-bundle")).toMatchObject({
      id: "desktop-bundle",
      args: ["--filter", "@builder/desktop", "tauri", "build", "--bundles", "app,dmg", "--config", "src-tauri/target/release-config/tauri.stable.generated.conf.json"]
    });
    expect(releaseCheckCommands({ distribution: true }).find((command) => command.id === "desktop-bundle")).toMatchObject({
      id: "desktop-bundle",
      args: ["--filter", "@builder/desktop", "tauri", "build", "--bundles", "app,dmg"]
    });
    expect(releaseCheckCommands({ platform: "windows", distribution: true }).find((command) => command.id === "desktop-bundle")).toMatchObject({
      args: ["--filter", "@builder/desktop", "tauri", "build", "--bundles", "msi,nsis"]
    });
    expect(releaseCheckCommands({ platform: "linux", distribution: true }).find((command) => command.id === "desktop-bundle")).toMatchObject({
      args: ["--filter", "@builder/desktop", "tauri", "build", "--bundles", "appimage,deb,rpm"]
    });
    expect(releaseCheckCommands({ distribution: true, channel: "stable" }).at(-1)).toMatchObject({
      id: "desktop-bundle-smoke",
      args: [
        "scripts/desktop-bundle-smoke.ts",
        "--platform",
        "macos",
        "--artifact-root",
        "apps/desktop/src-tauri/target/release/bundle/macos",
        "--distribution",
        "--channel",
        "stable"
      ]
    });
  });

  it("describes platform-specific bundle artifacts", () => {
    expect(releaseArtifactProfile({ platform: "macos", distribution: true })).toEqual({
      platform: "macos",
      artifactRoot: "apps/desktop/src-tauri/target/release/bundle/macos",
      requiredArtifacts: ["Builder Gear.app", "Builder Gear*.dmg"]
    });
    expect(releaseArtifactProfile({ platform: "macos", distribution: true, channel: "stable" }).requiredArtifacts).toEqual([
      "Builder Gear.app",
      "Builder Gear*.dmg",
      "Builder Gear.app.tar.gz",
      "Builder Gear.app.tar.gz.sig"
    ]);
    expect(releaseArtifactProfile({ platform: "windows", distribution: true }).requiredArtifacts).toEqual([
      "msi/Builder Gear*.msi",
      "nsis/Builder Gear*_x64-setup.exe"
    ]);
    expect(releaseArtifactProfile({ platform: "windows", distribution: true, channel: "stable" }).requiredArtifacts).toEqual([
      "msi/Builder Gear*.msi",
      "msi/Builder Gear*.msi.sig",
      "nsis/Builder Gear*_x64-setup.exe",
      "nsis/Builder Gear*_x64-setup.exe.sig"
    ]);
    expect(releaseArtifactProfile({ platform: "linux", distribution: true }).requiredArtifacts).toEqual([
      "appimage/Builder Gear*.AppImage",
      "deb/builder-gear*.deb",
      "rpm/builder-gear*.rpm"
    ]);
    expect(releaseArtifactProfile({ platform: "linux", distribution: true, channel: "stable" }).requiredArtifacts).toEqual([
      "appimage/Builder Gear*.AppImage",
      "appimage/Builder Gear*.AppImage.sig",
      "deb/builder-gear*.deb",
      "rpm/builder-gear*.rpm"
    ]);
    expect(stableUpdaterPlatformKey("macos", "aarch64")).toBe("darwin-aarch64");
    expect(stableUpdaterPlatformKey("windows", "x86_64")).toBe("windows-x86_64");
    expect(renderStableUpdaterFeed({
      version: "0.1.0",
      generatedAt: "2026-06-24T00:00:00.000Z",
      platform: "linux",
      arch: "x86_64",
      signature: "signed-payload",
      url: "https://updates.buildergear.app/Builder%20Gear.AppImage"
    })).toEqual({
      version: "0.1.0",
      notes: "Builder Gear 0.1.0",
      pub_date: "2026-06-24T00:00:00.000Z",
      platforms: {
        "linux-x86_64": {
          signature: "signed-payload",
          url: "https://updates.buildergear.app/Builder%20Gear.AppImage"
        }
      }
    });
  });

  it("describes macOS distribution signature and notarization postflight commands", () => {
    const commands = macOSDistributionVerificationCommands([
      "/tmp/Builder Gear_0.1.0.dmg",
      "/tmp/ignore.txt",
      "/tmp/Builder Gear.app"
    ]);

    expect(commands.map((command) => command.id)).toEqual([
      "macos-codesign-app",
      "macos-spctl-app",
      "macos-stapler-app",
      "macos-codesign-dmg",
      "macos-spctl-dmg",
      "macos-stapler-dmg"
    ]);
    expect(commands[0]).toMatchObject({
      command: "codesign",
      args: ["--verify", "--deep", "--strict", "--verbose=2", "/tmp/Builder Gear.app"]
    });
    expect(commands[2]).toMatchObject({
      command: "xcrun",
      args: ["stapler", "validate", "/tmp/Builder Gear.app"]
    });
    expect(commands[4]).toMatchObject({
      command: "spctl",
      args: ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", "/tmp/Builder Gear_0.1.0.dmg"]
    });
  });

  it("exposes required signing environment names", () => {
    expect(requiredDistributionEnvironment(validMetadata.distributionPolicy)).toEqual([
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID"
    ]);
    expect(requiredDistributionEnvironment(validMetadata.distributionPolicy, "macos", "internal")).toEqual([
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID"
    ]);
    expect(requiredDistributionEnvironment(validMetadata.distributionPolicy, "macos", "stable")).toEqual([
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      "BUILDER_GEAR_UPDATER_PUBKEY",
      "BUILDER_GEAR_UPDATE_ENDPOINT"
    ]);
    expect(requiredDistributionEnvironment(validMetadata.distributionPolicy, "windows")).toEqual([
      "WINDOWS_SIGNING_CERTIFICATE",
      "WINDOWS_SIGNING_PASSWORD"
    ]);
    expect(requiredDistributionEnvironment(validMetadata.distributionPolicy, "linux")).toEqual([]);
  });

  it("describes GitHub release environment secret requirements without secret values", () => {
    expect(releaseCandidateGitHubEnvironmentRequirements(validMetadata.distributionPolicy)).toEqual([
      {
        environment: "internal-release",
        deploymentBranches: ["main", "release/*"],
        requiredSecrets: [
          "APPLE_SIGNING_IDENTITY",
          "APPLE_CERTIFICATE",
          "APPLE_CERTIFICATE_PASSWORD",
          "APPLE_KEYCHAIN_PASSWORD",
          "APPLE_ID",
          "APPLE_PASSWORD",
          "APPLE_TEAM_ID",
          "WINDOWS_SIGNING_CERTIFICATE",
          "WINDOWS_SIGNING_PASSWORD"
        ]
      },
      {
        environment: "production",
        deploymentBranches: ["main", "release/*"],
        requiredSecrets: [
          "APPLE_SIGNING_IDENTITY",
          "APPLE_CERTIFICATE",
          "APPLE_CERTIFICATE_PASSWORD",
          "APPLE_KEYCHAIN_PASSWORD",
          "APPLE_ID",
          "APPLE_PASSWORD",
          "APPLE_TEAM_ID",
          "WINDOWS_SIGNING_CERTIFICATE",
          "WINDOWS_SIGNING_PASSWORD",
          "TAURI_SIGNING_PRIVATE_KEY",
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
          "BUILDER_GEAR_UPDATER_PUBKEY",
          "BUILDER_GEAR_UPDATE_ENDPOINT"
        ]
      }
    ]);

    expect(validateReleaseCandidateGitHubSecretInventory(validMetadata.distributionPolicy, [
      {
        environment: "internal-release",
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true
        },
        deploymentBranches: ["main", "release/*"],
        secrets: [
          "APPLE_SIGNING_IDENTITY",
          "APPLE_CERTIFICATE",
          "APPLE_CERTIFICATE_PASSWORD",
          "APPLE_KEYCHAIN_PASSWORD",
          "APPLE_ID",
          "APPLE_PASSWORD",
          "APPLE_TEAM_ID",
          "WINDOWS_SIGNING_CERTIFICATE",
          "WINDOWS_SIGNING_PASSWORD"
        ]
      },
      {
        environment: "production",
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true
        },
        deploymentBranches: ["main", "release/*"],
        secrets: [
          "APPLE_SIGNING_IDENTITY",
          "APPLE_CERTIFICATE",
          "APPLE_CERTIFICATE_PASSWORD",
          "APPLE_KEYCHAIN_PASSWORD",
          "APPLE_ID",
          "APPLE_PASSWORD",
          "APPLE_TEAM_ID",
          "WINDOWS_SIGNING_CERTIFICATE",
          "WINDOWS_SIGNING_PASSWORD",
          "TAURI_SIGNING_PRIVATE_KEY",
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
          "BUILDER_GEAR_UPDATER_PUBKEY",
          "BUILDER_GEAR_UPDATE_ENDPOINT"
        ]
      }
    ])).toEqual([]);

    expect(validateReleaseCandidateGitHubSecretInventory(validMetadata.distributionPolicy, [
      {
        environment: "internal-release",
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true
        },
        deploymentBranches: ["main"],
        secrets: [
          "APPLE_SIGNING_IDENTITY",
          "WINDOWS_SIGNING_CERTIFICATE"
        ]
      }
    ])).toEqual(expect.arrayContaining([
      "GitHub release environment internal-release is missing secret: APPLE_CERTIFICATE",
      "GitHub release environment internal-release is missing secret: WINDOWS_SIGNING_PASSWORD",
      "GitHub release environment internal-release is missing deployment branch policy: release/*",
      "GitHub release environment is missing: production"
    ]));
  });

  it("strips distribution secrets from debug release command environments", () => {
    const env = releaseCheckCommandEnvironment({
      PATH: "/usr/bin",
      APPLE_SIGNING_IDENTITY: "<DEVELOPER_ID_APPLICATION_IDENTITY>",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_CERTIFICATE: "base64-certificate-secret",
      APPLE_KEYCHAIN_PASSWORD: "keychain-secret",
      WINDOWS_SIGNING_CERTIFICATE: "base64:secret",
      TAURI_SIGNING_PRIVATE_KEY: "private-key",
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/latest.json",
      BUILDER_GEAR_SAFE_FLAG: "1"
    }, { distribution: false, distributionPolicy: validMetadata.distributionPolicy });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      BUILDER_GEAR_SAFE_FLAG: "1"
    });
    expect(env.APPLE_SIGNING_IDENTITY).toBeUndefined();
    expect(env.APPLE_PASSWORD).toBeUndefined();
    expect(env.APPLE_CERTIFICATE).toBeUndefined();
    expect(env.APPLE_KEYCHAIN_PASSWORD).toBeUndefined();
    expect(env.WINDOWS_SIGNING_CERTIFICATE).toBeUndefined();
    expect(env.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(env.BUILDER_GEAR_UPDATE_ENDPOINT).toBeUndefined();
  });

  it("keeps distribution secrets for distribution release command environments", () => {
    const env = releaseCheckCommandEnvironment({
      PATH: "/usr/bin",
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_PASSWORD: "super-secret-password"
    }, { distribution: true, distributionPolicy: validMetadata.distributionPolicy });

    expect(env.APPLE_SIGNING_IDENTITY).toBe("Developer ID Application: Builder Gear");
    expect(env.APPLE_PASSWORD).toBe("super-secret-password");
  });

  it("includes policy and common platform signing variables as sensitive release environment", () => {
    expect(releaseSensitiveEnvironmentNames(validMetadata.distributionPolicy)).toEqual(expect.arrayContaining([
      "APPLE_SIGNING_IDENTITY",
      "APPLE_API_KEY",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_KEYCHAIN_PASSWORD",
      "WINDOWS_SIGNING_CERTIFICATE",
      "TAURI_SIGNING_PRIVATE_KEY",
      "BUILDER_GEAR_UPDATE_ENDPOINT"
    ]));
  });

  it("parses release env files without exposing secret values in parse errors", () => {
    const parsed = parseReleaseEnvFile([
      "# release secrets",
      "export APPLE_ID=\"release@buildergear.app\"",
      "APPLE_TEAM_ID='ABCDE12345'",
      "BUILDER_GEAR_UPDATE_ENDPOINT=https://updates.buildergear.app/latest.json # safe comment",
      "APPLE_PASSWORD=super-secret-password",
      "bad line with super-secret-password"
    ].join("\n"));

    expect(parsed.values).toMatchObject({
      APPLE_ID: "release@buildergear.app",
      APPLE_TEAM_ID: "ABCDE12345",
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/latest.json",
      APPLE_PASSWORD: "super-secret-password"
    });
    expect(parsed.errors).toEqual(["release env line 6 must be KEY=value"]);
    expect(parsed.errors.join("\n")).not.toContain("super-secret-password");
  });

  it("loads release env files without overriding existing CI secrets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-release-env-"));
    const envPath = path.join(root, "release.env");
    const env: NodeJS.ProcessEnv = {
      APPLE_ID: "ci-release@buildergear.app"
    };

    writeFileSync(envPath, [
      "APPLE_ID=file-release@buildergear.app",
      "APPLE_TEAM_ID=ABCDE12345"
    ].join("\n"));

    expect(loadReleaseEnvFileFromArgv(["node", "script", "--env-file", envPath], root, env)).toEqual([]);
    expect(env.APPLE_ID).toBe("ci-release@buildergear.app");
    expect(env.APPLE_TEAM_ID).toBe("ABCDE12345");

    rmSync(root, { recursive: true, force: true });
  });

  it("fails malformed release env arguments without printing local env paths", () => {
    expect(loadReleaseEnvFileFromArgv(["node", "script", "--env-file"], "/private/tmp/client", {})).toEqual([
      "release env file path is missing after --env-file"
    ]);
    expect(loadReleaseEnvFileFromArgv(["node", "script", "--env-file", "missing.env"], "/private/tmp/client", {})).toEqual([
      "release env file is missing"
    ]);
  });

  it("rejects symlinked or non-regular release env files before reading secrets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-release-env-regular-"));

    try {
      const releaseDir = path.join(root, "release");
      const envPath = path.join(releaseDir, "internal.env");
      const linkPath = path.join(releaseDir, "linked.env");

      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(envPath, "APPLE_ID=release@buildergear.app\n");

      expect(loadReleaseEnvFileFromArgv(["node", "script", "--env-file", releaseDir], root, {})).toEqual([
        "release env file must be a regular file"
      ]);

      if (process.platform !== "win32") {
        symlinkSync(envPath, linkPath);

        expect(loadReleaseEnvFileFromArgv(["node", "script", "--env-file", linkPath], root, {})).toEqual([
          "release env file must not be a symlink"
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses bounded release CLI choices without falling back from invalid values", () => {
    expect(parseReleaseCliChoice(["node", "script"], "--channel", ["internal", "stable"])).toEqual({
      provided: false,
      errors: []
    });
    expect(parseReleaseCliChoice(["node", "script", "--channel", "stable"], "--channel", ["internal", "stable"])).toEqual({
      value: "stable",
      provided: true,
      errors: []
    });
    expect(parseReleaseCliChoice(["node", "script", "--channel"], "--channel", ["internal", "stable"])).toEqual({
      provided: true,
      errors: ["--channel value is missing"]
    });
    expect(parseReleaseCliChoice(["node", "script", "--channel", "production"], "--channel", ["internal", "stable"])).toEqual({
      provided: true,
      errors: ["--channel must be one of: internal, stable"]
    });
    expect(parseReleaseCliChoice([
      "node",
      "script",
      "--channel",
      "stable",
      "--channel",
      "internal"
    ], "--channel", ["internal", "stable"])).toEqual({
      value: "stable",
      provided: true,
      errors: ["--channel was provided more than once"]
    });
  });

  it("rejects unknown release-check arguments before falling back to defaults", () => {
    expect(validateReleaseCheckArgv(["node", "script", "--skip-bundle", "--distrubution"])).toEqual([
      "unknown release argument: --distrubution"
    ]);
    expect(validateReleaseCheckArgv(["node", "script", "--", "--platform", "macos", "--env-file", "release/internal.env"])).toEqual([]);
    expect(validateReleaseCheckArgv([
      "node",
      "script",
      "--skip-bundle",
      "--skip-bundle",
      "--env-file",
      "release/internal.env",
      "--env-file",
      "release/other.env",
      "unexpected"
    ])).toEqual([
      "--skip-bundle was provided more than once",
      "--env-file was provided more than once",
      "unexpected release argument: unexpected"
    ]);
  });

  it("rejects unknown distribution preflight arguments before falling back to defaults", () => {
    expect(validateDistributionPreflightArgv(["node", "script", "--skip-bundle"])).toEqual([
      "unknown release argument: --skip-bundle"
    ]);
    expect(validateDistributionPreflightArgv(["node", "script", "--platfrom", "macos"])).toEqual([
      "unknown release argument: --platfrom",
      "unexpected release argument: macos"
    ]);
    expect(validateDistributionPreflightArgv(["node", "script", "--", "--platform", "macos", "--channel", "stable"])).toEqual([]);
    expect(validateDistributionPreflightArgv([
      "node",
      "script",
      "--env-file",
      "release/internal.env",
      "--env-file",
      "release/other.env"
    ])).toEqual([
      "--env-file was provided more than once"
    ]);
  });

  it("validates distribution preflight environment without exposing secret values", () => {
    const macOSErrors = validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_ID: "not an email",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_TEAM_ID: "BAD"
    });

    expect(macOSErrors).toEqual(expect.arrayContaining([
      "APPLE_ID must look like an Apple ID email address",
      "APPLE_TEAM_ID must be a 10-character Apple team id"
    ]));
    expect(macOSErrors.join("\n")).not.toContain("super-secret-password");

    const placeholderErrors = validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      APPLE_SIGNING_IDENTITY: "<developer-id-identity>",
      APPLE_ID: "release@buildergear.app",
      APPLE_PASSWORD: "changeme",
      APPLE_TEAM_ID: "ABCDE12345"
    });

    expect(placeholderErrors).toEqual(expect.arrayContaining([
      "distribution signing env has a placeholder value: APPLE_SIGNING_IDENTITY",
      "distribution signing env has a placeholder value: APPLE_PASSWORD"
    ]));
    expect(placeholderErrors.join("\n")).not.toContain("changeme");
    expect(placeholderErrors).not.toContain("APPLE_ID must look like an Apple ID email address");

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_ID: "release@buildergear.app",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_TEAM_ID: "ABCDE12345"
    })).toEqual([]);

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_ID: "release@buildergear.app",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_TEAM_ID: "ABCDE12345",
      TAURI_SIGNING_PRIVATE_KEY: `tauri-updater-private-key-${"a".repeat(80)}`,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "update-secret",
      BUILDER_GEAR_UPDATER_PUBKEY: `tauri-updater-public-key-${"a".repeat(80)}`,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: validMetadata.tauriConfig
    })).toEqual(expect.arrayContaining([
      "distribution channel stable requires Tauri updater artifacts to be enabled"
    ]));

    const missingStableEnvErrors = validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {}, {
      channel: "stable",
      tauriConfig: validMetadata.tauriConfig
    });
    expect(missingStableEnvErrors).toEqual(expect.arrayContaining([
      "distribution signing env is missing: BUILDER_GEAR_UPDATER_PUBKEY",
      "distribution signing env is missing: BUILDER_GEAR_UPDATE_ENDPOINT"
    ]));
    expect(missingStableEnvErrors).not.toContain("Tauri updater plugin configuration is required for the stable distribution channel");
    expect(missingStableEnvErrors).not.toContain("Tauri updater pubkey is required for the stable distribution channel");
    expect(missingStableEnvErrors).not.toContain("Tauri updater endpoints must include at least one production HTTPS URL for the stable distribution channel");

    const placeholderStableEnvErrors = validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_ID: "release@buildergear.app",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_TEAM_ID: "ABCDE12345",
      TAURI_SIGNING_PRIVATE_KEY: "<TAURI_UPDATER_PRIVATE_KEY_FILE_OR_CONTENT>",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "<TAURI_UPDATER_PRIVATE_KEY_PASSWORD>",
      BUILDER_GEAR_UPDATER_PUBKEY: "<TAURI_UPDATER_PUBLIC_KEY_CONTENT>",
      BUILDER_GEAR_UPDATE_ENDPOINT: "<PRODUCTION_HTTPS_STATIC_UPDATER_JSON_URL>"
    }, {
      channel: "stable",
      tauriConfig: stableReadyTauriConfig()
    });
    expect(placeholderStableEnvErrors).toEqual(expect.arrayContaining([
      "distribution signing env has a placeholder value: TAURI_SIGNING_PRIVATE_KEY",
      "distribution signing env has a placeholder value: BUILDER_GEAR_UPDATER_PUBKEY",
      "distribution signing env has a placeholder value: BUILDER_GEAR_UPDATE_ENDPOINT"
    ]));
    expect(placeholderStableEnvErrors).not.toContain("BUILDER_GEAR_UPDATE_ENDPOINT must be a valid absolute URL");
    expect(placeholderStableEnvErrors).not.toContain("TAURI_SIGNING_PRIVATE_KEY must be a private key file path or key content with at least 64 characters");
    expect(placeholderStableEnvErrors).not.toContain("Tauri updater pubkey must not be a placeholder value");
  });

  it("requires stable update endpoints to be production-safe HTTPS URLs", () => {
    const stableTauriConfig = stableReadyTauriConfig();
    const baseEnv = {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_ID: "release@buildergear.app",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_TEAM_ID: "ABCDE12345",
      TAURI_SIGNING_PRIVATE_KEY: `tauri-updater-private-key-${"a".repeat(80)}`,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "update-secret",
      BUILDER_GEAR_UPDATER_PUBKEY: `tauri-updater-public-key-${"a".repeat(80)}`
    };

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual([]);

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/releases"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must point to a static JSON updater feed"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/{{target}}/{{arch}}/{{current_version}}"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must point to a static JSON updater feed",
      "BUILDER_GEAR_UPDATE_ENDPOINT must not include updater template variables when generating a static JSON feed"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "http://localhost:1420/update.json#dev"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must use HTTPS",
      "BUILDER_GEAR_UPDATE_ENDPOINT must not include a URL fragment",
      "BUILDER_GEAR_UPDATE_ENDPOINT must not point at localhost or a loopback address"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://token:secret@updates.example.com/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must not include URL credentials"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/builder-gear.json?token=secret"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must not include a URL query string"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://192.168.1.20/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must point at a public update host"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.example.com/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must point at a public update host"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      ...baseEnv,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.local/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: stableTauriConfig
    })).toEqual(expect.arrayContaining([
      "BUILDER_GEAR_UPDATE_ENDPOINT must point at a public update host"
    ]));
  });

  it("requires stable updater runtime configuration before public distribution", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        bundle: {
          ...validMetadata.tauriConfig.bundle,
          createUpdaterArtifacts: true
        }
      }
    }, { distributionChannel: "stable" })).toEqual(expect.arrayContaining([
      "Tauri updater plugin configuration is required for the stable distribution channel",
      "Tauri updater pubkey is required for the stable distribution channel",
      "Tauri updater endpoints must include at least one production HTTPS URL for the stable distribution channel"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        plugins: {
          updater: {
            pubkey: "./public-key.pem",
            endpoints: ["http://localhost:1420/latest.json?token=secret"],
            dangerousInsecureTransportProtocol: true
          }
        },
        bundle: {
          ...validMetadata.tauriConfig.bundle,
          createUpdaterArtifacts: true
        }
      }
    }, { distributionChannel: "stable" })).toEqual(expect.arrayContaining([
      "Tauri updater pubkey must be public key content, not a filesystem path",
      "Tauri updater endpoint must use HTTPS",
      "Tauri updater endpoint must not include a URL query string",
      "Tauri updater endpoint must not point at localhost or a loopback address",
      "Tauri updater dangerousInsecureTransportProtocol must stay disabled for the stable distribution channel"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "macos", {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Builder Gear",
      APPLE_ID: "release@buildergear.app",
      APPLE_PASSWORD: "super-secret-password",
      APPLE_TEAM_ID: "ABCDE12345",
      TAURI_SIGNING_PRIVATE_KEY: "./missing-updater.key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "update-secret",
      BUILDER_GEAR_UPDATER_PUBKEY: `tauri-updater-public-key-${"a".repeat(80)}`,
      BUILDER_GEAR_UPDATE_ENDPOINT: "https://updates.buildergear.app/builder-gear.json"
    }, {
      channel: "stable",
      tauriConfig: stableReadyTauriConfig()
    })).toEqual(expect.arrayContaining([
      "TAURI_SIGNING_PRIVATE_KEY points to a missing private key file"
    ]));
  });

  it("rejects array-shaped objects in stable updater runtime configuration", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        plugins: [],
        bundle: {
          ...validMetadata.tauriConfig.bundle,
          createUpdaterArtifacts: true
        }
      }
    }, { distributionChannel: "stable" })).toEqual(expect.arrayContaining([
      "Tauri updater plugin configuration is required for the stable distribution channel"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        plugins: {
          updater: []
        },
        bundle: {
          ...validMetadata.tauriConfig.bundle,
          createUpdaterArtifacts: true
        }
      }
    }, { distributionChannel: "stable" })).toEqual(expect.arrayContaining([
      "Tauri updater plugin configuration is required for the stable distribution channel"
    ]));
  });

  it("validates Windows signing certificate input before distribution packaging", () => {
    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "windows", {
      WINDOWS_SIGNING_CERTIFICATE: path.join(tmpdir(), "missing-builder-gear-cert.pfx"),
      WINDOWS_SIGNING_PASSWORD: "super-secret-password"
    })).toEqual(expect.arrayContaining([
      "WINDOWS_SIGNING_CERTIFICATE must point to an existing certificate file or use base64:<pfx>"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "windows", {
      WINDOWS_SIGNING_CERTIFICATE: "base64:not-valid!!",
      WINDOWS_SIGNING_PASSWORD: "super-secret-password"
    })).toEqual(expect.arrayContaining([
      "WINDOWS_SIGNING_CERTIFICATE base64 payload must be valid base64"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "windows", {
      WINDOWS_SIGNING_CERTIFICATE: "base64:AAAA",
      WINDOWS_SIGNING_PASSWORD: "super-secret-password"
    })).toEqual(expect.arrayContaining([
      "WINDOWS_SIGNING_CERTIFICATE base64 payload is too small to be valid signing material"
    ]));

    expect(validateDistributionPreflightEnvironment(validMetadata.distributionPolicy, "windows", {
      WINDOWS_SIGNING_CERTIFICATE: `base64:${fakePfxBase64()}`,
      WINDOWS_SIGNING_PASSWORD: "super-secret-password"
    })).toEqual([]);
  });

  it("accepts complete release metadata", () => {
    expect(validateReleaseMetadata(validMetadata)).toEqual([]);
  });

  it("requires desktop runtime dependencies used by the service shell", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      desktopPackage: {
        ...validMetadata.desktopPackage,
        dependencies: {
          "@tauri-apps/api": "^2.2.0"
        }
      }
    })).toEqual(expect.arrayContaining([
      "desktop dependency is missing: @tauri-apps/plugin-updater"
    ]));
  });

  it("requires every shipped package version to match shipped app metadata", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      cliPackage: {
        name: "@builder/cli",
        version: "0.2.0"
      }
    })).toEqual(expect.arrayContaining([
      "root, core, CLI, desktop, Tauri, and Cargo versions must match"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      cargoPackage: {
        name: "builder-gear-desktop",
        version: "0.2.0"
      }
    })).toEqual(expect.arrayContaining([
      "root, core, CLI, desktop, Tauri, and Cargo versions must match"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      corePackage: {}
    })).toEqual(expect.arrayContaining([
      "root, core, CLI, desktop, Tauri, and Cargo versions are required"
    ]));
  });

  it("requires CLI output and support bundle versions to use the CLI package version", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      cliEntryText: [
        "const CLI_VERSION = \"0.2.0\";",
        "program.version(CLI_VERSION);",
        "createSupportBundle({ appVersion: CLI_VERSION });"
      ].join("\n")
    })).toEqual(expect.arrayContaining([
      "CLI_VERSION must match @builder/cli package version"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      cliEntryText: "const CLI_VERSION = \"0.1.0\";"
    })).toEqual(expect.arrayContaining([
      "CLI --version must use CLI_VERSION",
      "CLI support bundle appVersion must use CLI_VERSION"
    ]));
  });

  it("requires Tauri bundle builds to run the typechecked desktop build", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      desktopPackage: {
        ...validMetadata.desktopPackage,
        scripts: {
          ...validMetadata.desktopPackage.scripts,
          build: "vite build"
        }
      },
      tauriConfig: {
        ...validMetadata.tauriConfig,
        build: {
          ...validMetadata.tauriConfig.build,
          beforeBuildCommand: "pnpm build:web"
        }
      }
    })).toEqual(expect.arrayContaining([
      "desktop build script must typecheck before bundling",
      "Tauri build.beforeBuildCommand must run the desktop build script with typecheck"
    ]));
  });

  it("allows updater artifacts only for the stable distribution channel", () => {
    const stableReadyMetadata = {
      ...validMetadata,
      tauriConfig: stableReadyTauriConfig()
    };

    expect(validateReleaseMetadata(stableReadyMetadata)).toEqual(expect.arrayContaining([
      "Tauri updater artifacts must remain disabled unless the stable distribution channel is selected"
    ]));
    expect(validateReleaseMetadata(stableReadyMetadata, { distributionChannel: "stable" })).toEqual([]);
    expect(validateReleaseMetadata(validMetadata, { distributionChannel: "stable" })).toEqual(expect.arrayContaining([
      "Tauri updater artifacts must be enabled for the stable distribution channel"
    ]));
  });

  it("requires stable channel update signing metadata", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      distributionPolicy: {
        ...validMetadata.distributionPolicy,
        channels: validMetadata.distributionPolicy.channels.map((channel) => channel.id === "stable"
          ? { ...channel, requiredEnvironment: [] }
          : channel)
      }
    })).toEqual(expect.arrayContaining([
      "distribution policy stable channel requiredEnvironment must include TAURI_SIGNING_PRIVATE_KEY",
      "distribution policy stable channel requiredEnvironment must include TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      "distribution policy stable channel requiredEnvironment must include BUILDER_GEAR_UPDATER_PUBKEY",
      "distribution policy stable channel requiredEnvironment must include BUILDER_GEAR_UPDATE_ENDPOINT"
    ]));
  });

  it("keeps release workflow and env examples aligned with distribution policy", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      releaseCandidateWorkflowText: validMetadata.releaseCandidateWorkflowText.replace(
        "  WINDOWS_SIGNING_PASSWORD: ${{ inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_PASSWORD || '' }}\n",
        ""
      ),
      releaseEnvExampleTexts: {
        ...validMetadata.releaseEnvExampleTexts,
        "release/windows.stable.env.example": [
          "WINDOWS_SIGNING_CERTIFICATE=\"<WINDOWS_PFX_FILE_OR_BASE64_PFX>\"",
          "TAURI_SIGNING_PRIVATE_KEY=\"<TAURI_UPDATER_PRIVATE_KEY_FILE_OR_CONTENT>\"",
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\"<TAURI_UPDATER_PRIVATE_KEY_PASSWORD>\"",
          "BUILDER_GEAR_UPDATER_PUBKEY=\"<TAURI_UPDATER_PUBLIC_KEY_CONTENT>\"",
          "BUILDER_GEAR_UPDATE_ENDPOINT=\"<PRODUCTION_HTTPS_STATIC_UPDATER_JSON_URL>\""
        ].join("\n"),
        "release/linux.stable.env.example": [
          "TAURI_SIGNING_PRIVATE_KEY=\"<TAURI_UPDATER_PRIVATE_KEY_FILE_OR_CONTENT>\"",
          "TAURI_SIGNING_PRIVATE_KEY=\"<DUPLICATE>\"",
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\"<TAURI_UPDATER_PRIVATE_KEY_PASSWORD>\"",
          "BUILDER_GEAR_UPDATER_PUBKEY=\"<TAURI_UPDATER_PUBLIC_KEY_CONTENT>\"",
          "BUILDER_GEAR_UPDATE_ENDPOINT=\"<PRODUCTION_HTTPS_STATIC_UPDATER_JSON_URL>\""
        ].join("\n")
      }
    })).toEqual(expect.arrayContaining([
      "release candidate workflow must map distribution env WINDOWS_SIGNING_PASSWORD from windows secrets",
      "release env example release/windows.stable.env.example must include WINDOWS_SIGNING_PASSWORD",
      "release env example release/linux.stable.env.example has duplicate key: TAURI_SIGNING_PRIVATE_KEY"
    ]));
  });

  it("rejects unsafe or incomplete release metadata", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      rootPackage: {
        ...validMetadata.rootPackage,
        scripts: {
          typecheck: "pnpm -r typecheck",
          test: "pnpm -r test",
          build: "pnpm -r build"
        }
      },
      tauriConfig: {
        ...validMetadata.tauriConfig,
        version: "0.2.0",
        identifier: "Builder Gear",
        app: {
          security: {
            csp: null
          }
        }
      }
    })).toEqual(expect.arrayContaining([
      "root script is missing: release:check",
      "root script is missing: security:audit",
      "root script is missing: privacy:scan",
      "root script is missing: ci:policy",
      "root script is missing: license:policy",
      "root script is missing: license:notices",
      "root script is missing: license:notices:check",
      "root script is missing: sbom:generate",
      "root script is missing: sbom:check",
      "root script is missing: icons:generate",
      "root script is missing: release:check:distribution",
      "root script is missing: release:check:stable",
      "root script is missing: release:preflight",
      "root script is missing: release:github-setup",
      "root script is missing: release:github-preflight",
      "root script is missing: release:smoke-bundle",
      "root script is missing: release:stage-upload",
      "root script is missing: release:verify",
      "root script is missing: release:verify-updater",
      "root script is missing: service:readiness",
      "root, core, CLI, desktop, Tauri, and Cargo versions must match",
      "Tauri identifier must be a reverse-DNS identifier",
      "Tauri CSP must be explicit",
      "Tauri devCsp must be explicit so production CSP can stay closed",
      "Tauri security.freezePrototype must be true"
    ]));
  });

  it("keeps localhost development origins out of the production CSP", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        app: {
          security: {
            csp: "default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost http://127.0.0.1:1420 ws://localhost:1420; object-src 'none'; form-action 'none'",
            devCsp: "default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost http://127.0.0.1:1420 ws://127.0.0.1:1420; object-src 'none'; form-action 'none'",
            freezePrototype: true
          }
        }
      }
    })).toEqual(expect.arrayContaining([
      "Tauri production CSP must not allow localhost dev origins"
    ]));
  });

  it("rejects broad or external source expressions in the production CSP", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        app: {
          security: {
            csp: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' asset: http://asset.localhost data:",
              "connect-src ipc: http://ipc.localhost https://api.buildergear.example",
              "font-src *",
              "object-src 'none'",
              "base-uri data:",
              "frame-ancestors 'none'",
              "form-action 'none'"
            ].join("; "),
            devCsp: validMetadata.tauriConfig.app.security.devCsp,
            freezePrototype: true
          }
        }
      }
    })).toEqual(expect.arrayContaining([
      "Tauri production CSP must not use wildcard source expressions",
      "Tauri production CSP must not allow unsafe-eval",
      "Tauri production CSP must not allow external network origins",
      "Tauri production CSP must allow data: only for image sources"
    ]));
  });

  it("allows only Tauri internal production CSP origins for assets and IPC", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        app: {
          security: {
            csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            devCsp: validMetadata.tauriConfig.app.security.devCsp,
            freezePrototype: true
          }
        }
      }
    })).toEqual([]);
  });

  it("requires form blocking and prototype freezing in the desktop WebView", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        app: {
          security: {
            csp: "default-src 'self'; script-src 'self'; object-src 'none'",
            devCsp: "default-src 'self'; script-src 'self'; object-src 'none'",
            freezePrototype: false
          }
        }
      }
    })).toEqual(expect.arrayContaining([
      "Tauri CSP must block form submissions",
      "Tauri security.freezePrototype must be true"
    ]));
  });

  it("keeps Tauri default capability on least-privilege renderer permissions", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriCapability: {
        identifier: "default",
        windows: ["main"],
        permissions: [
          "core:default",
          "dialog:default",
          "updater:default",
          "dialog:allow-save",
          "fs:default"
        ]
      },
      repositoryFiles: validMetadata.repositoryFiles.filter((filePath) => filePath !== "apps/desktop/src-tauri/capabilities/default.json")
    })).toEqual(expect.arrayContaining([
      "Tauri capability file is missing: apps/desktop/src-tauri/capabilities/default.json",
      "Tauri default capability permissions must be exactly: core:event:allow-listen, core:event:allow-unlisten, updater:allow-check, updater:allow-download-and-install",
      "Tauri default capability must not include broad default permission sets",
      "Tauri default capability must not expose filesystem plugin permissions"
    ]));
  });

  it("requires the dependency audit gate to fail on low and higher advisories", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      rootPackage: {
        ...validMetadata.rootPackage,
        scripts: {
          ...validMetadata.rootPackage.scripts,
          "security:audit": "pnpm audit --audit-level high"
        }
      }
    })).toEqual(expect.arrayContaining([
      "root security:audit must fail on low and higher advisories"
    ]));
  });

  it("requires GitHub Actions to be pinned by immutable refs", () => {
    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/pinned.yml",
        content: [
          "jobs:",
          "  test:",
          "    steps:",
          "      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6",
          "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
          "      - uses: ./local-action",
          "      - uses: docker://example/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ].join("\n")
      }
    ])).toEqual([]);

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/pinned.yml",
        content: [
          "jobs:",
          "  test:",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: actions/setup-node",
          "      - uses: docker://example/image:latest"
        ].join("\n")
      }
    ])).toEqual(expect.arrayContaining([
      "workflow action must be pinned to a 40-character commit SHA at .github/workflows/pinned.yml:4: actions/checkout@v4",
      "workflow action must include a ref at .github/workflows/pinned.yml:5: actions/setup-node",
      "workflow Docker action must be pinned by sha256 digest at .github/workflows/pinned.yml:6: docker://example/image:latest"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/pinned.yml",
        content: [
          "jobs:",
          "  test:",
          "    steps:",
          "      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
          "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0"
        ].join("\n")
      }
    ])).toEqual(expect.arrayContaining([
      "workflow action must use a Node 24-compatible actions/checkout@v5 or newer pin at .github/workflows/pinned.yml:4: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "workflow action must use a Node 24-compatible actions/setup-node@v5 or newer pin at .github/workflows/pinned.yml:5: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
    ]));
  });

  it("requires CI to run the release readiness gate across supported desktop platforms", () => {
    const validCiWorkflow = [
      "on:",
      "  pull_request:",
      "  push:",
      "    branches:",
      "      - main",
      "      - \"release/*\"",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  release-readiness:",
      "    timeout-minutes: 30",
      "    strategy:",
      "      matrix:",
      "        os:",
      "          - macos-14",
      "          - windows-2022",
      "          - ubuntu-22.04",
      "    steps:",
      "      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6",
      "        with:",
      "          persist-credentials: false",
      "      - run: pnpm install --frozen-lockfile",
      "      - run: pnpm --filter @builder/desktop exec playwright install chromium",
      "      - run: pnpm release:check:fast",
      "      - run: pnpm release:verify -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json",
      "      - run: pnpm service:readiness -- --manifest apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json --skip-github --skip-updater --json",
      "      - run: pnpm release:stage-upload -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json"
    ].join("\n");

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/ci.yml",
        content: validCiWorkflow
      }
    ])).toEqual([]);

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/ci.yml",
        content: validCiWorkflow
          .replace("          - windows-2022\n", "")
          .replace("      - run: pnpm release:check:fast", "      - run: pnpm test")
          .replace(
            "      - run: pnpm release:verify -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json",
            ""
          )
          .replace(
            "      - run: pnpm service:readiness -- --manifest apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json --skip-github --skip-updater --json",
            ""
          )
          .replace(
            "      - run: pnpm release:stage-upload -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json",
            ""
          )
          .replace("    timeout-minutes: 30\n", "")
      }
    ])).toEqual(expect.arrayContaining([
      "CI workflow must run release readiness on Windows",
      "CI workflow must run the fast release readiness gate",
      "CI workflow must verify the generated release manifest",
      "CI workflow must run the local service readiness audit",
      "CI workflow must stage the verified release upload set",
      "CI workflow release readiness job must have a bounded timeout"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/ci.yml",
        content: validCiWorkflow.replace("          persist-credentials: false", "          persist-credentials: true")
      }
    ])).toEqual(expect.arrayContaining([
      "CI workflow checkout must disable persisted GitHub credentials"
    ]));
  });

  it("requires a manual release candidate workflow for signed artifacts", () => {
    const validReleaseCandidateWorkflow = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      platform:",
      "        type: choice",
      "        options:",
      "          - macos",
      "          - windows",
      "          - linux",
      "      channel:",
      "        type: choice",
      "        options:",
      "          - internal",
      "          - stable",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  ref-guard:",
      "    name: Release ref guard",
      "    runs-on: ubuntu-22.04",
      "    timeout-minutes: 5",
      "    steps:",
      "      - name: Require main or release ref",
      "        run: |",
      "          case \"$GITHUB_REF\" in",
      "            refs/heads/release/*/*)",
      "              exit 1",
      "              ;;",
      "            refs/heads/main|refs/heads/release/*)",
      "              ;;",
      "            *)",
      "              exit 1",
      "              ;;",
      "          esac",
      "  build:",
      "    timeout-minutes: 60",
      "    needs: ref-guard",
      "    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')",
      "    permissions:",
      "      attestations: write",
      "      contents: read",
      "      id-token: write",
      "    env:",
      "      APPLE_SIGNING_IDENTITY: ${{ inputs.platform == 'macos' && secrets.APPLE_SIGNING_IDENTITY || '' }}",
      "      APPLE_CERTIFICATE: ${{ inputs.platform == 'macos' && secrets.APPLE_CERTIFICATE || '' }}",
      "      APPLE_CERTIFICATE_PASSWORD: ${{ inputs.platform == 'macos' && secrets.APPLE_CERTIFICATE_PASSWORD || '' }}",
      "      APPLE_KEYCHAIN_PASSWORD: ${{ inputs.platform == 'macos' && secrets.APPLE_KEYCHAIN_PASSWORD || '' }}",
      "      APPLE_ID: ${{ inputs.platform == 'macos' && secrets.APPLE_ID || '' }}",
      "      APPLE_PASSWORD: ${{ inputs.platform == 'macos' && secrets.APPLE_PASSWORD || '' }}",
      "      APPLE_TEAM_ID: ${{ inputs.platform == 'macos' && secrets.APPLE_TEAM_ID || '' }}",
      "      WINDOWS_SIGNING_CERTIFICATE: ${{ inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_CERTIFICATE || '' }}",
      "      WINDOWS_SIGNING_PASSWORD: ${{ inputs.platform == 'windows' && secrets.WINDOWS_SIGNING_PASSWORD || '' }}",
      "      TAURI_SIGNING_PRIVATE_KEY: ${{ inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY || '' }}",
      "      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ inputs.channel == 'stable' && secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' }}",
      "      BUILDER_GEAR_UPDATER_PUBKEY: ${{ inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATER_PUBKEY || '' }}",
      "      BUILDER_GEAR_UPDATE_ENDPOINT: ${{ inputs.channel == 'stable' && secrets.BUILDER_GEAR_UPDATE_ENDPOINT || '' }}",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - platform: macos",
      "            os: macos-14",
      "          - platform: windows",
      "            os: windows-2022",
      "          - platform: linux",
      "            os: ubuntu-22.04",
      "    steps:",
      "      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6",
      "        with:",
      "          persist-credentials: false",
      "      - name: Validate release environment secrets",
      "        run: |",
      "          required=()",
      "          case \"${{ inputs.platform }}\" in",
      "            macos)",
      "              required+=(APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_KEYCHAIN_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)",
      "              ;;",
      "            windows)",
      "              required+=(WINDOWS_SIGNING_CERTIFICATE WINDOWS_SIGNING_PASSWORD)",
      "              ;;",
      "            linux)",
      "              ;;",
      "          esac",
      "          if [ \"${{ inputs.channel }}\" = \"stable\" ]; then",
      "            required+=(TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD BUILDER_GEAR_UPDATER_PUBKEY BUILDER_GEAR_UPDATE_ENDPOINT)",
      "          fi",
      "          missing=()",
      "          for name in \"${required[@]}\"; do",
      "            if [ -z \"${!name:-}\" ]; then",
      "              missing+=(\"$name\")",
      "            fi",
      "          done",
      "          if [ \"${#missing[@]}\" -gt 0 ]; then",
      "            printf 'Missing release environment secret: %s\\n' \"${missing[@]}\"",
      "            exit 1",
      "          fi",
      "      - run: pnpm install --frozen-lockfile",
      "      - run: pnpm --filter @builder/desktop exec playwright install chromium",
      "      - name: Import Apple signing certificate",
      "        if: inputs.platform == 'macos'",
      "        run: |",
      "          security create-keychain -p \"$APPLE_KEYCHAIN_PASSWORD\" \"$KEYCHAIN_PATH\"",
      "          security import \"$CERTIFICATE_PATH\" -P \"$APPLE_CERTIFICATE_PASSWORD\" -t cert -f pkcs12 -k \"$KEYCHAIN_PATH\"",
      "          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k \"$APPLE_KEYCHAIN_PASSWORD\" \"$KEYCHAIN_PATH\"",
      "          security find-identity -v -p codesigning \"$KEYCHAIN_PATH\" | grep -F \"$APPLE_SIGNING_IDENTITY\"",
      "          rm -f \"$CERTIFICATE_PATH\"",
      "      - run: |",
      "          pnpm release:check:distribution -- --platform \"${{ inputs.platform }}\"",
      "          pnpm release:check:stable -- --platform \"${{ inputs.platform }}\"",
      "          MANIFEST_PATH=\"apps/desktop/src-tauri/target/release/bundle/builder-gear-release-manifest.json\"",
      "          pnpm release:verify -- \"$MANIFEST_PATH\"",
      "          pnpm release:stage-upload -- \"$MANIFEST_PATH\"",
      "      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
      "        with:",
      "          subject-path: apps/desktop/src-tauri/target/release-upload/**",
      "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "        with:",
      "          path: apps/desktop/src-tauri/target/release-upload/**",
      "          if-no-files-found: error",
      "          retention-days: 14",
      "      - name: Remove Apple signing keychain",
      "        if: always() && inputs.platform == 'macos'",
      "        run: |",
      "          CERTIFICATE_PATH=\"$RUNNER_TEMP/builder-gear-signing.p12\"",
      "          KEYCHAIN_PATH=\"$RUNNER_TEMP/builder-gear-signing.keychain-db\"",
      "          rm -f \"$CERTIFICATE_PATH\"",
      "          security default-keychain -s login.keychain-db || true",
      "          security delete-keychain \"$KEYCHAIN_PATH\" || true"
    ].join("\n");

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow
      }
    ])).toEqual([]);

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow.replace("          persist-credentials: false", "          persist-credentials: true")
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow checkout must disable persisted GitHub credentials"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow.replace(
          [
            "      - name: Validate release environment secrets",
            "        run: |",
            "          required=()",
            "          case \"${{ inputs.platform }}\" in",
            "            macos)",
            "              required+=(APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_KEYCHAIN_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)",
            "              ;;",
            "            windows)",
            "              required+=(WINDOWS_SIGNING_CERTIFICATE WINDOWS_SIGNING_PASSWORD)",
            "              ;;",
            "            linux)",
            "              ;;",
            "          esac",
            "          if [ \"${{ inputs.channel }}\" = \"stable\" ]; then",
            "            required+=(TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD BUILDER_GEAR_UPDATER_PUBKEY BUILDER_GEAR_UPDATE_ENDPOINT)",
            "          fi",
            "          missing=()",
            "          for name in \"${required[@]}\"; do",
            "            if [ -z \"${!name:-}\" ]; then",
            "              missing+=(\"$name\")",
            "            fi",
            "          done",
            "          if [ \"${#missing[@]}\" -gt 0 ]; then",
            "            printf 'Missing release environment secret: %s\\n' \"${missing[@]}\"",
            "            exit 1",
            "          fi"
          ].join("\n"),
          ""
        )
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must validate selected release secret names before build",
      "release candidate workflow must report missing release secret names without printing values"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow
          .replace(
            "      - run: pnpm install --frozen-lockfile",
            ""
          )
          .replace(
            "      - name: Validate release environment secrets",
            [
              "      - run: pnpm install --frozen-lockfile",
              "      - name: Validate release environment secrets"
            ].join("\n")
          )
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must validate selected release secret names before dependency install or build"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow.replace(
          "    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')",
          "    if: github.ref != ''"
        )
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must run only from main or release branches"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow
          .replace(
            [
              "  ref-guard:",
              "    name: Release ref guard",
              "    runs-on: ubuntu-22.04",
              "    timeout-minutes: 5",
              "    steps:",
              "      - name: Require main or release ref",
              "        run: |",
              "          case \"$GITHUB_REF\" in",
              "            refs/heads/release/*/*)",
              "              exit 1",
              "              ;;",
              "            refs/heads/main|refs/heads/release/*)",
              "              ;;",
              "            *)",
              "              exit 1",
              "              ;;",
              "          esac"
            ].join("\n"),
            ""
          )
          .replace("    needs: ref-guard\n", "")
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must fail before signing when dispatched from non-release refs",
      "release candidate build job must depend on the release ref guard"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow
          .replace("permissions:\n  contents: read", "permissions:\n  attestations: write\n  contents: read\n  id-token: write")
          .replace(
            [
              "    permissions:",
              "      attestations: write",
              "      contents: read",
              "      id-token: write"
            ].join("\n"),
            "    permissions:\n      contents: read"
          )
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must scope artifact attestation permissions to the build job",
      "release candidate workflow must allow artifact attestation writes",
      "release candidate workflow must allow OIDC tokens for artifact attestations"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow.replace(
          [
            "          CERTIFICATE_PATH=\"$RUNNER_TEMP/builder-gear-signing.p12\"",
            "          KEYCHAIN_PATH=\"$RUNNER_TEMP/builder-gear-signing.keychain-db\"",
            "          rm -f \"$CERTIFICATE_PATH\""
          ].join("\n"),
          [
            "          CERTIFICATE_PATH=\"$RUNNER_TEMP/builder-gear-signing.p12\"",
            "          KEYCHAIN_PATH=\"$RUNNER_TEMP/builder-gear-signing.keychain-db\""
          ].join("\n")
        )
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must delete the temporary Apple signing certificate file"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow.replace(
          "          subject-path: apps/desktop/src-tauri/target/release-upload/**",
          "          subject-path: apps/desktop/src-tauri/target/release/bundle/**"
        )
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must attest staged release files",
      "release candidate workflow must not attest the raw Tauri bundle directory"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: validReleaseCandidateWorkflow
          .replace(
            [
              "      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
              "        with:",
              "          subject-path: apps/desktop/src-tauri/target/release-upload/**"
            ].join("\n"),
            "__ATTEST_STEP__"
          )
          .replace(
            [
              "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
              "        with:",
              "          path: apps/desktop/src-tauri/target/release-upload/**",
              "          if-no-files-found: error",
              "          retention-days: 14"
            ].join("\n"),
            [
              "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
              "        with:",
              "          path: apps/desktop/src-tauri/target/release-upload/**",
              "          if-no-files-found: error",
              "          retention-days: 14",
              "      - uses: actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
              "        with:",
              "          subject-path: apps/desktop/src-tauri/target/release-upload/**"
            ].join("\n")
          )
          .replace("__ATTEST_STEP__", "")
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must attest release artifacts before upload"
    ]));

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/release-candidate.yml",
        content: [
          "on:",
          "  push:",
          "jobs:",
          "  build:",
          "    timeout-minutes: 90",
          "    steps:",
          "      - uses: actions/upload-artifact@v4",
          "        with:",
          "          path: apps/desktop/src-tauri/target/release/bundle/**"
        ].join("\n")
      }
    ])).toEqual(expect.arrayContaining([
      "release candidate workflow must be manually dispatched",
      "release candidate workflow must run the internal distribution gate for the selected platform",
      "release candidate workflow must run the stable distribution gate for the selected platform",
      "release candidate workflow must verify the generated release manifest before upload",
      "release candidate workflow must stage only verified release files before upload",
      "release candidate workflow must validate selected release secret names before build",
      "release candidate workflow must report missing release secret names without printing values",
      "release candidate workflow must allow artifact attestation writes",
      "release candidate workflow must allow OIDC tokens for artifact attestations",
      "release candidate workflow must attest release artifacts",
      "release candidate workflow must attest staged release files",
      "release candidate workflow must fail before signing when dispatched from non-release refs",
      "release candidate build job must depend on the release ref guard",
      "release candidate workflow must run only from main or release branches",
      "release candidate workflow must import the Apple signing certificate on macOS",
      "release candidate workflow must scope Apple certificate import to macOS",
      "release candidate workflow must create an isolated macOS signing keychain",
      "release candidate workflow must import the macOS signing certificate",
      "release candidate workflow must allow codesign to use the imported key",
      "release candidate workflow must verify the imported Apple signing identity",
      "release candidate workflow must remove the temporary Apple signing keychain",
      "release candidate workflow must always clean up the Apple signing keychain on macOS",
      "release candidate workflow must delete the temporary Apple signing certificate file",
      "release candidate workflow must restore the default macOS login keychain",
      "release candidate workflow must delete the temporary Apple signing keychain",
      "release candidate workflow must upload staged release files",
      "release candidate workflow must not upload the raw Tauri bundle directory",
      "release candidate workflow must fail when release artifacts are missing",
      "release candidate workflow must scope Apple signing identity to macOS",
      "release candidate workflow must scope Apple signing certificate to macOS",
      "release candidate workflow must scope Tauri updater private key to stable",
      "release candidate workflow job must have a bounded timeout",
      "release candidate workflow checkout must disable persisted GitHub credentials",
      "workflow action must be pinned to a 40-character commit SHA at .github/workflows/release-candidate.yml:7: actions/upload-artifact@v4"
    ]));
  });

  it("requires a manual stable updater verification workflow after publication", () => {
    const validStableUpdaterWorkflow = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      release_run_id:",
      "        type: string",
      "      platform:",
      "        type: choice",
      "        options:",
      "          - macos",
      "          - windows",
      "          - linux",
      "      verify_downloads:",
      "        type: boolean",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  ref-guard:",
      "    name: Stable updater verification ref guard",
      "    runs-on: ubuntu-22.04",
      "    timeout-minutes: 5",
      "    steps:",
      "      - name: Require main or release ref",
      "        run: |",
      "          case \"$GITHUB_REF\" in",
      "            refs/heads/release/*/*)",
      "              exit 1",
      "              ;;",
      "            refs/heads/main|refs/heads/release/*)",
      "              ;;",
      "            *)",
      "              exit 1",
      "              ;;",
      "          esac",
      "  verify:",
      "    needs: ref-guard",
      "    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')",
      "    runs-on: ubuntu-22.04",
      "    timeout-minutes: 20",
      "    environment:",
      "      name: production",
      "    permissions:",
      "      actions: read",
      "      attestations: read",
      "      contents: read",
      "    steps:",
      "      - name: Validate release candidate run metadata",
      "        id: release-run-metadata",
      "        env:",
      "          GH_TOKEN: ${{ github.token }}",
      "        run: |",
      "          metadata=\"$(gh run view \"${{ inputs.release_run_id }}\" \\",
      "            --repo \"$GITHUB_REPOSITORY\" \\",
      "            --json workflowName,event,conclusion,headBranch,headSha \\",
      "            --jq '[.workflowName, .event, .conclusion, .headBranch, .headSha] | @tsv')\"",
      "          IFS=$'\\t' read -r workflow_name event conclusion head_branch head_sha <<< \"$metadata\"",
      "          if [ \"$workflow_name\" != \"Release Candidate\" ]; then",
      "            exit 1",
      "          fi",
      "          if [ \"$event\" != \"workflow_dispatch\" ]; then",
      "            exit 1",
      "          fi",
      "          if [ \"$conclusion\" != \"success\" ]; then",
      "            exit 1",
      "          fi",
      "          case \"$head_branch\" in",
      "            release/*/*)",
      "              exit 1",
      "              ;;",
      "            main|release/*)",
      "              ;;",
      "            *)",
      "              exit 1",
      "              ;;",
      "          esac",
      "          if ! [[ \"$head_sha\" =~ ^[a-f0-9]{40}$ ]]; then",
      "            exit 1",
      "          fi",
      "          printf 'head_sha=%s\\n' \"$head_sha\" >> \"$GITHUB_OUTPUT\"",
      "          printf 'RELEASE_CANDIDATE_HEAD_SHA=%s\\n' \"$head_sha\" >> \"$GITHUB_ENV\"",
      "      - name: Checkout selected release source",
      "        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6",
      "        with:",
      "          ref: ${{ steps.release-run-metadata.outputs.head_sha }}",
      "          persist-credentials: false",
      "      - run: pnpm install --frozen-lockfile",
      "      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "        with:",
      "          run-id: ${{ inputs.release_run_id }}",
      "          github-token: ${{ github.token }}",
      "          pattern: builder-gear-stable-${{ inputs.platform }}-*",
      "          path: release-candidate-artifact",
      "          merge-multiple: true",
      "      - run: |",
      "          MANIFEST_PATH=\"apps/desktop/src-tauri/target/release/bundle/builder-gear-release-manifest.json\"",
      "          pnpm release:verify -- --artifact-root \"$ARTIFACT_ROOT\" \"$MANIFEST_PATH\"",
      "          MANIFEST_PATH=\"$MANIFEST_PATH\" node --input-type=module <<'NODE'",
      "          const expectedPlatform = process.env.EXPECTED_PLATFORM;",
      "          if (manifest.mode !== \"distribution\" || manifest.channel !== \"stable\" || manifest.includeBundle !== true) {",
      "            process.exit(1);",
      "          }",
      "          if (manifest.platform !== expectedPlatform) {",
      "            process.exit(1);",
      "          }",
      "          const expectedHeadSha = process.env.RELEASE_CANDIDATE_HEAD_SHA;",
      "          if (manifest.git?.commit !== expectedHeadSha) {",
      "            process.exit(1);",
      "          }",
      "          NODE",
      "        env:",
      "          ARTIFACT_ROOT: release-candidate-artifact",
      "          EXPECTED_PLATFORM: ${{ inputs.platform }}",
      "      - run: |",
      "          while IFS= read -r -d '' file; do",
      "            gh attestation verify \"$file\" \\",
      "              --repo \"$GITHUB_REPOSITORY\" \\",
      "              --signer-workflow \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/release-candidate.yml\" \\",
      "              --deny-self-hosted-runners",
      "          done < <(find release-candidate-artifact/apps/desktop/src-tauri/target/release-upload -type f -print0)",
      "        env:",
      "          GH_TOKEN: ${{ github.token }}",
      "      - run: |",
      "          pnpm release:verify-updater -- --artifact-root release-candidate-artifact \"$MANIFEST_PATH\"",
      "          pnpm release:verify-updater -- --artifact-root release-candidate-artifact \"$MANIFEST_PATH\" --verify-downloads",
      "      - run: |",
      "          pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github --json",
      "          pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github --verify-downloads --json"
    ].join("\n");

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/verify-stable-updater.yml",
        content: validStableUpdaterWorkflow
      }
    ])).toEqual([]);

    expect(validateWorkflowActionRefs([
      {
        path: ".github/workflows/verify-stable-updater.yml",
        content: validStableUpdaterWorkflow
          .replace("      actions: read\n", "")
          .replace("      attestations: read\n", "")
          .replace("          metadata=\"$(gh run view \"${{ inputs.release_run_id }}\" \\", "          metadata=\"$(echo \"${{ inputs.release_run_id }}\" \\")
          .replace("            --json workflowName,event,conclusion,headBranch,headSha \\\n", "")
          .replace("          if [ \"$workflow_name\" != \"Release Candidate\" ]; then\n            exit 1\n          fi\n", "")
          .replace("          if [ \"$event\" != \"workflow_dispatch\" ]; then\n            exit 1\n          fi\n", "")
          .replace("          if [ \"$conclusion\" != \"success\" ]; then\n            exit 1\n          fi\n", "")
          .replace("          case \"$head_branch\" in\n            release/*/*)\n              exit 1\n              ;;\n            main|release/*)\n              ;;\n            *)\n              exit 1\n              ;;\n          esac\n", "")
          .replace("          if ! [[ \"$head_sha\" =~ ^[a-f0-9]{40}$ ]]; then\n            exit 1\n          fi\n", "")
          .replace("          printf 'head_sha=%s\\n' \"$head_sha\" >> \"$GITHUB_OUTPUT\"\n", "")
          .replace("          printf 'RELEASE_CANDIDATE_HEAD_SHA=%s\\n' \"$head_sha\" >> \"$GITHUB_ENV\"\n", "")
          .replace("          ref: ${{ steps.release-run-metadata.outputs.head_sha }}\n", "")
          .replace("          if (manifest.mode !== \"distribution\" || manifest.channel !== \"stable\" || manifest.includeBundle !== true) {\n            process.exit(1);\n          }\n", "")
          .replace("          if (manifest.platform !== expectedPlatform) {\n            process.exit(1);\n          }\n", "")
          .replace("          if (manifest.git?.commit !== expectedHeadSha) {\n            process.exit(1);\n          }\n", "")
          .replace("          ARTIFACT_ROOT: release-candidate-artifact\n", "")
          .replace("          EXPECTED_PLATFORM: ${{ inputs.platform }}\n", "")
          .replace("          pattern: builder-gear-stable-${{ inputs.platform }}-*", "          pattern: builder-gear-internal-*")
          .replace("          path: release-candidate-artifact\n", "")
          .replace("          pnpm release:verify -- --artifact-root \"$ARTIFACT_ROOT\" \"$MANIFEST_PATH\"", "          pnpm release:verify -- \"$MANIFEST_PATH\"")
          .replace("          done < <(find release-candidate-artifact/apps/desktop/src-tauri/target/release-upload -type f -print0)", "          done < <(find apps/desktop/src-tauri/target/release-upload -type f -print0)")
          .replace("            gh attestation verify \"$file\" \\", "            echo \"$file\" \\")
          .replace("              --signer-workflow \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/release-candidate.yml\" \\\n", "")
          .replace("          pnpm release:verify-updater -- --artifact-root release-candidate-artifact \"$MANIFEST_PATH\"", "          pnpm release:verify-updater -- \"$MANIFEST_PATH\"")
          .replace("          pnpm release:verify-updater -- --artifact-root release-candidate-artifact \"$MANIFEST_PATH\" --verify-downloads", "")
          .replace("          pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github --json\n", "")
          .replace("          pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github --verify-downloads --json\n", "")
          .replace("          pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github --json", "")
          .replace("          pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest \"$MANIFEST_PATH\" --stable-manifest \"$MANIFEST_PATH\" --skip-github --verify-downloads --json", "")
          .replace("    needs: ref-guard\n", "")
          .replace("    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')\n", "")
          .replace("    timeout-minutes: 20\n", "")
          .replace("          persist-credentials: false", "          persist-credentials: true")
      }
    ])).toEqual(expect.arrayContaining([
      "stable updater verification workflow must allow reading release candidate artifacts",
      "stable updater verification workflow must allow reading release candidate attestations",
      "stable updater verification workflow must inspect the selected release run before download",
      "stable updater verification workflow must read release run workflow, event, conclusion, branch, and commit metadata",
      "stable updater verification workflow must require the Release Candidate workflow",
      "stable updater verification workflow must require manually dispatched release candidates",
      "stable updater verification workflow must require a successful release candidate run",
      "stable updater verification workflow must require release candidate runs from main or release branches",
      "stable updater verification workflow must require a valid release candidate commit SHA",
      "stable updater verification workflow must expose the selected release commit as a step output",
      "stable updater verification workflow must carry the selected release commit into manifest verification",
      "stable updater verification workflow must check out the selected release candidate commit",
      "stable updater verification workflow must isolate downloaded release artifacts from the source checkout",
      "stable updater verification workflow must pass the isolated artifact root into manifest verification",
      "stable updater verification workflow must verify the downloaded release manifest from the isolated artifact root",
      "stable updater verification workflow must pass the requested platform into manifest verification",
      "stable updater verification workflow must require a bundled stable distribution manifest",
      "stable updater verification workflow must require the downloaded manifest platform to match the selected platform",
      "stable updater verification workflow must match the downloaded manifest to the selected release run",
      "stable updater verification workflow must download only stable artifacts for the selected platform",
      "stable updater verification workflow must verify release candidate attestations",
      "stable updater verification workflow must require the release candidate signer workflow",
      "stable updater verification workflow must attest only files from the isolated release upload set",
      "stable updater verification workflow must run the service readiness audit from the isolated artifact root",
      "stable updater verification workflow must support hosted payload SHA-256 verification",
      "stable updater verification job must depend on the release ref guard",
      "stable updater verification workflow must run only from main or release branches",
      "stable updater verification workflow job must have a bounded timeout",
      "stable updater verification workflow checkout must disable persisted GitHub credentials"
    ]));
  });

  it("validates dependency licenses from Node and Rust metadata", () => {
    expect(validateLicensePolicy({
      schemaVersion: 1,
      allowedLicenses: ["MIT", "Apache-2.0", "Unicode-3.0", "Apache-2.0 WITH LLVM-exception"]
    })).toEqual([]);

    expect(validateDependencyLicenses([
      { ecosystem: "node", name: "react", version: "18.3.1", license: "MIT" },
      { ecosystem: "rust", name: "icu", version: "1.0.0", license: "(MIT OR Apache-2.0) AND Unicode-3.0" },
      { ecosystem: "rust", name: "compiler", version: "1.0.0", license: "Apache-2.0 WITH LLVM-exception" },
      { ecosystem: "rust", name: "optional", version: "1.0.0", license: "MIT OR LGPL-2.1-or-later" }
    ], {
      schemaVersion: 1,
      allowedLicenses: ["MIT", "Apache-2.0", "Unicode-3.0", "Apache-2.0 WITH LLVM-exception"]
    })).toEqual([]);

    expect(validateDependencyLicenses([
      { ecosystem: "node", name: "missing", version: "1.0.0", license: null },
      { ecosystem: "rust", name: "copyleft", version: "1.0.0", license: "GPL-3.0-only" }
    ], {
      schemaVersion: 1,
      allowedLicenses: ["MIT"]
    })).toEqual(expect.arrayContaining([
      "dependency license is missing: node:missing@1.0.0",
      "dependency license is not allowed: rust:copyleft@1.0.0 (GPL-3.0-only)"
    ]));

    expect(validateLicensePolicy({
      schemaVersion: 2,
      allowedLicenses: []
    })).toEqual(expect.arrayContaining([
      "license policy schemaVersion must be 1",
      "license policy allowedLicenses must not be empty"
    ]));
  });

  it("renders deterministic third-party notices for release artifacts", () => {
    const notices = renderThirdPartyNotices([
      {
        ecosystem: "rust",
        name: "serde",
        version: "1.0.0",
        license: "MIT OR Apache-2.0",
        repository: "https://github.com/serde-rs/serde"
      },
      {
        ecosystem: "node",
        name: "react",
        version: "18.3.1",
        license: "MIT",
        homepage: "https://react.dev"
      }
    ]);

    expect(notices).toContain("# Third-Party Notices");
    expect(notices).toContain("Total dependencies: 2");
    expect(notices).toContain("- node: 1");
    expect(notices).toContain("- rust: 1");
    expect(notices).toContain("| node | react | 18.3.1 | MIT | https://react.dev |");
    expect(notices).toContain("| rust | serde | 1.0.0 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |");
    expect(notices).toBe(renderThirdPartyNotices([
      {
        ecosystem: "node",
        name: "react",
        version: "18.3.1",
        license: "MIT",
        homepage: "https://react.dev"
      },
      {
        ecosystem: "rust",
        name: "serde",
        version: "1.0.0",
        license: "MIT OR Apache-2.0",
        repository: "https://github.com/serde-rs/serde"
      }
    ]));
  });

  it("renders deterministic CycloneDX SBOM metadata for release artifacts", () => {
    const sbom = renderCycloneDxSbom([
      {
        ecosystem: "rust",
        name: "serde",
        version: "1.0.0",
        license: "MIT OR Apache-2.0",
        repository: "https://github.com/serde-rs/serde"
      },
      {
        ecosystem: "node",
        name: "@scope/package",
        version: "2.0.0",
        license: "MIT",
        homepage: "https://example.com/package"
      }
    ], {
      productName: "Builder Gear",
      version: "0.1.0"
    });
    const parsed = JSON.parse(sbom) as {
      bomFormat: string;
      specVersion: string;
      metadata: {
        component: { name: string; version: string };
      };
      components: Array<{
        "bom-ref": string;
        purl: string;
        licenses: Array<{ expression: string }>;
      }>;
    };

    expect(parsed.bomFormat).toBe("CycloneDX");
    expect(parsed.specVersion).toBe("1.5");
    expect(parsed.metadata.component).toEqual({
      type: "application",
      name: "Builder Gear",
      version: "0.1.0"
    });
    expect(parsed.components.map((component) => component["bom-ref"])).toEqual([
      "node:@scope/package@2.0.0",
      "rust:serde@1.0.0"
    ]);
    expect(parsed.components[0]?.purl).toBe("pkg:npm/%40scope/package@2.0.0");
    expect(parsed.components[1]?.purl).toBe("pkg:cargo/serde@1.0.0");
    expect(parsed.components[1]?.licenses[0]?.expression).toBe("MIT OR Apache-2.0");
    expect(sbom).toBe(renderCycloneDxSbom([
      {
        ecosystem: "node",
        name: "@scope/package",
        version: "2.0.0",
        license: "MIT",
        homepage: "https://example.com/package"
      },
      {
        ecosystem: "rust",
        name: "serde",
        version: "1.0.0",
        license: "MIT OR Apache-2.0",
        repository: "https://github.com/serde-rs/serde"
      }
    ], {
      productName: "Builder Gear",
      version: "0.1.0"
    }));
  });

  it("requires operational files for service readiness", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      repositoryFiles: [
        "SECURITY.md"
      ]
    })).toEqual(expect.arrayContaining([
      "operational file is missing: .gitignore",
      "operational file is missing: .github/dependabot.yml",
      "operational file is missing: .github/workflows/ci.yml",
      "operational file is missing: .github/workflows/release-candidate.yml",
      "operational file is missing: .github/workflows/verify-stable-updater.yml",
      "operational file is missing: release/macos.internal.env.example",
      "operational file is missing: release/macos.stable.env.example",
      "operational file is missing: release/windows.internal.env.example",
      "operational file is missing: release/windows.stable.env.example",
      "operational file is missing: release/linux.internal.env.example",
      "operational file is missing: release/linux.stable.env.example",
      "operational file is missing: release/SBOM.cdx.json",
      "operational file is missing: release/THIRD_PARTY_NOTICES.md",
      "operational file is missing: release/license-policy.json",
      "operational file is missing: release/tauri.stable.conf.json",
      "operational file is missing: scripts/ci-policy.ts",
      "operational file is missing: scripts/cli-smoke.ts",
      "operational file is missing: scripts/desktop-bundle-smoke.ts",
      "operational file is missing: scripts/distribution-preflight.ts",
      "operational file is missing: scripts/github-release-preflight.ts",
      "operational file is missing: scripts/github-release-setup.ts",
      "operational file is missing: scripts/license-data.ts",
      "operational file is missing: scripts/license-notices.ts",
      "operational file is missing: scripts/license-policy.ts",
      "operational file is missing: scripts/privacy-scan.ts",
      "operational file is missing: scripts/release-check.ts",
      "operational file is missing: scripts/sbom.ts",
      "operational file is missing: scripts/release-script-args.ts",
      "operational file is missing: scripts/service-readiness.ts",
      "operational file is missing: scripts/script-file-safety.ts",
      "operational file is missing: scripts/stage-release-upload.ts",
      "operational file is missing: scripts/verify-stable-updater.ts",
      "operational file is missing: scripts/verify-release-manifest.ts",
      "operational file is missing: README.md",
      "operational file is missing: PRIVACY.md"
    ]));
  });

  it("keeps README capability documentation aligned with renderer permissions", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      readmeText: "Tauri capability exposes event listen/unlisten, open-dialog, and explicit updater check/download-install permissions."
    })).toEqual(expect.arrayContaining([
      "README.md must not document renderer open-dialog permission",
      "README.md must document that workspace folder selection is mediated by Rust"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      readmeText: "The renderer uses updater check/download-install permissions only."
    })).toEqual(expect.arrayContaining([
      "README.md must document the current least-privilege Tauri capability boundary",
      "README.md must document that workspace folder selection is mediated by Rust"
    ]));
  });

  it("keeps SECURITY and PRIVACY docs aligned with service privacy boundaries", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      securityText: "Security details are private."
    })).toEqual(expect.arrayContaining([
      "SECURITY.md must document the read-only Codex auth-file boundary",
      "SECURITY.md must document stdin prompt delivery instead of argv prompts",
      "SECURITY.md must document distribution preflight and stable updater verification",
      "SECURITY.md must document diagnostics and support-bundle privacy exclusions"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      privacyText: "Privacy details are private."
    })).toEqual(expect.arrayContaining([
      "PRIVACY.md must document the local-first data model",
      "PRIVACY.md must document the read-only Codex auth-file boundary",
      "PRIVACY.md must document stdin prompt delivery instead of command-line prompt storage",
      "PRIVACY.md must document diagnostics privacy exclusions",
      "PRIVACY.md must document support-bundle privacy exclusions",
      "PRIVACY.md must document the MVP network boundary"
    ]));
  });

  it("requires Dependabot to monitor service dependency surfaces", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      dependabotConfigText: [
        "version: 2",
        "updates:",
        "  - package-ecosystem: npm",
        "    directory: /",
        "    schedule:",
        "      interval: monthly",
        "    open-pull-requests-limit: 0"
      ].join("\n")
    })).toEqual(expect.arrayContaining([
      "Dependabot config must check npm dependencies at / weekly",
      "Dependabot config must bound open pull requests for npm dependencies at /",
      "Dependabot config must monitor Cargo dependencies at /apps/desktop/src-tauri",
      "Dependabot config must monitor GitHub Actions dependencies at /"
    ]));
  });

  it("requires .gitignore to exclude local runtime and build state", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      gitignoreText: validMetadata.gitignoreText
        .split("\n")
        .filter((line) => line !== ".builder/" && line !== "*.sqlite-wal" && line !== "release-candidate-artifact/" && line !== "*.tgz")
        .join("\n")
    })).toEqual(expect.arrayContaining([
      ".gitignore must ignore local runtime or build state: .builder/",
      ".gitignore must ignore local runtime or build state: *.sqlite-wal",
      ".gitignore must ignore local runtime or build state: release-candidate-artifact/",
      ".gitignore must ignore local runtime or build state: *.tgz"
    ]));
  });

  it("requires production app icon assets in the Tauri bundle", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      tauriConfig: {
        ...validMetadata.tauriConfig,
        bundle: {
          ...validMetadata.tauriConfig.bundle,
          icon: [
            "icons/icon.png"
          ]
        }
      },
      repositoryFiles: validMetadata.repositoryFiles.filter((filePath) => filePath !== "apps/desktop/src-tauri/icons/icon.ico")
    })).toEqual(expect.arrayContaining([
      "Tauri bundle.icon must include icons/32x32.png",
      "Tauri bundle.icon must include icons/128x128.png",
      "Tauri bundle.icon must include icons/128x128@2x.png",
      "Tauri bundle.icon must include icons/icon.icns",
      "Tauri bundle.icon must include icons/icon.ico",
      "Tauri bundle icon is missing: apps/desktop/src-tauri/icons/icon.ico"
    ]));
  });

  it("requires macOS entitlements policy to match the checked-in Tauri entitlement file", () => {
    expect(validateReleaseMetadata({
      ...validMetadata,
      repositoryFiles: [
        ".github/workflows/ci.yml",
        "PRIVACY.md",
        "SECURITY.md"
      ]
    })).toEqual(expect.arrayContaining([
      "Tauri macOS entitlements file is missing: apps/desktop/src-tauri/entitlements.plist"
    ]));

    expect(validateReleaseMetadata({
      ...validMetadata,
      distributionPolicy: {
        ...validMetadata.distributionPolicy,
        macOS: {
          ...validMetadata.distributionPolicy.macOS,
          entitlements: "apps/desktop/src-tauri/stale-entitlements.plist"
        }
      }
    })).toEqual(expect.arrayContaining([
      "distribution policy macOS entitlements path must match Tauri config"
    ]));
  });

  it("accepts a complete release manifest for executed gates", () => {
    const gateIds = releaseCheckCommands().map((command) => command.id);

    expect(validateReleaseManifest({
      schemaVersion: 1,
      generatedAt: "2026-06-24T00:00:00.000Z",
      mode: "debug",
      platform: "macos",
      arch: "aarch64",
      includeBundle: true,
      versions: {
        root: "0.1.0",
        core: "0.1.0",
        cli: "0.1.0",
        desktop: "0.1.0",
        tauri: "0.1.0",
        cargo: "0.1.0"
      },
      packageManager: "pnpm@10.26.1",
      productName: "Builder Gear",
      identifier: "com.buildergear.desktop",
      git: {
        commit: null,
        dirty: true
      },
      gateIds,
      buildInputs: {
        tauriConfigSha256: "e".repeat(64)
      },
      artifacts: [
        {
          path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
          sha256: "a".repeat(64)
        }
      ],
      inventory: inventoryReferenceFixture(13)
    }, gateIds)).toEqual([]);
  });

  it("requires distribution manifests to declare their channel", () => {
    const gateIds = releaseCheckCommands({ distribution: true }).map((command) => command.id);
    const manifest = releaseManifestFixture({
      mode: "distribution",
      channel: "internal",
      includeBundle: false,
      git: {
        commit: "a".repeat(40),
        dirty: false
      },
      gateIds
    });

    expect(validateReleaseManifest(manifest, gateIds)).toEqual([]);
    expect(validateReleaseManifest({
      ...manifest,
      channel: undefined
    }, gateIds)).toEqual(expect.arrayContaining([
      "release manifest distribution channel is required"
    ]));
    expect(validateReleaseManifest({
      ...releaseManifestFixture(),
      channel: "internal"
    }, releaseCheckCommands().map((command) => command.id))).toEqual(expect.arrayContaining([
      "release manifest debug mode must not declare a distribution channel"
    ]));
  });

  it("requires stable release manifests to include updater payloads and signatures", () => {
    const gateIds = releaseCheckCommands({ distribution: true, channel: "stable" }).map((command) => command.id);
    const manifest = releaseManifestFixture({
      mode: "distribution",
      channel: "stable",
      includeBundle: true,
      arch: "aarch64",
      git: {
        commit: "a".repeat(40),
        dirty: false
      },
      gateIds,
      buildInputs: stableBuildInputs(),
      artifacts: [
        {
          path: "apps/desktop/src-tauri/target/release/bundle/macos/Builder Gear.app",
          sha256: "a".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/macos/Builder Gear_0.1.0_aarch64.dmg",
          sha256: "b".repeat(64)
        }
      ]
    });

    expect(validateReleaseManifest(manifest, gateIds)).toEqual(expect.arrayContaining([
      "stable release manifest is missing macOS updater payload",
      "stable release manifest is missing macOS updater signature",
      "stable release manifest is missing Tauri updater static JSON feed"
    ]));
    expect(validateReleaseManifest({
      ...manifest,
      artifacts: [
        ...manifest.artifacts,
        {
          path: "apps/desktop/src-tauri/target/release/bundle/macos/Builder Gear.app.tar.gz",
          sha256: "c".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/macos/Builder Gear.app.tar.gz.sig",
          sha256: "d".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-updater-latest.json",
          sha256: "e".repeat(64)
        }
      ]
    }, gateIds)).toEqual([]);
  });

  it("requires stable Windows and Linux manifests to include updater payloads with signatures", () => {
    const windowsGateIds = releaseCheckCommands({ distribution: true, channel: "stable", platform: "windows" }).map((command) => command.id);
    const windowsManifest = releaseManifestFixture({
      mode: "distribution",
      channel: "stable",
      platform: "windows",
      arch: "x86_64",
      git: {
        commit: "a".repeat(40),
        dirty: false
      },
      gateIds: windowsGateIds,
      buildInputs: stableBuildInputs(),
      artifacts: [
        {
          path: "apps/desktop/src-tauri/target/release/bundle/msi/Builder Gear_0.1.0_x64_en-US.msi.sig",
          sha256: "a".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/nsis/Builder Gear_0.1.0_x64-setup.exe.sig",
          sha256: "b".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/builder-gear-updater-latest.json",
          sha256: "c".repeat(64)
        }
      ]
    });

    expect(validateReleaseManifest(windowsManifest, windowsGateIds)).toEqual(expect.arrayContaining([
      "stable release manifest is missing Windows MSI updater payload",
      "stable release manifest is missing Windows NSIS updater payload"
    ]));
    expect(validateReleaseManifest({
      ...windowsManifest,
      artifacts: [
        ...windowsManifest.artifacts,
        {
          path: "apps/desktop/src-tauri/target/release/bundle/msi/Builder Gear_0.1.0_x64_en-US.msi",
          sha256: "d".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/nsis/Builder Gear_0.1.0_x64-setup.exe",
          sha256: "e".repeat(64)
        }
      ]
    }, windowsGateIds)).toEqual([]);

    const linuxGateIds = releaseCheckCommands({ distribution: true, channel: "stable", platform: "linux" }).map((command) => command.id);
    const linuxManifest = releaseManifestFixture({
      mode: "distribution",
      channel: "stable",
      platform: "linux",
      arch: "x86_64",
      git: {
        commit: "a".repeat(40),
        dirty: false
      },
      gateIds: linuxGateIds,
      buildInputs: stableBuildInputs(),
      artifacts: [
        {
          path: "apps/desktop/src-tauri/target/release/bundle/appimage/Builder Gear_0.1.0_amd64.AppImage.sig",
          sha256: "a".repeat(64)
        },
        {
          path: "apps/desktop/src-tauri/target/release/bundle/builder-gear-updater-latest.json",
          sha256: "b".repeat(64)
        }
      ]
    });

    expect(validateReleaseManifest(linuxManifest, linuxGateIds)).toEqual(expect.arrayContaining([
      "stable release manifest is missing Linux AppImage updater payload"
    ]));
    expect(validateReleaseManifest({
      ...linuxManifest,
      artifacts: [
        ...linuxManifest.artifacts,
        {
          path: "apps/desktop/src-tauri/target/release/bundle/appimage/Builder Gear_0.1.0_amd64.AppImage",
          sha256: "c".repeat(64)
        }
      ]
    }, linuxGateIds)).toEqual([]);
  });

  it("requires stable release manifests to record updater build inputs", () => {
    const gateIds = releaseCheckCommands({ distribution: true, channel: "stable" }).map((command) => command.id);
    const stableManifest = releaseManifestFixture({
      mode: "distribution",
      channel: "stable",
      includeBundle: false,
      git: {
        commit: "a".repeat(40),
        dirty: false
      },
      gateIds
    });

    expect(validateReleaseManifest(stableManifest, gateIds)).toEqual(expect.arrayContaining([
      "stable release manifest must include updater build inputs"
    ]));
    expect(validateReleaseManifest({
      ...stableManifest,
      buildInputs: {
        tauriConfigSha256: "e".repeat(64),
        stableUpdater: {
          pubkeySha256: "f".repeat(64),
          endpoints: ["http://localhost:1420/latest.json?token=secret"]
        }
      }
    }, gateIds)).toEqual(expect.arrayContaining([
      "stable release manifest updater endpoint must use HTTPS",
      "stable release manifest updater endpoint must not include a URL query string",
      "stable release manifest updater endpoint must not point at localhost or a loopback address"
    ]));
    expect(validateReleaseManifest({
      ...stableManifest,
      buildInputs: stableBuildInputs()
    }, gateIds)).toEqual([]);
    expect(validateReleaseManifest({
      ...releaseManifestFixture(),
      buildInputs: stableBuildInputs()
    }, releaseCheckCommands().map((command) => command.id))).toEqual(expect.arrayContaining([
      "release manifest stable updater build inputs must not be declared outside the stable channel"
    ]));
  });

  it("reports malformed release evidence without throwing", () => {
    const malformedManifest = {
      schemaVersion: 1,
      generatedAt: "not-a-date",
      mode: "debug",
      platform: "macos",
      includeBundle: true,
      versions: null,
      gateIds: "typecheck",
      buildInputs: null,
      artifacts: null,
      inventory: {
        path: "",
        sha256: "not-a-sha",
        entryCount: 0
      }
    } as unknown as ReleaseManifest;
    const malformedProvenance = {
      schemaVersion: 1,
      generatedAt: "not-a-date",
      gateIds: "typecheck",
      files: [null, "bad"]
    } as unknown as ReleaseProvenance;
    const malformedInventory = {
      schemaVersion: 1,
      generatedAt: "not-a-date",
      gateIds: "typecheck",
      entries: "bad"
    } as unknown as ReturnType<typeof releaseInventoryFixture>;

    expect(() => validateReleaseManifest(malformedManifest, ["typecheck"])).not.toThrow();
    expect(validateReleaseManifest(malformedManifest, ["typecheck"])).toEqual(expect.arrayContaining([
      "release manifest versions are required",
      "release manifest gateIds must be an array of strings",
      "release manifest buildInputs are required",
      "release manifest artifacts must be an array"
    ]));
    expect(() => verifyReleaseManifestArtifacts({
      manifest: malformedManifest,
      rootDir: tmpdir(),
      expectedGateIds: ["typecheck"]
    })).not.toThrow();

    expect(() => validateReleaseProvenance(malformedProvenance, malformedManifest, ["typecheck"])).not.toThrow();
    expect(validateReleaseProvenance(malformedProvenance, malformedManifest, ["typecheck"])).toEqual(expect.arrayContaining([
      "release provenance generatedAt must be an ISO timestamp",
      "release provenance gateIds must be an array of strings",
      "release provenance file kind is invalid: "
    ]));

    expect(() => validateReleaseInventory(malformedInventory, malformedManifest)).not.toThrow();
    expect(validateReleaseInventory(malformedInventory, malformedManifest)).toEqual(expect.arrayContaining([
      "release inventory generatedAt must be an ISO timestamp",
      "release inventory gateIds must be an array of strings",
      "release inventory entries must be an array"
    ]));
  });

  it("requires distribution releases to come from a clean committed git state", () => {
    const gateIds = releaseCheckCommands({ distribution: true }).map((command) => command.id);

    expect(validateReleaseGitState({ commit: "a".repeat(40), dirty: false }, "distribution")).toEqual([]);
    expect(validateReleaseGitState({ commit: null, dirty: false }, "distribution")).toEqual(expect.arrayContaining([
      "distribution release requires a git commit"
    ]));
    expect(validateReleaseGitState({ commit: "abc123", dirty: false }, "distribution")).toEqual(expect.arrayContaining([
      "release manifest git.commit must be a full 40-character lowercase SHA"
    ]));
    expect(validateReleaseGitState({ commit: "a".repeat(40), dirty: true }, "distribution")).toEqual(expect.arrayContaining([
      "distribution release requires a clean git worktree"
    ]));

    expect(validateReleaseManifest(releaseManifestFixture({
      mode: "distribution",
      channel: "internal",
      includeBundle: false,
      gateIds,
      git: {
        commit: "a".repeat(40),
        dirty: true
      }
    }), gateIds)).toEqual(expect.arrayContaining([
      "distribution release requires a clean git worktree"
    ]));
  });

  it("rejects release manifests with missing artifacts or stale gate order", () => {
    expect(validateReleaseManifest({
      schemaVersion: 1,
      generatedAt: "not a date",
      mode: "debug",
      platform: "plan9" as "macos",
      arch: "sparc" as "aarch64",
      includeBundle: true,
      versions: {
        root: "0.1.0",
        core: "0.1.0",
        cli: "0.1.0",
        desktop: "0.2.0",
        tauri: "0.1.0",
        cargo: "0.1.0"
      },
      packageManager: "",
      productName: "Builder Gear",
      identifier: "com.buildergear.desktop",
      git: {
        commit: "abc",
        dirty: false
      },
      gateIds: ["typecheck"],
      buildInputs: {
        tauriConfigSha256: "e".repeat(64)
      },
      artifacts: [],
      inventory: inventoryReferenceFixture(0)
    }, ["typecheck", "unit-tests"])).toEqual(expect.arrayContaining([
      "release manifest generatedAt must be an ISO timestamp",
      "release manifest platform is invalid",
      "release manifest arch is invalid",
      "release manifest versions must match",
      "release manifest packageManager is required",
      "release manifest git.commit must be a full 40-character lowercase SHA",
      "release manifest gateIds must match the executed release gate order",
      "release manifest must include artifacts when bundle checks run"
    ]));
  });

  it("verifies release artifact paths and hashes against the current filesystem", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-release-"));

    try {
      mkdirSync(path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app", "Contents"), { recursive: true });
      writeFileSync(path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app", "Contents", "Info.plist"), "bundle");
      const artifactPath = path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app");
      const manifest = releaseManifestFixture({
        artifacts: [
          {
            path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
            sha256: hashReleaseArtifactPath(artifactPath)
          }
        ]
      });
      const manifestWithInventory = attachInventoryFixture(root, manifest);

      expect(resolveReleaseArtifactPath(root, "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app")).toBe(artifactPath);
      expect(verifyReleaseManifestArtifacts({
        manifest: manifestWithInventory,
        rootDir: root,
        expectedGateIds: manifestWithInventory.gateIds
      })).toEqual([]);

      writeFileSync(path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app", "Contents", "Info.plist"), "tampered");
      expect(verifyReleaseManifestArtifacts({
        manifest: manifestWithInventory,
        rootDir: root,
        expectedGateIds: manifestWithInventory.gateIds
      })).toEqual(expect.arrayContaining([
        "release manifest artifact sha256 mismatch: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects release artifact directory symlinks that escape the artifact root", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-release-"));

    try {
      const artifactPath = path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app");
      mkdirSync(path.join(artifactPath, "Contents"), { recursive: true });
      writeFileSync(path.join(artifactPath, "Contents", "Info.plist"), "bundle");
      symlinkSync("Contents/Info.plist", path.join(artifactPath, "InfoAlias.plist"));

      expect(hashReleaseArtifactPath(artifactPath)).toMatch(/^[a-f0-9]{64}$/);

      writeFileSync(path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "shared-secret.txt"), "outside");
      symlinkSync("../shared-secret.txt", path.join(artifactPath, "ExternalAlias.txt"));

      expect(() => hashReleaseArtifactPath(artifactPath)).toThrow(
        "artifact directory contains symlink escaping artifact root: ExternalAlias.txt"
      );

      const manifest = releaseManifestFixture({
        artifacts: [
          {
            path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
            sha256: "a".repeat(64)
          }
        ]
      });
      const manifestWithInventory = attachInventoryFixture(root, manifest);

      expect(verifyReleaseManifestArtifacts({
        manifest: manifestWithInventory,
        rootDir: root,
        expectedGateIds: manifestWithInventory.gateIds
      })).toEqual(expect.arrayContaining([
        "release manifest artifact could not be hashed: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app: artifact directory contains symlink escaping artifact root: ExternalAlias.txt",
        "release inventory entry could not be hashed: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app: artifact directory contains symlink escaping artifact root: ExternalAlias.txt"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute symlinks inside release artifact directories", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-release-"));

    try {
      const artifactPath = path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app");
      const infoPlistPath = path.join(artifactPath, "Contents", "Info.plist");
      mkdirSync(path.dirname(infoPlistPath), { recursive: true });
      writeFileSync(infoPlistPath, "bundle");
      symlinkSync(infoPlistPath, path.join(artifactPath, "AbsoluteAlias.plist"));

      expect(() => hashReleaseArtifactPath(artifactPath)).toThrow(
        "artifact directory contains absolute symlink: AbsoluteAlias.plist"
      );

      const manifest = releaseManifestFixture({
        artifacts: [
          {
            path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
            sha256: "a".repeat(64)
          }
        ]
      });
      const manifestWithInventory = attachInventoryFixture(root, manifest);

      expect(verifyReleaseManifestArtifacts({
        manifest: manifestWithInventory,
        rootDir: root,
        expectedGateIds: manifestWithInventory.gateIds
      })).toEqual(expect.arrayContaining([
        "release manifest artifact could not be hashed: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app: artifact directory contains absolute symlink: AbsoluteAlias.plist",
        "release inventory entry could not be hashed: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app: artifact directory contains absolute symlink: AbsoluteAlias.plist"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported filesystem entries inside release artifact directories", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-release-"));

    try {
      const artifactPath = path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app");
      const infoPlistPath = path.join(artifactPath, "Contents", "Info.plist");
      mkdirSync(path.dirname(infoPlistPath), { recursive: true });
      writeFileSync(infoPlistPath, "bundle");

      try {
        execFileSync("mkfifo", [path.join(artifactPath, "BuildPipe")]);
      } catch {
        return;
      }

      expect(() => hashReleaseArtifactPath(artifactPath)).toThrow(
        "artifact directory contains unsupported entry: BuildPipe"
      );

      const manifest = releaseManifestFixture({
        artifacts: [
          {
            path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
            sha256: "a".repeat(64)
          }
        ]
      });
      const manifestWithInventory = attachInventoryFixture(root, manifest);

      expect(verifyReleaseManifestArtifacts({
        manifest: manifestWithInventory,
        rootDir: root,
        expectedGateIds: manifestWithInventory.gateIds
      })).toEqual(expect.arrayContaining([
        "release manifest artifact could not be hashed: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app: artifact directory contains unsupported entry: BuildPipe",
        "release inventory entry could not be hashed: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app: artifact directory contains unsupported entry: BuildPipe"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects release artifact paths that are missing, duplicated, or outside the repository", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-release-"));

    try {
      const manifest = releaseManifestFixture({
        artifacts: [
          {
            path: "../outside.app",
            sha256: "a".repeat(64)
          },
          {
            path: "missing.app",
            sha256: "b".repeat(64)
          },
          {
            path: "missing.app",
            sha256: "b".repeat(64)
          }
        ]
      });
      const manifestWithInventory = attachInventoryFixture(root, manifest);

      expect(resolveReleaseArtifactPath(root, "../outside.app")).toBeUndefined();
      expect(resolveReleaseArtifactPath(root, path.join(root, "apps/desktop/src-tauri/target/debug/bundle/macos", "Builder Gear.app"))).toBeUndefined();
      expect(resolveReleaseArtifactPath(root, "artifacts\\Builder Gear.app")).toBeUndefined();
      expect(resolveReleaseArtifactPath(root, "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app\0extra")).toBeUndefined();
      expect(verifyReleaseManifestArtifacts({
        manifest: manifestWithInventory,
        rootDir: root,
        expectedGateIds: manifestWithInventory.gateIds
      })).toEqual(expect.arrayContaining([
        "release manifest artifact path escapes repository root: ../outside.app",
        "release manifest artifact is missing: missing.app",
        "release manifest artifact path is duplicated: missing.app"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects release artifact paths outside the expected bundle root", () => {
    const gateIds = releaseCheckCommands({ includeBundle: false }).map((command) => command.id);

    expect(validateReleaseManifest(releaseManifestFixture({
      includeBundle: false,
      gateIds,
      artifacts: [
        {
          path: "package.json",
          sha256: "a".repeat(64)
        }
      ]
    }), gateIds)).toEqual(expect.arrayContaining([
      "release manifest must not include artifacts when bundle checks are skipped"
    ]));

    expect(validateReleaseManifest(releaseManifestFixture({
      artifacts: [
        {
          path: "package.json",
          sha256: "a".repeat(64)
        }
      ]
    }), releaseCheckCommands().map((command) => command.id))).toEqual(expect.arrayContaining([
      "release manifest artifact must be under apps/desktop/src-tauri/target/debug/bundle/macos: package.json"
    ]));

    const distributionGateIds = releaseCheckCommands({ distribution: true, platform: "windows" }).map((command) => command.id);
    expect(validateReleaseManifest(releaseManifestFixture({
      mode: "distribution",
      channel: "internal",
      platform: "windows",
      arch: "x86_64",
      git: {
        commit: "a".repeat(40),
        dirty: false
      },
      gateIds: distributionGateIds,
      artifacts: [
        {
          path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
          sha256: "a".repeat(64)
        }
      ]
    }), distributionGateIds)).toEqual(expect.arrayContaining([
      "release manifest artifact must be under apps/desktop/src-tauri/target/release/bundle: apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app"
    ]));
  });

  it("verifies inventory source entries from checkout root and artifact entries from artifact root", () => {
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "builder-gear-source-root-"));
    const artifactRoot = mkdtempSync(path.join(tmpdir(), "builder-gear-artifact-root-"));

    try {
      mkdirSync(path.join(sourceRoot, "packages/core"), { recursive: true });
      mkdirSync(path.join(artifactRoot, "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app"), { recursive: true });
      const sourcePath = path.join(sourceRoot, "packages/core/package.json");
      const artifactPath = path.join(artifactRoot, "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app/Info.plist");
      writeFileSync(sourcePath, "{\"name\":\"@builder/core\"}\n");
      writeFileSync(artifactPath, "bundle");

      const inventory = {
        schemaVersion: 1 as const,
        generatedAt: "2026-06-24T00:00:00.000Z",
        productName: "Builder Gear",
        version: "0.1.0",
        platform: "macos" as const,
        mode: "debug" as const,
        gateIds: ["typecheck"],
        entries: [
          {
            kind: "source" as const,
            path: "packages/core/package.json",
            sha256: hashReleaseArtifactPath(sourcePath)
          },
          {
            kind: "artifact" as const,
            path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app/Info.plist",
            sha256: hashReleaseArtifactPath(artifactPath)
          }
        ]
      };

      expect(verifyReleaseInventoryEntries(inventory, sourceRoot, artifactRoot)).toEqual([]);
      expect(verifyReleaseInventoryEntries(inventory, artifactRoot, artifactRoot)).toEqual(expect.arrayContaining([
        "release inventory entry is missing: packages/core/package.json"
      ]));
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("verifies release provenance against manifest files and hashes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-provenance-"));

    try {
      const outputDir = path.join(root, "target", "release-readiness");
      const releaseDir = path.join(root, "release");
      mkdirSync(outputDir, { recursive: true });
      mkdirSync(releaseDir, { recursive: true });

      const inventoryPath = path.join(outputDir, "builder-gear-release-inventory.json");
      const manifestPath = path.join(outputDir, "builder-gear-release-manifest.json");
      const sbomPath = path.join(releaseDir, "SBOM.cdx.json");
      const noticesPath = path.join(releaseDir, "THIRD_PARTY_NOTICES.md");
      const distributionPolicyPath = path.join(releaseDir, "distribution-policy.json");
      const licensePolicyPath = path.join(releaseDir, "license-policy.json");
      const dependabotPath = path.join(root, ".github", "dependabot.yml");

      mkdirSync(path.dirname(dependabotPath), { recursive: true });
      writeFileSync(inventoryPath, "{\"schemaVersion\":1,\"entries\":[]}\n");
      writeFileSync(sbomPath, "{\"bomFormat\":\"CycloneDX\"}\n");
      writeFileSync(noticesPath, "# Third-Party Notices\n");
      writeFileSync(distributionPolicyPath, "{\"schemaVersion\":1}\n");
      writeFileSync(licensePolicyPath, "{\"schemaVersion\":1}\n");
      writeFileSync(dependabotPath, "version: 2\nupdates: []\n");

      const manifest = releaseManifestFixture({
        includeBundle: false,
        inventory: {
          path: "target/release-readiness/builder-gear-release-inventory.json",
          sha256: hashReleaseArtifactPath(inventoryPath),
          entryCount: 1
        }
      });
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const provenance: ReleaseProvenance = {
        schemaVersion: 1,
        generatedAt: "2026-06-24T00:00:00.000Z",
        productName: manifest.productName,
        version: manifest.versions.root,
        mode: manifest.mode,
        platform: manifest.platform,
        channel: manifest.channel,
        git: manifest.git,
        gateIds: manifest.gateIds,
        files: [
          { kind: "manifest", path: "target/release-readiness/builder-gear-release-manifest.json", sha256: hashReleaseArtifactPath(manifestPath) },
          { kind: "inventory", path: manifest.inventory.path, sha256: manifest.inventory.sha256, entryCount: manifest.inventory.entryCount },
          { kind: "sbom", path: "release/SBOM.cdx.json", sha256: hashReleaseArtifactPath(sbomPath) },
          { kind: "notices", path: "release/THIRD_PARTY_NOTICES.md", sha256: hashReleaseArtifactPath(noticesPath) },
          { kind: "policy", path: ".github/dependabot.yml", sha256: hashReleaseArtifactPath(dependabotPath) },
          { kind: "policy", path: "release/distribution-policy.json", sha256: hashReleaseArtifactPath(distributionPolicyPath) },
          { kind: "policy", path: "release/license-policy.json", sha256: hashReleaseArtifactPath(licensePolicyPath) }
        ]
      };

      expect(validateReleaseProvenance(provenance, manifest, manifest.gateIds)).toEqual([]);
      expect(verifyReleaseProvenanceArtifacts({
        provenance,
        manifest,
        rootDir: root,
        expectedGateIds: manifest.gateIds,
        expectedManifestPath: "target/release-readiness/builder-gear-release-manifest.json"
      })).toEqual([]);
      expect(verifyReleaseProvenanceArtifacts({
        provenance,
        manifest,
        rootDir: root,
        expectedGateIds: manifest.gateIds,
        expectedManifestPath: "target/other/builder-gear-release-manifest.json"
      })).toEqual(expect.arrayContaining([
        "release provenance manifest file must match verified manifest: target/other/builder-gear-release-manifest.json"
      ]));

      writeFileSync(sbomPath, "{\"bomFormat\":\"tampered\"}\n");
      expect(verifyReleaseProvenanceArtifacts({
        provenance,
        manifest,
        rootDir: root,
        expectedGateIds: manifest.gateIds
      })).toEqual(expect.arrayContaining([
        "release provenance file sha256 mismatch: release/SBOM.cdx.json"
      ]));

      rmSync(sbomPath, { recursive: true, force: true });
      mkdirSync(sbomPath);
      rmSync(noticesPath, { recursive: true, force: true });
      symlinkSync("distribution-policy.json", noticesPath);
      expect(verifyReleaseProvenanceArtifacts({
        provenance,
        manifest,
        rootDir: root,
        expectedGateIds: manifest.gateIds
      })).toEqual(expect.arrayContaining([
        "release provenance sbom file must be a regular file: release/SBOM.cdx.json",
        "release provenance notices file must not be a symlink: release/THIRD_PARTY_NOTICES.md"
      ]));
      expect(validateReleaseProvenance({
        ...provenance,
        version: "9.9.9",
        gateIds: ["typecheck"],
        files: []
      }, manifest, manifest.gateIds)).toEqual(expect.arrayContaining([
        "release provenance version must match manifest",
        "release provenance gateIds must match the executed release gate order",
        "release provenance files are required"
      ]));
      expect(validateReleaseProvenance({
        ...provenance,
        files: [
          ...provenance.files,
          { kind: "manifest", path: "target/other/builder-gear-release-manifest.json", sha256: "4".repeat(64) },
          { kind: "artifact", path: "apps/desktop/src-tauri/target/release/bundle/macos/extra.dmg", sha256: "7".repeat(64) },
          { kind: "policy", path: "README.md", sha256: "9".repeat(64) },
          { kind: "policy", path: ".builder/local-state.json", sha256: "8".repeat(64) },
          { kind: "policy", path: "release-candidate-artifact/provenance.json", sha256: "8".repeat(64) },
          { kind: "policy", path: "builder-gear-0.1.0.tgz", sha256: "8".repeat(64) }
        ]
      }, manifest, manifest.gateIds)).toEqual(expect.arrayContaining([
        "release provenance must include exactly one manifest file",
        "release provenance has artifact file not declared in manifest: apps/desktop/src-tauri/target/release/bundle/macos/extra.dmg",
        "release provenance has undeclared policy file: README.md",
        "release provenance has undeclared policy file: .builder/local-state.json",
        "release provenance has undeclared policy file: release-candidate-artifact/provenance.json",
        "release provenance has undeclared policy file: builder-gear-0.1.0.tgz",
        "release provenance must not include local runtime state: .builder/local-state.json",
        "release provenance must not include local runtime state: release-candidate-artifact/provenance.json",
        "release provenance must not include local runtime state: builder-gear-0.1.0.tgz"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates release inventory metadata against the manifest", () => {
    const manifest = releaseManifestFixture({
      artifacts: [
        {
          path: "apps/desktop/src-tauri/target/debug/bundle/macos/Builder Gear.app",
          sha256: "a".repeat(64)
        }
      ],
      inventory: inventoryReferenceFixture(13)
    });

    expect(validateReleaseInventory(releaseInventoryFixture(manifest), manifest)).toEqual([]);
    expect(validateReleaseInventory({
      ...releaseInventoryFixture({
        ...manifest,
        mode: "distribution",
        channel: "internal"
      }),
      channel: "stable"
    }, {
      ...manifest,
      mode: "distribution",
      channel: "internal"
    })).toEqual(expect.arrayContaining([
      "release inventory channel must match manifest"
    ]));
    expect(validateReleaseInventory({
      ...releaseInventoryFixture(manifest),
      version: "9.9.9",
      entries: releaseInventoryFixture(manifest).entries.filter((entry) => entry.path !== "pnpm-lock.yaml")
    }, manifest)).toEqual(expect.arrayContaining([
      "release inventory version must match manifest",
      "release inventory entry count must match manifest",
      "release inventory is missing required entry: pnpm-lock.yaml"
    ]));

    const runtimeManifest = releaseManifestFixture({
      includeBundle: false,
      inventory: inventoryReferenceFixture(12)
    });
    expect(validateReleaseInventory({
      ...releaseInventoryFixture(runtimeManifest),
      entries: [
        ...releaseInventoryFixture(runtimeManifest).entries,
        { kind: "source", path: ".builder/schedules.sqlite", sha256: "6".repeat(64) },
        { kind: "source", path: "release-candidate-artifact/builder-gear-release-manifest.json", sha256: "6".repeat(64) },
        { kind: "source", path: "builder-gear-0.1.0.tgz", sha256: "6".repeat(64) }
      ]
    }, runtimeManifest)).toEqual(expect.arrayContaining([
      "release inventory must not include local runtime state: .builder/schedules.sqlite",
      "release inventory must not include local runtime state: release-candidate-artifact/builder-gear-release-manifest.json",
      "release inventory must not include local runtime state: builder-gear-0.1.0.tgz"
    ]));
  });

  it("verifies release inventory entry hashes against the current filesystem", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-inventory-"));

    try {
      const manifest = releaseManifestFixture();
      const inventory = releaseInventoryFixtureForRoot(root, manifest);

      expect(verifyReleaseInventoryEntries(inventory, root)).toEqual([]);

      writeFileSync(path.join(root, "package.json"), "{\"name\":\"tampered\"}\n");
      expect(verifyReleaseInventoryEntries(inventory, root)).toEqual(expect.arrayContaining([
        "release inventory entry sha256 mismatch: package.json"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies macOS app bundle metadata against release configuration", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-macos-app-"));

    try {
      const appPath = path.join(root, "Builder Gear.app");
      writeMacOSAppFixture(appPath, {
        productName: "Builder Gear",
        identifier: "com.buildergear.desktop",
        version: "0.1.0",
        minimumSystemVersion: "12.0",
        executableName: "builder-gear-desktop",
        categoryType: "public.app-category.developer-tools"
      });

      expect(verifyMacOSAppBundle({
        appPath,
        productName: "Builder Gear",
        identifier: "com.buildergear.desktop",
        version: "0.1.0",
        minimumSystemVersion: "12.0",
        categoryType: "public.app-category.developer-tools"
      })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects macOS app bundles with stale metadata or missing executables", () => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-gear-macos-app-"));

    try {
      const appPath = path.join(root, "Builder Gear.app");
      writeMacOSAppFixture(appPath, {
        productName: "Old Gear",
        identifier: "com.example.old",
        version: "0.0.1",
        minimumSystemVersion: "11.0",
        executableName: "missing-executable",
        categoryType: "public.app-category.utilities",
        writeExecutable: false,
        writeIcon: false
      });

      expect(verifyMacOSAppBundle({
        appPath,
        productName: "Builder Gear",
        identifier: "com.buildergear.desktop",
        version: "0.1.0",
        minimumSystemVersion: "12.0",
        categoryType: "public.app-category.developer-tools"
      })).toEqual(expect.arrayContaining([
        "macOS app bundle Info.plist CFBundleDisplayName must be Builder Gear; got Old Gear",
        "macOS app bundle Info.plist CFBundleIdentifier must be com.buildergear.desktop; got com.example.old",
        "macOS app bundle Info.plist CFBundleShortVersionString must be 0.1.0; got 0.0.1",
        "macOS app bundle Info.plist LSMinimumSystemVersion must be 12.0; got 11.0",
        "macOS app bundle Info.plist LSApplicationCategoryType must be public.app-category.developer-tools; got public.app-category.utilities",
        "macOS app bundle executable is missing: Contents/MacOS/missing-executable",
        "macOS app bundle icon resource is missing: Contents/Resources/icon.icns"
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function releaseManifestFixture(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const gateIds = releaseCheckCommands().map((command) => command.id);

  return {
    schemaVersion: 1,
    generatedAt: "2026-06-24T00:00:00.000Z",
    mode: "debug",
    platform: "macos",
    arch: "aarch64",
    includeBundle: true,
    versions: {
      root: "0.1.0",
      core: "0.1.0",
      cli: "0.1.0",
      desktop: "0.1.0",
      tauri: "0.1.0",
      cargo: "0.1.0"
    },
    packageManager: "pnpm@10.26.1",
    productName: "Builder Gear",
    identifier: "com.buildergear.desktop",
    git: {
      commit: null,
      dirty: true
    },
    gateIds,
    buildInputs: {
      tauriConfigSha256: "e".repeat(64)
    },
    artifacts: [],
    inventory: inventoryReferenceFixture(12),
    ...overrides
  };
}

function stableBuildInputs(): ReleaseManifest["buildInputs"] {
  return {
    tauriConfigSha256: "e".repeat(64),
      stableUpdater: {
      pubkeySha256: "f".repeat(64),
      endpoints: [
        "https://updates.buildergear.app/builder-gear-updater-latest.json"
      ]
    }
  };
}

function inventoryReferenceFixture(entryCount: number): ReleaseManifest["inventory"] {
  return {
    path: "builder-gear-release-inventory.json",
    sha256: "c".repeat(64),
    entryCount
  };
}

function releaseInventoryFixture(manifest: ReleaseManifest) {
  const requiredEntries = [
    { kind: "source" as const, path: "package.json", sha256: "1".repeat(64) },
    { kind: "lockfile" as const, path: "pnpm-lock.yaml", sha256: "2".repeat(64) },
    { kind: "lockfile" as const, path: "apps/desktop/src-tauri/Cargo.lock", sha256: "3".repeat(64) },
    { kind: "source" as const, path: "apps/desktop/src-tauri/tauri.conf.json", sha256: "4".repeat(64) },
    { kind: "policy" as const, path: ".github/dependabot.yml", sha256: "9".repeat(64) },
    { kind: "workflow" as const, path: ".github/workflows/ci.yml", sha256: "0".repeat(64) },
    { kind: "workflow" as const, path: ".github/workflows/release-candidate.yml", sha256: "a".repeat(64) },
    { kind: "workflow" as const, path: ".github/workflows/verify-stable-updater.yml", sha256: "b".repeat(64) },
    { kind: "policy" as const, path: "release/distribution-policy.json", sha256: "5".repeat(64) },
    { kind: "policy" as const, path: "release/license-policy.json", sha256: "6".repeat(64) },
    { kind: "policy" as const, path: "release/SBOM.cdx.json", sha256: "7".repeat(64) },
    { kind: "policy" as const, path: "release/THIRD_PARTY_NOTICES.md", sha256: "8".repeat(64) }
  ];

  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-06-24T00:00:00.000Z",
    productName: manifest.productName,
    version: manifest.versions.root,
    platform: manifest.platform,
    mode: manifest.mode,
    channel: manifest.channel,
    gateIds: manifest.gateIds,
    entries: [
      ...requiredEntries,
      ...manifest.artifacts.map((artifact) => ({
        kind: "artifact" as const,
        path: artifact.path,
        sha256: artifact.sha256
      }))
    ]
  };
}

function attachInventoryFixture(root: string, manifest: ReleaseManifest): ReleaseManifest {
  const inventory = releaseInventoryFixtureForRoot(root, manifest);
  const inventoryPath = path.join(root, "builder-gear-release-inventory.json");
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  return {
    ...manifest,
    inventory: {
      path: "builder-gear-release-inventory.json",
      sha256: hashReleaseArtifactPath(inventoryPath),
      entryCount: inventory.entries.length
    }
  };
}

function releaseInventoryFixtureForRoot(root: string, manifest: ReleaseManifest) {
  const files: Array<{ kind: "source" | "lockfile" | "policy" | "workflow"; path: string; body: string }> = [
    { kind: "source", path: "package.json", body: "{\"name\":\"builder-gear\"}\n" },
    { kind: "lockfile", path: "pnpm-lock.yaml", body: "lockfileVersion: '9.0'\n" },
    { kind: "lockfile", path: "apps/desktop/src-tauri/Cargo.lock", body: "# lock\n" },
    { kind: "source", path: "apps/desktop/src-tauri/tauri.conf.json", body: "{\"productName\":\"Builder Gear\"}\n" },
    { kind: "policy", path: ".github/dependabot.yml", body: "version: 2\nupdates: []\n" },
    { kind: "workflow", path: ".github/workflows/ci.yml", body: "name: CI\n" },
    { kind: "workflow", path: ".github/workflows/release-candidate.yml", body: "name: Release Candidate\n" },
    { kind: "workflow", path: ".github/workflows/verify-stable-updater.yml", body: "name: Verify Stable Updater\n" },
    { kind: "policy", path: "release/distribution-policy.json", body: "{\"schemaVersion\":1}\n" },
    { kind: "policy", path: "release/license-policy.json", body: "{\"schemaVersion\":1}\n" },
    { kind: "policy", path: "release/SBOM.cdx.json", body: "{\"bomFormat\":\"CycloneDX\"}\n" },
    { kind: "policy", path: "release/THIRD_PARTY_NOTICES.md", body: "# Third-Party Notices\n" }
  ];

  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    writeFileSync(path.join(root, file.path), file.body);
  }

  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-06-24T00:00:00.000Z",
    productName: manifest.productName,
    version: manifest.versions.root,
    platform: manifest.platform,
    mode: manifest.mode,
    channel: manifest.channel,
    gateIds: manifest.gateIds,
    entries: [
      ...files.map((file) => ({
        kind: file.kind,
        path: file.path,
        sha256: hashReleaseArtifactPath(path.join(root, file.path))
      })),
      ...manifest.artifacts.map((artifact) => ({
        kind: "artifact" as const,
        path: artifact.path,
        sha256: artifact.sha256
      }))
    ]
  };
}

function writeMacOSAppFixture(appPath: string, options: {
  productName: string;
  identifier: string;
  version: string;
  minimumSystemVersion: string;
  executableName: string;
  categoryType: string;
  writeExecutable?: boolean;
  writeIcon?: boolean;
}) {
  mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(appPath, "Contents", "Resources"), { recursive: true });
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${options.productName}</string>
  <key>CFBundleExecutable</key>
  <string>${options.executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${options.identifier}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleName</key>
  <string>${options.productName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${options.version}</string>
  <key>CFBundleVersion</key>
  <string>${options.version}</string>
  <key>LSApplicationCategoryType</key>
  <string>${options.categoryType}</string>
  <key>LSMinimumSystemVersion</key>
  <string>${options.minimumSystemVersion}</string>
</dict>
</plist>`);

  if (options.writeExecutable ?? true) {
    const executablePath = path.join(appPath, "Contents", "MacOS", options.executableName);
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    chmodSync(executablePath, 0o755);
  }

  if (options.writeIcon ?? true) {
    writeFileSync(path.join(appPath, "Contents", "Resources", "icon.icns"), "icon");
  }
}
