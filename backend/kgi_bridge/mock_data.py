from __future__ import annotations

import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .normalizers import normalize_bidask, normalize_kbars, normalize_snapshot, normalize_tick


CONTRACTS: list[dict[str, Any]] = [
    {
        "region": "TW",
        "exchange": "TSE",
        "code": "2330",
        "security_type": "STK",
        "target_code": None,
        "name": "台積電",
        "currency": "TWD",
        "limit_up": 1320,
        "limit_down": 1080,
        "reference": 1200,
        "day_trade": "Yes",
        "update_date": "2026-08-17",
        "category": "24",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    },
    {
        "region": "TW",
        "exchange": "TSE",
        "code": "2317",
        "security_type": "STK",
        "target_code": None,
        "name": "鴻海",
        "currency": "TWD",
        "limit_up": 236.5,
        "limit_down": 193.5,
        "reference": 215,
        "day_trade": "Yes",
        "update_date": "2026-08-17",
        "category": "31",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    },
    {
        "region": "TW",
        "exchange": "TSE",
        "code": "2454",
        "security_type": "STK",
        "target_code": None,
        "name": "聯發科",
        "currency": "TWD",
        "limit_up": 1715,
        "limit_down": 1405,
        "reference": 1560,
        "day_trade": "Yes",
        "update_date": "2026-08-17",
        "category": "24",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    },
    {
        "region": "TW",
        "exchange": "TSE",
        "code": "2603",
        "security_type": "STK",
        "target_code": None,
        "name": "長榮",
        "currency": "TWD",
        "limit_up": 231,
        "limit_down": 189,
        "reference": 210,
        "day_trade": "Yes",
        "update_date": "2026-08-17",
        "category": "15",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    },
    {
        "region": "TW",
        "exchange": "TSE",
        "code": "0050",
        "security_type": "STK",
        "target_code": None,
        "name": "元大台灣50",
        "currency": "TWD",
        "limit_up": 220,
        "limit_down": 180,
        "reference": 200,
        "day_trade": "Yes",
        "update_date": "2026-08-17",
        "category": "",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    },
    {
        "region": "TW",
        "exchange": "TSE",
        "code": "IX0001",
        "security_type": "IND",
        "target_code": None,
        "name": "發行量加權股價指數",
        "currency": "TWD",
        "limit_up": 0,
        "limit_down": 0,
        "reference": 24200,
        "day_trade": "",
        "update_date": "2026-08-17",
        "category": "",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    },
    {
        "region": "TW",
        "exchange": "TAIFEX",
        "code": "TXFR1",
        "security_type": "FUT",
        "target_code": "TXFQ6",
        "name": "台指期近月",
        "currency": "TWD",
        "limit_up": 26700,
        "limit_down": 21800,
        "reference": 24250,
        "day_trade": "Yes",
        "update_date": "2026-08-17",
        "category": "",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
        "root": "TXF",
        "underlying_code": "IX0001",
        "delivery_month": "202608",
        "multiplier": 200,
    },
]

BY_CODE = {contract["code"]: contract for contract in CONTRACTS}


def seed(code: str) -> int:
    return sum(ord(ch) for ch in code)


def contract(code: str, security_type: str | None = None) -> dict[str, Any]:
    normalized = code.strip().upper()
    found = BY_CODE.get(normalized)
    if found and (not security_type or found["security_type"] == security_type):
        return dict(found)
    reference = 30 + seed(normalized) % 500
    return {
        "region": "TW",
        "exchange": "TAIFEX" if security_type in {"FUT", "OPT"} else "TSE",
        "code": normalized,
        "security_type": security_type or "STK",
        "target_code": None,
        "name": normalized,
        "currency": "TWD",
        "limit_up": round(reference * 1.1, 2),
        "limit_down": round(reference * 0.9, 2),
        "reference": reference,
        "day_trade": "" if security_type == "IND" else "Yes",
        "update_date": "2026-08-17",
        "category": "",
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
    }


def contracts(security_type: str) -> list[dict[str, Any]]:
    return [dict(row) for row in CONTRACTS if row["security_type"] == security_type]


def compact_now(at: float | None = None) -> str:
    current = datetime.fromtimestamp(at or time.time())
    return current.strftime("%Y%m%d%H%M%S")


def quote_base(code: str, at: float | None = None) -> dict[str, Any]:
    current = time.time() if at is None else at
    info = contract(code)
    wave = math.sin((current / 20 + seed(code)) % math.pi) * 0.012
    close = round(info["reference"] * (1 + wave), 2)
    return {
        "contract": info,
        "close": close,
        "open": round(info["reference"] * 0.998, 2),
        "high": round(max(close, info["reference"] * 1.012), 2),
        "low": round(min(close, info["reference"] * 0.988), 2),
    }


def snapshot(code: str, at: float | None = None) -> dict[str, Any]:
    base = quote_base(code, at)
    raw = {
        "exchange": "TWSE" if base["contract"]["exchange"] == "TSE" else base["contract"]["exchange"],
        "datetime": compact_now(at),
        "price": base["close"],
        "volume": 5 + seed(code) % 200,
        "total_volume": 10_000 + seed(code) * 13,
        "open_price": base["open"],
        "bid_price": round(base["close"] - 0.5, 2),
        "ask_price": round(base["close"] + 0.5, 2),
        "bid_volume": 200 + seed(code) % 300,
        "ask_volume": 120 + seed(code) % 250,
        "high_price": base["high"],
        "low_price": base["low"],
        "reference_price": base["contract"]["reference"],
    }
    return normalize_snapshot(code, raw)


def tick(code: str, at: float | None = None) -> dict[str, Any]:
    base = quote_base(code, at)
    raw = {
        "exchange": "TWSE" if base["contract"]["exchange"] == "TSE" else base["contract"]["exchange"],
        "symbol": code,
        "datetime": compact_now(at),
        "open": base["open"],
        "high": base["high"],
        "low": base["low"],
        "close": base["close"],
        "volume": 1 + seed(code) % 50,
        "total_volume": 10_000 + seed(code) * 13,
        "chg_type": 2 if base["close"] >= base["contract"]["reference"] else 3,
        "price_chg": round(base["close"] - base["contract"]["reference"], 2),
        "pct_chg": round((base["close"] - base["contract"]["reference"]) / base["contract"]["reference"] * 100, 2),
        "simtrade": False,
        "amount": base["close"] * (1 + seed(code) % 50),
    }
    return normalize_tick(raw)


def bidask(code: str, at: float | None = None) -> dict[str, Any]:
    base = quote_base(code, at)
    step = 5 if base["close"] >= 1000 else 0.5 if base["close"] >= 100 else 0.05
    raw = {
        "symbol": code,
        "datetime": compact_now(at),
        "bid_prices": [round(base["close"] - step * (i + 1), 2) for i in range(5)],
        "ask_prices": [round(base["close"] + step * (i + 1), 2) for i in range(5)],
        "bid_volumes": [120 + seed(code) + i * 17 for i in range(5)],
        "ask_volumes": [95 + seed(code) + i * 13 for i in range(5)],
        "diff_bid_vol": [4 + i for i in range(5)],
        "diff_ask_vol": [3 + i for i in range(5)],
        "simtrade": False,
    }
    return normalize_bidask(raw)


def kbars(code: str, start: str, end: str) -> dict[str, list[Any]]:
    base = contract(code)["reference"]
    tz = timezone(timedelta(hours=8))
    try:
        start_dt = datetime.fromisoformat(f"{start}T09:00:00+08:00")
        end_dt = datetime.fromisoformat(f"{end}T13:30:00+08:00")
    except ValueError:
        start_dt = datetime.now(tz).replace(hour=9, minute=0, second=0, microsecond=0)
        end_dt = start_dt.replace(hour=13, minute=30)
    rows = []
    current = start_dt
    i = 0
    while current <= end_dt and len(rows) < 120:
        if 9 <= current.hour <= 13 and not (current.hour == 13 and current.minute > 30):
            close = round(base * (1 + math.sin(i / 8) * 0.01), 2)
            open_ = round(close * (1 - math.sin(i / 5) * 0.002), 2)
            volume = 50 + (seed(code) + i) % 150
            rows.append(
                {
                    "symbol": code,
                    "datetime": current.isoformat(),
                    "open": open_,
                    "high": round(max(open_, close) * 1.001, 2),
                    "low": round(min(open_, close) * 0.999, 2),
                    "close": close,
                    "volume": volume,
                    "total_amount": close * volume,
                }
            )
            i += 1
        current += timedelta(minutes=1)
    return normalize_kbars(rows)


def daily_bars(code: str, days: int = 90) -> dict[str, list[Any]]:
    info = contract(code, "STK")
    base = info["reference"] or (30 + seed(code) % 500)
    today = datetime(2026, 8, 17)
    trend_by_code = {
        "2330": 0.0027,
        "2317": 0.0018,
        "2454": 0.0012,
        "2603": -0.0011,
        "0050": 0.0015,
    }
    trend = trend_by_code.get(code, ((seed(code) % 7) - 2) / 2500)
    volume_base = {
        "2330": 34_000_000,
        "2317": 52_000_000,
        "2454": 9_000_000,
        "2603": 18_000_000,
        "0050": 16_000_000,
    }.get(code, 4_000_000 + seed(code) * 1200)
    total_days = max(65, days)
    rows: list[dict[str, Any]] = []
    current = today - timedelta(days=total_days * 2)
    while len(rows) < total_days:
        current += timedelta(days=1)
        if current.weekday() >= 5:
            continue
        i = len(rows)
        wave = math.sin(i / 4 + seed(code)) * 0.013
        drift = (i - total_days) * trend
        close = round(base * (1 + drift + wave), 2)
        open_ = round(close * (1 - math.sin(i / 3) * 0.006), 2)
        high = round(max(open_, close) * (1.004 + abs(math.sin(i / 7)) * 0.004), 2)
        low = round(min(open_, close) * (0.996 - abs(math.cos(i / 6)) * 0.003), 2)
        volume_wave = 1 + math.sin(i / 5 + seed(code)) * 0.18
        volume = int(volume_base * volume_wave)
        if i == total_days - 1 and code in {"2330", "2317", "0050"}:
            volume = int(volume * 1.85)
        rows.append(
            {
                "symbol": code,
                "datetime": current.strftime("%Y-%m-%d"),
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
                "total_amount": close * volume,
            }
        )
    return normalize_kbars(rows[-days:])


def history_ticks(code: str, count: int = 80) -> dict[str, list[Any]]:
    now = time.time()
    rows = [tick(code, now - (count - i) * 15) for i in range(count)]
    return {
        "datetime": [f"{row['date']} {row['time']}" for row in rows],
        "close": [float(row["close"]) for row in rows],
        "volume": [row["volume"] for row in rows],
        "bid_price": [float(row["close"]) - 0.5 for row in rows],
        "bid_volume": [max(1, row["volume"] // 2) for row in rows],
        "ask_price": [float(row["close"]) + 0.5 for row in rows],
        "ask_volume": [max(1, (row["volume"] + 1) // 2) for row in rows],
        "tick_type": [row["tick_type"] for row in rows],
    }


def scanner_items(count: int, ascending: bool) -> list[dict[str, Any]]:
    rows = []
    for info in contracts("STK"):
        snap = snapshot(info["code"])
        rows.append(
            {
                "code": info["code"],
                "name": info["name"],
                "date": snap["datetime"][:8],
                "close": snap["close"],
                "open": snap["open"],
                "high": snap["high"],
                "low": snap["low"],
                "change_price": snap["change_price"],
                "change_type": 1 if snap["change_price"] > 0 else 2 if snap["change_price"] < 0 else 0,
                "average_price": snap["average_price"],
                "price_range": snap["high"] - snap["low"],
                "rank_value": snap["change_rate"],
                "total_volume": snap["total_volume"],
                "total_amount": snap["total_amount"],
                "volume_ratio": snap["volume_ratio"],
                "yesterday_volume": snap["yesterday_volume"],
                "tick_type": 0,
                "buy_price": snap["buy_price"],
                "sell_price": snap["sell_price"],
            }
        )
    return sorted(rows, key=lambda item: item["rank_value"], reverse=not ascending)[:count]


def default_watchlist_contracts() -> list[dict[str, Any]]:
    return [
        {
            "region": info["region"],
            "exchange": info["exchange"],
            "code": info["code"],
            "security_type": info["security_type"],
            "target_code": info["target_code"],
        }
        for info in (contract(code) for code in ["2330", "2317", "2454", "2603", "0050", "TXFR1"])
    ]
