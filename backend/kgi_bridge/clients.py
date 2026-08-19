from __future__ import annotations

import concurrent.futures
import contextlib
import functools
import importlib
import io
import os
import queue
import re
import threading
import time
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any

from . import mock_data
from .capabilities import CapabilityRegistry
from .errors import BridgeError
from .normalizers import (
    as_plain,
    normalize_account_values,
    normalize_account,
    normalize_bidask,
    normalize_contract,
    normalize_daily_bars,
    normalize_deal,
    normalize_inventory_positions,
    normalize_kbars,
    normalize_position,
    normalize_profit_loss_rows,
    normalize_index_quote,
    normalize_snapshot,
    normalize_tick,
    normalize_trade,
    normalize_settlement_rows,
    rows_from_table,
    detail_rows,
    field,
    number,
    integer,
    kgi_date,
    normalize_date,
    text,
)


INDEX_SYMBOLS: dict[str, dict[str, str]] = {
    "IX0001": {"quote": "001", "data": "Y9999", "name": "發行量加權股價指數", "exchange": "TSE"},
}


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def market_debug_enabled() -> bool:
    return env_bool("KGI_DEBUG_MARKET_DATA", False)


def market_debug(message: str) -> None:
    if market_debug_enabled():
        print(message, flush=True)


def perf_log(label: str, started_at: float) -> float:
    """Print one [PERF] line for a completed stage and return its duration
    in seconds. One line per meaningful backend operation (contract catalog
    build, snapshot batch, scanner run, ...) — not per-row — so this stays
    cheap enough to leave on by default."""
    elapsed = time.perf_counter() - started_at
    print(f"[PERF] {label}: {elapsed:.3f}s", flush=True)
    return elapsed


def timed(label: str):
    """Method decorator: log [PERF] {label}: N.NNNs for every call,
    success or failure, without touching the wrapped method's control
    flow."""

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            started_at = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                perf_log(label, started_at)

        return wrapper

    return decorator


def kgisuperpy_login_constructor() -> Any:
    errors: list[str] = []
    for module_name in ("kgisuperpy", "kgisuperpy.main"):
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            errors.append(f"{module_name}: {exc.__class__.__name__}: {exc}")
            continue

        login = getattr(module, "login", None)
        if callable(login):
            return login
        errors.append(f"{module_name}: missing callable login")

    detail = "; ".join(errors) or "unknown import error"
    raise BridgeError(503, f"kgisuperpy login API is unavailable: {detail}")


def account_rows(api: Any) -> list[dict[str, Any]]:
    raw_accounts = api.show_account()
    plain = as_plain(raw_accounts)
    if isinstance(plain, dict):
        rows = list(plain.values())
    elif isinstance(plain, list):
        rows = plain
    else:
        rows = []
    return [row for row in rows if isinstance(row, dict)]


def account_setter_name(account: dict[str, Any]) -> str:
    flag = str(account.get("account_flag") or account.get("account_type") or "").upper()
    if "期" in flag or flag.startswith("F"):
        return "set_FutAccount"
    if "複" in flag or flag.startswith("O"):
        return "set_SubAccount"
    return "set_Account"


def account_identifier(account: dict[str, Any]) -> str:
    return str(account.get("account") or account.get("account_id") or "").strip()


def is_stock_account(account: dict[str, Any]) -> bool:
    flag = str(account.get("account_flag") or account.get("account_type") or "").strip().upper()
    return "證券" in flag or "SECURITIES" in flag or "STOCK" in flag or flag.startswith("S")


def safe_account_label(account: dict[str, Any]) -> str:
    account_id = account_identifier(account)
    suffix = account_id[-4:] if len(account_id) >= 4 else account_id
    masked = f"***{suffix}" if suffix else "unknown"
    broker_id = str(account.get("broker_id") or "").strip() or "unknown-broker"
    flag = str(account.get("account_flag") or account.get("account_type") or "").strip() or "unknown-type"
    return f"{broker_id}/{flag}/{masked}"


def choose_stock_account(rows: list[dict[str, Any]], configured_account: str | None) -> str:
    stock_accounts = [row for row in rows if is_stock_account(row)]
    if not stock_accounts:
        raise BridgeError(503, "KGI stock account not found in show_account() response")

    configured = (configured_account or "").strip()
    if configured:
        selected = next((row for row in stock_accounts if account_identifier(row) == configured), None)
        if selected is None:
            safe_candidates = ", ".join(safe_account_label(row) for row in stock_accounts)
            raise BridgeError(
                503,
                "Configured KGI_ACCOUNT was not found among KGI stock accounts"
                + (f". Stock candidates: {safe_candidates}" if safe_candidates else ""),
            )
        return configured

    if len(stock_accounts) == 1:
        account_id = account_identifier(stock_accounts[0])
        if account_id:
            return account_id
        raise BridgeError(503, "KGI stock account was found but did not include an account identifier")

    safe_candidates = ", ".join(safe_account_label(row) for row in stock_accounts)
    raise BridgeError(
        503,
        "Multiple KGI stock accounts found; set KGI_ACCOUNT to choose one"
        + (f". Stock candidates: {safe_candidates}" if safe_candidates else ""),
    )


def queue_tick_event(event_queue: queue.Queue[tuple[str, dict[str, Any]]], event_name: str, data: Any) -> None:
    event_queue.put((event_name, normalize_tick(data)))


def queue_bidask_event(event_queue: queue.Queue[tuple[str, dict[str, Any]]], event_name: str, data: Any) -> None:
    event_queue.put((event_name, normalize_bidask(data)))


def queue_kbar_event(event_queue: queue.Queue[tuple[str, dict[str, Any]]], data: Any) -> None:
    event_queue.put(("kbar", as_plain(data)))


def kbar_symbol(data: Any) -> str:
    plain = as_plain(data) or {}
    if not isinstance(plain, dict):
        return ""
    return str(plain.get("symbol") or plain.get("code") or plain.get("股票代號") or "").strip().upper()


def kbar_minute(data: Any) -> int | None:
    plain = as_plain(data) or {}
    if not isinstance(plain, dict):
        return None
    for name in ("minute", "minutes", "interval", "timeframe"):
        raw = plain.get(name)
        if raw not in (None, ""):
            try:
                return int(float(raw))
            except (TypeError, ValueError):
                return None
    return None


def kbar_timestamp(data: dict[str, Any]) -> str:
    return str(data.get("datetime") or data.get("date_time") or "")


def bridge_data_error(exc: Exception, table: str, symbol: str, minute: int | None = None) -> BridgeError | None:
    code = getattr(getattr(exc, "code", None), "value", "")
    if not code:
        return None
    status_by_code = {
        "D400": 400,
        "D401": 401,
        "D403": 403,
        "D404": 404,
        "D500": 502,
    }
    status = status_by_code.get(str(code), 502)
    upstream_message = getattr(exc, "message", str(exc))
    return BridgeError(
        status,
        f"KGI historical K-bar request failed upstream ({code}): {upstream_message}",
        {
            "table": table,
            "symbol": symbol,
            "minute": minute,
            "upstream_code": code,
        },
    )


def bridge_upstream_error(exc: Exception, operation: str, details: dict[str, Any] | None = None) -> BridgeError | None:
    code = getattr(getattr(exc, "code", None), "value", "")
    if code:
        status_by_code = {
            "D400": 400,
            "D401": 401,
            "D403": 403,
            "D404": 404,
            "D500": 502,
        }
        status = status_by_code.get(str(code), 502)
        message = getattr(exc, "message", str(exc))
        return BridgeError(
            status,
            f"KGI {operation} failed upstream ({code}): {message}",
            {"upstream_code": code, **(details or {})},
        )
    return None


def bridge_order_error(exc: Exception, operation: str) -> BridgeError:
    bridge_error = bridge_upstream_error(exc, operation)
    if bridge_error is not None:
        return bridge_error
    if isinstance(exc, ValueError):
        return BridgeError(400, f"KGI {operation} rejected: {exc}")
    message = str(exc) or exc.__class__.__name__
    return BridgeError(502, f"KGI {operation} failed: {message}")


def enum_member(module: Any, enum_name: str, member_name: str) -> Any:
    enum_obj = getattr(module, enum_name, None)
    if enum_obj is None:
        raise BridgeError(503, f"kgisuperpy enum is unavailable: {enum_name}")
    try:
        return getattr(enum_obj, member_name)
    except AttributeError as exc:
        raise BridgeError(422, f"kgisuperpy enum {enum_name}.{member_name} is not supported") from exc


def normalize_client_request_id(value: Any) -> str:
    request_id = str(value or "").strip()
    if not request_id:
        raise BridgeError(400, "client_request_id is required for real order-changing requests")
    if len(request_id) > 128:
        raise BridgeError(400, "client_request_id is too long")
    return request_id


def contract_mapping_from_quote(api: Any) -> dict[str, Any]:
    quote = getattr(api, "Quote", None)
    candidates = [
        getattr(quote, "Contracts", None),
        getattr(getattr(quote, "_api", None), "Contracts", None),
    ]
    for candidate in candidates:
        plain = as_plain(candidate)
        if isinstance(plain, dict) and plain:
            return plain

    symbols = getattr(quote, "_list", None)
    if isinstance(symbols, list) and symbols:
        return {str(symbol): {"symbol": str(symbol)} for symbol in symbols}
    return {}


def _security_type(value: str | None) -> str:
    return (value or "STK").strip().upper()


def canonical_index_symbol(symbol: str) -> str:
    upper = symbol.strip().upper()
    if upper in {"001", "Y9999"}:
        return "IX0001"
    return upper


def index_quote_symbol(symbol: str) -> str:
    canonical = canonical_index_symbol(symbol)
    return INDEX_SYMBOLS.get(canonical, {}).get("quote", canonical)


def index_data_symbol(symbol: str) -> str:
    canonical = canonical_index_symbol(symbol)
    return INDEX_SYMBOLS.get(canonical, {}).get("data", canonical)


_INDEX_SYMBOL_PATTERN = re.compile(r"^IX\d{4}$")


def is_index_symbol(symbol: str) -> bool:
    # INDEX_SYMBOLS only carries a verified quote/data code mapping for
    # IX0001 (TAIEX). The frontend's SECTOR_INDICES table (src/lib/
    # stock-index.ts) also sends 25 more TWSE industry sub-index codes in
    # this same IX00xx shape (IX0010..IX0041) for the sector-heatmap
    # overview. Those aren't in INDEX_SYMBOLS (no verified KGI native code
    # for each), but they are still index codes, not stock codes — routing
    # them to the stock snapshot path (Data.get_snapshots) crashes with a
    # raw KeyError('bullBearRefPx') because indices don't carry that field
    # (verified live). Recognizing the IX00xx shape generically routes
    # every index code to the dedicated index-snapshot path instead, which
    # degrades to a documented BridgeError rather than an unhandled crash.
    canonical = canonical_index_symbol(symbol)
    return canonical in INDEX_SYMBOLS or bool(_INDEX_SYMBOL_PATTERN.match(canonical))


def row_value(row: dict[str, Any], index: int, default: Any = None) -> Any:
    values = list(row.values())
    return values[index] if index < len(values) else default


def empty_kbars(**meta: Any) -> dict[str, list[Any] | dict[str, Any]]:
    out: dict[str, list[Any] | dict[str, Any]] = {
        "datetime": [],
        "Open": [],
        "High": [],
        "Low": [],
        "Close": [],
        "Volume": [],
        "Amount": [],
    }
    if meta:
        out["capability"] = meta
    return out


def filter_kbars_by_date(kbars: dict[str, list[Any]], start: str, end: str) -> dict[str, list[Any]]:
    start_date = normalize_date(start)
    end_date = normalize_date(end)
    keep = [
        index
        for index, value in enumerate(kbars.get("datetime", []))
        if (not start_date or str(value)[:10] >= start_date) and (not end_date or str(value)[:10] <= end_date)
    ]
    return {key: [values[index] for index in keep if index < len(values)] for key, values in kbars.items()}


def merge_kbars(left: dict[str, list[Any]], right: dict[str, list[Any]]) -> dict[str, list[Any]]:
    rows: list[dict[str, Any]] = []
    for source in (left, right):
        datetimes = source.get("datetime", [])
        for index, dt in enumerate(datetimes):
            rows.append(
                {
                    "datetime": dt,
                    "Open": source.get("Open", [])[index] if index < len(source.get("Open", [])) else 0,
                    "High": source.get("High", [])[index] if index < len(source.get("High", [])) else 0,
                    "Low": source.get("Low", [])[index] if index < len(source.get("Low", [])) else 0,
                    "Close": source.get("Close", [])[index] if index < len(source.get("Close", [])) else 0,
                    "Volume": source.get("Volume", [])[index] if index < len(source.get("Volume", [])) else 0,
                    "Amount": source.get("Amount", [])[index] if index < len(source.get("Amount", [])) else 0,
                }
            )
    return normalize_kbars(rows)


def api_diagnostic(api: Any) -> dict[str, Any]:
    if api is None:
        return {
            "api_type": "None",
            "has_order": False,
            "has_quote": False,
            "has_show_account": False,
        }
    api_type = type(api)
    return {
        "api_type": f"{api_type.__module__}.{api_type.__qualname__}",
        "has_order": hasattr(api, "Order"),
        "has_quote": hasattr(api, "Quote"),
        "has_show_account": callable(getattr(api, "show_account", None)),
    }


def resolve_kgi_api(api: Any) -> Any:
    candidates = [
        api,
        getattr(api, "api", None),
        getattr(api, "_api", None),
        getattr(api, "_API", None),
    ]
    for candidate in candidates:
        if candidate is not None and callable(getattr(candidate, "show_account", None)):
            return candidate
    return api


class KGIClient(ABC):
    mode: str

    @abstractmethod
    def health(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def info(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def accounts(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def contract(self, code: str, security_type: str | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def contracts(self, security_type: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def snapshots(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def kbars(self, symbol: str, start: str, end: str, minute: int = 1) -> dict[str, list[Any]]:
        raise NotImplementedError

    @abstractmethod
    def history_ticks(self, symbol: str, count: int = 120) -> dict[str, list[Any]]:
        raise NotImplementedError

    @abstractmethod
    def bidask_snapshot(self, symbol: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def daily_bars(self, symbol: str, days: int = 90) -> dict[str, list[Any]]:
        raise NotImplementedError

    @abstractmethod
    def positions(self, account_type: str | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def orders(self, account_type: str | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def deals(self, account_type: str | None = None) -> dict[str, list[dict[str, Any]]]:
        raise NotImplementedError

    @abstractmethod
    def account_values(self) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def settlements(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def profit_loss(self, start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def profit_loss_summary(self, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def trading_limits(self, symbol: str | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def place_stock_order(self, contract: dict[str, Any], order: dict[str, Any], client_request_id: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def cancel_order(self, order_id: str, client_request_id: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def update_order(self, order_id: str, client_request_id: str, price: float | None = None, qty: int | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def subscribe_quote(self, symbol: str, quote_type: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def unsubscribe_quote(self, symbol: str, quote_type: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def poll_stream_events(self, timeout: float = 1.0) -> list[tuple[str, dict[str, Any]]]:
        raise NotImplementedError

    def scanner(self, scanner_type: str, count: int, ascending: bool) -> list[dict[str, Any]]:
        raise NotImplementedError


class MockKGIClient(KGIClient):
    mode = "mock"

    def __init__(self) -> None:
        self._subscriptions: set[tuple[str, str]] = set()

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "connected": True,
            "mode": self.mode,
            "version": "kgisuperpy-mock",
            "timestamp": datetime.now().isoformat(),
            "token_expires_in_seconds": 24 * 60 * 60,
            "token_stale": False,
            "contract_count": len(mock_data.contracts("STK")),
            "next_maintenance": "",
            "last_maintenance": "",
        }

    def info(self) -> dict[str, Any]:
        return {
            "name": "KGI SuperPy Bridge",
            "version": "mock",
            "description": "Local KGI bridge using MockKGIClient",
            "protocols": ["kgisuperpy", "http", "sse"],
            "simulation": True,
        }

    def accounts(self) -> list[dict[str, Any]]:
        return [
            {
                "account_type": "S",
                "person_id": "KGI_MOCK",
                "broker_id": "KGI",
                "account_id": "0000000",
                "signed": True,
                "username": "KGI Mock",
            },
            {
                "account_type": "F",
                "person_id": "KGI_MOCK",
                "broker_id": "KGI",
                "account_id": "F000000",
                "signed": True,
                "username": "KGI Mock",
            },
        ]

    def contract(self, code: str, security_type: str | None = None) -> dict[str, Any]:
        return mock_data.contract(code, security_type)

    def contracts(self, security_type: str) -> list[dict[str, Any]]:
        return mock_data.contracts(security_type)

    def snapshots(self, symbols: list[str]) -> list[dict[str, Any]]:
        return [mock_data.snapshot(symbol) for symbol in symbols]

    def kbars(self, symbol: str, start: str, end: str, minute: int = 1) -> dict[str, list[Any]]:
        return mock_data.kbars(symbol, start, end)

    def history_ticks(self, symbol: str, count: int = 120) -> dict[str, list[Any]]:
        return mock_data.history_ticks(symbol, count)

    def bidask_snapshot(self, symbol: str) -> dict[str, Any]:
        return mock_data.bidask(symbol)

    def daily_bars(self, symbol: str, days: int = 90) -> dict[str, list[Any]]:
        return mock_data.daily_bars(symbol, days)

    def positions(self, account_type: str | None = None) -> list[dict[str, Any]]:
        return []

    def orders(self, account_type: str | None = None) -> list[dict[str, Any]]:
        return []

    def deals(self, account_type: str | None = None) -> dict[str, list[dict[str, Any]]]:
        return {}

    def account_values(self) -> dict[str, Any]:
        return normalize_account_values({"acc_balance": 1_000_000, "date": datetime.now().strftime("%Y-%m-%d")})

    def settlements(self) -> list[dict[str, Any]]:
        return [{"date": datetime.now().strftime("%Y-%m-%d"), "amount": 0, "T": 0}]

    def profit_loss(self, start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
        return []

    def profit_loss_summary(self, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        return {
            "profitloss_sum": [],
            "total": {
                "entry_amount": 0,
                "cover_amount": 0,
                "quantity": 0,
                "buy_cost": 0,
                "sell_cost": 0,
                "pnl": 0,
                "pr_ratio": 0,
            },
        }

    def trading_limits(self, symbol: str | None = None) -> dict[str, Any]:
        return {
            "trading_limit": 0,
            "trading_used": 0,
            "trading_available": 0,
            "margin_limit": 0,
            "margin_used": 0,
            "margin_available": 0,
            "short_limit": 0,
            "short_used": 0,
            "short_available": 0,
        }

    def place_stock_order(self, contract: dict[str, Any], order: dict[str, Any], client_request_id: str) -> dict[str, Any]:
        return normalize_trade(
            {
                "order": {
                    "symbol": contract.get("code"),
                    "action": order.get("action"),
                    "price": order.get("price"),
                    "quantity": order.get("quantity"),
                    "time_in_force": order.get("order_type"),
                    "price_type": order.get("price_type"),
                    "odd_lot": order.get("order_lot"),
                },
                "status": {"id": client_request_id, "nid": client_request_id, "status": "Submitted"},
            },
            client_request_id,
        )

    def cancel_order(self, order_id: str, client_request_id: str) -> dict[str, Any]:
        return normalize_trade({"order": {"order_id": order_id}, "status": {"id": client_request_id, "status": "Cancelled"}}, client_request_id)

    def update_order(self, order_id: str, client_request_id: str, price: float | None = None, qty: int | None = None) -> dict[str, Any]:
        return normalize_trade({"order": {"order_id": order_id, "price": price or 0, "quantity": qty or 0}, "status": {"id": client_request_id, "status": "Submitted"}}, client_request_id)

    def subscribe_quote(self, symbol: str, quote_type: str) -> dict[str, Any]:
        self._subscriptions.add((symbol, quote_type))
        return {
            "success": True,
            "message": f"KGI mock subscribed {quote_type} {symbol}",
            "subscription": {"code": symbol, "quote_type": quote_type},
        }

    def unsubscribe_quote(self, symbol: str, quote_type: str) -> dict[str, Any]:
        self._subscriptions.discard((symbol, quote_type))
        return {
            "success": True,
            "message": f"KGI mock unsubscribed {quote_type} {symbol}",
        }

    def poll_stream_events(self, timeout: float = 1.0) -> list[tuple[str, dict[str, Any]]]:
        if timeout:
            threading.Event().wait(timeout)
        events: list[tuple[str, dict[str, Any]]] = []
        for symbol, quote_type in sorted(self._subscriptions):
            if quote_type == "BidAsk":
                events.append(("bidask_stk", mock_data.bidask(symbol)))
            elif quote_type == "Quote":
                events.append(("kbar", {"code": symbol, **mock_data.kbars(symbol, "2026-08-17", "2026-08-17")}))
            else:
                events.append(("tick_stk", mock_data.tick(symbol)))
        return events

    def scanner(self, scanner_type: str, count: int, ascending: bool) -> list[dict[str, Any]]:
        from .mock_data import scanner_items

        return scanner_items(count, ascending)


class RealKGIClient(KGIClient):
    mode = "real"

    def __init__(self) -> None:
        self.api: Any = None
        self.connected = False
        self.connection_error = ""
        self._connect_attempted = False
        self._connect_lock = threading.Lock()
        # kgisuperpy's TradeCom bridge is a ctypes wrapper around a native
        # DLL (tradecom_windows_bridge64.dll) that is not safe to call from
        # arbitrary OS threads. The HTTP server (ThreadingHTTPServer) hands
        # every request its own thread, so without this, login happens on
        # whichever thread first touches the client and every later call
        # (including order creation) arrives on a *different* thread than
        # the one that owns the native connection. That mismatch is the
        # verified cause of the "access violation reading 0x..." crash on
        # create_order: it's a ctypes-trapped Windows SEH fault, not a
        # Python exception, and it reproduces from cross-thread native
        # calls into non-reentrant broker SDKs like this one. Routing every
        # native call through a single dedicated worker thread guarantees
        # the DLL is always invoked from the same OS thread for the life of
        # the process.
        self._native_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="kgi-native"
        )
        self._native_thread_id = self._native_executor.submit(threading.get_ident).result()
        self._event_queue: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
        self._callbacks_installed = False
        self._api_diagnostic = api_diagnostic(None)
        self._kbar_lock = threading.Lock()
        self._kbar_subscriptions: set[tuple[str, int]] = set()
        self._kbar_cache: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self._historical_kbar_denials: dict[str, BridgeError] = {}
        self._quote_lock = threading.Lock()
        self._quote_subscriptions: set[tuple[str, str]] = set()
        self._quote_subscription_errors: dict[tuple[str, str], dict[str, Any]] = {}
        # Last known five-level depth per symbol. The KGI push feed only
        # sends a bidask update when the order book actually changes, so a
        # freshly (re)subscribed panel can otherwise sit empty for a long
        # time (or indefinitely once trading is quiet/closed). Replaying the
        # cached snapshot on subscribe means the UI always has the latest
        # known depth instead of a blank skeleton.
        self._bidask_cache: dict[str, dict[str, Any]] = {}
        self._order_lock = threading.Lock()
        self._submitted_request_ids: set[str] = set()
        self.selected_stock_account = ""
        # Session-scoped D403/entitlement cache shared by any Data/MSMP
        # table lookup that isn't already covered by a dedicated cache
        # (historical K-bars use their own `_historical_kbar_denials` dict
        # for the same reason: stop retrying a confirmed-forbidden table).
        self._capabilities = CapabilityRegistry()
        # Stock contract catalog cache — verified live: kgisuperpy's own
        # Order.contract("dic") already caches the raw ~2700-row KGI fetch
        # for the life of the login session, but our own as_plain() +
        # normalize_contract() pass over every row was being redone from
        # scratch on every single call (measured ~125-135ms of pure CPU per
        # call even with the SDK's cache warm) — including once per symbol
        # for every individual /data/contracts/{code} lookup (e.g. resolving
        # an N-symbol watchlist did N of these rebuilds, serialized on the
        # single native-call worker thread below). Contract metadata
        # (name/category/limit-up-down/reference price) is set once per
        # trading day, not "rapidly changing" like quotes/snapshots, so
        # caching the normalized result for the life of the process (with
        # an explicit refresh_stock_contracts() escape hatch) is safe.
        self._stock_contracts_lock = threading.Lock()
        self._stock_contracts_raw: dict[str, Any] | None = None
        self._stock_contracts_normalized: dict[str, dict[str, Any]] | None = None

    def _call_native(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        """Run fn on the single dedicated native-SDK thread and block for the
        result. Every call into kgisuperpy/TradeCom must go through this so
        the native DLL only ever sees calls from the OS thread that owns it
        (see the comment in __init__). If we're already executing on that
        thread (a native call nested inside another, e.g. a fallback path
        that reuses another method), call fn directly instead of submitting
        to the single-worker executor, which would otherwise deadlock
        waiting on itself.
        """
        if threading.get_ident() == self._native_thread_id:
            return fn(*args, **kwargs)
        return self._native_executor.submit(fn, *args, **kwargs).result()

    def _do_connect(self) -> Any:
        person_id = os.getenv("KGI_PERSON_ID")
        person_pwd = os.getenv("KGI_PERSON_PWD")
        if not person_id or not person_pwd:
            raise BridgeError(503, "KGI_PERSON_ID and KGI_PERSON_PWD are required for real mode")

        simulation = env_bool("KGI_SIMULATION", False)
        login = kgisuperpy_login_constructor()
        # Verified from the installed kgisuperpy 2.1.0 package:
        # kgisuperpy.__init__ exports main.login, a constructor-style
        # class that performs login in __init__.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            login_api = login(person_id, person_pwd, simulation)
        api = resolve_kgi_api(login_api)
        self._api_diagnostic = api_diagnostic(api)
        if api is None or not callable(getattr(api, "show_account", None)):
            raise BridgeError(503, "KGI login did not initialize account APIs")
        self.api = api
        account = os.getenv("KGI_ACCOUNT")
        # Account selection, API validation, and callback registration all
        # touch the native connection and must run on this same thread.
        self._select_stock_account(account)
        self._validate_stock_api()
        self._install_callbacks()
        return api

    def _ensure_connected(self) -> Any:
        if self.connected and self.api is not None:
            return self.api

        with self._connect_lock:
            if self.connected and self.api is not None:
                return self.api
            if self._connect_attempted:
                raise BridgeError(503, self.connection_error or "KGI login failed")

            self._connect_attempted = True
            try:
                api = self._call_native(self._do_connect)
                self.connected = True
                self.connection_error = ""
                return api
            except BridgeError as exc:
                self.api = None
                self.connected = False
                self.connection_error = exc.message
                raise
            except Exception as exc:
                self.api = None
                self.connected = False
                self.connection_error = f"KGI login failed: {exc}"
                raise BridgeError(503, self.connection_error)

    def _select_stock_account(self, account: str | None) -> None:
        if self.api is None:
            return
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rows = account_rows(self.api)
            selected_account = choose_stock_account(rows, account)
            setter = getattr(self.api, "set_Account", None)
            if not callable(setter):
                raise BridgeError(503, "KGI account setter is unavailable: set_Account")
            setter(selected_account)
            self.selected_stock_account = selected_account
        self._api_diagnostic = api_diagnostic(self.api)

    def _validate_stock_api(self) -> None:
        if self.api is None:
            raise BridgeError(503, "KGI login did not return an API object")
        self._api_diagnostic = api_diagnostic(self.api)
        missing: list[str] = []
        if not callable(getattr(self.api, "show_account", None)):
            missing.append("show_account")
        if not hasattr(self.api, "Quote"):
            missing.append("Quote")
        if not hasattr(self.api, "Account"):
            missing.append("Account")
        order = getattr(self.api, "Order", None)
        if order is None:
            missing.append("Order")
        else:
            for name in ("get_position", "get_trades"):
                if not callable(getattr(order, name, None)):
                    missing.append(f"Order.{name}")
        if missing:
            raise BridgeError(503, f"KGI stock API is incomplete after account selection: {', '.join(missing)}")

    def _install_callbacks(self) -> None:
        if self._callbacks_installed or self.api is None:
            return

        def on_tick(data):
            self._record_tick_event(data)

        def on_bidask(data):
            self._record_bidask_event(data)

        def on_kbar(data):
            self._record_kbar_event(data)

        quote = self.api.Quote
        # kgisuperpy 2.1.0 validates quote callbacks as single-data-argument
        # callables. Keep these functions unannotated; its validator rejects
        # postponed string annotations such as "None".
        quote.set_cb_tick(on_tick)
        quote.set_cb_bidask(on_bidask)
        quote.set_cb_kbar(on_kbar)

        set_order_event = getattr(getattr(self.api, "Order", None), "set_event", None)
        if callable(set_order_event):
            set_order_event(self._record_order_event)

        self._callbacks_installed = True

    def _record_order_event(self, data: Any) -> None:
        plain = as_plain(data)
        event_id = f"kgi-event-{int(datetime.now().timestamp() * 1000)}"
        self._event_queue.put(("order_event", normalize_trade({"order": plain, "status": plain}, event_id)))

    def _record_tick_event(self, data: Any) -> None:
        plain = as_plain(data)
        normalized = normalize_tick(plain)
        self._event_queue.put(("tick_stk", normalized))
        symbol = str(normalized.get("code") or "").strip().upper()
        if symbol:
            market_debug(f"[KGI tick] symbol={symbol}")
            self._record_tick_as_live_kbar(symbol, normalized)

    def _record_bidask_event(self, data: Any) -> None:
        plain = as_plain(data)
        normalized = normalize_bidask(plain)
        self._event_queue.put(("bidask_stk", normalized))
        symbol = str(normalized.get("code") or "").strip().upper()
        bids = len([price for price in normalized.get("bid_price", []) if price not in ("", "0", "0.0")])
        asks = len([price for price in normalized.get("ask_price", []) if price not in ("", "0", "0.0")])
        if symbol:
            if bids or asks:
                with self._quote_lock:
                    self._bidask_cache[symbol] = normalized
            market_debug(f"[KGI bidask] symbol={symbol} bids={bids} asks={asks}")

    def _record_tick_as_live_kbar(self, symbol: str, tick: dict[str, Any]) -> None:
        price = tick.get("close")
        try:
            close = float(price)
        except (TypeError, ValueError):
            return
        if close <= 0:
            return
        with self._kbar_lock:
            keys = [key for key in self._kbar_subscriptions if key[0] == symbol] or [(symbol, 1)]
            for key_symbol, minute in keys:
                rows = self._kbar_cache.setdefault((key_symbol, minute), [])
                datetime_text = f"{tick.get('date', '')} {tick.get('time', '')}".strip()
                bucket = datetime_text[:16] if datetime_text else ""
                volume = tick.get("volume", 0)
                try:
                    volume_number = int(float(volume))
                except (TypeError, ValueError):
                    volume_number = 0
                last = rows[-1] if rows else None
                last_bucket = kbar_timestamp(last)[:16] if isinstance(last, dict) else ""
                if last is not None and last_bucket == bucket:
                    last["high"] = max(float(last.get("high") or close), close)
                    last["low"] = min(float(last.get("low") or close), close)
                    last["close"] = close
                    last["volume"] = int(float(last.get("volume") or 0)) + volume_number
                    last["total_amount"] = close * int(float(last.get("volume") or 0))
                else:
                    rows.append(
                        {
                            "symbol": symbol,
                            "datetime": datetime_text,
                            "timeframe": minute,
                            "open": close,
                            "high": close,
                            "low": close,
                            "close": close,
                            "volume": volume_number,
                            "total_amount": close * volume_number,
                        }
                    )
                    if len(rows) > 1000:
                        del rows[:-1000]

    def _record_kbar_event(self, data: Any) -> None:
        plain = as_plain(data)
        queue_kbar_event(self._event_queue, plain)
        if not isinstance(plain, dict):
            return
        symbol = kbar_symbol(plain)
        if not symbol:
            return
        minute = kbar_minute(plain)
        with self._kbar_lock:
            keys = (
                [(symbol, minute)]
                if minute is not None
                else [key for key in self._kbar_subscriptions if key[0] == symbol]
            )
            if not keys:
                keys = [(symbol, 1)]
            for key in keys:
                rows = self._kbar_cache.setdefault(key, [])
                rows.append(plain)
                if len(rows) > 1000:
                    del rows[:-1000]
        market_debug(f"[KGI kbar] symbol={symbol} interval={minute or 'unknown'}m")

    def supports_futures(self) -> bool:
        return False

    def _futures_disabled(self, code: str = "", security_type: str | None = None) -> bool:
        stype = _security_type(security_type)
        symbol = code.strip().upper()
        return stype in {"FUT", "OPT"} or symbol.startswith(("TXF", "TXO"))

    def health(self) -> dict[str, Any]:
        try:
            self._ensure_connected()
        except BridgeError:
            return {
                "status": "disconnected",
                "connected": False,
                "mode": self.mode,
                "version": "kgisuperpy",
                "timestamp": datetime.now().isoformat(),
                "token_expires_in_seconds": 0,
                "token_stale": True,
                "contract_count": 0,
                "next_maintenance": "",
                "last_maintenance": "",
                "message": self.connection_error,
                "api_diagnostic": self._api_diagnostic,
            }
        return {
            "status": "ok",
            "connected": True,
            "mode": self.mode,
            "version": "kgisuperpy",
            "timestamp": datetime.now().isoformat(),
            "token_expires_in_seconds": 0,
            "token_stale": False,
            "contract_count": 0,
            "next_maintenance": "",
            "last_maintenance": "",
            "api_diagnostic": self._api_diagnostic,
        }

    def info(self) -> dict[str, Any]:
        return {
            "name": "KGI SuperPy Bridge",
            "version": "real",
            "description": "Local KGI bridge using RealKGIClient",
            "protocols": ["kgisuperpy", "http", "sse"],
            "simulation": env_bool("KGI_SIMULATION", False),
        }

    @timed("accounts")
    def accounts(self) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        # Verified from installed kgisuperpy 2.1.0: successful login exposes
        # api.show_account().
        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return account_rows(api)

        rows = self._call_native(call)
        return [normalize_account(row) for row in rows]

    def contract(self, code: str, security_type: str | None = None) -> dict[str, Any]:
        stype = _security_type(security_type)
        if stype == "IND" or is_index_symbol(code):
            canonical = canonical_index_symbol(code)
            meta = INDEX_SYMBOLS.get(canonical, {})
            return normalize_contract(
                canonical,
                {
                    "symbol": canonical,
                    "name": meta.get("name", canonical),
                    "exchange": meta.get("exchange", "TSE"),
                    "security_type": "IND",
                },
                "IND",
            )
        if self._futures_disabled(code, security_type):
            raise BridgeError(404, "KGI futures/options support is not enabled for this stock-only session")
        api = self._ensure_connected()
        normalized = self._normalized_stock_contracts(api)
        hit = normalized.get(code)
        if hit is not None:
            return hit
        # Unknown/unlisted code — same shape as before (an empty-raw row),
        # just without polluting the cache with a miss.
        return normalize_contract(code, None, security_type)

    def contracts(self, security_type: str) -> list[dict[str, Any]]:
        if _security_type(security_type) == "IND":
            return [self.contract(code, "IND") for code in INDEX_SYMBOLS]
        if self._futures_disabled(security_type=security_type):
            return []
        api = self._ensure_connected()
        return list(self._normalized_stock_contracts(api).values())

    def refresh_stock_contracts(self) -> dict[str, dict[str, Any]]:
        """Explicit cache-busting refresh path (task requirement: contract
        metadata is cached for the life of the process, but must still be
        refreshable without restarting the backend — e.g. after a new
        trading-day's 台股商品檔 publishes updated limit-up/down prices)."""
        api = self._ensure_connected()
        return self._normalized_stock_contracts(api, refresh=True)

    def _normalized_stock_contracts(self, api: Any, *, refresh: bool = False) -> dict[str, dict[str, Any]]:
        if not refresh:
            with self._stock_contracts_lock:
                if self._stock_contracts_normalized is not None:
                    return self._stock_contracts_normalized
        raw = self._stock_contracts(api, refresh=refresh)
        started_at = time.perf_counter()
        normalized = (
            {code: normalize_contract(code, row, "STK") for code, row in raw.items()}
            if isinstance(raw, dict)
            else {}
        )
        perf_log(f"normalize_contract x{len(normalized)}", started_at)
        with self._stock_contracts_lock:
            self._stock_contracts_normalized = normalized
        return normalized

    def _stock_contracts(self, api: Any, *, refresh: bool = False) -> dict[str, Any]:
        # Prefer Order.contract("dic") — wired in kgisuperpy 2.1.0 from
        # Data.contract(), which builds each row from the 台股商品檔 table
        # with a verified plain-dataclass shape: symbol, name, update_date,
        # market, category, sub_category, bull_limit, bear_limit, ref_price,
        # day_trade (kgisuperpy/data/data.py). normalize_contract()'s field
        # names line up with this exactly. api.Quote.Contracts (used below
        # as a fallback) is a native TradeCom-DLL-backed dict whose per-row
        # field names are undocumented and not guaranteed to include "name"
        # or "category" — using it as the primary source was the verified
        # cause of stock names rendering as their own code (e.g. 2330
        # instead of 台積電) in real mode.
        #
        # kgisuperpy's own Data.contract() (which Order.contract is aliased
        # to after login — see kgisuperpy/main.py) already memoizes the raw
        # ~2700-row fetch for the life of the session, so this only pays a
        # real KGI round-trip once; but the process boundary between that
        # cache and ours still costs a native-thread hop plus a fresh
        # as_plain() walk of ~2700 dataclasses on every call, so we cache
        # the raw dict here too and skip _call_native entirely on a hit.
        if not refresh:
            with self._stock_contracts_lock:
                if self._stock_contracts_raw is not None:
                    return self._stock_contracts_raw

        started_at = time.perf_counter()
        contract_getter = getattr(getattr(api, "Order", None), "contract", None)
        rows: dict[str, Any] | None = None
        if callable(contract_getter):
            try:
                fetched = as_plain(self._call_native(contract_getter, "dic"))
            except Exception as exc:
                bridge_error = bridge_upstream_error(exc, "stock contract lookup", {"source": "Order.contract"})
                if bridge_error is not None:
                    raise bridge_error
                raise BridgeError(
                    503,
                    f"KGI contract lookup failed: {exc.__class__.__name__}: {exc}",
                )
            if isinstance(fetched, dict) and fetched:
                rows = fetched
        if rows is None:
            rows = contract_mapping_from_quote(api)
        perf_log(f"contracts fetch (Order.contract dic) x{len(rows)}", started_at)
        with self._stock_contracts_lock:
            self._stock_contracts_raw = rows
            if refresh:
                self._stock_contracts_normalized = None
        return rows

    def snapshots(self, symbols: list[str]) -> list[dict[str, Any]]:
        started_at = time.perf_counter()
        try:
            return self._snapshots_impl(symbols)
        finally:
            perf_log(f"snapshots batch (n={len(symbols)})", started_at)

    def _snapshots_impl(self, symbols: list[str]) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        normalized_symbols = [canonical_index_symbol(symbol) for symbol in symbols]
        index_symbols = [symbol for symbol in normalized_symbols if is_index_symbol(symbol)]
        stock_symbols = [symbol for symbol in normalized_symbols if not is_index_symbol(symbol)]
        out: dict[str, dict[str, Any]] = {}
        for symbol in index_symbols:
            # One index without a verified KGI native code (any of the 25
            # TWSE sub-indices beyond IX0001 — see is_index_symbol) must not
            # take the whole batch down; degrade that single symbol to a
            # real zero/unavailable snapshot instead of failing every other
            # requested symbol in the same call.
            try:
                out[symbol] = self._index_snapshot(symbol)
            except Exception:
                out[symbol] = normalize_snapshot(symbol, {})
        if not stock_symbols:
            return [out[symbol] for symbol in normalized_symbols if symbol in out]
        # Verified in official data docs: api.Data.get_snapshots(symbols)
        try:
            raw = as_plain(self._call_native(api.Data.get_snapshots, stock_symbols))
        except Exception as exc:
            bridge_error = bridge_upstream_error(exc, "snapshot request", {"symbols": stock_symbols})
            if bridge_error is not None:
                raise bridge_error
            raise BridgeError(
                502,
                f"KGI snapshot request failed: {exc.__class__.__name__}: {exc}",
                {"symbols": stock_symbols},
            ) from exc
        if isinstance(raw, dict):
            for symbol in stock_symbols:
                out[symbol] = normalize_snapshot(symbol, raw.get(symbol, {}))
        elif isinstance(raw, list):
            for index, row in enumerate(raw):
                if index < len(stock_symbols):
                    out[stock_symbols[index]] = normalize_snapshot(stock_symbols[index], row)
        return [out[symbol] for symbol in normalized_symbols if symbol in out]

    def _index_snapshot(self, symbol: str) -> dict[str, Any]:
        api = self._ensure_connected()
        canonical = canonical_index_symbol(symbol)
        table = "取得歷史分K(含加權/櫃買指數)"
        try:
            raw = self._call_native(api.Data.get, table, index_data_symbol(canonical), 1)
        except Exception as exc:
            bridge_error = bridge_upstream_error(exc, "weighted index request", {"table": table, "symbol": index_data_symbol(canonical)})
            if bridge_error is None or bridge_error.status != 403:
                if bridge_error is not None:
                    raise bridge_error
                raise
            fallback_table = "日K/技術指標/價量資料-單檔股票多個區間"
            try:
                raw = self._call_native(api.Data.get, fallback_table, index_data_symbol(canonical))
            except Exception as fallback_exc:
                fallback_error = bridge_upstream_error(
                    fallback_exc,
                    "weighted index request",
                    {"table": fallback_table, "symbol": index_data_symbol(canonical)},
                )
                if fallback_error is not None:
                    raise fallback_error
                raise
        rows = rows_from_table(raw)
        row = rows[-1] if rows else {}
        normalized = normalize_snapshot(canonical, row)
        if normalized["close"] == 0 and row:
            normalized.update(
                {
                    "datetime": text(row_value(row, 0)),
                    "open": number(row_value(row, 3)),
                    "high": number(row_value(row, 4)),
                    "low": number(row_value(row, 5)),
                    "close": number(row_value(row, 6)),
                    "volume": integer(row_value(row, 7)),
                    "total_volume": integer(row_value(row, 7)),
                    "total_amount": number(row_value(row, 8)) * 1_000_000,
                    "change_price": number(row_value(row, 9)),
                    "change_rate": number(row_value(row, 10)),
                }
            )
        return normalized

    @timed("kbars")
    def kbars(self, symbol: str, start: str, end: str, minute: int = 1) -> dict[str, list[Any]]:
        symbol = symbol.strip().upper()
        if not symbol:
            raise BridgeError(400, "symbol is required")
        if minute >= 1440:
            return filter_kbars_by_date(self.daily_bars(symbol, 0), start, end)

        historical: dict[str, list[Any]] | None = None
        denied: BridgeError | None = None
        historical_unavailable = False
        try:
            historical = self.historical_kbars(symbol, start, end, minute)
        except BridgeError as exc:
            if exc.status == 503 and "Data API is unavailable" in exc.message:
                historical = None
                historical_unavailable = True
            elif exc.status != 403:
                raise
            else:
                denied = exc

        live = self.live_kbars(symbol, minute)
        if historical is not None:
            merged = merge_kbars(historical, live)
            if historical.get("datetime"):
                merged["capability"] = {"historical": "ok", "live": "available"}
            return merged
        if historical_unavailable:
            if live.get("datetime"):
                live["capability"] = {"historical": "unavailable", "live": "available"}
            return live
        # KGI denied every historical table for this symbol/interval (D403 —
        # verified live against production: the account has entitlement for
        # today's session via 取得即時分K(最後交易日) but not for any 歷史
        # (prior-day) intraday K-bar table, at any interval). `live` may
        # already hold real bars for today (either from _seed_today_kbars'
        # REST backfill or from accumulated push ticks) — returning
        # empty_kbars() here used to throw that away and show a permanently
        # blank chart even when today's session data was available.
        live["capability"] = {
            "historical": "denied",
            "live": "available" if live.get("datetime") else "pending",
            "message": denied.message if denied else "KGI historical intraday K-bars are unavailable",
            "upstream_code": (denied.details or {}).get("upstream_code") if denied else None,
        }
        return live

    def live_kbars(self, symbol: str, minute: int = 1) -> dict[str, list[Any]]:
        symbol = symbol.strip().upper()
        if not symbol:
            raise BridgeError(400, "symbol is required")
        if minute not in {1, 3, 5, 15, 30, 60}:
            raise BridgeError(400, "KGI live K-bar minute must be one of: 1, 3, 5, 15, 30, 60")
        api = self._ensure_connected()
        key = (symbol, minute)
        with self._kbar_lock:
            should_subscribe = key not in self._kbar_subscriptions
            if should_subscribe:
                self._kbar_subscriptions.add(key)
        if should_subscribe:
            def call() -> None:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    api.Quote.subscribe_kbar(symbol, minute)

            try:
                self._call_native(call)
            except Exception:
                with self._kbar_lock:
                    self._kbar_subscriptions.discard(key)
                raise
            self._seed_today_kbars(symbol, minute)
        with self._kbar_lock:
            cached = list(self._kbar_cache.get(key, []))
        return normalize_kbars(cached)

    def _seed_today_kbars(self, symbol: str, minute: int) -> None:
        """Backfill today's session from KGI's 取得即時分K(最後交易日) REST
        table right after subscribing, so the chart shows the full current
        session immediately instead of only the ticks pushed from this
        moment forward (issue: a freshly (re)started backend otherwise
        served a near-empty chart all morning even though this table has
        always been entitled — verified live, 200 OK for 1/5/15m). This is
        a best-effort backfill for *today only*; it does not touch, and
        cannot substitute for, prior-day history (that's still gated by the
        separate 歷史分K D403 denial in historical_kbars)."""
        api = self.api
        if api is None or not hasattr(api, "Data"):
            return
        try:
            raw = self._call_native(api.Data.get, "取得即時分K(最後交易日)", symbol, minute)
        except Exception as exc:
            market_debug(f"[KGI live kbar seed] symbol={symbol} interval={minute}m FAILED: {exc}")
            return
        rows = [row for row in (as_plain(raw) or []) if isinstance(row, dict)]
        if not rows:
            return
        key = (symbol, minute)
        with self._kbar_lock:
            if not self._kbar_cache.get(key):
                self._kbar_cache[key] = rows
        market_debug(f"[KGI live kbar seed] symbol={symbol} interval={minute}m rows={len(rows)}")

    def historical_kbars(self, symbol: str, start: str, end: str, minute: int = 1) -> dict[str, list[Any]]:
        api = self._ensure_connected()
        if not hasattr(api, "Data"):
            raise BridgeError(503, "KGI Data API is unavailable after account selection")
        environment = "simulation" if env_bool("KGI_SIMULATION", False) else "production"
        candidates: list[tuple[str, tuple[Any, ...]]] = []
        if minute == 1:
            candidates.append(("取得歷史1分K(指定起訖日)", (symbol, kgi_date(start), kgi_date(end))))
        candidates.extend(
            [
                ("取得歷史分K(指定日期前)", (symbol, kgi_date(end), minute)),
                ("取得歷史分K(含加權/櫃買指數)", (symbol, minute)),
            ]
        )
        if minute in {3, 5} and normalize_date(start) == normalize_date(end):
            candidates.insert(0, (f"取得歷史{minute}分K(指定當日)", (symbol, kgi_date(end))))
        last_denied: BridgeError | None = None
        last_error: Exception | None = None
        tried: list[str] = []
        for table, args in candidates:
            if table in self._historical_kbar_denials:
                last_denied = self._historical_kbar_denials[table]
                tried.append(table)
                continue
            tried.append(table)
            market_debug(
                f"[KGI historical kbar] method=Data.get table={table} args={args} "
                f"symbol={symbol} minute={minute} start={start} end={end} env={environment}"
            )
            try:
                raw = self._call_native(api.Data.get, table, *args)
            except Exception as exc:
                bridge_error = bridge_data_error(exc, table, symbol, minute)
                status = bridge_error.status if bridge_error is not None else "error"
                market_debug(f"[KGI historical kbar] table={table} status={status} error={exc}")
                if bridge_error is not None and bridge_error.status == 403:
                    bridge_error.details.update({"start": start, "end": end, "environment": environment})
                    self._historical_kbar_denials[table] = bridge_error
                    last_denied = bridge_error
                    continue
                if bridge_error is not None:
                    last_error = bridge_error
                    continue
                last_error = exc
                continue
            market_debug(f"[KGI historical kbar] table={table} status=200 rows={len(raw) if hasattr(raw, '__len__') else '?'}")
            normalized = normalize_kbars(raw)
            if normalized["datetime"]:
                return filter_kbars_by_date(normalized, start, end)
        if last_denied is not None:
            # last_denied may be a BridgeError cached in
            # _historical_kbar_denials from an earlier call with a
            # different date range — always refresh the range/environment
            # to reflect *this* request rather than leaving stale values
            # from whenever that table was first denied.
            last_denied.details["tables_tried"] = tried
            last_denied.details["start"] = start
            last_denied.details["end"] = end
            last_denied.details["environment"] = environment
            raise last_denied
        if last_error is not None:
            if isinstance(last_error, BridgeError):
                raise last_error
            raise last_error
        return empty_kbars()

    def history_ticks(self, symbol: str, count: int = 120) -> dict[str, list[Any]]:
        raise BridgeError(501, "TODO(KGI): historical tick query has not been verified in official docs")

    def bidask_snapshot(self, symbol: str) -> dict[str, Any]:
        raise BridgeError(501, "TODO(KGI): synchronous bid/ask snapshot query has not been verified in official docs")

    @timed("daily_bars")
    def daily_bars(self, symbol: str, days: int = 90) -> dict[str, list[Any]]:
        api = self._ensure_connected()
        if not hasattr(api, "Data"):
            raise BridgeError(503, "KGI Data API is unavailable after account selection")
        # Verified in official Data.get docs:
        #   api.Data.get('還原日K價量資料(個股、ETF、大盤)-單檔股票多個區間', '2330')
        # TODO(KGI): verify production payload shape, date ordering, and
        # volume/amount units before using this for live screening decisions.
        table = "還原日K價量資料(個股、ETF、大盤)-單檔股票多個區間"
        try:
            raw = self._call_native(api.Data.get, table, symbol)
        except Exception as exc:
            bridge_error = bridge_upstream_error(exc, "daily bar request", {"table": table, "symbol": symbol})
            if bridge_error is not None:
                raise bridge_error
            raise
        normalized = normalize_daily_bars(raw)
        if days <= 0:
            return normalized
        return {key: values[-days:] for key, values in normalized.items()}

    @timed("scanner")
    def scanner(self, scanner_type: str, count: int, ascending: bool) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        tables = (
            ["漲跌列表(盤中)", "日K價量資料(個股、ETF)-多檔股票最新時間"]
            if scanner_type in {"ChangePercentRank", "ChangePriceRank", "DayRangeRank"}
            else ["即時周轉率排行", "日K價量資料(個股、ETF)-多檔股票最新時間", "漲跌列表(盤中)"]
        )
        raw: Any = []
        last_permission_error: BridgeError | None = None
        for table in tables:
            capability_key = f"data:{table}"
            if self._capabilities.is_forbidden(capability_key):
                # Confirmed D403 earlier this session — skip the upstream
                # call entirely instead of retrying a table we already know
                # this account has no entitlement for.
                cached = self._capabilities.detail(capability_key) or {}
                last_permission_error = BridgeError(
                    403,
                    cached.get("message", f"KGI scanner table denied: {table}"),
                    cached,
                )
                continue
            try:
                raw = as_plain(self._call_native(api.Data.get, table))
                rows = list(raw.values()) if isinstance(raw, dict) else raw
                if isinstance(rows, list) and rows:
                    self._capabilities.mark_available(capability_key)
                    break
            except Exception as exc:
                bridge_error = bridge_upstream_error(exc, "scanner request", {"table": table, "scanner_type": scanner_type})
                if bridge_error is not None and bridge_error.status == 403:
                    self._capabilities.mark_forbidden(
                        capability_key,
                        {"message": bridge_error.message, "upstream_code": (bridge_error.details or {}).get("upstream_code")},
                    )
                    last_permission_error = bridge_error
                    continue
                if bridge_error is not None:
                    continue
                continue
        else:
            if last_permission_error is not None:
                raise BridgeError(403, "此帳戶無排行資料權限", last_permission_error.details)
        rows = list(raw.values()) if isinstance(raw, dict) else raw
        if not isinstance(rows, list):
            rows = []
        items = [self._scanner_item(row) for row in rows if isinstance(row, dict)]
        items = [item for item in items if item["code"]]
        key_name = {
            "VolumeRank": "total_volume",
            "AmountRank": "total_amount",
            "ChangePriceRank": "change_price",
            "DayRangeRank": "price_range",
            "TickCountRank": "total_volume",
        }.get(scanner_type, "change_rate")
        items.sort(key=lambda item: item.get(key_name, 0), reverse=ascending)
        return items[: max(1, count)]

    def _scanner_item(self, row: dict[str, Any]) -> dict[str, Any]:
        code = text(field(row, "symbol", "code", "股票代號", "證券代號"))
        name = text(field(row, "name", "股票名稱", "證券名稱"), code)
        close = number(field(row, "close", "Close", "收盤價", "成交價", "最新價", "price"))
        open_price = number(field(row, "open", "Open", "開盤價"), close)
        high = number(field(row, "high", "High", "最高價"), close)
        low = number(field(row, "low", "Low", "最低價"), close)
        reference = number(field(row, "reference", "ref_price", "reference_price", "參考價", "昨收"), close)
        change = number(field(row, "change_price", "漲跌", "漲跌價差"), close - reference)
        volume = integer(field(row, "total_volume", "volume", "成交量", "總量"))
        amount = number(field(row, "total_amount", "amount", "成交金額"))
        if "成交金額(百萬)" in row:
            amount = number(row.get("成交金額(百萬)")) * 1_000_000
        if not code and len(row) >= 11:
            first = text(row_value(row, 0))
            code_index = 0 if 1 <= len(first) <= 6 else 1
            code = text(row_value(row, code_index))
            name = text(row_value(row, code_index + 1), code)
            open_price = number(row_value(row, 3))
            high = number(row_value(row, 4))
            low = number(row_value(row, 5))
            close = number(row_value(row, 6))
            volume = integer(row_value(row, 7))
            change = number(row_value(row, 8))
            change_rate = number(row_value(row, 9))
            amount = number(row_value(row, 11 if code_index == 0 else 8))
            if amount and amount < 10_000_000:
                amount *= 1_000_000
        if not amount and close and volume:
            amount = close * volume
        change_rate = (change / reference * 100) if reference else number(field(row, "change_rate", "漲跌幅"))
        return {
            "code": code,
            "name": name,
            "date": text(field(row, "date", "日期", "datetime", "date_time")),
            "close": close,
            "open": open_price,
            "high": high,
            "low": low,
            "change_price": change,
            "change_type": 1 if change > 0 else 2 if change < 0 else 0,
            "average_price": number(field(row, "average_price", "均價"), close),
            "price_range": high - low,
            "rank_value": change_rate,
            "change_rate": change_rate,
            "total_volume": volume,
            "total_amount": amount,
            "volume_ratio": number(field(row, "volume_ratio", "量比")),
            "yesterday_volume": integer(field(row, "yesterday_volume", "昨日量")),
            "tick_type": 0,
            "buy_price": number(field(row, "bid_price", "buy_price", "委買價")),
            "sell_price": number(field(row, "ask_price", "sell_price", "委賣價")),
        }

    @timed("positions")
    def positions(self, account_type: str | None = None) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        getter = getattr(getattr(api, "Account", None), "InventorySum", None)
        if not callable(getter):
            raise BridgeError(503, "KGI Account.InventorySum is unavailable after account selection")

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return getter("B")

        raw = self._call_native(call)
        rows = normalize_inventory_positions(raw, "B", self.selected_stock_account)
        market_debug(f"[positions raw] rows={len(rows_from_table(raw))}")
        market_debug(f"[positions normalized] rows={len(rows)}")
        self._log_inventory_probe(raw, rows, {"2330", "2327"})
        return rows

    def _log_inventory_probe(self, raw: Any, normalized: list[dict[str, Any]], symbols: set[str]) -> None:
        if not market_debug_enabled():
            return
        raw_rows = rows_from_table(raw)
        for symbol in symbols:
            source = next(
                (
                    row
                    for row in raw_rows
                    if text(field(row, "Symbol", "symbol", "STOCK", "code")).strip().upper() == symbol
                ),
                None,
            )
            if source is None:
                continue
            normalized_rows = [row for row in normalized if row.get("code") == symbol]
            raw_fields = sorted(source.keys())
            values = [
                {
                    "bucket": row.get("inventory_bucket"),
                    "position_type": row.get("position_type"),
                    "shares": row.get("quantity"),
                    "avg_cost": row.get("price"),
                    "current_price": row.get("last_price"),
                    "market_value": row.get("market_value"),
                    "unrealized_pnl": row.get("pnl"),
                    "dedupe_key": row.get("dedupe_key"),
                }
                for row in normalized_rows
            ]
            market_debug(f"[positions probe {symbol}] raw_fields={raw_fields} normalized={values}")

    @timed("orders")
    def orders(self, account_type: str | None = None) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        # Installed kgisuperpy 2.1.0 stock Order API uses full=True for
        # all known order records; it does not accept a Shioaji-style all= kwarg.
        raw = as_plain(self._call_native(api.Order.get_trades, full=True))
        rows = self._trade_rows(raw)
        return [normalize_trade(row, f"kgi-{index}") for index, row in enumerate(rows)]

    def _trade_rows(self, raw: Any) -> list[dict[str, Any]]:
        if isinstance(raw, dict):
            rows: list[dict[str, Any]] = []
            for value in raw.values():
                if isinstance(value, dict):
                    rows.append(value)
                elif isinstance(value, list):
                    rows.extend(row for row in value if isinstance(row, dict))
            if rows:
                return rows
            return [raw] if ("order" in raw or "order_status" in raw) else []
        if isinstance(raw, list):
            return [row for row in raw if isinstance(row, dict)]
        return []

    @timed("deals")
    def deals(self, account_type: str | None = None) -> dict[str, list[dict[str, Any]]]:
        api = self._ensure_connected()
        # Verified in official order docs: api.Order.get_deals()
        raw = as_plain(self._call_native(api.Order.get_deals))
        out: dict[str, list[dict[str, Any]]] = {}
        if isinstance(raw, dict):
            iterator = raw.items()
        elif isinstance(raw, list):
            iterator = enumerate(raw)
        else:
            iterator = []
        for key, value in iterator:
            code = str(key)
            values = value if isinstance(value, list) else [value]
            out[code] = [normalize_deal(item) for item in values]
        return out

    @timed("account_values")
    def account_values(self) -> dict[str, Any]:
        api = self._ensure_connected()
        account_api = getattr(api, "Account", None)
        sources: dict[str, Any] = {}

        def capture(name: str, *args: Any) -> None:
            getter = getattr(account_api, name, None)
            if not callable(getter):
                sources[name] = {"errmsg": f"KGI Account.{name} is unavailable"}
                return

            def call() -> Any:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    try:
                        return getter(*args)
                    except TypeError:
                        return getter()

            sources[name] = self._call_native(call)

        capture("SettleAmtTrial", "S")
        capture("SettleAmt", "SS")
        capture("InventorySum", "A")
        capture("RealizePL", "M")
        return self._normalize_account_sources(sources)

    def _normalize_account_sources(self, sources: dict[str, Any]) -> dict[str, Any]:
        # Verified exhaustively against the installed kgisuperpy 2.1.0 SDK
        # (every method main.py wires onto api.Account: BalanceStatement,
        # ExecReport, Inventory, InventorySum, OrderReport, RealizePL,
        # SettleAmt, SettleAmtDetail, SettleAmtTrial): there is NO field
        # anywhere in this Account API surface for a linked bank-account
        # balance or a general "available cash" figure. The closest real
        # signals are SettleAmtTrial (today's settlement TRIAL net — real,
        # but a same-day trade-driven trial, not a balance; genuinely
        # returns no data on a day with nothing to settle) and SettleAmt's
        # rolling T+0/T+1/T+2 net settlement flows (already surfaced
        # separately via settlements()/SettleSection — do NOT re-derive a
        # second "balance" number by summing those here, which is what the
        # old code did: it silently substituted a sum of T+0..T+2 flows
        # (often a real 0 on a quiet day) for "cash" whenever SettleAmtTrial
        # had nothing, making "$0" look like an account balance query that
        # succeeded when the actual balance concept was never queried at all.
        trial_rows = detail_rows(sources.get("SettleAmtTrial"), "Detail1", "Detail2", "PB4302_3", "PB4302_4")
        inventory_rows = rows_from_table(sources.get("InventorySum"))
        realized_rows = rows_from_table(sources.get("RealizePL"))

        cash_candidates = [
            field(row, "NETAMT", "DNAMT", "AMT", "RECAMT", "PAYAMT")
            for row in trial_rows
        ]
        settlement_trial_net = next(
            (number(value) for value in cash_candidates if value not in (None, "")),
            None,
        )

        stock_market_value = sum(number(field(row, "ASSET_REAL", "ASSET")) for row in inventory_rows) if inventory_rows else None
        realized_pnl = sum(number(field(row, "NETPL", "NETPL_TWD", "NETPLTWD")) for row in realized_rows) if realized_rows else None
        total_assets = (
            (settlement_trial_net or 0) + (stock_market_value or 0)
            if settlement_trial_net is not None or stock_market_value is not None
            else None
        )
        raw_fields = {
            name: sorted({key for row in rows_from_table(value) for key in row.keys()})
            for name, value in sources.items()
        }
        unavailable = [name for name, value in sources.items() if not self._source_has_payload(value)]
        return {
            "acc_balance": settlement_trial_net,
            "available_balance": settlement_trial_net,
            # KGI genuinely does not expose this — always null, never a
            # placeholder 0. Kept as an explicit field (not just omitted)
            # so the frontend renders "銀行帳戶餘額：API 未提供" from a real
            # backend-asserted fact rather than an assumption baked into UI.
            "bank_balance": None,
            "buying_power": None,
            "total_assets": total_assets,
            "stock_market_value": stock_market_value,
            "realized_pnl": realized_pnl,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "errmsg": "",
            "raw_fields": raw_fields,
            "unavailable_fields": unavailable,
        }

    def _source_has_payload(self, value: Any) -> bool:
        plain = as_plain(value)
        if isinstance(plain, dict) and "errmsg" in plain and len(plain) <= 2:
            return False
        rows = rows_from_table(plain)
        if rows and not (len(rows) == 1 and "errmsg" in rows[0] and len(rows[0]) <= 2):
            return True
        return bool(detail_rows(plain, "Detail", "Detail1", "Detail2", "PB4302_3", "PB4302_4"))

    def settlements(self) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        account_api = getattr(api, "Account", None)
        getter = getattr(account_api, "SettleAmt", None)
        if not callable(getter):
            return []

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    return getter()
                except TypeError:
                    return getter(None, None)

        raw = self._call_native(call)
        return normalize_settlement_rows(raw)

    def profit_loss(self, start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
        api = self._ensure_connected()
        getter = getattr(getattr(api, "Account", None), "RealizePL", None)
        if not callable(getter):
            return []
        start_date = kgi_date(start or datetime.now().strftime("%Y-%m-%d"))
        end_date = kgi_date(end or start_date)

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return getter("D", start_date, end_date)

        raw = self._call_native(call)
        rows = normalize_profit_loss_rows(raw, start_date, end_date)
        market_debug(f"[realized pnl raw] start={start_date} end={end_date} rows={len(detail_rows(raw, 'Detail'))}")
        market_debug(f"[realized pnl normalized] rows={len(rows)}")
        return rows

    def profit_loss_summary(self, start: str | None = None, end: str | None = None) -> dict[str, Any]:
        rows = self.profit_loss(start, end)
        total_pnl = sum(number(row.get("pnl")) for row in rows)
        return {
            "profitloss_sum": [
                {
                    "code": row["code"],
                    "quantity": row["quantity"],
                    "pnl": row["pnl"],
                    "pr_ratio": row["pr_ratio"],
                    "entry_price": row["price"],
                    "cover_price": 0,
                    "entry_cost": 0,
                    "cover_cost": 0,
                    "buy_cost": 0,
                    "sell_cost": 0,
                    "cond": row["cond"],
                    "currency": "TWD",
                }
                for row in rows
            ],
            "total": {
                "entry_amount": 0,
                "cover_amount": 0,
                "quantity": sum(integer(row.get("quantity")) for row in rows),
                "buy_cost": 0,
                "sell_cost": 0,
                "pnl": total_pnl,
                "pr_ratio": 0,
            },
        }

    def trading_limits(self, symbol: str | None = None) -> dict[str, Any]:
        api = self._ensure_connected()
        getter = getattr(getattr(api, "Order", None), "TSECreditInfo", None)
        out = {
            "trading_limit": 0,
            "trading_used": 0,
            "trading_available": 0,
            "margin_limit": 0,
            "margin_used": 0,
            "margin_available": 0,
            "short_limit": 0,
            "short_used": 0,
            "short_available": 0,
        }
        if not callable(getter) or not symbol:
            return out

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return getter(symbol)

        raw = self._call_native(call)
        rows = rows_from_table(raw)
        if not rows:
            return out
        row = rows[0]
        out["margin_limit"] = integer(field(row, "MarignQty", "MarginQty"))
        out["margin_available"] = out["margin_limit"]
        out["short_limit"] = integer(field(row, "ShortQty"))
        out["short_available"] = out["short_limit"]
        return out

    def _map_stock_order(self, contract: dict[str, Any], order: dict[str, Any]) -> dict[str, Any]:
        symbol = str(contract.get("code") or order.get("symbol") or "").strip().upper()
        if not symbol or not symbol.isdigit():
            raise BridgeError(400, "A valid stock symbol is required")
        if self._futures_disabled(symbol, contract.get("security_type")):
            raise BridgeError(404, "KGI futures/options support is not enabled for this stock-only session")
        action_raw = str(order.get("action") or "")
        if action_raw not in {"Buy", "Sell"}:
            raise BridgeError(400, "Stock order action must be Buy or Sell")
        qty = integer(order.get("quantity"))
        if qty <= 0:
            raise BridgeError(400, "Stock order quantity must be greater than zero")
        price_type = str(order.get("price_type") or "LMT").upper()
        order_type = str(order.get("order_type") or "ROD").upper()
        if order_type not in {"ROD", "IOC", "FOK"}:
            raise BridgeError(422, f"Unsupported stock time-in-force: {order_type}")
        kgi = importlib.import_module("kgisuperpy")
        if price_type == "LMT":
            price = number(order.get("price"))
            if price <= 0:
                raise BridgeError(400, "Limit stock orders require a positive price")
        elif price_type == "MKT":
            price = enum_member(kgi, "PriceType", "MKT")
        else:
            raise BridgeError(422, f"Unsupported stock price type: {price_type}")
        cond_map = {
            "Cash": "CASH",
            "CASH": "CASH",
            "MarginTrading": "MARGIN",
            "ShortSelling": "SHORT_SELLING",
            "SBLShort": "Lend_SELLING",
        }
        cond_key = str(order.get("order_cond") or "Cash")
        if bool(order.get("daytrade_short")) and cond_key in {"Cash", "CASH"} and action_raw == "Sell":
            cond_member = "CASH_SELLING"
        else:
            cond_member = cond_map.get(cond_key)
        if cond_member is None:
            raise BridgeError(422, f"Unsupported stock order condition: {cond_key}")
        lot_map = {
            "Common": "Common",
            "Odd": "Odd",
            "IntradayOdd": "Odd",
            "Fixing": "Fixing",
        }
        lot_key = str(order.get("order_lot") or "Common")
        lot_member = lot_map.get(lot_key)
        if lot_member is None:
            raise BridgeError(422, f"Unsupported stock order lot: {lot_key}")
        return {
            "action": enum_member(kgi, "Action", action_raw),
            "symbol": symbol,
            "qty": qty,
            "price": price,
            "time_in_force": enum_member(kgi, "TimeInForce", order_type),
            "order_cond": enum_member(kgi, "OrderCond", cond_member),
            "odd_lot": enum_member(kgi, "OddLot", lot_member),
            "name": str(order.get("custom_field") or ""),
        }

    def _reserve_request_id(self, client_request_id: str) -> None:
        with self._order_lock:
            if client_request_id in self._submitted_request_ids:
                raise BridgeError(409, "Duplicate client_request_id; order-changing request was already submitted")
            self._submitted_request_ids.add(client_request_id)

    def place_stock_order(self, contract: dict[str, Any], order: dict[str, Any], client_request_id: str) -> dict[str, Any]:
        api = self._ensure_connected()
        request_id = normalize_client_request_id(client_request_id)
        mapped = self._map_stock_order(contract, order)
        self._reserve_request_id(request_id)

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return api.Order.create_order(**mapped)

        try:
            trade = self._call_native(call)
        except Exception as exc:
            raise bridge_order_error(exc, "stock order create") from exc
        if trade is None:
            raise BridgeError(502, "KGI stock order create returned no Trade object")
        return normalize_trade(trade, request_id)

    def _find_order(self, order_id: str) -> dict[str, Any]:
        if not order_id:
            raise BridgeError(400, "order_id is required")
        for trade in self.orders("S"):
            if order_id in {trade.get("order", {}).get("id"), trade.get("order", {}).get("ordno"), trade.get("order", {}).get("seqno")}:
                return trade
        raise BridgeError(404, "KGI order was not found or is no longer available")

    def cancel_order(self, order_id: str, client_request_id: str) -> dict[str, Any]:
        api = self._ensure_connected()
        request_id = normalize_client_request_id(client_request_id)
        trade = self._find_order(order_id)
        if str(trade.get("status", {}).get("status")) not in {"PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"}:
            raise BridgeError(422, "KGI order is not cancellable in its current status")
        self._reserve_request_id(request_id)

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return api.Order.cancel_order(order_id)

        try:
            result = self._call_native(call)
        except Exception as exc:
            raise bridge_order_error(exc, "stock order cancel") from exc
        return normalize_trade(result or trade, request_id)

    def update_order(self, order_id: str, client_request_id: str, price: float | None = None, qty: int | None = None) -> dict[str, Any]:
        api = self._ensure_connected()
        request_id = normalize_client_request_id(client_request_id)
        if (price is None and qty is None) or (price is not None and qty is not None):
            raise BridgeError(400, "Provide exactly one of price or qty for stock order modification")
        trade = self._find_order(order_id)
        if str(trade.get("status", {}).get("status")) not in {"PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"}:
            raise BridgeError(422, "KGI order is not modifiable in its current status")
        if price is not None and price <= 0:
            raise BridgeError(400, "Modified price must be greater than zero")
        if qty is not None and qty <= 0:
            raise BridgeError(400, "Modified quantity must be greater than zero")
        self._reserve_request_id(request_id)

        def call() -> Any:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return api.Order.update_order(order_id, price=price, qty=qty)

        try:
            result = self._call_native(call)
        except Exception as exc:
            raise bridge_order_error(exc, "stock order update") from exc
        return normalize_trade(result or trade, request_id)

    def subscribe_quote(self, symbol: str, quote_type: str) -> dict[str, Any]:
        symbol = canonical_index_symbol(symbol)
        if not symbol:
            raise BridgeError(400, "symbol is required")
        api = self._ensure_connected()
        quote = api.Quote
        normalized_type = quote_type or "Tick"
        key = (symbol, normalized_type)
        with self._quote_lock:
            cached_error = self._quote_subscription_errors.get(key)
            if cached_error is not None:
                return {
                    "success": False,
                    "message": cached_error.get("message", "KGI quote subscription is denied"),
                    "subscription": {"code": symbol, "quote_type": normalized_type},
                    "capability": cached_error,
                }
            should_subscribe = key not in self._quote_subscriptions
            if should_subscribe:
                self._quote_subscriptions.add(key)
        if should_subscribe:
            def call() -> None:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    if normalized_type == "BidAsk":
                        # Verified in installed kgisuperpy 2.1.0 Quote.py.
                        quote.subscribe_bidask(symbol, odd_lot=False)
                    elif normalized_type == "Quote" and is_index_symbol(symbol):
                        self._subscribe_index_quote(quote, symbol)
                    elif normalized_type == "Quote":
                        # The frontend's Quote stream expects minute bars.
                        quote.subscribe_kbar(symbol, 1)
                    else:
                        quote.subscribe_tick(symbol, odd_lot=False)

            try:
                self._call_native(call)
            except Exception as exc:
                with self._quote_lock:
                    self._quote_subscriptions.discard(key)
                capability = self._quote_subscription_denial(exc, normalized_type, symbol)
                if capability is not None:
                    with self._quote_lock:
                        self._quote_subscription_errors[key] = capability
                    return {
                        "success": False,
                        "message": capability["message"],
                        "subscription": {"code": symbol, "quote_type": normalized_type},
                        "capability": capability,
                    }
                raise
        if normalized_type == "BidAsk":
            # KGI only pushes a bidask update when the order book changes,
            # so a fresh subscription (or a re-subscription after a panel
            # remounts) can otherwise wait indefinitely for the first event.
            # Replay the last known depth immediately so the UI never shows
            # an empty skeleton while genuinely-unchanged depth is available.
            with self._quote_lock:
                cached = self._bidask_cache.get(symbol)
            if cached is not None:
                self._event_queue.put(("bidask_stk", cached))
        return {
            "success": True,
            "message": f"KGI real subscribed {normalized_type} {symbol}",
            "subscription": {"code": symbol, "quote_type": normalized_type},
        }

    def _quote_subscription_denial(self, exc: Exception, quote_type: str, symbol: str) -> dict[str, Any] | None:
        code = str(getattr(getattr(exc, "code", None), "value", "") or getattr(exc, "code", "") or "")
        message = str(getattr(exc, "message", str(exc)) or exc.__class__.__name__)
        lower = message.lower()
        if code in {"Q010", "Q403"} or "permission" in lower or "rejected due to previous permission errors" in lower:
            return {
                "quote": "denied",
                "quote_type": quote_type,
                "symbol": symbol,
                "upstream_code": code or None,
                "message": f"KGI quote subscription denied for {quote_type} {symbol}: {message}",
            }
        return None

    def _subscribe_index_quote(self, quote: Any, symbol: str) -> None:
        upstream = index_quote_symbol(symbol)
        callback = getattr(quote, "set_cb_index", None)
        subscriber = getattr(quote, "subscribe_index", None)
        if callable(callback) and callable(subscriber):
            callback(lambda data: self._event_queue.put(("quote_idx", normalize_index_quote(symbol, data))))
            subscriber(upstream)
            return
        raw_quote = getattr(quote, "_api", None)
        raw_callback = getattr(raw_quote, "set_cb_index", None)
        raw_subscriber = getattr(raw_quote, "subscribe_index", None)
        if callable(raw_callback) and callable(raw_subscriber):
            raw_callback(func=lambda data: self._event_queue.put(("quote_idx", normalize_index_quote(symbol, data))))
            raw_subscriber(symbol=upstream)
            return
        self._event_queue.put(("quote_idx", normalize_index_quote(symbol, self._index_snapshot(symbol))))

    def unsubscribe_quote(self, symbol: str, quote_type: str) -> dict[str, Any]:
        # TODO(KGI): official unsubscribe method needs verification before
        # real mode can actively unsubscribe. Keeping this as a no-op avoids
        # inventing a method name.
        return {
            "success": True,
            "message": "TODO(KGI): real unsubscribe not verified; subscription retained until session ends",
        }

    def poll_stream_events(self, timeout: float = 1.0) -> list[tuple[str, dict[str, Any]]]:
        events: list[tuple[str, dict[str, Any]]] = []
        try:
            item = self._event_queue.get(timeout=timeout)
            events.append(item)
        except queue.Empty:
            return events
        while True:
            try:
                events.append(self._event_queue.get_nowait())
            except queue.Empty:
                break
        return events


def make_client(mode: str | None = None) -> KGIClient:
    selected = (mode or os.getenv("KGI_CLIENT_MODE") or os.getenv("KGI_MODE") or "mock").lower()
    if selected == "real":
        return RealKGIClient()
    return MockKGIClient()
