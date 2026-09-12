# Agent Harness threat model

This candidate enables production semantic Agent trading with Shioaji 1.7.5.
The maintainer explicitly requested user-selected production Auto, superseding
#51's original mandatory-confirm-only product constraint. The wire capability
contract remains v1. See [AGENT_HARNESS_CONTRACT.md](AGENT_HARNESS_CONTRACT.md).

## Trusted components

The native host owns sidecar/provider processes, generation keys, approval
windows, runtime identity, audit and exact-byte forwarding. The main WebView is
trusted App code and runs the existing risk engine and durable idempotency
store. Provider output, skills and shell descendants are untrusted inputs.
A provider and its descendants share their own short-lived MCP bearer scope.

## Boundaries

1. Every owned sidecar generation receives a new random signing secret through
   an inherited anonymous stdin pipe: `SJAHIPC1` + 64 ASCII hex bytes + EOF.
   `SJ_AGENT_HARNESS_SECRET` is removed from its environment. Production startup
   requires the server's explicit `one_shot_ipc` report; missing, environment or
   unknown bootstrap fails closed. The derived signer key remains native.
2. A production semantic mutation must match a retained native MCP call, or a
   Pi native protocol request. Call IDs are consumed once. Operation, quantity,
   price, side, order defaults, authoritative contract and account are checked
   before approval and forwarding. The native proxy signs retained UTF-8 bytes
   once and never returns a capability to the caller.
3. Confirm uses a separate native-created `agent-approval` window. Its label
   and creation marker are checked by pending/respond. Forged labels are
   destroyed. Close, reload, expiry and stale authority deny before send.
4. Auto is an in-memory grant scoped to runtime, generation and account. Its
   first production mutation asks the user to authorize the displayed order
   and that session scope. The renderer's `agentAuto` flag requests this flow;
   it does not prove consent. Selection/environment changes, reload, runtime
   stop/exit and restart revoke it. App risk rules can still force confirmation.
5. Main WebView manual trading remains a separate trusted entry point. It
   does not inherit an Agent call's approval or open an Agent window merely
   because another call is pending. This boundary does not claim protection
   from compromised App code invoking the manual trading proxy.
6. Provider shell permission grants no App trading authority. Native CLI
   broker variables are not injected into providers; production CLI grants
   remain blocked. Direct HTTP callers cannot mint a sidecar capability.
7. MCP binds to IPv4 loopback, rejects non-loopback Origins, limits request and
   pending-call sizes, validates registered schemas, and revokes bearer digests
   with runtimes. Native event redaction removes exact credentials before logs
   or WebView emission. Bearers may reside in owner-only provider configuration
   or argv and are not secret from that provider's own descendants.
8. Audit records include proposal/denial, scope digests, capability consumption,
   response class and unknown outcome. They contain no body or credentials.
   Keyed entries and a MACed head checkpoint detect edits, missing segments,
   truncation and deletion; unhealthy audit blocks Agent mutations.
9. Durable idempotency never retries ambiguous mutations. Reconciliation uses
   the original tool/key; matching payloads alone do not prove execution. Hard
   capacity limits preserve unresolved entries, and completed replay guards
   remain for the retention period. Oversized results retain digest guards.

## Residual risks and verification limits

- This is an App/sidecar authorization boundary, not an OS sandbox against a
  hostile process with debugger access, process-memory access or replacement of
  the trusted bundle. Broker login/CA bootstrap credentials still use the
  server's existing startup environment. A separately compromised same-user
  credential store or external broker session is outside this capability
  verifier's boundary. One-shot signing IPC does not make all same-user secrets
  inaccessible.
- The trusted WebView still runs risk policy and idempotency. Native code
  validates semantic/body identity and approval scope, not a complete portfolio
  risk model. New remote content must not receive privileged Tauri access.
  The embedded Dashboard is restricted to the owned loopback sidecar and gets
  no App capability or signing material.
- Local audit keys/checkpoints are not hardware-backed or externally anchored;
  restoring an old valid complete snapshot can roll back local evidence.
- Unix detached descendants can survive orderly process-group termination or
  an App crash. Revoked MCP bearers and generation keys cannot authorize later
  App calls, but this is not complete OS containment.
- A crash or cancellation after network submission can leave an unknown broker
  outcome. Revocation cannot undo a request already sent; reconciliation must
  complete before a new intended mutation is considered.
- Fixture/CI coverage is not real broker-order or clean-machine certification.
  Candidate evidence and outstanding native/platform gates are recorded in
  [agent-harness-production-qa.md](agent-harness-production-qa.md). No historical
  release waiver applies automatically.
