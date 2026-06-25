# Privacy

Builder Gear is designed as a local-first desktop and CLI tool.

## Local Data

The app stores workspace schedules in `.builder/schedules.json`, CLI schedule state in `.builder/schedules.sqlite`, and desktop runtime state in the platform app data directory. CLI, native, local queued-run, and browser-preview event payloads keep workspace selection metadata plus `pathRedacted: true` instead of copying raw workspace paths. Run history stores structured event status summaries; stdout, stderr, Codex JSON payload bodies, artifact payloads, prompts, and workspace paths are omitted or summarized before writing `run-events.json`. Clearing run history from the desktop requires confirmation before persisted summaries are deleted.

CLI schedule add creates new SQLite schedules immediately, but existing-id updates preview by default and require `--confirm` before replacement. CLI schedule removal previews by default and requires `--confirm` before deleting a persisted SQLite schedule entry. CLI schedule import with `--replace` previews stale SQLite rows by default and requires `--confirm` before deleting them.

Before the desktop app overwrites or deletes workspace schedules, ontology, or skills, it stores a local recovery snapshot in `.builder/backups/`. Desktop deletes for schedules, ontology entities, and skills require confirmation before the backed-up mutation runs. These backups are workspace-local user data and are not uploaded by Builder Gear. The desktop and CLI backup list, health checks, and diagnostics report backup metadata such as relative path, kind, target, creation time, size, entry count, and aggregate count/size; they do not read backup file contents into the event stream or diagnostics. Desktop and confirmed CLI restore write a `restore-preimage` backup of the current target before replacing it; CLI restore without `--confirm` previews the target only. Desktop prune requires a preview plus Confirm prune, and CLI prune is dry-run by default and requires `--confirm`, before deleting backup entries.

If desktop runtime state in the app data directory becomes unreadable JSON, Builder Gear renames the local file with a `.corrupt-*` suffix and recreates the derived state from defaults. User-authored workspace files are not silently repaired; invalid skill, ontology, or schedule files are surfaced as catalog errors.

## Codex Auth

Builder Gear checks whether the user-owned Codex auth file exists at the platform Codex home path. It does not read, copy, edit, print, upload, or persist auth file contents. The desktop renderer receives only auth readiness plus a generic auth-file label, not the raw auth path.

## Prompt Delivery

Agent prompts are sent to Codex over stdin during execution instead of being included in command-line arguments. Prompt text is not written to dry-run output, persisted run history, diagnostics reports, or saved request preferences.

## Diagnostics

Diagnostics reports are generated locally. They include platform details, Codex availability, auth-file presence, catalog counts, enabled schedule counts, and run-event type counts. They intentionally exclude prompts, event payload bodies, skill instruction bodies, full local paths, catalog error file paths, and Codex auth contents. The desktop renderer receives only a file-name label plus `pathRedacted: true` for generated reports, not the raw app-data path.

Support bundles are generated locally from diagnostics plus health-check status. They include an explicit privacy block stating that auth contents, raw prompts, full workspace paths, and run payload bodies are not included. Health messages are redacted before output so local filesystem paths and common token/key shapes are replaced with generic labels. The desktop renderer receives only a file-name label plus `pathRedacted: true` for generated bundles, not the raw app-data path.

Renderer recovery details and global runtime warning events are redacted before they are shown or persisted. Local filesystem paths, file URLs, Windows user paths, session tokens, and common API-key shapes are replaced with generic labels. Browser-state persistence stores layout preferences, safe run options, and summarized event history, but it does not store raw prompts or workspace paths. Reset local state from the recovery screen requires confirmation before Builder Gear browser-state keys are removed.

## Network

Builder Gear does not add a separate cloud service in the MVP. Agent execution uses the installed Codex CLI and whatever network behavior the user's Codex configuration allows.
