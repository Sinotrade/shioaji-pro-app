# Managed Agent Setup QA

Tracking: [#68](https://github.com/Sinotrade/shioaji-pro-app/issues/68),
[Codex #56](https://github.com/Sinotrade/shioaji-pro-app/issues/56),
[Claude Code #69](https://github.com/Sinotrade/shioaji-pro-app/issues/69),
[Pi #70](https://github.com/Sinotrade/shioaji-pro-app/issues/70).

This feature is not release-certified. Do not close the tracking issues based
on compilation, mocked UI tests, or runtime version checks alone.

## Acceptance Matrix

| Platform | Runtime | Native login + model + App query |
| --- | --- | --- |
| macOS | Codex | Passed on existing Mac; see evidence below |
| macOS | Claude Code | Passed on existing Mac; see evidence below |
| macOS | Pi (record model service) | Passed on existing Mac; see evidence below |
| Windows | Codex | Pending |
| Windows | Claude Code | Pending |
| Windows | Pi (record model service) | Pending |

For every row, record OS version, architecture, App commit, runtime version and
installation source. Never attach credentials, account IDs, tokens or raw auth
logs to a public issue. Account authorization remains a human action.

## Mac Native QA, 2026-09-05

Environment: macOS 26.6.2 (25G83), arm64. Tested an isolated
`Shioaji Pro QA` native Tauri bundle using the paired managed-onboarding
worktrees (public #71, private #8). No Shioaji API credentials were entered,
no orders were placed, and the installed release App was not modified.

| Provider | Runtime source/version | Model | Actual UI result |
| --- | --- | --- | --- |
| Codex | ChatGPT-bundled CLI 0.153.1 | GPT-5.6-Sol | Native login reused; installation, official skill and explicit connection test passed. A real first-run conversation invoked `get_app_state` and returned an empty panel list. |
| Claude Code | Existing native CLI 2.1.260 | Default (recommended) | User completed native browser authorization. Connection test and first-run conversation succeeded; real `get_app_state` returned an empty first-run panel list. |
| Pi | App-managed standalone 0.85.0 | GPT-5.3 Codex Spark, OpenAI (ChatGPT Plus/Pro) | Download/install, native OAuth selection and browser handoff succeeded. User completed authorization. Connection test, text conversation and real `get_app_state` succeeded. |

Pi and Claude completed conversations can return to Settings and reload the
native model catalogue without restarting the App. Runtime/authentication
state survives restarting the isolated QA bundle. A connection test alone
does not prove the model can invoke an App tool: both paths are exercised.

This existing-Mac run is not clean-machine certification. Windows, clean OS
accounts, all cancellation/removal combinations and alternate Pi model
services remain separate acceptance work.

Regression reproduced and corrected: disabling Codex's code-mode host hid
the execution path for the otherwise advertised App MCP tool. Removing that
single disable restored real tool calls with the same native CLI, model and
prompt. Empty environments, the exact read-only App tool definition and
disabled shell/file/trading capabilities remain in place.

Private implementation: `8b7d4b9af35ea1a7833e81cedd94827ed5c1e1eb`.
Independent composite QA: 424 frontend tests passed, TypeScript and production
build passed, 192 Rust tests passed (13 opt-in ignored), Clippy all targets
with warnings denied passed, and 15 Pi Node tests passed (one native smoke
skipped). Independent review found no remaining blocking findings. These
automated results do not replace the uncompleted platform matrix above.

## Fresh Machine

1. Use a clean OS account without Node, npm, Agent CLIs, Git Bash or a provider
   desktop app. Launch the test build and open AI Agent settings.
2. Select the provider and start setup. Check download progress and native
   browser login. For Pi, select a service and supported login method.
3. Complete authorization. Confirm official integration and available models.
4. Select a model and explicitly run the connection test. This may consume
   subscription usage. Ready requires a real model response and read-only App
   query, not merely an installed executable or an auth file.
5. Start a conversation. Check that native permissions and App tools work;
   do not place a live order during onboarding QA.

## Recovery and Ownership

- Cancel a download and retry; no partial installation should become active.
- Cancel login, close/reopen settings and restart the App. Login must not
  reopen without a user action, and completed installation must be reused.
- Verify an unsupported model or exhausted account does not report Ready or
  force a runtime reinstall. Select a usable model or account and retry.
- While an Agent task runs, setup, removal and connection tests must be blocked.
- Cancel a connection test and check that its subprocesses stop; a late result
  must not enable Ready.
- Verify compatible external installations are reused without being modified.
- Sign out separately from removal. Removal must preserve conversations,
  skills and credentials. Check the shared-login warning before logout.
- On Windows, exercise Pi's native PowerShell tool with the confirmation gate;
  no Node/npm/Git Bash setup should be required.
- Test dark/light themes and narrow settings panels for overflow and usable
  cancel/login controls.

Codex uses an App-owned native login scope. A login available only in another
Codex home's keyring can require one additional browser authorization. Legacy
App credential symlinks are detached without deleting their external targets.
Claude Code and Pi use their native credential scope; logout can affect other
clients sharing that scope.
