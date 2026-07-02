#!/bin/sh
# Dev API server — runs the BUNDLED sidecar binary（與 CI 打包同版本），
# so the UI always talks to a matching API version. Never touches the
# user's own CLI server on 8080.
#
#   port:    21322（app 預設），override with SJ_DEV_PORT
#   binary:  src-tauri/binaries/shioaji-<target-triple>（gitignored；
#            下載對應版本：github.com/sinotrade/shioaji releases）
#   keys:    專案根目錄 .env（SJ_API_KEY / SJ_SEC_KEY）

set -eu
cd "$(dirname "$0")/.."

case "$(uname -sm)" in
    "Darwin arm64") TRIPLE=aarch64-apple-darwin ;;
    "Darwin x86_64") TRIPLE=x86_64-apple-darwin ;;
    "Linux x86_64") TRIPLE=x86_64-unknown-linux-gnu ;;
    *) echo "unsupported platform: $(uname -sm)" >&2; exit 1 ;;
esac

BIN="src-tauri/binaries/shioaji-$TRIPLE"
if [ ! -x "$BIN" ]; then
    echo "missing $BIN — download the sidecar binary first:" >&2
    echo "  https://github.com/sinotrade/shioaji/releases" >&2
    exit 1
fi

echo "dev api: $("$BIN" --version | tail -1) on 127.0.0.1:${SJ_DEV_PORT:-21322}"
exec env SJ_HTTP_ADDR="127.0.0.1:${SJ_DEV_PORT:-21322}" \
    "$BIN" server start --no-open
