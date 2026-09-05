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
| macOS | Codex | Pending |
| macOS | Claude Code | Pending |
| macOS | Pi (record model service) | Pending |
| Windows | Codex | Pending |
| Windows | Claude Code | Pending |
| Windows | Pi (record model service) | Pending |

For every row, record OS version, architecture, App commit, runtime version and
installation source. Never attach credentials, account IDs, tokens or raw auth
logs to a public issue. Account authorization remains a human action.

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
