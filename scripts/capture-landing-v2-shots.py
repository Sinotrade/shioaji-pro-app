# scripts/capture-landing-v2-shots.py — 官網 v2（#156）首屏用的 App 實際畫面。
#
# 只能對「模擬環境」的 shioaji server 跑：先確認 /api/v1/info 回傳
# simulation=true，否則直接結束。隱私模式（帳號＋金額）一律開啟。
# 自選清單 GET 改回傳固定的測試清單，所有修改自選與下單／改單／刪單的
# 請求都在瀏覽器端擋掉，腳本不會動到使用者的資料或送出委託。
#
# Run:
#   VITE_API_TARGET=http://127.0.0.1:<sim-port> PORT=5400 npx vite --strictPort
#   uv run --python 3.12 --with playwright==1.52.0 python scripts/capture-landing-v2-shots.py
#
# 環境變數：LANDING_BASE（預設 http://127.0.0.1:5400）、LANDING_OUT（預設 docs/images）。

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("LANDING_OUT", ROOT / "docs" / "images"))
BASE = os.environ.get("LANDING_BASE", "http://127.0.0.1:5400")

TEST_WATCHLIST = [
    {
        "id": "landing-demo",
        "name": "示範清單",
        "contracts": [
            {"security_type": "STK", "exchange": "TSE", "code": c}
            for c in ["2330", "2317", "2454", "2308", "2382", "2881", "2891", "0050", "2603", "3711"]
        ],
    }
]

# 24 欄（v2）存檔，App 讀到時自動升階。股票為主的版面。
WS = {
    "blocks": [
        {"id": "watchlist-0", "type": "watchlist", "pin": None},
        {"id": "chart-a", "type": "chart", "pin": "2330"},
        {"id": "flash-a", "type": "flash", "pin": "2330"},
        {"id": "depth-0", "type": "depth", "pin": "2330"},
        {"id": "movers-0", "type": "movers", "pin": None},
    ],
    "layout": [
        {"i": "watchlist-0", "x": 0, "y": 0, "w": 5, "h": 25, "minW": 3, "minH": 6},
        {"i": "chart-a", "x": 5, "y": 0, "w": 10, "h": 15, "minW": 6, "minH": 7},
        {"i": "flash-a", "x": 15, "y": 0, "w": 5, "h": 25, "minW": 4, "minH": 8},
        {"i": "depth-0", "x": 20, "y": 0, "w": 4, "h": 25, "minW": 4, "minH": 7},
        {"i": "movers-0", "x": 5, "y": 15, "w": 10, "h": 10, "minW": 3, "minH": 5},
    ],
}

BLOCKED_ORDER_PATHS = (
    "/api/v1/order/place_order",
    "/api/v1/order/cancel_order",
    "/api/v1/order/update_price",
    "/api/v1/order/update_qty",
    "/api/v1/order/place_comboorder",
    "/api/v1/order/cancel_comboorder",
    "/api/v1/order/reserve_stock",
    "/api/v1/order/reserve_earmarking",
)


def assert_simulation():
    with urllib.request.urlopen(f"{BASE}/api/v1/info", timeout=5) as r:
        info = json.load(r)
    if info.get("simulation") is not True:
        sys.exit("refusing to capture: server is not in simulation mode")


def guard(route, request):
    url = request.url
    if "/api/v1/watchlist" in url:
        if request.method == "GET" and url.rstrip("/").endswith("/api/v1/watchlist"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(TEST_WATCHLIST))
        return route.abort()
    if any(p in url for p in BLOCKED_ORDER_PATHS):
        return route.abort()
    return route.continue_()


def seed(page, mode):
    page.goto(BASE)
    page.evaluate(
        """([ws, mode]) => {
            localStorage.clear();
            localStorage.setItem('sj-pro-workspace-v2', ws);
            localStorage.setItem('sj-pro-watchlist-spark', '1');
            localStorage.setItem('sj-pro-privacy-mode', '1');
            localStorage.setItem('sj-pro-privacy-money', '1');
            localStorage.setItem('sj-pro-theme', JSON.stringify({mode, convention:'tw', fontScale:1}));
        }""",
        [json.dumps(WS), mode],
    )
    page.reload()


def main():
    assert_simulation()
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("LANDING_CHANNEL") or None)
        for mode, fname in [("dark", "landing-v2-app-dark.png"), ("light", "landing-v2-app-light.png")]:
            ctx = browser.new_context(
                viewport={"width": 1600, "height": 960},
                device_scale_factor=1.5,
                color_scheme="dark" if mode == "dark" else "light",
                locale="zh-TW",
                timezone_id="Asia/Taipei",
            )
            ctx.route("**/api/v1/**", guard)
            page = ctx.new_page()
            seed(page, mode)
            print("waiting for data...", mode)
            deadline = time.time() + 120
            while time.time() < deadline:
                body = page.inner_text("body")
                if "載入" not in body:
                    break
                time.sleep(2)
            time.sleep(8)
            # 隱私模式已遮掉大部分帳號；截圖前再把殘留的帳號尾碼與開發版字樣換掉。
            page.evaluate(
                """() => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    const hits = [];
                    while (walker.nextNode()) hits.push(walker.currentNode);
                    for (const n of hits) {
                        const t = n.nodeValue || '';
                        if (/[•·]{3,}\\s*\\d{1,4}/.test(t) || /[0-9A-Z]{3,}[•·]{3,}/.test(t)) n.nodeValue = '••••••';
                        else if (/App dev/.test(t)) n.nodeValue = t.replace(/\\s*[·・]?\\s*App dev.*$/, '');
                    }
                }"""
            )
            time.sleep(1)
            page.screenshot(path=str(OUT / fname))
            print("saved", OUT / fname)
            ctx.close()
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
