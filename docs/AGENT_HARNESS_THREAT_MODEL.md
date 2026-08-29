# Agent Harness threat model

This document defines the Phase 1 security boundary for provider-native agents.
It complements the versioned tool contract in
[`AGENT_HARNESS_CONTRACT.md`](AGENT_HARNESS_CONTRACT.md).

## Assets and trust boundaries

| Component | Trust and responsibility |
| --- | --- |
| User | Grants workspace access and confirms production mutations on an App-owned surface. |
| Tauri host | Trusted computing base. Owns provider processes, native credentials, MCP bearers, trading grants, audit writes, and process cleanup. |
| React WebView | App code, but not a credential boundary. It receives redacted semantic calls and renders confirmations; provider and broker secrets must never cross into it. |
| Codex / Claude process | Sandboxed, authenticated by its own native runtime, and authorized only through its runtime-scoped MCP bearer. Model output and skill text are untrusted input. |
| Shioaji sidecar | Native-owned API process. Trading mutations require a one-use capability bound to the provider PID, sidecar generation, operation, request digest, and expiry. |
| Skills and community content | Untrusted procedural guidance. Installation and conversation text grant no App capability. |

## Security invariants

1. The WebView can observe only coarse provider login status. Access tokens,
   refresh tokens, API keys, MCP bearers, and broker credentials remain native.
2. Each provider runtime receives a separate random MCP bearer. It is stored as
   a digest in native memory and revoked with the runtime.
3. MCP binds only to IPv4 loopback, rejects non-loopback Origins, limits request
   and pending-call sizes, validates the advertised tool schema, and denies tools
   outside the runtime's registry.
4. Shell/filesystem permission never implies an App capability. Market,
   account, UI, task, preview, and trade execution are independently granted.
5. Production mutations require an App-owned exact-payload confirmation.
   Controlled auto is simulation-only and expires when the App/runtime stops.
6. Every mutation carries a stable idempotency key. A pending or ambiguous
   operation is reconciled; it is never blindly retried after timeout or restart.
7. Native audit records persist only redacted metadata and request digests in a
   `0600`, no-symlink, append-only JSONL hash chain. A broken chain fails closed.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Prompt or skill asks for broader access | Tool registry and capability checks are host-owned and deny by default. |
| Malicious local page probes loopback MCP | Random bearer, loopback bind, Origin validation, no CORS grant, and runtime revocation. |
| Stolen bearer is replayed after stop | Runtime-specific bearer digest and stop/exit revocation cancel authority and pending calls. |
| Provider invokes an unadvertised or malformed tool | Per-runtime registry plus recursive top-level JSON Schema validation. |
| Model retries a timed-out order | Durable idempotency state and explicit reconciliation prevent a second execution. |
| Production order bypasses provider prompts | The App confirmation and native one-use trading grant are independent of provider approval caches. |
| User profile redirects `shioaji` to another binary | Native host binds approved argv to the bundled CLI in an isolated shell profile. |
| App restarts during autonomous work | Pending grants expire, controlled auto pauses, and restored context starts read-only until reconciled/regranted. |
| Audit log is edited, truncated, removed in the middle, or symlinked | Hash-chain verification, JSONL terminator checks, `O_NOFOLLOW`, and startup verification fail closed. |
| Diagnostics expose personal or account data | Audit stores digests rather than raw payloads; skill privacy rules require redaction before export. |

## Residual risk

- A user account with permission to modify the application bundle or process
  memory can replace the trusted computing base; code signing and release
  verification remain distribution responsibilities.
- The WebView executes trusted application code. A future remote-content or XSS
  surface must not be allowed to receive MCP events or invoke native resolution
  commands without an additional window-label/nonce boundary.
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
