from __future__ import annotations

import math
from dataclasses import asdict, is_dataclass
from datetime import datetime
from typing import Any


def as_plain(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): as_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [as_plain(v) for v in value]
    if is_dataclass(value):
        return as_plain(asdict(value))
    if type(value).__module__.startswith("pandas") and hasattr(value, "to_dict"):
        try:
            return as_plain(value.to_dict("records"))
        except TypeError:
            pass
    if type(value).__module__.startswith("pandas") and hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    if hasattr(value, "to_dict"):
        try:
            return as_plain(value.to_dict())
        except TypeError:
            pass
    if hasattr(value, "_asdict"):
        return as_plain(value._asdict())
    if hasattr(value, "value"):
        return as_plain(value.value)
    module_name = type(value).__module__
    if module_name.startswith("kgisuperpy."):
        try:
            names = [name for name in dir(value) if not name.startswith("_")]
        except Exception:
            names = []
        if names:
            out = {}
            for name in names:
                try:
                    attr = getattr(value, name)
                except Exception:
                    continue
                if callable(attr):
                    continue
                out[name] = as_plain(attr)
            if out:
                return out
    if hasattr(value, "__dict__"):
        return {
            k: as_plain(v)
            for k, v in vars(value).items()
            if not k.startswith("_")
        }
    return str(value)


def number(value: Any, default: float = 0) -> float:
    try:
        if value is None or value == "":
            return default
        result = float(value)
        # KGI's own contract table (台股商品檔) carries NaN limit-up/down
        # for products that trade without a price limit (e.g. actively
        # managed ETFs) — pandas propagates that straight through as a
        # Python float('nan'), which float()/try-except do NOT catch (nan
        # is a valid float). json.dumps() then emits a literal `NaN`
        # token, which is invalid JSON and makes the browser's JSON.parse
        # throw on the ENTIRE response — verified live: one NaN row in a
        # ~2700-row bulk /data/contracts response broke stock-name/
        # category resolution for every symbol in the catalog. Treat any
        # non-finite float as "no value" (the caller's default) instead.
        if not math.isfinite(result):
            return default
        return result
    except (TypeError, ValueError):
        return default


def optional_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
        if not math.isfinite(result):
            return None
        return result
    except (TypeError, ValueError):
        return None


def integer(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def optional_integer(value: Any) -> int | None:
    value_number = optional_number(value)
    return None if value_number is None else int(value_number)


def text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def field(raw: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in raw and raw[name] is not None:
            return raw[name]
    lower = {k.lower(): v for k, v in raw.items()}
    for name in names:
        key = name.lower()
        if key in lower and lower[key] is not None:
            return lower[key]
    return default


def stable_id(value: Any) -> int:
    raw = text(value)
    return abs(sum((index + 1) * ord(ch) for index, ch in enumerate(raw)))


def normalize_date(value: Any) -> str:
    raw = text(value)
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) >= 8:
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
    return raw


def kgi_date(value: Any) -> str:
    return normalize_date(value).replace("-", "")[:8]


def compact_datetime(value: Any) -> tuple[str, str]:
    raw = text(value)
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) >= 14:
        return (
            f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}",
            f"{digits[8:10]}:{digits[10:12]}:{digits[12:14]}",
        )
    if len(digits) >= 12:
        return (
            f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}",
            f"{digits[8:10]}:{digits[10:12]}:00",
        )
    return "", ""


def exchange_from_kgi(value: Any) -> str:
    raw = text(value).upper()
    if raw in {"TWSE", "TSE"}:
        return "TSE"
    if raw in {"TPEX", "OTC"}:
        return "OTC"
    if raw == "TAIFEX":
        return "TAIFEX"
    return "TSE"


def normalize_snapshot(symbol: str, raw_value: Any) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    close = number(field(raw, "price", "close", "收盤價", "成交價", "最新價"))
    raw_change = optional_number(field(raw, "change_price", "price_chg", "漲跌", "漲跌價差"))
    reference_field = field(raw, "reference_price", "ref_price", "reference", "參考價", "昨收")
    reference = number(reference_field, close - raw_change if raw_change is not None else close)
    change = raw_change if raw_change is not None else close - reference
    volume = integer(field(raw, "volume", "vol", "成交量"))
    total_volume = integer(field(raw, "total_volume", "vol_sum", "總量", "累計成交量"), volume)
    return {
        "code": symbol,
        "exchange": exchange_from_kgi(field(raw, "exchange", "market")),
        "datetime": text(field(raw, "datetime", "date_time", "日期", "DateTime")),
        "open": number(field(raw, "open_price", "open", "開盤價"), close),
        "high": number(field(raw, "high_price", "high", "最高價"), close),
        "low": number(field(raw, "low_price", "low", "最低價"), close),
        "close": close,
        "average_price": number(field(raw, "average_price", "avg_price"), close),
        "buy_price": number(field(raw, "bid_price", "buy_price")),
        "buy_volume": integer(field(raw, "bid_volume", "buy_volume")),
        "sell_price": number(field(raw, "ask_price", "sell_price")),
        "sell_volume": integer(field(raw, "ask_volume", "sell_volume")),
        "volume": volume,
        "total_volume": total_volume,
        "amount": close * volume,
        "total_amount": close * total_volume,
        "change_price": change,
        "change_rate": number(field(raw, "change_rate", "pct_chg", "漲跌幅(%)"), (change / reference * 100) if reference else 0),
        "change_type": "Up" if change > 0 else "Down" if change < 0 else "Unchanged",
        # TODO(KGI): official quote docs do not document a buy/sell tick
        # direction field. Keep unknown.
        "tick_type": "0",
        "volume_ratio": number(field(raw, "volume_ratio")),
        "yesterday_volume": integer(field(raw, "yesterday_volume")),
    }


def normalize_tick(raw_value: Any) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    date, time = compact_datetime(field(raw, "datetime", "date_time"))
    close = number(field(raw, "close", "price"))
    total_volume = integer(field(raw, "total_volume", "vol_sum"))
    return {
        "code": text(field(raw, "symbol", "code")),
        "date": date,
        "time": time,
        "open": str(number(field(raw, "open"), close)),
        "high": str(number(field(raw, "high"), close)),
        "low": str(number(field(raw, "low"), close)),
        "close": str(close),
        "volume": integer(field(raw, "volume", "vol")),
        "total_volume": total_volume,
        "amount": str(number(field(raw, "amount"))),
        "total_amount": str(close * total_volume),
        # TODO(KGI): KGI tick docs expose chg_type but not a documented trade
        # side field.
        "tick_type": 0,
        "chg_type": integer(field(raw, "chg_type"), 0),
        "price_chg": str(number(field(raw, "price_chg"))) if field(raw, "price_chg") is not None else None,
        "pct_chg": str(number(field(raw, "pct_chg"))) if field(raw, "pct_chg") is not None else None,
        "intraday_odd": bool(field(raw, "odd_lot", default=False)),
        "simtrade": bool(field(raw, "simtrade", default=False)),
    }


def normalize_bidask(raw_value: Any) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    date, time = compact_datetime(field(raw, "datetime", "date_time"))
    return {
        "code": text(field(raw, "symbol", "code")),
        "date": date,
        "time": time,
        "bid_price": [str(v) for v in (field(raw, "bid_prices", "bid_price", default=[]) or [])],
        "bid_volume": [integer(v) for v in (field(raw, "bid_volumes", "bid_volume", default=[]) or [])],
        "ask_price": [str(v) for v in (field(raw, "ask_prices", "ask_price", default=[]) or [])],
        "ask_volume": [integer(v) for v in (field(raw, "ask_volumes", "ask_volume", default=[]) or [])],
        "diff_bid_vol": [integer(v) for v in (field(raw, "diff_bid_vol", default=[]) or [])],
        "diff_ask_vol": [integer(v) for v in (field(raw, "diff_ask_vol", default=[]) or [])],
        "intraday_odd": bool(field(raw, "odd_lot", default=False)),
        "simtrade": bool(field(raw, "simtrade", default=False)),
    }


def _bar_rows(rows_value: Any) -> list[dict[str, Any]]:
    rows = as_plain(rows_value)
    if isinstance(rows, dict):
        # Pandas DataFrame.to_dict() default orientation can produce
        # {column: {row: value}}. Flatten it cautiously.
        if all(isinstance(v, dict) for v in rows.values()):
            keys = sorted({idx for col in rows.values() for idx in col})
            rows = [{col: values.get(idx) for col, values in rows.items()} for idx in keys]
        elif all(isinstance(v, list) for v in rows.values()):
            keys = range(max((len(v) for v in rows.values()), default=0))
            rows = [{col: values[index] if index < len(values) else None for col, values in rows.items()} for index in keys]
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def _normalized_bar_columns(rows: list[dict[str, Any]]) -> dict[str, list[Any]]:
    by_datetime: dict[str, dict[str, Any]] = {}
    for row in rows:
        dt = text(field(row, "datetime", "date_time", "DateTime", "日期", "date"))
        if not dt:
            continue
        if len("".join(ch for ch in dt if ch.isdigit())) == 8:
            dt = normalize_date(dt)
        close = number(field(row, "close", "Close", "收盤價"))
        # "成交量(張)" is 取得即時分K(最後交易日)'s per-bar volume column
        # (in 張/lots) — distinct from "日成交量(張)", that table's running
        # cumulative-for-the-day total, which must NOT be read as a per-bar
        # value.
        volume = integer(field(row, "volume", "Volume", "成交量", "成交量(張)"))
        amount = number(field(row, "total_amount", "amount", "Amount", "成交金額"))
        if "成交金額(百萬)" in row:
            amount = number(row.get("成交金額(百萬)")) * 1_000_000
        by_datetime[dt] = {
            "datetime": dt,
            "open": number(field(row, "open", "Open", "開盤價"), close),
            "high": number(field(row, "high", "High", "最高價"), close),
            "low": number(field(row, "low", "Low", "最低價"), close),
            "close": close,
            "volume": volume,
            "amount": amount if amount else close * volume,
        }
    ordered = [by_datetime[key] for key in sorted(by_datetime)]
    return {
        "datetime": [row["datetime"] for row in ordered],
        "Open": [row["open"] for row in ordered],
        "High": [row["high"] for row in ordered],
        "Low": [row["low"] for row in ordered],
        "Close": [row["close"] for row in ordered],
        "Volume": [row["volume"] for row in ordered],
        "Amount": [row["amount"] for row in ordered],
    }


def normalize_kbars(rows_value: Any) -> dict[str, list[Any]]:
    return _normalized_bar_columns(_bar_rows(rows_value))


def normalize_daily_bars(rows_value: Any) -> dict[str, list[Any]]:
    return _normalized_bar_columns(_bar_rows(rows_value))


def normalize_account(raw_value: Any) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    flag = text(field(raw, "account_flag", "account_type"))
    account_type = "F" if "期" in flag or flag.upper().startswith("F") else "S"
    return {
        "account_type": account_type,
        "person_id": text(field(raw, "person_id")),
        "broker_id": text(field(raw, "broker_id"), "KGI"),
        "account_id": text(field(raw, "account", "account_id")),
        # TODO(KGI): show_account() does not document an API agreement status.
        # Treat returned accounts as selectable for read-only queries.
        "signed": bool(field(raw, "signed", default=True)),
        "username": text(field(raw, "username"), "KGI User"),
    }


def rows_from_table(raw_value: Any) -> list[dict[str, Any]]:
    raw = as_plain(raw_value)
    if isinstance(raw, dict):
        if all(isinstance(v, dict) for v in raw.values()):
            keys = sorted({idx for col in raw.values() for idx in col})
            return [{col: values.get(idx) for col, values in raw.items()} for idx in keys]
        return [raw]
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    return []


def detail_rows(raw_value: Any, *detail_names: str) -> list[dict[str, Any]]:
    raw = as_plain(raw_value)
    if isinstance(raw, dict):
        names = detail_names or ("Detail", "Detail1", "Detail2")
        rows: list[dict[str, Any]] = []
        for name in names:
            value = field(raw, name)
            if value is None:
                continue
            rows.extend(rows_from_table(value))
        if rows:
            return rows
    return rows_from_table(raw)


def quantity_to_shares(value: Any, source_unit: str = "B") -> int:
    qty = integer(value)
    unit = source_unit.upper()
    # KGI InventorySum: A = 張/lots, B = 股/shares. The frontend canonical
    # stock position unit is shares.
    return qty * 1000 if unit == "A" else qty


def _inventory_bucket_key(account: str, symbol: str, position_type: str, inventory_bucket: str) -> str:
    return f"{account}:{symbol}:{position_type}:{inventory_bucket}"


def normalize_inventory_positions(raw_value: Any, source_unit: str = "B", account: str = "") -> list[dict[str, Any]]:
    rows = rows_from_table(raw_value)
    # NETQTY0 (現股/cash) is KGI's total for the cash-settled bucket, and in
    # Taiwan odd-lot (零股) trades always settle into that same cash bucket —
    # NETQTY9 is not an independent holding, it is the odd-lot component
    # already folded into NETQTY0. Verified against a live account: e.g.
    # 00403A reported NETQTY9=100 and NETQTY0=1100 (1000 round-lot + the same
    # 100 odd-lot shares). Emitting both as separate rows double-counts the
    # odd-lot shares, so "odd" is intentionally not a row-producing bucket
    # here; its quantity is attached to the cash row instead.
    position_defs = [
        ("cash", "現股", "NETQTY0", "R_QTY0", "AVG_PRICE0", "Buy"),
        ("margin", "融資", "NETQTY3", "R_QTY3", "AVG_PRICE3", "Buy"),
        ("short", "融券", "NETQTY4", "R_QTY4", "AVG_PRICE4", "Sell"),
        ("lending", "借券", "NETQTY5", "R_QTY5", "AVG_PRICE0", "Sell"),
    ]
    out: list[dict[str, Any]] = []
    for row in rows:
        symbol = text(field(row, "Symbol", "symbol", "STOCK", "code")).strip().upper()
        if not symbol:
            continue
        name = text(field(row, "SymbolName", "SNAME", "name"), symbol)
        last_price = optional_number(field(row, "RLPRICE", "lastprice", "last_price"))
        total_pnl = optional_number(field(row, "NETPL_TWD", "NETPL", "unrealized"))
        total_market_value = optional_number(field(row, "ASSET_REAL", "ASSET", "market_value"))
        odd_lot_shares = abs(quantity_to_shares(field(row, "NETQTY9", "R_QTY9"), source_unit))
        present: list[tuple[str, str, int, float | None, str]] = []
        for key, label, net_field, yesterday_field, avg_field, direction in position_defs:
            qty_field = field(row, net_field, yesterday_field)
            shares = quantity_to_shares(qty_field, source_unit)
            if key == "cash" and shares == 0 and odd_lot_shares:
                # No round-lot component: this symbol is held entirely via
                # odd-lot trades, so NETQTY9 is the only record of it (there
                # is nothing for it to be double-counted against).
                shares = odd_lot_shares
            if shares == 0:
                continue
            present.append((key, label, abs(shares), optional_number(field(row, avg_field)), direction))
        if not present:
            continue
        total_shares = sum(item[2] for item in present) or 1
        seen_keys: set[str] = set()
        for key, label, shares, avg_price, direction in present:
            last = last_price if last_price is not None else 0
            allocated_pnl = None
            if total_pnl is not None:
                allocated_pnl = total_pnl if len(present) == 1 else total_pnl * (shares / total_shares)
            allocated_market_value = None
            if total_market_value is not None and last <= 0:
                allocated_market_value = total_market_value if len(present) == 1 else total_market_value * (shares / total_shares)
            cost = avg_price if avg_price is not None else 0
            pnl = allocated_pnl if allocated_pnl is not None else (last - cost) * shares * (1 if direction == "Buy" else -1)
            market_value = (
                allocated_market_value
                if allocated_market_value is not None
                else last * shares * (1 if direction == "Buy" else -1)
            )
            dedupe_key = _inventory_bucket_key(account, symbol, key, key)
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)
            out.append(
                {
                    "id": stable_id(dedupe_key),
                    "code": symbol,
                    "name": name,
                    "direction": direction,
                    "quantity": shares,
                    "quantity_unit": "shares",
                    "price": cost,
                    "last_price": last,
                    "market_value": market_value,
                    "pnl": pnl,
                    "pnl_pct": ((pnl / (cost * shares)) * 100) if cost and shares else None,
                    "yd_quantity": quantity_to_shares(field(row, {
                        "cash": "R_QTY0",
                        "margin": "R_QTY3",
                        "short": "R_QTY4",
                        "lending": "R_QTY5",
                    }[key]), source_unit),
                    "position_type": key,
                    "position_type_label": label,
                    "inventory_bucket": key,
                    "dedupe_key": dedupe_key,
                    "account": account or None,
                    # Odd-lot (零股) shares already folded into this cash
                    # total; surfaced for display, not a separate holding.
                    "odd_lot_quantity": odd_lot_shares if key == "cash" else 0,
                }
            )
    return out


def normalize_account_values(raw_value: Any) -> dict[str, Any]:
    rows = rows_from_table(raw_value)
    raw = rows[0] if rows else (as_plain(raw_value) or {})
    if not isinstance(raw, dict):
        raw = {}
    balance = optional_number(
        field(raw, "acc_balance", "balance", "BANKBAL", "CASHBAL", "CSPAYAMT", "CSRECAMT", "可用餘額", "銀行餘額")
    )
    available = optional_number(field(raw, "available_balance", "EXCESS", "可用餘額"))
    buying_power = optional_number(field(raw, "buying_power", "ORDMAMT", "trading_available", "可用額度"))
    return {
        "acc_balance": balance,
        "available_balance": available if available is not None else balance,
        # See RealKGIClient._normalize_account_sources: kgisuperpy's real
        # Account API has no linked-bank-balance field, so this is always
        # None outside of a hypothetical future raw payload that actually
        # carries one of the probed field names above.
        "bank_balance": optional_number(field(raw, "bank_balance", "BANKBAL", "銀行餘額")),
        "buying_power": buying_power,
        "total_assets": optional_number(field(raw, "total_assets", "ASSET", "ASSET_REAL")),
        "stock_market_value": optional_number(field(raw, "stock_market_value")),
        "realized_pnl": optional_number(field(raw, "realized_pnl", "NETPL", "NETPL_TWD", "NETPLTWD")),
        "date": text(field(raw, "date", "TradeDate", "日期"), datetime.now().strftime("%Y-%m-%d")),
        "errmsg": text(field(raw, "errmsg", "ErrMsg", "CodeDesc")),
        "raw_fields": sorted(raw.keys()),
    }


def normalize_settlement_rows(raw_value: Any) -> list[dict[str, Any]]:
    rows = rows_from_table(raw_value)
    out: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        triplets = [
            ("CDate1", "CSRPAMT1", 0),
            ("CDate2", "CSRPAMT2", 1),
            ("CDate3", "CSRPAMT3", 2),
        ]
        if any(field(row, amount_name) is not None for _, amount_name, _ in triplets):
            for date_name, amount_name, t_value in triplets:
                out.append(
                    {
                        "date": text(field(row, date_name), ""),
                        "amount": optional_number(field(row, amount_name)),
                        "T": t_value,
                    }
                )
            continue
        amount = optional_number(field(row, "amount", "NETAMT", "DNAMT", "AMT", "CSPAYAMT", "CSRECAMT", "PAYAMT", "RECAMT"))
        out.append(
            {
                "date": text(field(row, "date", "TradeDate", "SETTLEDATE", "日期"), datetime.now().strftime("%Y-%m-%d")),
                "amount": amount,
                "T": integer(field(row, "T", "t"), index),
            }
        )
    return out


def normalize_profit_loss_rows(
    raw_value: Any,
    start_date: str | None = None,
    end_date: str | None = None,
) -> list[dict[str, Any]]:
    # RealizePL(FType='D', StartDate, EndDate) is already scoped server-side
    # to [StartDate, EndDate] (verified against the installed kgisuperpy
    # 2.1.0 SDK: kgisuperpy/trading/Order.py). This range filter is a
    # defensive re-check against the SAME range the query used, not a
    # single-day exact match — filtering to only `start_date` here used to
    # silently drop every row outside the first day of a multi-day
    # historical query, which broke date-range (historical) results while
    # leaving same-day ("today") queries looking correct by coincidence.
    rows = detail_rows(raw_value, "Detail")
    out: list[dict[str, Any]] = []
    start = normalize_date(start_date) if start_date else ""
    end = normalize_date(end_date) if end_date else ""
    for index, row in enumerate(rows):
        date = normalize_date(field(row, "date", "TradeDate", "日期"))
        if date and start and date < start:
            continue
        if date and end and date > end:
            continue
        pnl = number(field(row, "pnl", "NETPL", "NETPL_TWD", "NETPLTWD"))
        code = text(field(row, "code", "Symbol", "股票代號")).strip().upper()
        dseq = text(field(row, "TERMSEQNO", "seqno", "dseq"), str(index))
        direction_raw = text(field(row, "direction", "BS", "買賣別")).strip().upper()
        direction = (
            "Sell"
            if direction_raw in {"S", "SELL", "賣", "賣出"}
            else "Buy"
            if direction_raw in {"B", "BUY", "買", "買進"}
            else ""
        )
        out.append(
            {
                "id": stable_id(f"{date}:{code}:{dseq}:{index}"),
                "code": code,
                "name": text(field(row, "SymbolName", "SNAME", "name"), code),
                "quantity": integer(field(row, "quantity", "QTY")),
                "pnl": pnl,
                "date": date or datetime.now().strftime("%Y-%m-%d"),
                "trade_date": date or datetime.now().strftime("%Y-%m-%d"),
                "dseq": dseq,
                "price": number(field(row, "price", "PRICE", "ORIPRICE")),
                "cost": number(field(row, "COST")),
                "fee": number(field(row, "FEE")),
                "tax": number(field(row, "TAX")),
                "pr_ratio": number(field(row, "pr_ratio", "PNLRATE")),
                "cond": text(field(row, "cond", "ordClass", "Descript")),
                "descript": text(field(row, "Descript", "cond", "ordClass")),
                "seqno": text(field(row, "seqno", "TERMSEQNO"), str(index)),
                "quantity_unit": "shares",
                "direction": direction,
            }
        )
    return out


def normalize_index_quote(symbol: str, raw_value: Any) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    close = number(field(raw, "close", "price", "Close", "收盤價", "成交價", "最新價"))
    reference = number(field(raw, "reference", "reference_price", "ref_price", "參考價", "昨收"), close)
    return {
        "code": symbol,
        "exchange": exchange_from_kgi(field(raw, "exchange", "market")),
        "date": text(field(raw, "date", "日期")),
        "time": text(field(raw, "time", "時間")),
        "datetime": text(field(raw, "datetime", "date_time", "DateTime", "日期")),
        "reference": str(reference),
        "open": str(number(field(raw, "open", "open_price", "開盤價"), close)),
        "high": str(number(field(raw, "high", "high_price", "最高價"), close)),
        "low": str(number(field(raw, "low", "low_price", "最低價"), close)),
        "close": str(close),
        "amount_sum": str(number(field(raw, "amount_sum", "total_amount", "成交金額"))) if field(raw, "amount_sum", "total_amount", "成交金額") is not None else None,
        "volume": optional_integer(field(raw, "volume", "成交量")),
        "vol_sum": optional_integer(field(raw, "vol_sum", "total_volume", "總量")),
    }


def normalize_contract(code: str, raw_value: Any = None, security_type: str | None = None) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    symbol = text(field(raw, "symbol", "code"), code).upper()
    stype = security_type or text(field(raw, "security_type"), "STK")
    return {
        "region": "TW",
        "exchange": exchange_from_kgi(field(raw, "market", "exchange", default="TSE")),
        "code": symbol,
        "security_type": stype,
        "target_code": field(raw, "target_code"),
        "name": text(field(raw, "name"), symbol),
        "currency": "TWD",
        "limit_up": number(field(raw, "bull_limit", "limit_up")),
        "limit_down": number(field(raw, "bear_limit", "limit_down")),
        "reference": number(field(raw, "ref_price", "reference")),
        "day_trade": text(field(raw, "day_trade")),
        "update_date": text(field(raw, "update_date")),
        "category": text(field(raw, "category")),
        "margin_trading_balance": 0,
        "short_selling_balance": 0,
        "root": field(raw, "root"),
        "underlying_code": field(raw, "underlying_code"),
        "delivery_month": field(raw, "delivery_month"),
    }


def normalize_position(code: str, raw_value: Any) -> dict[str, Any] | None:
    raw = as_plain(raw_value) or {}
    quantity_td = field(raw, "quantity_td", default=[]) or []
    quantity_yd = field(raw, "quantity_yd", default=[]) or []
    if not isinstance(quantity_td, list):
        quantity_td = [quantity_td]
    if not isinstance(quantity_yd, list):
        quantity_yd = [quantity_yd]
    quantity = sum(integer(v) for v in quantity_td)
    if quantity == 0:
        quantity = integer(field(raw, "quantity"))
    if quantity == 0:
        return None
    prices = field(raw, "dealPrice_cash", "price", default=[]) or []
    if not isinstance(prices, list):
        prices = [prices]
    return {
        "id": abs(sum(ord(ch) for ch in code)),
        "code": code,
        "direction": "Buy" if quantity >= 0 else "Sell",
        "quantity": abs(quantity),
        "price": next((number(price) for price in prices if number(price) > 0), 0),
        "last_price": number(field(raw, "lastprice", "last_price")),
        "pnl": number(field(raw, "unrealized", "pnl")),
        "yd_quantity": sum(integer(v) for v in quantity_yd),
    }


def normalize_trade(raw_value: Any, fallback_id: str) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    order = field(raw, "order", default=raw) or raw
    status = field(raw, "order_status", "status", default={}) or {}
    code = text(
        field(order, "symbol", "code", "stock_no", "stk_no", "股票代號"),
        text(field(raw, "symbol", "code", "stock_no", "stk_no", "股票代號"), ""),
    ).strip().upper()
    action_raw = text(field(order, "action", "buy_sell", "bs", "買賣")).lower()
    status_raw = text(field(status, "status", "order_status", "ord_status"), "Submitted")
    quantity = integer(field(order, "quantity", "qty", "order_quantity", "ord_qty", "委託數量"))
    order_id = text(
        field(status, "nid", "id", "order_id", "ordno", "seqno"),
        text(field(order, "order_id", "ordno", "id", "seqno"), fallback_id),
    )
    filled_quantity = integer(field(status, "deal_quantity", "filled_quantity", "filled_qty", "成交數量"))
    cancel_quantity = integer(field(status, "cancel_quantity", "cancel_qty", "取消數量"))
    remaining_quantity = max(0, quantity - filled_quantity - cancel_quantity)
    status_name = status_raw.replace("Status.", "").replace("_", "")
    status_map = {
        "Pending": "PendingSubmit",
        "PendingSubmitted": "PendingSubmit",
        "Submitted": "Submitted",
        "Success": "Submitted",
        "Filled": "Filled",
        "PartFilled": "PartFilled",
        "PartFilledCancelled": "Cancelled",
        "Cancelled": "Cancelled",
        "Failed": "Failed",
    }
    order_type_raw = text(field(order, "time_in_force", "order_type")).upper()
    price_type_raw = text(field(order, "price_type")).replace("PriceType.", "")
    odd_lot_raw = text(field(order, "odd_lot")).replace("OddLot.", "")
    price = number(field(order, "price", "order_price", "ord_price", "委託價格"))
    return {
        "contract": normalize_contract(code, order),
        "order": {
            "id": order_id,
            "seqno": text(field(status, "nid", "seqno"), order_id),
            "ordno": text(field(order, "order_id", "ordno"), order_id),
            "action": "Sell" if "sell" in action_raw or "'s'" in action_raw else "Buy",
            "price": price,
            "quantity": quantity,
            "order_type": "FOK" if "FOK" in order_type_raw else "IOC" if "IOC" in order_type_raw else "ROD",
            "price_type": price_type_raw or ("MKT" if price == 0 else "LMT"),
            "order_lot": "IntradayOdd" if odd_lot_raw == "Odd" else odd_lot_raw,
            "custom_field": text(field(order, "name", "custom_field")),
        },
        "status": {
            "id": order_id,
            "status": status_map.get(status_name, "Submitted"),
            "status_code": status_raw,
            "order_quantity": quantity,
            "deal_quantity": filled_quantity,
            "cancel_quantity": cancel_quantity,
            "remaining_quantity": remaining_quantity,
            "modified_price": number(field(status, "modified_price", default=price)),
            "msg": text(field(status, "msg", "message")),
            "deals": [normalize_deal(deal) for deal in (field(status, "deals", default=[]) or [])],
            "order_id_present": bool(order_id and order_id != fallback_id),
        },
        "raw_fields": {
            "trade": sorted(raw.keys()) if isinstance(raw, dict) else [],
            "order": sorted(order.keys()) if isinstance(order, dict) else [],
            "status": sorted(status.keys()) if isinstance(status, dict) else [],
        },
    }


def epoch_millis(value: Any = None) -> int:
    if value is None:
        return int(datetime.now().timestamp() * 1000)
    if isinstance(value, (int, float)):
        return int(value if value > 10_000_000_000 else value * 1000)
    return int(datetime.now().timestamp() * 1000)


def normalize_deal(raw_value: Any) -> dict[str, Any]:
    raw = as_plain(raw_value) or {}
    return {
        "seq": text(field(raw, "seq", "seqno", "order_id")),
        "price": number(field(raw, "price")),
        "quantity": integer(field(raw, "quantity")),
        "ts": epoch_millis(field(raw, "ts", "datetime", "date_time")),
    }
