# Shioaji #226 integration QA branch

This branch pins the matching private native-bootstrap integration commit.
It is branch-only: no App PR or release until the Shioaji bootstrap change is
published. `SHIOAJI_VERSION` intentionally remains unchanged; local QA must
build the server feature branch, not download the released binary.

Overlay `modules/`, `src-tauri/`, and `plugins/` from the pinned private commit.
Build the Shioaji `feat/226-native-secret-bootstrap` branch and install its
binary as the matching `src-tauri/binaries/shioaji-<target>` sidecar. Build/run
the native App, not just Vite in a browser.

Check the owned sidecar's `/api/v1/info`: `agent_harness.bootstrap` must be
`one_shot_ipc`, audience must be present, and version must match the feature
build. Inspect argv/environment without printing credentials: the secret must
not be present. Restart through native App lifecycle and verify a new owned
PID and audience. Native verification must reject legacy/missing/unknown
bootstrap reports. Production Agent trading stays blocked in this branch;
do not send production orders as part of bootstrap QA.

## Local evidence (2026-09-08, macOS arm64)

- Actual bundled App launched its own sidecar: App PID 64086, child 64181,
  loopback port 21322; version 1.7.4 feature build, simulation true,
  `bootstrap=one_shot_ipc`, enabled true. UI finished loading live market panels.
- OS environment inspection returned `secret_environment_present=0`; stdin
  was `/dev/null` after bootstrap. No credentials were printed or recorded.
- Native App quit removed both PIDs and released the port. Relaunch produced
  App PID 65752 / child 65926 and a different audience with the same IPC mode.
- Public/private composite: 424 frontend tests and build passed; native Rust
  194 passed / 14 intentionally ignored; strict all-target clippy passed.
- Explicit ignored `native_launcher_interoperates_with_real_server_bootstrap`
  was run with `SJ_BOOTSTRAP_PROBE` set to the server test executable and passed.
- No orders were sent. Bootstrap integration is verified; production approval
  remains outside this branch and Windows/Linux results belong to server CI.
