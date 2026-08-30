# Agent Harness threat model

This document defines the Phase 1 security boundary for provider-native agents.
It complements the versioned tool contract in
[`AGENT_HARNESS_CONTRACT.md`](AGENT_HARNESS_CONTRACT.md).

## Assets and trust boundaries

| Component | Trust and responsibility |
| --- | --- |
| User | Grants workspace access and confirms production mutations on an App-owned surface. |
| Tauri host | Trusted computing base. Owns provider processes, provider credentials, MCP authority, trading grants, audit writes, and process cleanup. |
| React WebView | App code, but not a credential boundary. It receives redacted semantic calls and renders confirmations; provider and broker secrets must never cross into it. |
| Codex / Claude process and descendants | One provider trust principal. It necessarily holds its short-lived runtime-scoped MCP capability, and same-user child shells may inspect the provider's argv or temporary native config. Provider output and skill text remain untrusted input to the host even though descendants share the provider's authority. |
| Shioaji sidecar | Native-owned API process. Trading mutations require a one-use capability bound to the provider PID, sidecar generation, operation, request digest, and expiry. |
| Skills and community content | Untrusted procedural guidance. Installation and conversation text grant no App capability. |

## Security invariants

1. The WebView can observe only coarse provider login status. Access tokens,
   refresh tokens, API keys, MCP bearers, and broker credentials never cross
   Tauri serialization into JavaScript. The provider runtime receives only its
   own revocable MCP capability; it receives no trading-broker credential.
2. Each provider runtime receives a separate random MCP bearer. It is stored as
   a digest in MCP native memory and revoked with the runtime. Exact bearer
   forms are retained only in the runtime host for centralized event redaction;
   stdout, stderr, journals, and WebView events cannot reflect them.
3. MCP binds only to IPv4 loopback, rejects non-loopback Origins, limits request
   and pending-call sizes, validates the advertised tool schema, and denies tools
   outside the runtime's registry.
4. Shell/filesystem permission never implies an App capability. Market,
   account, UI, task, preview, and trade execution are independently granted.
5. Agent-initiated production mutations require user approval on an App-owned
   native surface (the `agent-approval` window — a separate webview the main
   WebView cannot script; its content comes only from Rust state). The
   first-level view is a visual order summary; the exact payload is available
   behind a detail expander. Approval can be disabled (full-auto) only through
   a natively persisted, natively confirmed, audited mode switch. Manual UI
   mutations are signed as UI-origin without a per-order native prompt; the
   optional visual order confirmation (`RiskSettings.confirmManualOrders`) is
   a WebView UX aid, not a security boundary (see
   docs/design/order-confirm-split.md). Controlled auto is simulation-only
   and expires when the App/runtime stops.
6. Every mutation carries a stable idempotency key. A pending or ambiguous
   operation is reconciled; it is never blindly retried after timeout or restart.
7. Native audit records persist only redacted metadata and request digests in a
   `0600`, no-symlink JSONL chain with keyed entry hashes and a separately MACed
   head checkpoint. Missing logs, missing checkpoints, edits, and valid tail
   removal fail closed.
8. A runtime that can reach the trading sidecar starts only after native code
   verifies the current App-owned sidecar generation and an enabled Harness.
   Disabling Harness is rejected while a native runtime is active.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Prompt or skill asks for broader access | Tool registry and capability checks are host-owned and deny by default. |
| Malicious local page probes loopback MCP | Random bearer, loopback bind, Origin validation, no CORS grant, and runtime revocation. |
| Stolen bearer is replayed after stop | Runtime-specific bearer digest and stop/exit revocation cancel authority and pending calls. |
| Provider or descendant prints its MCP bearer | Provider descendants are explicitly the same trust principal; the host recursively redacts exact runtime credentials at the single event-journal boundary before persistence or WebView emission. |
| Provider invokes an unadvertised or malformed tool | Per-runtime registry plus recursive top-level JSON Schema validation. |
| Model retries a timed-out order | Durable idempotency state and explicit reconciliation prevent a second execution. |
| A payload-shaped order is mistaken for the original operation | Payload matches are evidence only. Without an immutable broker operation ID the mutation remains unresolved and cannot be retried automatically. |
| Production order bypasses provider prompts | The App-owned approval window and native one-use trading grant are independent of provider approval caches. |
| Main WebView forges or auto-clicks the agent approval | Approval UI runs in a separate native-created window; `agent_approval_pending`/`agent_approval_respond` reject every caller whose window label is not `agent-approval`, and the displayed content is read from Rust state only. |
| Compromised WebView relaxes the approval mode | Phase 1 production approval cannot be disabled. Native state resets to required on every launch and the mode command rejects relaxation; simulation controlled-auto is session-scoped. |
| Compromised WebView orders via the UI signing proxy | Accepted residual risk equivalent to the pre-Harness posture (the WebView could always place orders over direct HTTP). The UI capability signature attests WebView origin, not per-order human intent. |
| Provider shell calls the sidecar directly | Trading/admin commands are denied by `run_shell`; native runtimes receive no broker credential; server-linked runtimes require the current Harness to remain enabled. |
| User profile redirects `shioaji` to another binary | Native host binds approved argv to the bundled CLI in an isolated shell profile. |
| App restarts during autonomous work | Pending grants expire, controlled auto pauses, and restored context starts read-only until reconciled/regranted. |
| Audit log is edited, truncated, removed, recomputed without the native key, or symlinked | Keyed-chain and MACed-checkpoint verification, JSONL terminator checks, `O_NOFOLLOW`, and startup verification fail closed. |
| Diagnostics expose personal or account data | Audit stores digests rather than raw payloads; skill privacy rules require redaction before export. |

## Residual risk

- A user account with permission to modify the application bundle or process
  memory can replace the trusted computing base; code signing and release
  verification remain distribution responsibilities.
- The audit key is an owner-only native file, not hardware-backed secure
  storage. A malicious process already running as the same OS user that can
  replace the key, log, and checkpoint together is outside this Phase 1
  tamper-evidence guarantee.
- The WebView executes trusted application code. A future remote-content or XSS
  surface must not be allowed to receive MCP events or invoke native resolution
  commands without an additional window-label/nonce boundary.
- Provider-native MCP authentication is capability isolation between runtimes,
  not secrecy from the provider process or its same-user descendants. A
  compromised provider can exercise its own advertised tools until revocation,
  but receives neither broker credentials nor another runtime's bearer.
- A crash between an external broker accepting a mutation and receipt
  persistence can leave an unknown outcome. The only safe response is to pause,
  query current broker/order state, and reconcile the original operation ID.

## Verification gates

- Unit tests cover contract classification, schema denial, permission denial,
  idempotent replay/conflict/restart, and restart policy.
- Native tests cover bearer isolation/revocation, broker PID and sidecar binding,
  exact request digests, reconnect journals, audit tamper detection, and auth-file
  permissions.
- Composite CI runs frontend build/tests, plugin contract tests, Rust tests,
  formatting, and warning-free Clippy on the supported desktop matrices.
