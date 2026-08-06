#!/bin/sh
# 抓取 mkcert 到 src-tauri/binaries/，供 tauri dev / 本機打包使用。
# CI（release.yml）有等效的下載步驟；此腳本只服務開發機。
set -e
VER=v1.4.4
cd "$(dirname "$0")/.."
mkdir -p src-tauri/binaries

case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  asset=darwin-arm64;  triple=aarch64-apple-darwin ;;
    Darwin-x86_64) asset=darwin-amd64;  triple=x86_64-apple-darwin ;;
    Linux-x86_64)  asset=linux-amd64;   triple=x86_64-unknown-linux-gnu ;;
    *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

out="src-tauri/binaries/mkcert-$triple"
curl -fsSL -o "$out" \
    "https://github.com/FiloSottile/mkcert/releases/download/$VER/mkcert-$VER-$asset"
chmod +x "$out"
"$out" --version
