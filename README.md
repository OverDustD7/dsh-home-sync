# dsh-home-sync

[![npm version](https://img.shields.io/npm/v/dsh-home-sync)](https://www.npmjs.com/package/dsh-home-sync)
[![GitHub](https://img.shields.io/badge/GitHub-OverDustD7%2Fdsh--home--sync-24292e)](https://github.com/OverDustD7/dsh-home-sync)

English | [简体中文](README.zh-CN.md)

Git-based sync for DSH configuration and Mnemon memory plugin data, with automatic two-way sync, cross-device migration, initialization backups, conflict detection, and a web UI.

Version 0.2.1 completes the maintenance improvements and fixes gaps in history validation, initialization, and status reporting found during a second review.

## Requirements

- Node.js 20 or newer and Git.
- A DSH host providing `webServer`, `timer`, and `connection.requestRejection`.
- Local compatibility was verified with DSH 0.1.2-rc.1, Node.js 24.20.0, and Git 2.55.0.windows.4.

## Installation

### From npm (recommended)

```powershell
dsh plugin --profile web add dsh-home-sync
```

Restart DSH web after the install and refresh the browser to load the UI. The published package needs no build step or third-party dependencies.

### From GitHub

```powershell
dsh plugin --profile web add github:OverDustD7/dsh-home-sync
```

### Local development (from source)

```powershell
dsh plugin --profile web add link:D:/Project/DSH/dsh-home-sync
```

A `link:` installation reads that source directory directly: restart DSH web after backend changes and refresh the browser for UI changes.

### Offline / air-gapped devices

Build a tarball and copy it to the target machine:

```powershell
npm pack --ignore-scripts --pack-destination dist
```

On the target, run the following from the directory containing the archive:

```powershell
dsh plugin --profile web add ./dsh-home-sync-0.2.1.tgz
```

If the package manager cannot install a local tarball, extract it into a permanent directory and install the extracted `package` subdirectory using `link:`. Do not use a temporary extraction directory as a permanent link target.

## Synchronization behavior

- **Pull** checks the remote and attempts a fast-forward. It fails if the branches have diverged or local changes could be overwritten, and does not create local commits. The operation explicitly disables `merge.autoStash` to avoid reporting success when restoring stashed changes produces conflicts. The index is also checked after merging.
- **Sync to remote** fetches and validates the remote tree, commits allowed local changes, integrates remote changes, and pushes. It retries unpublished commits even when the working tree is clean.
- **Automatic sync** performs the full synchronization cycle at the configured interval, including checking remote changes when there are no local changes. Saving switches or the interval immediately rebuilds the scheduled tasks. Configuration saves and other write requests return a busy response while an operation is running.
- The checked-out branch must match the configured branch. Diverged branches may be integrated with a regular Git merge. If a content conflict occurs, the plugin stops before pushing, aborts the unfinished merge, and preserves local commits. Resolve the conflict manually before retrying; the plugin does not automatically force-push.
- Status refreshes every 15 seconds and distinguishes uncommitted files, commits to push or pull, and read failures. New directories are counted by their individual files. Ahead/behind counts reflect the most recent successful fetch.
- Immediate feedback appears in a toast. The **Operation history** section is collapsed by default; expand it to view and copy backup paths and recovery instructions. Up to 100 recent manual and background operations are stored beside the home directory in `<DSH_HOME>.home-sync-history.json`, subject to a total size limit. These records survive restarts and are excluded from Git synchronization. They contain results, timestamps, and backup paths, not synchronized file contents. A damaged history file is preserved and reported; a history write failure does not undo a successful sync.
- An open panel and its floating button follow host and system theme changes without losing current input or expanded sections. The current web interface uses Chinese labels.

All HTTP data endpoints use the host's authentication and Host/Origin validation. The plugin does not activate without that service. POST requests accept JSON only. The UI script itself contains no user data.

## Files included in synchronization

- `.gitignore`, `settings.yaml`, and the root `cordis.patch.yml`.
- Under `profiles/web/`: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `cordis.yml`, `cordis.patch.yml`, and `.dsh-market/state.json`.
- Non-hidden files under `mnemon/`, excluding path components named `data`, `state`, `credential`, `credentials`, `secret`, or `secrets`, and files ending in `.log`, `.wal`, or `.shm`.

Credentials, sessions, attachments, and `node_modules` are not added to commits. Forbidden files already staged or tracked block synchronization.

Before pushing, the plugin validates the entire history reachable from HEAD, up to 1,000 commits. Commits already present at the fetch remote are not exempt, so separate fetch/push addresses and multiple push destinations receive the same checks. A forbidden file anywhere in that history blocks the push even if it has since been deleted. History exceeding the limit must first be manually reviewed and organized into a clean synchronization history.

Pushes update only the selected branch; they do not automatically follow tags or mirror other references. Pushes to multiple repositories are not a single transaction, so partial network failures may require retries. The plugin does not redact fields inside allowed files. Do not put content you do not want uploaded in synchronized configuration or memory files.

Only ordinary files are accepted. Symbolic links, hard links, submodules, paths outside the home directory, Windows reserved names, and case collisions are rejected. Git hooks and commit signing still follow your Git configuration. Git subprocesses use timeouts and non-interactive credential settings.

## Device initialization and recovery

Both initialization modes create backups. The `merge` mode means **back up, reset, then merge manually**; it does not automatically combine two sets of memories.

1. Fetch the remote into an independent temporary repository and validate target paths and file types.
2. Check local path collisions and back up every file that may be overwritten or removed, the original Git metadata, and the plugin configuration.
3. Verify that local files did not change during backup, apply the allowed files, and configure the target branch, origin, and upstream.
4. Pause automatic sync and startup pull after success, allowing you to inspect the results, merge any required content manually, and re-enable automation.

Initialization supports a new directory, an independent repository that has been initialized with `git init` but has no first commit, and switching an existing setup to a remote with unrelated history. A successful response includes the actual configuration, and the UI immediately updates the automatic switches. Initialization explicitly resets settings, so the current form is replaced with the server configuration.

Backups are stored beside DSH_HOME at `<DSH_HOME>.home-sync-backups/init-*`, outside the synchronized working tree. With the default home directory, this resembles `~/.dsh.home-sync-backups/init-*`.

| Backup entry | Contents |
| --- | --- |
| `files/` | Original files |
| `repository/` | Original `.git`, including local history, index, and remote configuration |
| `config.json` | Original plugin configuration, if it existed |
| `manifest.json` | Target, operation state, original file existence, and checksums |
| `MERGE.md` | Recovery instructions |

Caught execution errors trigger an attempt to restore the original state. Automatic recovery cannot be guaranteed after a power failure or forced termination. Stop DSH, restore files according to the manifest, restore `repository/` as `.git`, restore the original configuration, and remove files the manifest marks as originally absent. Do not restore while DSH is writing memory data. Initialization explicitly rejects Git worktrees and linked `.git` entries.

Other programs must also avoid writing synchronized files during initialization. The plugin lock coordinates its own instances; it cannot pause other plugins or manual Git operations.

## Configuration and operation lock

Configuration is stored at `<DSH_HOME>/dsh-home-sync.json`.

| Setting | Purpose or constraint |
| --- | --- |
| `branch` | Synchronization branch |
| `autoPullOnStartup` | Pull when the plugin starts |
| `autoSync` | Run periodic full synchronization |
| `syncIntervalSeconds` | Integer from 15 to 86,400 |
| `commitMessage` | Commit message, 1–1,000 characters |
| `sshBatch` | Use SSH batch mode |

The legacy `autoSyncOnStartup` setting migrates to `autoSync`. If both are present, `autoSync` takes precedence.

A damaged configuration does not fall back to defaults and enable automatic tasks. Repair or restore the JSON file, then restart DSH. Configuration writes flush a temporary file before replacing the original; initialization also creates a separate configuration backup.

The cross-process lock directory is `<DSH_HOME>.home-sync-lock`. An abnormal exit may leave it behind. Remove that directory only after confirming that no DSH synchronization task is running. Recover an unfinished initialization from its backup first.

## Verification

```powershell
npm run check
npm test
```

Tests use system temporary directories, synthetic files, and local Git remotes. They do not access your real DSH home or accounts. Test repositories are retained in temporary directories for diagnosis.

Browser tests use a separate temporary Chrome/Edge profile and are skipped if no supported browser is found. Set `CHROME_PATH` to select a browser. Restricted environments may require running browser tests with normal user permissions.

For host compatibility tests, `DSH_HOST_MODULES` can point to an installed DSH `node_modules/@deepseek-ai` directory. These tests are skipped if no host installation is found. They reuse the real host routing and source-validation methods with a synthetic identity-cookie implementation.

Development and audit documentation (inspection / repair / review reports and `audit/` evidence) is kept locally as internal material and is not distributed with this repository. `test/` and `npm test` are the public, reproducible verification entry points.

## Historical review: September 7, 2026

**The following describes the 0.2.0 review. Its conclusion that no new high-risk defects had been found was superseded by the second review.** Development and audit reports (including the 0.2.1 second review) are kept locally as internal material and are not distributed with this repository; this section documents the earlier independent review for traceability. Immediate logs remain visually hidden; a separate collapsed operation-history section is now available.

The earlier review covered `lib/index.js`, `lib/sync.js`, `lib/ui.js`, `package.json`, and `cordis.patch.yml`, comparing them with the two original reports. It reported implementations for all 17 original findings and 35 passing tests with no failures. Later independent probes found gaps that those tests did not cover.

That review also restored toast feedback instead of showing a log box inside the card after saving settings. The hidden `#log` remains an `aria-live` region for screen readers. This interaction is preserved in 0.2.1.

Both initialization modes still perform backup, reset, and pausing of automatic tasks; their messages explain the intended workflow. Migrating an existing device requires manually selecting content from the backup using `MERGE.md`. HTTP data endpoints require a trusted authenticated session; an unauthenticated request returning 401 is expected. Backend changes require a DSH web restart, and UI changes require a browser refresh.
