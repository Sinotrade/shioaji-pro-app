# 1.7.5 / production Agent Harness candidate QA

Status: release candidate work, not merge/release authorization. No v0.1.46
onboarding waiver applies. The maintainer explicitly chose production Auto;
issue #51's original production-Auto prohibition is superseded by that decision.

## Evidence

- Official macOS arm64 Shioaji 1.7.5 binary: real Rust anonymous stdin pipe
  bootstrap (`SJAHIPC1`, 64 hex bytes, EOF), isolated temporary HOME, explicit
  simulation environment. `/api/v1/info` returned version 1.7.5,
  `simulation=true`, `bootstrap=one_shot_ipc`, enabled capability v1,
  compact keyed BLAKE3. No order endpoint was called.
- Actual OpenAPI and monitor metrics/subscriptions/settings endpoints returned
  200. This verifies upstream wire availability, not production broker execution.
- Independent browser QA: valid/missing/invalid usage, owned/external server,
  expand/collapse, document hidden/unmount, Auto scope copy and one-second
  approval expiry. Fixtures only; no native approval was submitted.
- Frontend unit tests and production build, Rust capability/runtime/approval
  tests, native pipe process test, plugin packaging checks and independent
  code review are recorded with exact results in the paired PRs.
- Rust loopback/process tests run outside the restrictive local sandbox.
  Fixture tests do not certify the real native provider or broker.

## Required remaining native gates before merge/release

1. Fresh native Codex, Claude Code and Pi sessions against the candidate:
   production readonly access, per-order proposal deny/expiry, first Auto
   scope deny/revoke, account/environment/runtime restart changes. Do not
   submit real orders; use denied proposals and an isolated broker fixture
   for successful dispatch and ambiguous-response paths.
2. Actual bootstrap and native approval-window behavior on macOS arm64/x64,
   Windows and Linux; clean-machine installation/onboarding. Current real
   sidecar smoke covers macOS arm64 simulation only.
3. Native WKWebView/WebView2/WebKitGTK Dashboard rendering, CSP/iframe behavior,
   subscription diagnostics and collection lifecycle with the real sidecar.
   Capture dark zh-TW privacy-mode release screenshots from that verified UI;
   current browser fixture screenshots are QA evidence, not release images.
4. Private `desktop-ci`, public required CI and Linux/Windows composed tests
   must be green at the pinned immutable private SHA. These are build/test
   gates, separate from the native checks above.
5. Maintainer approval to merge, private merge commit first, public repin to
   that merge SHA, rerun composed CI, public merge commit, then separate
   explicit authorization for a public-main release tag.

## Safety and cleanup

No real orders are used for testing. Unknown outcomes are never retried.
Only task-owned fixture/browser/sidecar processes are stopped. Unmerged
worktrees remain for review. Signing secrets, bootstrap credentials and raw
account data are excluded from committed evidence.
