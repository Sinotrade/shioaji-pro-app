#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$(dirname "$ROOT_DIR")"
DESKTOP_DIR="${SHIOAJI_PRO_DESKTOP_DIR:-$WORKSPACE_DIR/shioaji-pro-agent-harness}"
SERVER_DIR="${SHIOAJI_SERVER_DIR:-$WORKSPACE_DIR/shioaji-agent-permission}"
TARGET_TRIPLE="aarch64-apple-darwin"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    echo "This QA launcher currently supports Apple Silicon macOS only." >&2
    exit 1
fi

for directory in "$DESKTOP_DIR/modules" "$DESKTOP_DIR/src-tauri" "$SERVER_DIR"; do
    if [[ ! -e "$directory" ]]; then
        echo "Missing required development source: $directory" >&2
        exit 1
    fi
done

# Vite resolves packages from the physical location of a symlinked module,
# and Tauri requires Cargo metadata to live beneath the app root. Mirror the
# private overlay exactly like CI does, but keep it gitignored locally.
for overlay in modules src-tauri; do
    if [[ -L "$ROOT_DIR/$overlay" ]]; then
        unlink "$ROOT_DIR/$overlay"
    fi
    mkdir -p "$ROOT_DIR/$overlay"
done
rsync -a "$DESKTOP_DIR/modules/" "$ROOT_DIR/modules/"
rsync -a --exclude target --exclude binaries \
    "$DESKTOP_DIR/src-tauri/" "$ROOT_DIR/src-tauri/"

EXPECTED_DESKTOP_REF="$(tr -d '[:space:]' < "$ROOT_DIR/DESKTOP_MODULES_REF")"
ACTUAL_DESKTOP_REF="$(git -C "$DESKTOP_DIR" rev-parse HEAD)"
if [[ "$ACTUAL_DESKTOP_REF" != "$EXPECTED_DESKTOP_REF" ]]; then
    echo "Desktop source $ACTUAL_DESKTOP_REF does not match pin $EXPECTED_DESKTOP_REF" >&2
    exit 1
fi

BIN_DIR="$ROOT_DIR/src-tauri/binaries"
SERVER_BIN="$BIN_DIR/shioaji-$TARGET_TRIPLE"
MKCERT_BIN="$BIN_DIR/mkcert-$TARGET_TRIPLE"
SERVER_HEAD_FILE="$BIN_DIR/.shioaji-dev-head"
SERVER_HEAD="$(git -C "$SERVER_DIR" rev-parse HEAD)"
EXPECTED_VERSION="$(tr -d 'v[:space:]' < "$ROOT_DIR/SHIOAJI_VERSION")"

mkdir -p "$BIN_DIR"
DESKTOP_BIN_DIR="$DESKTOP_DIR/src-tauri/binaries"
if [[ ! -x "$SERVER_BIN" && -x "$DESKTOP_BIN_DIR/shioaji-$TARGET_TRIPLE" ]]; then
    install -m 755 "$DESKTOP_BIN_DIR/shioaji-$TARGET_TRIPLE" "$SERVER_BIN"
    if [[ -f "$DESKTOP_BIN_DIR/.shioaji-dev-head" ]]; then
        cp "$DESKTOP_BIN_DIR/.shioaji-dev-head" "$SERVER_HEAD_FILE"
    fi
fi
if [[ ! -x "$MKCERT_BIN" && -x "$DESKTOP_BIN_DIR/mkcert-$TARGET_TRIPLE" ]]; then
    install -m 755 "$DESKTOP_BIN_DIR/mkcert-$TARGET_TRIPLE" "$MKCERT_BIN"
fi
if [[ ! -x "$SERVER_BIN" || ! -f "$SERVER_HEAD_FILE" || "$(<"$SERVER_HEAD_FILE")" != "$SERVER_HEAD" ]]; then
    DEV_TARGET="${TMPDIR:-/tmp}/shioaji-pro-harness-server-target"
    cargo build --manifest-path "$SERVER_DIR/Cargo.toml" --bin shioaji --target-dir "$DEV_TARGET"
    install -m 755 "$DEV_TARGET/debug/shioaji" "$SERVER_BIN"
    printf '%s\n' "$SERVER_HEAD" > "$SERVER_HEAD_FILE"
    cargo clean --manifest-path "$SERVER_DIR/Cargo.toml" --target-dir "$DEV_TARGET"
fi

ACTUAL_VERSION="$("$SERVER_BIN" --version | tail -1 | awk '{print $2}')"
if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "Dev sidecar version $ACTUAL_VERSION does not match expected $EXPECTED_VERSION" >&2
    exit 1
fi

if [[ ! -x "$MKCERT_BIN" ]]; then
    curl -fsSL -o "$MKCERT_BIN" \
        https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-darwin-arm64
    chmod +x "$MKCERT_BIN"
fi

case "$MODE" in
    run)
        exec pnpm tauri dev
        ;;
    --debug|debug)
        export RUST_BACKTRACE=1
        export RUST_LOG=debug
        exec pnpm tauri dev
        ;;
    --logs|logs|--telemetry|telemetry)
        export RUST_BACKTRACE=1
        export RUST_LOG=info
        exec pnpm tauri dev
        ;;
    --verify|verify)
        pnpm tauri dev &
        launcher_pid=$!
        for _ in {1..120}; do
            if pgrep -x "$APP_PROCESS" >/dev/null; then
                echo "Shioaji Pro dev app is running (PID $(pgrep -x "$APP_PROCESS" | head -1))."
                wait "$launcher_pid"
                exit $?
            fi
            sleep 1
        done
        kill "$launcher_pid" >/dev/null 2>&1 || true
        echo "Shioaji Pro dev app did not launch within 120 seconds." >&2
        exit 1
        ;;
    *)
        echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
        exit 2
        ;;
esac
