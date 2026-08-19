from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv

from .agent_tools import execute_agent_tool, list_agent_tools
from .clients import env_bool
from .clients import KGIClient, make_client
from .codex_bridge import CodexAuthenticationError, CodexBridge, CodexBridgeError
from .errors import BridgeError
from .mock_data import default_watchlist_contracts
from .scanner import run_scanner


class KGIHTTPServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        client: KGIClient,
        codex_bridge: CodexBridge | None = None,
    ):
        super().__init__(server_address, KGIRequestHandler)
        self.client = client
        self.state_dir = _state_dir()
        self.watchlist_path = self.state_dir / "watchlists.json"
        self.watchlists: list[dict[str, Any]] = _load_watchlists(self.watchlist_path)
        self.watchlist_lock = threading.Lock()
        self.stream_lock = threading.Lock()
        self.stream_subscribers: set[queue.Queue[tuple[str, dict[str, Any]]]] = set()
        self.stream_stop = threading.Event()
        self.stream_pump_thread = threading.Thread(
            target=self._pump_stream_events,
            name="kgi-stream-fanout",
            daemon=True,
        )
        self.stream_pump_thread.start()
        host = self.server_address[0]
        if host in {"", "0.0.0.0", "::"}:
            host = "127.0.0.1"
        tool_base_url = f"http://{host}:{self.server_address[1]}"
        self.codex_bridge = codex_bridge or CodexBridge(
            workspace=Path.cwd(),
            tool_base_url=tool_base_url,
        )

    def server_close(self) -> None:
        self.stream_stop.set()
        try:
            self.codex_bridge.shutdown()
        finally:
            try:
                self.stream_pump_thread.join(timeout=2)
            finally:
                try:
                    native_executor = getattr(self.client, "_native_executor", None)
                    if native_executor is not None:
                        native_executor.shutdown(wait=False)
                finally:
                    super().server_close()

    def save_watchlists(self) -> None:
        _save_watchlists(self.watchlist_path, self.watchlists)

    def register_stream_client(self) -> queue.Queue[tuple[str, dict[str, Any]]]:
        subscriber: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue(maxsize=1000)
        with self.stream_lock:
            self.stream_subscribers.add(subscriber)
        return subscriber

    def unregister_stream_client(self, subscriber: queue.Queue[tuple[str, dict[str, Any]]]) -> None:
        with self.stream_lock:
            self.stream_subscribers.discard(subscriber)

    def _broadcast_stream_event(self, event: str, data: dict[str, Any]) -> None:
        with self.stream_lock:
            subscribers = list(self.stream_subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait((event, data))
            except queue.Full:
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    pass
                try:
                    subscriber.put_nowait((event, data))
                except queue.Full:
                    pass

    def _pump_stream_events(self) -> None:
        while not self.stream_stop.is_set():
            try:
                for event, data in self.client.poll_stream_events(timeout=0.5):
                    self._broadcast_stream_event(event, data)
            except Exception:
                time.sleep(0.5)


def _state_dir() -> Path:
    configured = os.getenv("KGI_BRIDGE_STATE_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".kgi-pro"


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_project_env(path: Path | None = None) -> bool:
    env_path = path or (_project_root() / ".env")
    return load_dotenv(dotenv_path=env_path, override=False)


def _should_load_project_env(mode: str | None) -> bool:
    selected = (mode or os.getenv("KGI_CLIENT_MODE") or os.getenv("KGI_MODE") or "").lower()
    return selected == "real"


def _load_watchlists(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    rows: list[dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        contracts = row.get("contracts")
        rows.append(
            {
                "id": str(row.get("id") or f"kgi-{int(time.time() * 1000)}"),
                "name": str(row.get("name") or "自選"),
                "contracts": contracts if isinstance(contracts, list) else [],
            }
        )
    return rows


def _save_watchlists(path: Path, watchlists: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(watchlists, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def response_status_for_health(health: dict[str, Any]) -> str:
    if health.get("connected") is True:
        return "mock" if health.get("mode") == "mock" else "connected"
    return "disconnected"


def client_supports_futures(client: KGIClient) -> bool:
    checker = getattr(client, "supports_futures", None)
    if callable(checker):
        return bool(checker())
    return True


class KGIRequestHandler(BaseHTTPRequestHandler):
    server: KGIHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        if "--quiet" not in sys.argv:
            super().log_message(format, *args)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        # Request-level timing instrumentation (task requirement): one
        # [PERF] line per request, always on — this is the request/response
        # cycle's total wall time including whatever KGI round-trips it
        # triggers, so a slow endpoint shows up here even if a deeper
        # per-stage [PERF] line (clients.py) doesn't exist for it yet.
        raw_path = self.path
        started_at = time.perf_counter()
        try:
            self._handle_inner(method)
        finally:
            elapsed_ms = (time.perf_counter() - started_at) * 1000
            print(f"[PERF] {method} {raw_path} {elapsed_ms:.0f}ms", flush=True)

    def _handle_inner(self, method: str) -> None:
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            body = self._json_body()

            if method == "GET" and path == "/api/v1/health":
                self._json(self.server.client.health())
                return
            if method == "GET" and path == "/api/v1/info":
                self._json(self.server.client.info())
                return
            if method == "GET" and path == "/api/v1/agent/tools":
                self._json(list_agent_tools())
                return
            if method == "GET" and path in {"/api/v1/agent/status", "/api/v1/codex/status"}:
                self._json(self.server.codex_bridge.status())
                return
            if method == "GET" and path == "/api/v1/auth/accounts":
                self._json(self.server.client.accounts())
                return
            if method == "GET" and path == "/api/v1/stream/data":
                self._sse()
                return
            if method == "GET" and path == "/api/v1/data/contracts/futures/roots":
                roots = [{"root": "TXF", "name": "台指期"}] if client_supports_futures(self.server.client) else []
                self._json(roots)
                return
            if method == "GET" and path == "/api/v1/data/contracts/options/roots":
                self._json([{"root": "TXO", "name": "台指選擇權"}])
                return
            if method == "GET" and path == "/api/v1/data/contracts/warrants/underlyings":
                stocks = self.server.client.contracts("STK")
                self._json(
                    [
                        {
                            "underlying_code": row["code"],
                            "name": row.get("name"),
                            "warrant_count": 0,
                        }
                        for row in stocks
                    ]
                )
                return
            if method == "GET" and path == "/api/v1/data/contracts/futures":
                if not client_supports_futures(self.server.client):
                    self._json([])
                    return
                self._json(self.server.client.contracts("FUT"))
                return
            if method == "GET" and path == "/api/v1/data/contracts/options":
                # TODO(KGI): option catalog filtering needs real contract payloads.
                self._json([])
                return
            if method == "GET" and path == "/api/v1/data/contracts/warrants":
                # TODO(KGI): warrant catalog filtering needs real contract payloads.
                self._json([])
                return
            if method == "GET" and path == "/api/v1/data/contracts":
                security_type = (query.get("security_type") or ["STK"])[0]
                page = int((query.get("page") or ["1"])[0])
                page_size = int((query.get("page_size") or ["0"])[0] or 0)
                refresh = (query.get("refresh") or ["0"])[0].strip().lower() not in {"", "0", "false", "no"}
                refresher = getattr(self.server.client, "refresh_stock_contracts", None)
                if refresh and security_type.upper() == "STK" and callable(refresher):
                    refresher()
                rows = self.server.client.contracts(security_type)
                page_size = page_size or len(rows) or 1
                start = (page - 1) * page_size
                page_rows = rows[start : start + page_size]
                self._json(
                    {
                        "contracts": page_rows,
                        "security_type": security_type,
                        "region": "TW",
                        "total": len(rows),
                        "page": page,
                        "page_size": page_size,
                        "max_page": max(1, (len(rows) + page_size - 1) // page_size),
                    }
                )
                return
            if method == "GET" and path.startswith("/api/v1/data/contracts/"):
                parts = path.split("/")
                code = parts[5]
                security_type = (query.get("security_type") or [None])[0]
                self._json(self.server.client.contract(code, security_type))
                return
            if method == "GET" and path == "/api/v1/watchlist":
                with self.server.watchlist_lock:
                    self._json(self.server.watchlists)
                return

            if method == "POST" and path == "/api/v1/data/snapshots":
                contracts = body.get("contracts") or []
                symbols = body.get("symbols") or [row.get("code") for row in contracts if row.get("code")]
                self._json(self.server.client.snapshots(symbols))
                return
            if method == "POST" and path == "/api/v1/data/kbars":
                contract = body.get("contract") or {}
                minute = int(body.get("minute") or body.get("timeframe") or body.get("interval") or 1)
                self._json(
                    self.server.client.kbars(
                        contract.get("code", ""),
                        body.get("start", ""),
                        body.get("end", ""),
                        minute,
                    )
                )
                return
            if method == "POST" and path == "/api/v1/data/ticks":
                contract = body.get("contract") or {}
                count = int(body.get("last_cnt") or 120)
                self._json(self.server.client.history_ticks(contract.get("code", ""), count))
                return
            if method == "POST" and path == "/api/v1/data/scanner":
                count = int(body.get("count") or 30)
                ascending = bool(body.get("ascending", False))
                scanner_type = str(body.get("scanner_type") or "ChangePercentRank")
                self._json(self.server.client.scanner(scanner_type, count, ascending))
                return
            if method == "POST" and path == "/api/v1/scanner/run":
                self._json(run_scanner(self.server.client, body))
                return
            if method == "POST" and path in {"/api/v1/agent/conversations", "/api/v1/codex/conversations"}:
                conversation = self.server.codex_bridge.create_conversation()
                self._json({"conversation_id": conversation.id, "thread_id": conversation.thread_id})
                return
            if method == "POST" and path in {"/api/v1/agent/chat", "/api/v1/codex/chat"}:
                wants_stream = "text/event-stream" in (self.headers.get("Accept") or "") or bool(body.get("stream"))
                if wants_stream:
                    self._codex_chat_sse(body)
                else:
                    self._json(self.server.codex_bridge.collect_chat(body))
                return
            if method == "POST" and path == "/api/v1/agent/tools":
                name = str(body.get("name") or "")
                args = body.get("args") if isinstance(body.get("args"), dict) else {}
                self._json(execute_agent_tool(self.server.client, name, args))
                return
            if method == "POST" and path.startswith("/api/v1/agent/tools/"):
                name = path.rsplit("/", 1)[-1]
                self._json(execute_agent_tool(self.server.client, name, body))
                return
            if method == "POST" and path == "/api/v1/stream/subscribe":
                code = body.get("code", "")
                quote_type = body.get("quote_type", "Tick")
                self._json(self.server.client.subscribe_quote(code, quote_type))
                return
            if method == "POST" and path == "/api/v1/stream/unsubscribe":
                code = body.get("code", "")
                quote_type = body.get("quote_type", "Tick")
                self._json(self.server.client.unsubscribe_quote(code, quote_type))
                return
            if method == "POST" and (
                path.startswith("/api/v1/stream/subscribe/")
                or path.startswith("/api/v1/stream/unsubscribe/")
            ):
                capability = path.rsplit("/", 1)[-1]
                self._json(
                    {
                        "success": True,
                        "message": (
                            f"{capability} capability registered with KGI bridge; "
                            "TODO(KGI): real-time publisher awaits verified KGI data source"
                        ),
                    }
                )
                return
            if method == "POST" and path == "/api/v1/order/trades":
                self._json(self.server.client.orders(body.get("account_type")))
                return
            if method == "POST" and path == "/api/v1/order/deals":
                self._json(self.server.client.deals(body.get("account_type")))
                return
            if method == "POST" and path == "/api/v1/order/place_order":
                if body.get("futures_order"):
                    raise BridgeError(404, "KGI futures/options support is not enabled for this stock-only session")
                self._json(
                    self.server.client.place_stock_order(
                        body.get("contract") or {},
                        body.get("stock_order") or {},
                        str(body.get("client_request_id") or body.get("request_id") or ""),
                    )
                )
                return
            if method == "POST" and path == "/api/v1/order/cancel_order":
                self._json(
                    self.server.client.cancel_order(
                        str(body.get("order_id") or body.get("trade_id") or ""),
                        str(body.get("client_request_id") or body.get("request_id") or ""),
                    )
                )
                return
            if method == "POST" and path == "/api/v1/order/update_price":
                self._json(
                    self.server.client.update_order(
                        str(body.get("order_id") or body.get("trade_id") or ""),
                        str(body.get("client_request_id") or body.get("request_id") or ""),
                        price=float(body.get("price")),
                    )
                )
                return
            if method == "POST" and path == "/api/v1/order/update_qty":
                self._json(
                    self.server.client.update_order(
                        str(body.get("order_id") or body.get("trade_id") or ""),
                        str(body.get("client_request_id") or body.get("request_id") or ""),
                        qty=int(body.get("quantity")),
                    )
                )
                return
            if method == "POST" and path == "/api/v1/portfolio/position_unit":
                self._json(self.server.client.positions(body.get("account_type")))
                return
            if method == "POST" and path == "/api/v1/portfolio/account_balance":
                self._json(self.server.client.account_values())
                return
            if method == "POST" and path == "/api/v1/portfolio/margin":
                self._json(self._empty_margin())
                return
            if method == "POST" and path == "/api/v1/portfolio/settlements":
                self._json(self.server.client.settlements())
                return
            if method == "POST" and path == "/api/v1/portfolio/profit_loss":
                self._json(
                    self.server.client.profit_loss(
                        body.get("begin_date") or body.get("start_date") or body.get("start"),
                        body.get("end_date") or body.get("end"),
                    )
                )
                return
            if method == "POST" and path == "/api/v1/portfolio/profitloss_sum":
                self._json(
                    self.server.client.profit_loss_summary(
                        body.get("begin_date") or body.get("start_date") or body.get("start"),
                        body.get("end_date") or body.get("end"),
                    )
                )
                return
            if method == "POST" and path == "/api/v1/portfolio/trading_limits":
                contract = body.get("contract") or {}
                self._json(self.server.client.trading_limits(contract.get("code") or body.get("symbol")))
                return
            if method == "POST" and path in {
                "/api/v1/order/stock_reserve_summary",
                "/api/v1/order/stock_reserve_detail",
                "/api/v1/order/earmarking_detail",
            }:
                if self.server.client.mode == "real":
                    raise BridgeError(501, "KGI reserve/prepayment data is unavailable in this stock-only bridge")
                account = self.server.client.accounts()[0]
                self._json({"stocks": [], "account": account})
                return
            if method == "POST" and path == "/api/v1/order/combotrades":
                self._json([])
                return
            if path.startswith("/api/v1/order/") and method == "POST":
                raise BridgeError(405, "Unsupported KGI stock order endpoint")

            if path == "/api/v1/watchlist" and method == "POST":
                with self.server.watchlist_lock:
                    created = {
                        "id": f"kgi-{int(time.time() * 1000)}",
                        "name": body.get("name", "自選"),
                        "contracts": self._watchlist_contracts(body.get("contracts") or default_watchlist_contracts()),
                    }
                    self.server.watchlists.append(created)
                    self.server.save_watchlists()
                    self._json(created)
                return
            if path.startswith("/api/v1/watchlist/"):
                self._handle_watchlist(method, path, body)
                return

            raise BridgeError(404, f"Unknown endpoint: {method} {path}")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except CodexAuthenticationError as exc:
            self._json({"code": 401, "message": str(exc)}, 401)
        except CodexBridgeError as exc:
            self._json({"code": 502, "message": str(exc)}, 502)
        except BridgeError as exc:
            self._json({"code": exc.status, "message": exc.message, "details": exc.details}, exc.status)
        except Exception as exc:
            self._json({"code": 500, "message": str(exc)}, 500)

    def _handle_watchlist(self, method: str, path: str, body: dict[str, Any]) -> None:
        parts = path.split("/")
        list_id = parts[4]
        action = parts[5] if len(parts) > 5 else ""
        with self.server.watchlist_lock:
            index = next((i for i, row in enumerate(self.server.watchlists) if row["id"] == list_id), -1)
            if index == -1:
                raise BridgeError(404, "watchlist not found")
            current = self.server.watchlists[index]
            if method == "PUT":
                current["contracts"] = self._watchlist_contracts(body.get("contracts") or [])
                self.server.save_watchlists()
                self._json(current)
                return
            if method == "POST" and action == "contracts":
                existing = {row["code"] for row in current["contracts"]}
                current["contracts"].extend(
                    row for row in self._watchlist_contracts(body.get("contracts") or []) if row["code"] not in existing
                )
                self.server.save_watchlists()
                self._json(current)
                return
            if method == "DELETE" and action == "contracts":
                remove = {row["code"] for row in self._watchlist_contracts(body.get("contracts") or [])}
                current["contracts"] = [row for row in current["contracts"] if row["code"] not in remove]
                self.server.save_watchlists()
                self._json(current)
                return
            if method == "DELETE":
                self.server.watchlists.pop(index)
                self.server.save_watchlists()
                self._json({})
                return
        raise BridgeError(405, f"Unsupported watchlist operation: {method} {path}")

    def _json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _json(self, data: Any, status: int = 200) -> None:
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _sse_write(self, event: str, data: Any) -> None:
        if env_bool("KGI_DEBUG_MARKET_DATA", False) and event in {"tick_stk", "bidask_stk", "kbar"}:
            symbol = ""
            if isinstance(data, dict):
                symbol = str(data.get("code") or data.get("symbol") or "")
            print(f"[SSE send] type={event} symbol={symbol}", flush=True)
        payload = json.dumps(data, ensure_ascii=False)
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        for line in payload.splitlines() or [""]:
            self.wfile.write(f"data: {line}\n".encode("utf-8"))
        self.wfile.write(b"\n")
        self.wfile.flush()

    def _codex_chat_sse(self, body: dict[str, Any]) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for event in self.server.codex_bridge.stream_chat(
                str(body.get("message") or ""),
                body.get("context") if isinstance(body.get("context"), dict) else {},
                body.get("conversation_id") or body.get("conversationId"),
                body.get("thread_id") or body.get("threadId"),
                bool(body.get("new_conversation") or body.get("newConversation")),
            ):
                event_type = str(event.get("type") or "event")
                self._sse_write(event_type, event)
        except CodexAuthenticationError as exc:
            self._sse_write("error", {"type": "error", "message": str(exc), "code": 401})
        except (CodexBridgeError, BridgeError, TimeoutError) as exc:
            self._sse_write("error", {"type": "error", "message": str(exc)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except Exception as exc:
            self._sse_write("error", {"type": "error", "message": str(exc)})
        finally:
            self.close_connection = True

    def _sse(self) -> None:
        subscriber = self.server.register_stream_client()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                try:
                    health = self.server.client.health()
                    self._sse_write("status", {"status": response_status_for_health(health), "health": health})
                    connected = health.get("connected") is True
                    deadline = time.monotonic() + (1 if connected else 2)
                    while time.monotonic() < deadline:
                        timeout = max(0.1, deadline - time.monotonic())
                        try:
                            event, data = subscriber.get(timeout=timeout)
                        except queue.Empty:
                            break
                        self._sse_write(event, data)
                        while True:
                            try:
                                event, data = subscriber.get_nowait()
                            except queue.Empty:
                                break
                            self._sse_write(event, data)
                    self._sse_write("heartbeat", {"ts": int(time.time() * 1000), "connected": connected})
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    break
        finally:
            self.server.unregister_stream_client(subscriber)

    def _watchlist_contracts(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "security_type": row.get("security_type"),
                "exchange": row.get("exchange") or "",
                "code": row.get("code") or "",
            }
            for row in rows
            if row.get("code")
        ]

    def _empty_margin(self) -> dict[str, int]:
        keys = [
            "yesterday_balance",
            "today_balance",
            "deposit_withdrawal",
            "fee",
            "tax",
            "initial_margin",
            "maintenance_margin",
            "margin_call",
            "risk_indicator",
            "royalty_revenue_expenditure",
            "equity",
            "equity_amount",
            "option_openbuy_market_value",
            "option_opensell_market_value",
            "option_open_position",
            "option_settle_profitloss",
            "future_open_position",
            "today_future_open_position",
            "future_settle_profitloss",
            "available_margin",
            "plus_margin",
            "plus_margin_indicator",
            "security_collateral_amount",
            "order_margin_premium",
            "collateral_amount",
        ]
        return {key: 0 for key in keys}


def run(host: str = "127.0.0.1", port: int = 21323, mode: str | None = None) -> None:
    if _should_load_project_env(mode):
        load_project_env()
    client = make_client(mode)
    # KGI's real-mode login (CA handshake via TradeCom) is ~18s and was
    # measured live — see backend performance investigation — as an
    # unavoidable, purely SDK-side cost, not something our code can shorten.
    # It used to only start on the FIRST frontend request that touched KGI
    # data, so the user's first meaningful action always paid the full 18s
    # inline. Kicking it off here, in the background, lets it run
    # concurrently with the frontend's own boot (JS bundle load, browser
    # navigation, React mount) instead of purely after it — by the time the
    # first real request arrives, login is often already done or well
    # underway. health() already contains its own try/except around
    # _ensure_connected(), so a failed/slow login here can never crash
    # startup or block serve_forever() below.
    if client.mode == "real":
        threading.Thread(target=client.health, name="kgi-login-warmup", daemon=True).start()
    server = KGIHTTPServer((host, port), client)
    print(f"KGI bridge listening on http://{host}:{port} ({client.mode})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local KGI bridge backend.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=21323)
    parser.add_argument("--mode", choices=["mock", "real"], default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    run(args.host, args.port, args.mode)


if __name__ == "__main__":
    main()
