# scripts/capture-landing-v2-shots.py — 官網 v2（#156）首屏用的 App 實際畫面。
#
# 只能對「模擬環境」的 shioaji server 跑：先確認 /api/v1/info 回傳
# simulation=true，否則直接結束。隱私模式（帳號＋金額）一律開啟。
# 自選清單 GET 改回傳固定的測試清單，所有修改自選與下單／改單／刪單的
# 請求都在瀏覽器端擋掉，腳本不會動到使用者的資料或送出委託。
#
# 首屏需要 AI Agent 面板：桌面版私有模組放在 ./modules（desktop repo 的 modules/ 複製過來，不進版控）。
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

WS = {
    "blocks": [
        {"id": "assistant-0", "type": "assistant", "pin": None},
        {"id": "chart-a", "type": "chart", "pin": "2330"},
        {"id": "watchlist-0", "type": "watchlist", "pin": None},
        {"id": "flash-a", "type": "flash", "pin": "2330"},
    ],
    "layout": [
        {"i": "assistant-0", "x": 0, "y": 0, "w": 7, "h": 25, "minW": 4, "minH": 6},
        {"i": "chart-a", "x": 7, "y": 0, "w": 9, "h": 25, "minW": 6, "minH": 7},
        {"i": "watchlist-0", "x": 16, "y": 0, "w": 4, "h": 25, "minW": 3, "minH": 6},
        {"i": "flash-a", "x": 20, "y": 0, "w": 4, "h": 25, "minW": 4, "minH": 8},
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


SCRUB_JS = """() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    for (const n of hits) {
        const t = n.nodeValue || '';
        if (/[•·]{3,}\\s*\\d{1,4}/.test(t) || /[0-9A-Z]{3,}[•·]{3,}/.test(t)) n.nodeValue = '••••••';
        else if (/App dev/.test(t)) n.nodeValue = t.replace(/\\s*[·・]?\\s*App dev.*$/, '');
    }
}"""

# 官網「看盤與交易」一區：每個面板單獨拍一張。(檔名, 面板, 固定商品, 寬, 高)，24 欄格線。
GALLERY = [
    ("pulse", "pulse", None, 14, 22),
    ("heatmap", "heatmap", None, 14, 22),
    ("movers", "movers", None, 8, 22),
    ("signals", "signals", None, 10, 22),
    ("chart", "chart", "2330", 14, 20),
    ("intraday", "intraday", "2330", 12, 18),
    ("depth", "depth", "2330", 6, 12),
    ("tape", "tape", "2330", 6, 18),
    ("volprofile", "volprofile", "2330", 7, 18),
    ("depthmap", "depthmap", "2330", 12, 16),
    ("chips", "chips", "2330", 8, 18),
    ("replay", "replay", "2330", 12, 18),
    ("ticket", "ticket", "2330", 6, 18),
    ("flash", "flash", "2330", 7, 24),
    ("oddspread", "oddspread", "2330", 12, 20),
    ("grid", "grid", "2330", 8, 22),
    ("dock", "dock", None, 16, 14),
    ("intradaywall", "intradaywall", None, 16, 22),
    ("pnl", "pnl", None, 12, 18),
    ("watchlist", "watchlist", None, 6, 22),
]


def wait_loaded(page, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if "載入" not in page.inner_text("body"):
            break
        time.sleep(2)
    time.sleep(6)


def seed(page, mode, ws=None):
    ws = ws or WS
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
        [json.dumps(ws), mode],
    )
    page.reload()


def new_ctx(browser, mode, w=1600, h=960, dpr=1.5):
    ctx = browser.new_context(
        viewport={"width": w, "height": h},
        device_scale_factor=dpr,
        color_scheme="dark" if mode == "dark" else "light",
        locale="zh-TW",
        timezone_id="Asia/Taipei",
    )
    ctx.route("**/api/v1/**", guard)
    return ctx


def gallery(browser, mode):
    for name, kind, pin, w, h in GALLERY:
        ws = {
            "blocks": [{"id": "g-0", "type": kind, "pin": pin}],
            "layout": [{"i": "g-0", "x": 0, "y": 0, "w": w, "h": h, "minW": 2, "minH": 2}],
        }
        ctx = new_ctx(browser, mode)
        page = ctx.new_page()
        seed(page, mode, ws)
        wait_loaded(page)
        page.evaluate(SCRUB_JS)
        el = page.locator(".react-grid-item").first
        out = OUT / f"panel-{name}-{mode}.png"
        el.screenshot(path=str(out))
        print("saved", out)
        ctx.close()


def main():
    assert_simulation()
    OUT.mkdir(parents=True, exist_ok=True)
    only_gallery = "--gallery" in sys.argv
    modes = ["dark"] if "--dark-only" in sys.argv else ["dark", "light"]
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("LANDING_CHANNEL") or None)
        if only_gallery:
            for mode in modes:
                gallery(browser, mode)
            browser.close()
            return
        for mode, fname in [("dark", "landing-v2-app-dark.png"), ("light", "landing-v2-app-light.png")]:
            ctx = new_ctx(browser, mode)
            page = ctx.new_page()
            seed(page, mode)
            print("waiting for data...", mode)
            wait_loaded(page, 120)
            time.sleep(2)
            page.evaluate(SCRUB_JS)
            time.sleep(1)
            page.screenshot(path=str(OUT / fname))
            print("saved", OUT / fname)
            ctx.close()
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
