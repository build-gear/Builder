# Builder Gear

Builder Gear is a CLI-first agent builder for professional workflows. The CLI owns execution; the desktop app is a thin visual layer over the same run, skill, ontology, and schedule contracts.

## Current MVP

- Shared TypeScript core in `packages/core`
- `builder` CLI in `packages/cli`
- Tauri 2 + React desktop shell in `apps/desktop`
- Read-only Codex auth detection at the platform Codex home path
- Local schedule persistence through SQLite
- Desktop schedule ticks while the app is active, with run state stored in the app data directory
- Desktop schedule management for creating, editing, enabling, disabling, deleting, saving, and manually queuing schedules
- Desktop skill and ontology selection that writes directly into the next `AgentRunRequest`
- Desktop skill creation, editing, deletion, and validated `skill.yaml` plus instruction persistence
- Desktop ontology entity creation, editing, deletion, and validated JSON persistence
- CI release-readiness gate for pull requests and protected release branches
- Security and privacy policy documents for auth, diagnostics, and local data boundaries

## Development

```sh
pnpm install
pnpm --filter @builder/cli builder -- init --workspace ./BuilderGearWorkspace
pnpm build
pnpm test
pnpm lint
pnpm security:audit
pnpm icons:generate
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
cd apps/desktop/src-tauri && cargo test
pnpm --filter @builder/cli builder -- doctor
pnpm --filter @builder/desktop dev
```

`builder init` creates a starter workspace with `skills/build-plan`, `ontology/builder-gear.json`, and `.builder/schedules.json` without overwriting existing files. `builder doctor` checks Codex CLI availability, Codex auth-file presence/readability, workspace existence, skill manifests, ontology JSON, schedule JSON, and workspace backup inventory. Health reports redact local workspace and auth paths by default, print actionable failures, support `--json` for automation, support `--support` for a redacted troubleshooting bundle, and honor `BUILDER_GEAR_CODEX_BIN` plus `CODEX_HOME` for mock or alternate Codex-compatible runtimes. `pnpm icons:generate` rebuilds the desktop PNG, ICNS, and ICO icon set from the checked-in generator. `pnpm security:audit` blocks low, moderate, high, and critical npm advisories before release. `pnpm privacy:scan` rejects checked-in developer-machine paths, high-confidence secret patterns, private key blocks, current environment secret values, source-tree symlinks, and oversized text-like source files that would exceed the scan limit before release. The release gate also runs workspace lint, `cargo clippy --all-targets -- -D warnings` for the Tauri backend, executes the built CLI artifact through init, doctor, support-bundle, dry-run, packages the CLI tarball, installs that tarball into a fresh project, verifies the installed `builder` binary, and runs an installed-Codex parser smoke check when `codex` is on `PATH`.

To launch the Tauri desktop shell:

```sh
pnpm --filter @builder/desktop tauri dev
```

Before a release candidate, run the full readiness gate:

```sh
pnpm release:check
```

The release gate writes `builder-gear-release-manifest.json` and `builder-gear-release-inventory.json` into the target directory for the selected gate. `pnpm release:check:fast` writes to `apps/desktop/src-tauri/target/release-readiness/`. `pnpm release:check` writes beside the debug bundle, such as `apps/desktop/src-tauri/target/debug/bundle/macos/` on macOS. Signed distribution and stable gates write beside release bundles under `apps/desktop/src-tauri/target/release/bundle/`, with macOS using the `macos/` subdirectory. Bundle-producing gates run `pnpm release:smoke-bundle` after Tauri packaging to verify required package outputs, executable bits, macOS `.app` Mach-O link-table readability, Windows MSI/NSIS headers, and Linux AppImage/deb/rpm headers without launching the GUI. The manifest records platform, root/core/CLI/desktop/Tauri/Cargo versions, gate order, git state, SHA-256 fingerprints for generated app/dmg/msi/nsis/appimage/deb/rpm artifacts, and the SHA-256 fingerprint of the release inventory. The inventory records source files, lockfiles, release policy, CI workflow, and artifact hashes used for the build while excluding local runtime state such as `.builder/`, `release-candidate-artifact/`, and package tarballs. Release metadata also verifies `.gitignore` keeps local runtime and build state out of commit candidates. Release provenance must match the manifest-declared artifact set and rejects local runtime state or undeclared artifact entries, so upload evidence cannot be padded with unrelated build-machine files.

To re-check a built release artifact set before upload or after moving files between machines, verify the generated manifest:

```sh
# Fast local or CI readiness gate
pnpm release:verify -- apps/desktop/src-tauri/target/release-readiness/builder-gear-release-manifest.json

# macOS debug bundle from pnpm release:check
pnpm release:verify -- apps/desktop/src-tauri/target/debug/bundle/macos/builder-gear-release-manifest.json

# macOS signed distribution or stable candidate
pnpm release:verify -- apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json
```

The verification command rejects stale gate order, missing artifacts, paths outside the repository, duplicate artifact entries, artifact paths outside the expected Tauri bundle output root for the selected platform/mode/channel, non-bundle manifests that still declare artifacts, SHA-256 mismatches, missing or tampered release inventories, provenance entries that include local runtime state or undeclared artifacts, provenance records whose manifest file does not match the manifest being verified, inventory entries whose current file hashes no longer match, missing bundle smoke evidence, and macOS `.app` bundles whose `Info.plist` metadata or executable layout does not match the release configuration. Distribution manifests also record the macOS post-build signature, Gatekeeper, and notarization staple gates that were executed before publication.

The desktop updater checks the current package version before prompting to install an available update. Candidates with malformed versions, the same version, or a lower version are recorded as rejected update events and never reach the download/install call.

Pull requests and pushes to `main` or single-segment `release/*` run `.github/workflows/ci.yml` on macOS, Windows, and Ubuntu. Each runner installs Node/Rust dependencies, executes `pnpm release:check:fast`, verifies the generated release manifest with `pnpm release:verify`, runs a local `pnpm service:readiness -- --skip-github --skip-updater` rehearsal, stages the verified upload set with `pnpm release:stage-upload`, and writes `builder-gear-release-upload-plan.json` with `pnpm release:upload-plan`; Ubuntu also installs the Tauri 2 WebKit/AppIndicator/Rsvg/patchelf system dependencies used by the official Tauri GitHub Actions workflow. GitHub checkout steps disable persisted credentials so workflow tokens are not left in the repository clone after checkout. `.github/dependabot.yml` keeps npm, Cargo, and GitHub Actions dependency updates on a weekly review cadence, and release metadata fails if that policy is removed or no longer covers those ecosystems.

Signed release candidates can also be produced from `.github/workflows/release-candidate.yml` with manual `workflow_dispatch` inputs for platform and channel. A separate `ref-guard` job fails non-`main` and non-single-segment `release/*` dispatches before the signing build job can start. The build job scopes signing and updater secrets to the selected platform/channel, validates the selected required secret names before dependency installation, imports the base64 Developer ID `.p12` into an ephemeral macOS keychain only for macOS builds, restores the default login keychain and deletes the temporary `.p12` plus signing keychain in an `always()` cleanup step, runs the distribution or stable gate, verifies the generated release manifest, stages only manifest/provenance-declared release files into `apps/desktop/src-tauri/target/release-upload/`, rejects symlinked staging path segments, re-hashes the staged copies, writes the upload plan that maps staged updater files to their public feed and payload URLs, creates GitHub build-provenance attestations for the staged files and plan, then uploads that staged set with bounded retention; the gate still fails if signing, notarization, attestation permissions, or updater secrets are missing. After a stable candidate is published to the updater host, `.github/workflows/verify-stable-updater.yml` can be manually dispatched with the Release Candidate run ID and platform. It uses its own `ref-guard` before entering the production environment, checks that the selected run is a successful manual `Release Candidate` run from `main` or a single-segment `release/*` branch, records that run's `headSha`, checks out that exact commit for verification, downloads the immutable stable artifact with `actions: read` into an isolated `release-candidate-artifact/` root, grants `attestations: read` only for provenance verification, re-verifies the release manifest and upload plan from that artifact root, rejects artifacts whose manifest is not a bundled stable distribution for the requested platform, rejects artifacts whose manifest git commit does not match the selected run, verifies GitHub build-provenance attestations for every staged file in the isolated upload set against the release-candidate signer workflow, compares the hosted updater JSON with the staged feed, and can download the hosted updater payload to verify SHA-256 before public rollout.

Before dispatching a hosted signed release, run the GitHub environment preflight:

```sh
pnpm release:github-setup -- --repo OWNER/REPO
pnpm release:github-setup -- --repo OWNER/REPO --apply
pnpm release:github-preflight -- --repo OWNER/REPO
```

The setup command dry-runs by default and creates or updates the `internal-release` and `production` environments only when `--apply` is provided. Creating or updating GitHub environments requires repository admin rights. Setup also enables custom deployment branch policies and ensures only `main` plus `release/*` can deploy through those environments. If an applied setup lacks admin rights, `--json` still emits a per-environment report with the value-free error and remediation commands before exiting non-zero. The preflight command uses the GitHub CLI to verify that those environments contain the required secret names for all supported platforms/channels and the expected deployment branch policies. Its JSON output includes value-free remediation commands for missing environments, secret names, and branch policies so CI artifacts can point operators at the next step without exposing credentials. Remediation commands quote glob-bearing branch policy fields such as `'name=release/*'` so they can be copied into common shells without expanding local files. GitHub CLI failure output is redacted for token, key, private-key, and sensitive environment value patterns before printing. Neither command reads or prints secret values.

For a single operational go/no-go check after local release evidence exists, run:

```sh
pnpm service:readiness -- --repo OWNER/REPO --manifest apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json --stable-manifest apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json
```

The service readiness audit verifies the local release manifest, re-verifies the staged release upload plan for stable promotion, checks that the current commit has a successful hosted `CI` workflow run, checks GitHub release environment and secret names, and compares the hosted stable updater feed with the stable manifest. Command failure details in the audit use the same token, key, private-key, environment-value, and local path redaction boundary as the GitHub release scripts. Add `--verify-downloads` for final production rollout to reject non-public hosted updater payload URLs before download, then download the hosted updater payload and compare SHA-256. For local-only rehearsal, use `--skip-github --skip-updater`; the command reports that as a partial `warn` audit rather than a full production pass.

When verifying a downloaded release artifact outside its original build checkout, pass the isolated artifact root and make manifest paths relative to that root:

```sh
pnpm service:readiness -- --artifact-root release-candidate-artifact --manifest apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json --stable-manifest apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json --skip-github --verify-downloads
```

For a faster local pass that skips rebuilding the app bundle:

```sh
pnpm release:check:fast
```

For an internal distribution candidate, use the signing/notarization gate:

```sh
cp release/macos.internal.env.example release/macos.internal.env
# Edit release/macos.internal.env with real local or CI values.
pnpm release:preflight -- --platform macos --channel internal --env-file release/macos.internal.env
pnpm release:check:distribution -- --platform macos --env-file release/macos.internal.env
```

The distribution preflight checks required signing environment variables and platform tooling before release packaging. Platform/channel templates live at `release/{platform}.{channel}.env.example`, and release metadata verifies those templates plus `.github/workflows/release-candidate.yml` stay aligned with `release/distribution-policy.json`. Release commands reject invalid or duplicate `--platform`/`--channel` values instead of falling back to defaults. On macOS it verifies `codesign`, `security`, `notarytool`, `stapler`, `spctl`, and that `APPLE_SIGNING_IDENTITY` is present in the codesigning keychain. The macOS internal distribution gate requires `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` in the environment before it will build release app/dmg artifacts. Hosted macOS release-candidate builds also require `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_KEYCHAIN_PASSWORD` so the workflow can import a base64-encoded Developer ID `.p12` before preflight. Windows templates include Authenticode certificate inputs, while Linux internal packaging currently has no platform signing environment. After packaging, the distribution gate verifies `.app` and `.dmg` signatures, Gatekeeper assessment, and notarization staples before writing the release manifest.

For a public stable channel candidate, run:

```sh
cp release/macos.stable.env.example release/macos.stable.env
# Edit release/macos.stable.env with real local or CI values.
pnpm release:preflight -- --platform macos --channel stable --env-file release/macos.stable.env
pnpm release:check:stable -- --platform macos --env-file release/macos.stable.env
pnpm release:stage-upload -- apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json
pnpm release:upload-plan -- apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json
```

The stable channel adds signed updater requirements. `pnpm release:check:stable` uses the checked-in `release/tauri.stable.conf.json` overlay to enable Tauri updater artifact generation only for the stable build. It then generates `apps/desktop/src-tauri/target/release-config/tauri.stable.generated.conf.json` from `BUILDER_GEAR_UPDATER_PUBKEY` and `BUILDER_GEAR_UPDATE_ENDPOINT` and passes that generated config to Tauri. The stable gate will fail until `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `BUILDER_GEAR_UPDATER_PUBKEY`, and `BUILDER_GEAR_UPDATE_ENDPOINT` are present with non-placeholder values, and until the effective Tauri config includes updater public key content plus at least one production HTTPS static JSON feed URL. The update endpoint must be an absolute HTTPS URL ending in `.json`, must point at a public host, and must not include updater template variables, URL credentials, query strings, fragments, localhost, loopback, private-network, `.local` mDNS hosts, or reserved example hosts. Preflight also rejects missing updater private-key files, too-small updater key content, invalid base64 signing material, and Windows certificate base64 that does not decode like a DER PKCS#12/PFX payload. Stable release manifests must include updater artifacts, generated `.sig` files, and `builder-gear-updater-latest.json`, a Tauri static updater feed with the release version, RFC 3339 publication date, `OS-ARCH` platform key, artifact URL, and inline signature content. `pnpm release:upload-plan` requires the staged upload set to exist, re-hashes the staged files, then writes a JSON plan with the feed endpoint path, decoded upload path, updater payload URL, payload artifact, and payload signature artifact so the static host can be populated without guessing. The default `pnpm release:check:distribution` command stays on the internal channel.

After publishing the staged stable artifacts to the update host, verify that the public updater endpoint serves the same feed generated by the release gate:

```sh
pnpm release:verify-updater -- apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json
pnpm release:verify-updater -- apps/desktop/src-tauri/target/release/bundle/macos/builder-gear-release-manifest.json --verify-downloads
```

The default check compares the hosted HTTPS static JSON feed with the staged `builder-gear-updater-latest.json`. `--verify-downloads` also downloads the hosted updater payload and compares its SHA-256 with the release manifest.

## Local Data Model

- Skills: `skills/**/skill.yaml` with local instruction files
- Ontology: `ontology/*.json` or `.builder/ontology/*.json`
- Desktop schedules: `.builder/schedules.json`
- CLI schedule database: `.builder/schedules.sqlite`
- Workspace mutation backups: `.builder/backups/`
- Desktop run history: app data `run-events.json`
- Desktop schedule runtime state: app data `schedule-state.json`

The desktop app does not ship with a developer-machine workspace path. On startup it keeps the user's saved workspace if one exists; otherwise it uses `BUILDER_GEAR_WORKSPACE`, the nearest parent directory containing both `skills/` and `ontology/`, or `~/Builder Gear` as a final cross-platform fallback. The workspace can always be changed from the sidebar, and the workspace prepare action creates starter `skills/`, `ontology/`, and `.builder/schedules.json` files without overwriting existing files. CLI and desktop workspace roots must be real directories, not symlinks; existing workspaces are canonicalized before catalog loading, scheduling, or Codex execution.

If desktop runtime state in the platform app data directory is unreadable or contains corrupt JSON, Builder Gear quarantines the file next to the original with a `.corrupt-*` suffix and rebuilds from an empty run history or default schedule runtime state. Workspace-owned files such as `skill.yaml`, ontology JSON, and `.builder/schedules.json` still fail visibly in catalog loading so user-authored data is not silently rewritten.

Desktop schedule ticks evaluate `once`, `interval`, and five-field `cron` triggers while Builder Gear is open. The CLI can import the desktop workspace schedule file into the SQLite queue with `builder schedules import --workspace . --db .builder/schedules.sqlite`, then run that queue with `builder schedules run-due --db .builder/schedules.sqlite` for one tick or `builder schedules daemon --db .builder/schedules.sqlite` for a long-running CLI-first daemon. `builder schedules add <file>` creates new SQLite schedules immediately but previews existing-id updates by default; add `--confirm` to replace an existing schedule. `builder schedules import --replace` previews stale SQLite schedules that are absent from `.builder/schedules.json`; add `--confirm` to delete those stale rows during import. `builder schedules remove <id>` previews by default and requires `--confirm` before deleting a persisted SQLite schedule. During import, relative schedule workspace paths are resolved against the imported workspace so daemon execution is stable from any current directory. The CLI rejects symlinked schedule JSON files and symlinked SQLite schedule database paths. A due schedule whose workspace cannot be prepared emits a redacted error event, stays pending, and does not stop the daemon from running other due schedules. CLI SQLite scheduled runs take an atomic per-schedule claim before spawning Codex, so overlapping `run-due` or daemon processes sharing a database do not duplicate the same job; cancelled, failed, and timed-out runs release the claim without marking completion, and crashed-process claims can be reclaimed after the schedule's effective run timeout. CLI SQLite scheduled runs can set `timeoutSeconds` on their `runRequest` or use `--run-timeout-seconds`; that same effective timeout controls stale claim recovery, timed-out jobs emit `timedOut: true`, return a failing exit code, and stay pending. Invalid SQLite queue rows are reported as redacted diagnostics while valid schedules continue to list, import, and run. Cron schedules are evaluated in their configured IANA timezone and support numeric fields, lists, ranges, steps, and month/day names. `run-on-start` queues a missed job on startup; `skip` records a skipped baseline and waits for the next due time while the app or daemon remains active.

The desktop GUI writes schedule changes back to `.builder/schedules.json` through Tauri commands after validating the schedule contract. Schedule creation and editing support `interval`, `once`, `cron`, and optional `timeoutSeconds` run limits. Manual schedule runs reuse the same Codex execution path and event stream as normal agent runs.

Skill and ontology cards can be attached to or removed from the active run request. The Runs surface shows the selected IDs as removable chips so GUI context and CLI request payload stay aligned.

Skill edits from the desktop GUI are validated by the Tauri backend and persisted under `skills/<skill-id>/skill.yaml` with the configured instruction file. Skill IDs are restricted to path-safe characters, and instruction paths must remain inside the skill directory, including after resolving existing intermediate directories.

Before desktop workspace mutations overwrite or delete user-authored schedules, ontology, or skills, Builder Gear writes a local recovery snapshot under `.builder/backups/`. Desktop deletes for schedules, ontology entities, and skills also require an explicit confirmation before the backed-up mutation runs. Backup creation rejects symlinked sources and does not follow symlinks inside skill directories, so recovery snapshots stay inside the selected workspace boundary. The desktop Backups view and `builder backups list --workspace .` can list available workspace backups by relative path, kind, target, creation time, size, and entry count without reading backup file contents into the event stream. Desktop restore and `builder backups restore <name> --workspace . --confirm` restore a selected backup and first save the current target as a `restore-preimage` backup. CLI restore without `--confirm` previews the target only. Desktop prune preview and `builder backups prune --workspace . --keep 50` show old backups that would be removed; desktop pruning requires the Confirm prune action, and CLI pruning requires `--confirm`, before anything is deleted. Health checks warn when backup inventory grows beyond 50 entries or 1 GiB so operators know when to review and prune local recovery data.

Catalog loading errors are surfaced in the desktop UI instead of silently falling back to preview data. Broken `skill.yaml`, ontology JSON, or schedule JSON files are shown as catalog errors with a refresh action, so workspace data problems are visible during operation. Loaded skill manifests must use path-safe IDs and instruction paths that stay inside the skill directory after resolving existing intermediate directories, matching the desktop write policy.

Ontology entity edits from the desktop GUI are validated by the Tauri backend and persisted to `ontology/builder-gear.json` as sorted JSON. The catalog reader still supports additional ontology JSON files for inspection, while GUI writes use the default Builder Gear ontology file.

Failed manual runs keep an in-memory request snapshot for the current desktop session and expose a retry action. Prompt text is not written to persisted run history or request preferences; retry is intentionally session-scoped. CLI, native, local queued-run, and browser-preview events keep workspace selection metadata plus `pathRedacted: true` instead of copying raw workspace paths into event payloads. Persisted run history stores event status summaries only: stdout, stderr, Codex JSON event payloads, artifact payloads, and workspace paths are omitted or summarized before writing `run-events.json`. Clearing run history from the desktop requires confirmation before persisted run summaries are deleted.

The desktop toolbar can generate a local diagnostics report under the app data `diagnostics/` directory. The report includes app/platform, Codex availability, auth-file existence, workspace catalog counts, enabled schedule counts, backup count/size totals, and run-event type counts. It intentionally excludes prompts, event payloads, skill instruction bodies, backup file contents, workspace paths and selected workspace folder names, catalog error file paths, and Codex auth contents. Desktop artifact events receive only a file-name label plus `pathRedacted: true`, not the raw app-data path.

The CLI and desktop toolbar can also generate a redacted support bundle. It combines diagnostics with health-check status while declaring the privacy contract in the JSON: no Codex auth contents, no raw prompts, no workspace paths or workspace folder names, and no run payload bodies. Local paths in health messages are replaced with generic labels before the bundle is written or printed. Desktop artifact events use the same file-name label plus `pathRedacted: true` boundary instead of returning the raw bundle path to the renderer.

The desktop toolbar also exposes the same health-check contract as `builder doctor`, returning pass/warn/fail checks for runtime and workspace readiness.

Renderer crashes are handled in two layers. React render faults show a recovery screen with Reload and Reset local state actions. Reset local state requires confirmation before deleting Builder Gear browser-state keys. Recovery screen messages, stack details, and render-failure console logs are redacted before use. Global browser errors and unhandled promise rejections are captured as redacted runtime warning events, with local paths and secret-shaped values removed before display or persistence. Browser-state persistence keeps layout preferences, safe run options, and summarized event history, but it does not store raw prompts or workspace paths. Browser-preview fallbacks are allowed only when no Tauri native bridge is detected; if a native bridge is present but a command fails, the desktop UI surfaces the command failure instead of replacing real workspace state with sample preview data.

## Codex Runtime Testing

The CLI and desktop runtime use `codex` from `PATH` by default. Set `BUILDER_GEAR_CODEX_BIN=/absolute/path/to/codex-compatible-binary` to point Builder Gear at a mock or alternate Codex-compatible executable. Builder Gear invokes `codex exec --json ... -` and writes the prompt to stdin, so prompt text is not placed in the process argument list. `builder run --dry-run --json` redacts local executable and workspace paths by default for shareable logs; pass `--unsafe-show-paths` only when you need exact local invocation paths for private debugging. Long-running runs can be bounded with desktop `timeoutSeconds`, `builder run --timeout-seconds <seconds>`, `builder schedules run-due --run-timeout-seconds <seconds>`, or `builder schedules daemon --run-timeout-seconds <seconds>`. Timed-out runs emit `timedOut: true`; CLI runs return a failing exit code, and CLI SQLite scheduled runs are not marked complete. The desktop invocation preview also redacts local executable, workspace, model, and profile path-like values before returning data to the renderer. Builder Gear strips its own release, signing, and updater environment variables from Codex child processes before version probes or runs. Run requests are rejected before Codex is spawned when the prompt exceeds 1,048,576 characters, workspace paths contain control characters, model/profile options contain whitespace or control characters, timeout options exceed the 24-hour maximum, or skill/context/schedule reference IDs exceed bounded service limits. Tests use this seam to verify `codex exec --json` argument construction, stdin prompt delivery, JSON stdout events, plain stdout events, stderr redaction, successful exit handling, timeout handling, and health checks without reading Codex auth contents.

## Security Boundary

Builder Gear detects whether the Codex auth file exists, but it never reads, copies, edits, prints, or stores auth file contents. The desktop renderer receives only auth readiness and a generic auth-file label, not the raw auth path. Auth health checks reject symlinked auth files and, on POSIX systems, auth files that expose group or other permissions; use `chmod 600 ~/.codex/auth.json` after `codex login` if doctor reports open permissions. Runtime prompts are delivered to Codex over stdin instead of argv, and runtime output is passed through conservative redaction and per-event text truncation before being emitted as Builder events. CLI fatal error output redacts secret-shaped values and local filesystem paths before writing to stderr, so shared failure logs do not expose project or account paths by default.

The Tauri desktop shell ships with separate production and development Content Security Policies. The production policy keeps scripts and default resources on `self`, allows only the Tauri IPC connection path needed by the app, blocks object embedding and form submission, and does not allow localhost Vite/WebSocket development origins. The development-only `devCsp` keeps those localhost origins available for `tauri dev`. The WebView also enables Tauri `freezePrototype` so release builds fail metadata checks if that hardening is removed.

Distribution policy is tracked in `release/distribution-policy.json`. The macOS bundle enables hardened runtime, uses `apps/desktop/src-tauri/entitlements.plist`, targets macOS 12.0+, and the release metadata gate verifies that the policy and Tauri config point at the same checked-in entitlements file. The release metadata gate also requires the checked-in app icon set declared in `tauri.conf.json`: standard PNG sizes, macOS ICNS, and Windows ICO. It verifies the default Tauri capability stays scoped to the main window with only event listen/unlisten and explicit updater check/download-install permissions, with no filesystem plugin permissions or broad default permission sets. Workspace folder selection is mediated by a Rust command instead of exposing generic renderer dialog permissions. The policy records Windows MSI/NSIS plus Linux AppImage/deb/rpm artifact requirements. Updater artifacts stay disabled for debug and internal distribution checks; the stable channel enables them through `release/tauri.stable.conf.json`, injects updater public key and endpoint values from environment, and requires signed updater artifacts before publication. The release manifest and verifier reject stable builds that omit the updater payload/signature pair or generated static updater feed needed by Tauri updater metadata.

Security reporting and privacy boundaries are documented in `SECURITY.md` and `PRIVACY.md`. The release metadata check fails if those files, the CI workflows, or the release upload staging script are removed.
