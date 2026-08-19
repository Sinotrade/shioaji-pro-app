import json
import os
import inspect
import tempfile
import threading
import time
import unittest
from enum import Enum
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock
from urllib.request import Request, urlopen

import backend.kgi_bridge.server as server_module
from backend.kgi_bridge.clients import MockKGIClient, RealKGIClient, merge_kbars
from backend.kgi_bridge.errors import BridgeError
from backend.kgi_bridge.normalizers import (
    normalize_contract,
    normalize_inventory_positions,
    normalize_kbars,
    normalize_profit_loss_rows,
    normalize_trade,
    number,
    optional_number,
)
from backend.kgi_bridge.server import KGIHTTPServer, load_project_env


@contextmanager
def running_server(client=None):
    server = KGIHTTPServer(("127.0.0.1", 0), client or MockKGIClient())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def get_json(base, path):
    with urlopen(f"{base}{path}", timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(base, path, payload):
    request = Request(
        f"{base}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


class FakeKGIQuote:
    def set_cb_tick(self, callback):
        self.tick = callback

    def set_cb_bidask(self, callback):
        self.bidask = callback

    def set_cb_kbar(self, callback):
        self.kbar = callback

    def subscribe_kbar(self, symbol, minute=1):
        subscriptions = getattr(self, "subscriptions", [])
        subscriptions.append((symbol, minute))
        self.subscriptions = subscriptions


class FakeKGIOrder:
    def get_position(self):
        return {}

    def get_trades(self, full=False):
        self.full = full
        return []

    def get_deals(self):
        return {}

    def contract(self, output_type):
        return {}


class FakeKGIStockLogin:
    Quote = FakeKGIQuote()

    def __init__(self, person_id="P123", person_pwd="fake-password", simulation=False):
        self.person_id = person_id
        self.person_pwd = person_pwd
        self.simulation = simulation

    def show_account(self):
        return [
            {
                "account_flag": "證券",
                "person_id": self.person_id,
                "broker_id": "KGI",
                "account": "A123",
            }
        ]

    def set_Account(self, account):
        if account == "A123":
            self.Order = FakeKGIOrder()
            self.Account = object()


class KGIClientTests(unittest.TestCase):
    def test_inventory_positions_fold_odd_lot_into_cash_total(self):
        # Verified against a live KGI account: NETQTY0 (現股) already
        # includes any odd-lot (NETQTY9) shares held for the same symbol —
        # they are not independent buckets. E.g. 00403A reported
        # NETQTY9=100 and NETQTY0=1100 (1000 round-lot + the same 100
        # odd-lot shares), so the combined holding is 1100 shares, not 1400.
        rows = normalize_inventory_positions(
            [
                {
                    "Symbol": "2367",
                    "SymbolName": "燿華",
                    "RLPRICE": "20",
                    "NETPL_TWD": "150",
                    "NETQTY0": "1300",
                    "NETQTY9": "300",
                    "R_QTY0": "1300",
                    "R_QTY9": "300",
                    "AVG_PRICE0": "18",
                }
            ],
            "B",
        )

        self.assertEqual([(row["position_type"], row["quantity"]) for row in rows], [("cash", 1300)])
        self.assertEqual(rows[0]["odd_lot_quantity"], 300)
        self.assertTrue(all(row["quantity_unit"] == "shares" for row in rows))
        self.assertEqual(rows[0]["name"], "燿華")

    def test_inventory_positions_use_odd_lot_total_when_no_round_lot_held(self):
        rows = normalize_inventory_positions(
            [
                {
                    "Symbol": "2367",
                    "SymbolName": "燿華",
                    "RLPRICE": "20",
                    "NETPL": "60",
                    "NETQTY9": "300",
                    "R_QTY9": "300",
                    "AVG_PRICE0": "18",
                }
            ],
            "B",
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["position_type"], "cash")
        self.assertEqual(rows[0]["quantity"], 300)
        self.assertEqual(rows[0]["odd_lot_quantity"], 300)

    def test_inventory_positions_collapse_equal_total_cash_and_odd_lot_duplicate(self):
        rows = normalize_inventory_positions(
            [
                {
                    "Symbol": "2330",
                    "SymbolName": "台積電",
                    "RLPRICE": "2385",
                    "NETPL_TWD": "1200",
                    "NETQTY0": "240",
                    "NETQTY9": "240",
                    "R_QTY0": "240",
                    "R_QTY9": "240",
                    "AVG_PRICE0": "2380",
                }
            ],
            "B",
            "A123",
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["code"], "2330")
        self.assertEqual(rows[0]["position_type"], "cash")
        self.assertEqual(rows[0]["quantity"], 240)
        self.assertEqual(rows[0]["quantity_unit"], "shares")
        self.assertEqual(rows[0]["market_value"], 2385 * 240)
        self.assertEqual(rows[0]["pnl"], 1200)
        self.assertEqual(rows[0]["dedupe_key"], "A123:2330:cash:cash")

    def test_inventory_positions_convert_lots_only_when_source_unit_is_lots(self):
        rows = normalize_inventory_positions(
            [
                {
                    "Symbol": "2330",
                    "RLPRICE": "100",
                    "NETQTY0": "1",
                    "R_QTY0": "1",
                    "AVG_PRICE0": "90",
                }
            ],
            "A",
        )

        self.assertEqual(rows[0]["quantity"], 1000)
        self.assertEqual(rows[0]["yd_quantity"], 1000)

    def test_inventory_positions_map_margin_short_and_unrealized_fields(self):
        rows = normalize_inventory_positions(
            [
                {
                    "Symbol": "2454",
                    "RLPRICE": "1200",
                    "NETPL": "600",
                    "NETQTY3": "200",
                    "NETQTY4": "100",
                    "AVG_PRICE3": "1100",
                    "AVG_PRICE4": "1300",
                }
            ],
            "B",
        )

        self.assertEqual([(row["position_type"], row["direction"], row["quantity"]) for row in rows], [("margin", "Buy", 200), ("short", "Sell", 100)])
        self.assertAlmostEqual(sum(row["pnl"] for row in rows), 600)

    def test_realized_profit_loss_filters_today_and_keeps_share_units(self):
        rows = normalize_profit_loss_rows(
            {
                "Detail": [
                    {"Symbol": "2367", "SymbolName": "燿華", "TradeDate": "20260818", "QTY": "300", "PRICE": "20", "COST": "6000", "FEE": "10", "TAX": "18", "NETPL": "72", "PNLRATE": "1.2", "Descript": "零股"},
                    {"Symbol": "2367", "TradeDate": "20260817", "QTY": "300", "NETPL": "99"},
                ]
            },
            "20260818",
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], "2026-08-18")
        self.assertEqual(rows[0]["quantity"], 300)
        self.assertEqual(rows[0]["quantity_unit"], "shares")
        self.assertEqual(rows[0]["fee"], 10)
        self.assertEqual(rows[0]["tax"], 18)

    def test_kbars_sort_and_remove_duplicate_timestamps(self):
        kbars = normalize_kbars(
            [
                {"datetime": "2026-08-18 09:02:00", "Open": 2, "High": 3, "Low": 1, "Close": 2, "Volume": 20},
                {"datetime": "2026-08-18 09:01:00", "Open": 1, "High": 2, "Low": 1, "Close": 1.5, "Volume": 10},
                {"datetime": "2026-08-18 09:02:00", "Open": 2, "High": 4, "Low": 1, "Close": 3, "Volume": 30},
            ]
        )

        self.assertEqual(kbars["datetime"], ["2026-08-18 09:01:00", "2026-08-18 09:02:00"])
        self.assertEqual(kbars["Close"], [1.5, 3])

    def test_kbars_merge_keeps_live_tail_without_duplicate_history_timestamp(self):
        historical = normalize_kbars(
            [
                {"datetime": "2026-08-18 09:01:00", "Open": 1, "High": 2, "Low": 1, "Close": 1.5, "Volume": 10},
                {"datetime": "2026-08-18 09:02:00", "Open": 2, "High": 3, "Low": 1, "Close": 2, "Volume": 20},
            ]
        )
        live = normalize_kbars(
            [
                {"datetime": "2026-08-18 09:02:00", "Open": 2, "High": 4, "Low": 1, "Close": 3, "Volume": 30},
                {"datetime": "2026-08-18 09:03:00", "Open": 3, "High": 5, "Low": 3, "Close": 4, "Volume": 40},
            ]
        )

        merged = merge_kbars(historical, live)

        self.assertEqual(merged["datetime"], ["2026-08-18 09:01:00", "2026-08-18 09:02:00", "2026-08-18 09:03:00"])
        self.assertEqual(merged["Close"], [1.5, 3, 4])

    def test_kbars_recognizes_intraday_rest_table_lot_volume_column(self):
        # 取得即時分K(最後交易日) — verified live — reports per-bar volume as
        # "成交量(張)", distinct from "日成交量(張)" (that table's running
        # cumulative-for-the-day total, not a per-bar value).
        kbars = normalize_kbars(
            [
                {
                    "datetime": "2026-08-19T09:05:00",
                    "開盤價": 100,
                    "最高價": 101,
                    "最低價": 99,
                    "收盤價": 100.5,
                    "成交量(張)": 12,
                    "日成交量(張)": 512,
                }
            ]
        )
        self.assertEqual(kbars["Volume"], [12])
        self.assertEqual(kbars["Close"], [100.5])

    def test_mock_client_provides_read_only_shapes(self):
        client = MockKGIClient()
        self.assertEqual(client.health()["status"], "ok")
        self.assertEqual(client.accounts()[0]["broker_id"], "KGI")
        self.assertEqual(client.snapshots(["2330"])[0]["code"], "2330")
        self.assertIn("Open", client.kbars("2330", "2026-08-17", "2026-08-17"))
        self.assertEqual(client.bidask_snapshot("2330")["code"], "2330")
        self.assertGreaterEqual(len(client.daily_bars("2330", 90)["Close"]), 90)
        self.assertEqual(client.orders("S"), [])
        self.assertEqual(client.deals("S"), {})

    def test_mock_client_streams_after_subscription(self):
        client = MockKGIClient()
        client.subscribe_quote("2330", "Tick")
        client.subscribe_quote("2330", "BidAsk")
        events = client.poll_stream_events(timeout=0)
        names = {name for name, _ in events}
        self.assertIn("tick_stk", names)
        self.assertIn("bidask_stk", names)

    def test_server_broadcasts_stream_events_to_all_sse_subscribers(self):
        server = KGIHTTPServer(("127.0.0.1", 0), MockKGIClient())
        first = server.register_stream_client()
        second = server.register_stream_client()
        try:
            server._broadcast_stream_event("bidask_stk", {"code": "2330"})
            self.assertEqual(first.get_nowait(), ("bidask_stk", {"code": "2330"}))
            self.assertEqual(second.get_nowait(), ("bidask_stk", {"code": "2330"}))
        finally:
            server.unregister_stream_client(first)
            server.unregister_stream_client(second)
            server.server_close()

    def test_real_client_without_credentials_is_disconnected(self):
        with mock.patch.dict(
            os.environ,
            {
                "KGI_PERSON_ID": "",
                "KGI_PERSON_PWD": "",
                "KGI_ACCOUNT": "",
            },
            clear=False,
        ):
            client = RealKGIClient()
            health = client.health()
        self.assertEqual(health["status"], "disconnected")
        self.assertFalse(health["connected"])

    def test_real_client_uses_kgisuperpy_login_constructor(self):
        calls = {}

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                calls["person_id"] = person_id
                calls["person_pwd"] = person_pwd
                calls["simulation"] = simulation
                self.selected_account = None

            def set_Account(self, account):
                super().set_Account(account)
                self.selected_account = account

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "",
                    "KGI_SIMULATION": "false",
                },
                clear=False,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "ok")
        self.assertEqual(calls["person_id"], "P123")
        self.assertEqual(calls["person_pwd"], "fake-password")
        self.assertFalse(calls["simulation"])

    def test_real_client_models_kgisuperpy_facade_mutated_by_set_account(self):
        instances = []

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                instances.append(self)
                self.had_order_before_set_account = hasattr(self, "Order")

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "ok")
        self.assertIs(client.api, instances[0])
        self.assertFalse(instances[0].had_order_before_set_account)
        self.assertTrue(hasattr(client.api, "Order"))
        self.assertTrue(health["api_diagnostic"]["has_order"])
        self.assertTrue(health["api_diagnostic"]["has_quote"])
        self.assertTrue(health["api_diagnostic"]["has_show_account"])

    def test_real_client_auto_selects_single_stock_account_without_kgi_account(self):
        instances = []

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                instances.append(self)
                self.selected_account = None

            def set_Account(self, account):
                super().set_Account(account)
                self.selected_account = account

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "ok")
        self.assertEqual(instances[0].selected_account, "A123")
        self.assertTrue(hasattr(client.api, "Order"))
        self.assertTrue(hasattr(client.api, "Account"))

    def test_real_client_reports_when_no_stock_account_exists(self):
        class FakeAPI(FakeKGIStockLogin):
            def show_account(self):
                return [
                    {
                        "account_flag": "期貨",
                        "broker_id": "KGI",
                        "account": "FUTURE123456",
                    }
                ]

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "disconnected")
        self.assertIn("KGI stock account not found", health["message"])
        self.assertNotIn("FUTURE123456", health["message"])

    def test_real_client_requires_optional_override_for_multiple_stock_accounts(self):
        class FakeAPI(FakeKGIStockLogin):
            def show_account(self):
                return [
                    {"account_flag": "證券", "broker_id": "KGI", "account": "STOCK111111"},
                    {"account_flag": "證券", "broker_id": "KGI", "account": "STOCK222222"},
                ]

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "disconnected")
        self.assertIn("Multiple KGI stock accounts found", health["message"])
        self.assertIn("***1111", health["message"])
        self.assertIn("***2222", health["message"])
        self.assertNotIn("STOCK111111", health["message"])
        self.assertNotIn("STOCK222222", health["message"])

    def test_real_client_uses_kgi_account_override_for_multiple_stock_accounts(self):
        instances = []

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                instances.append(self)
                self.selected_account = None

            def show_account(self):
                return [
                    {"account_flag": "證券", "broker_id": "KGI", "account": "STOCK111111"},
                    {"account_flag": "證券", "broker_id": "KGI", "account": "STOCK222222"},
                ]

            def set_Account(self, account):
                self.selected_account = account
                self.Order = FakeKGIOrder()
                self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "STOCK222222",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "ok")
        self.assertEqual(instances[0].selected_account, "STOCK222222")

    def test_real_client_simulation_defaults_to_false(self):
        calls = {}

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                calls["simulation"] = simulation

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            self.assertFalse(client.info()["simulation"])
            self.assertEqual(client.health()["status"], "ok")

        self.assertFalse(calls["simulation"])

    def test_real_client_does_not_print_secrets_during_login(self):
        secret_person = "SECRET_PERSON"
        secret_password = "SECRET_PASSWORD"
        secret_account = "SECRET_ACCOUNT"

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                print(f"login {person_id} {person_pwd}")

            def show_account(self):
                print(f"accounts {secret_account}")
                return [{"account_flag": "S", "account": secret_account}]

            def set_Account(self, account):
                self.Order = FakeKGIOrder()
                self.Account = object()
                print(f"set {account}")

        out = StringIO()
        err = StringIO()
        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": secret_person,
                    "KGI_PERSON_PWD": secret_password,
                    "KGI_ACCOUNT": secret_account,
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            client = RealKGIClient()
            self.assertEqual(client.health()["status"], "ok")

        output = out.getvalue() + err.getvalue()
        self.assertNotIn(secret_person, output)
        self.assertNotIn(secret_password, output)
        self.assertNotIn(secret_account, output)

    def test_real_stock_callbacks_are_single_argument_and_futures_are_not_registered(self):
        callbacks = {}

        class RecordingQuote:
            def set_cb_tick(self, callback):
                callbacks["tick"] = callback

            def set_cb_bidask(self, callback):
                callbacks["bidask"] = callback

            def set_cb_kbar(self, callback):
                callbacks["kbar"] = callback

        class ForbiddenFutQuote:
            def set_cb_tick(self, callback):
                raise AssertionError("FutQuote callbacks must not be installed for stock-only sessions")

            def set_cb_bidask(self, callback):
                raise AssertionError("FutQuote callbacks must not be installed for stock-only sessions")

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()
            FutQuote = ForbiddenFutQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            self.assertEqual(client.health()["status"], "ok")

        self.assertEqual(set(callbacks), {"tick", "bidask", "kbar"})
        for callback in callbacks.values():
            signature = inspect.signature(callback)
            self.assertEqual(len(signature.parameters), 1)
            self.assertEqual(callback.__annotations__, {})

        callbacks["tick"]({"symbol": "2330", "price": 100})
        callbacks["bidask"]({"symbol": "2330", "bid_price": [99], "ask_price": [100]})
        callbacks["kbar"]({"symbol": "2330", "close": 100})
        events = client.poll_stream_events(timeout=0)
        self.assertEqual([event for event, _ in events], ["tick_stk", "bidask_stk", "kbar"])

    def test_real_live_kbars_subscribes_to_stock_quote_kbar(self):
        subscriptions = []

        class RecordingQuote(FakeKGIQuote):
            def subscribe_kbar(self, symbol, minute=1):
                subscriptions.append((symbol, minute))

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            kbars = client.kbars("2330", "2026-08-18", "2026-08-18", 5)

        self.assertEqual(subscriptions, [("2330", 5)])
        self.assertEqual(kbars, {"datetime": [], "Open": [], "High": [], "Low": [], "Close": [], "Volume": [], "Amount": []})

    def test_real_live_kbars_prevents_duplicate_subscriptions(self):
        subscriptions = []

        class RecordingQuote(FakeKGIQuote):
            def subscribe_kbar(self, symbol, minute=1):
                subscriptions.append((symbol, minute))

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.kbars("2330", "2026-08-18", "2026-08-18", 1)
            client.kbars("2330", "2026-08-18", "2026-08-18", 1)

        self.assertEqual(subscriptions, [("2330", 1)])

    def test_real_kbar_callback_caches_and_formats_bridge_response(self):
        callbacks = {}

        class RecordingQuote(FakeKGIQuote):
            def set_cb_kbar(self, callback):
                callbacks["kbar"] = callback

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.kbars("2330", "2026-08-18", "2026-08-18", 1)
            callbacks["kbar"](
                {
                    "symbol": "2330",
                    "datetime": "2026-08-18 09:01:00",
                    "open": 100,
                    "high": 101,
                    "low": 99,
                    "close": 100.5,
                    "volume": 12,
                    "amount": 1206,
                }
            )
            kbars = client.kbars("2330", "2026-08-18", "2026-08-18", 1)

        self.assertEqual(kbars["datetime"], ["2026-08-18 09:01:00"])
        self.assertEqual(kbars["Open"], [100])
        self.assertEqual(kbars["High"], [101])
        self.assertEqual(kbars["Low"], [99])
        self.assertEqual(kbars["Close"], [100.5])
        self.assertEqual(kbars["Volume"], [12])
        self.assertEqual(kbars["Amount"], [1206])

    def test_real_tick_callback_builds_live_kbar_fallback_cache(self):
        callbacks = {}

        class RecordingQuote(FakeKGIQuote):
            def set_cb_tick(self, callback):
                callbacks["tick"] = callback

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.kbars("2330", "2026-08-18", "2026-08-18", 1)
            callbacks["tick"](
                {
                    "symbol": "2330",
                    "datetime": "20260818115900",
                    "open": 100,
                    "high": 101,
                    "low": 99,
                    "close": 100.5,
                    "volume": 3,
                    "total_volume": 30,
                }
            )
            kbars = client.kbars("2330", "2026-08-18", "2026-08-18", 1)

        self.assertEqual(kbars["Close"], [100.5])
        self.assertEqual(kbars["Volume"], [3])

    def test_real_historical_kbars_maps_upstream_403_to_bridge_error(self):
        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access to the specified request is denied"

        class FakeData:
            def get(self, table, *args):
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            with self.assertRaises(BridgeError) as raised:
                client.historical_kbars("2330", "2026-08-18", "2026-08-18", 1)

        self.assertEqual(raised.exception.status, 403)
        self.assertIn("D403", raised.exception.message)
        self.assertIn("取得歷史分K(指定日期前)", raised.exception.details["tables_tried"])
        self.assertEqual(raised.exception.details["symbol"], "2330")

    def test_real_kbars_d403_backoff_does_not_retry_denied_tables(self):
        calls = []

        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access to the specified request is denied"

        class FakeData:
            def get(self, table, *args):
                calls.append((table, args))
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            first = client.kbars("2330", "2026-08-18", "2026-08-18", 1)
            second = client.kbars("2330", "2026-08-18", "2026-08-18", 1)

        self.assertEqual(first["capability"]["historical"], "denied")
        self.assertEqual(second["capability"]["historical"], "denied")
        # 3 denied 歷史分K candidates (cached after the first kbars() call,
        # so the second call retries none of them) + 1 one-time
        # 取得即時分K(最後交易日) seed call from the first live_kbars()
        # subscribe (also denied here, but that must not be retried either
        # since the subscription itself is only established once).
        self.assertEqual(len(calls), 4)

    def test_real_historical_kbars_denial_details_include_range_and_environment(self):
        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access to the specified request is denied"

        class FakeData:
            def get(self, table, *args):
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                    "KGI_SIMULATION": "false",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            with self.assertRaises(BridgeError) as raised:
                client.historical_kbars("2330", "2026-08-18", "2026-08-18", 5)

        self.assertEqual(raised.exception.details["start"], "2026-08-18")
        self.assertEqual(raised.exception.details["end"], "2026-08-18")
        self.assertEqual(raised.exception.details["environment"], "production")

    def test_real_kbars_returns_available_live_bars_instead_of_empty_when_history_denied(self):
        # Regression: kbars() used to discard `live` entirely and always
        # return empty_kbars() once historical_kbars() hit a D403 — even
        # when the live push-tick cache already held real bars for today.
        # That made the chart permanently blank on any account without
        # 歷史分K entitlement (verified live: every interval, this account),
        # instead of showing the today session data it did have.
        callbacks = {}

        class RecordingQuote(FakeKGIQuote):
            def set_cb_kbar(self, callback):
                callbacks["kbar"] = callback

        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access to the specified request is denied"

        class FakeData:
            def get(self, table, *args):
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.kbars("2330", "2026-08-18", "2026-08-18", 5)
            callbacks["kbar"](
                {
                    "symbol": "2330",
                    "minute": 5,
                    "datetime": "2026-08-19 09:05:00",
                    "open": 100,
                    "high": 101,
                    "low": 99,
                    "close": 100.5,
                    "volume": 12,
                    "amount": 1206,
                }
            )
            kbars = client.kbars("2330", "2026-08-18", "2026-08-18", 5)

        self.assertEqual(kbars["capability"]["historical"], "denied")
        self.assertEqual(kbars["datetime"], ["2026-08-19 09:05:00"])
        self.assertEqual(kbars["Close"], [100.5])

    def test_real_live_kbars_seeds_todays_session_from_intraday_rest_table(self):
        calls = []

        class FakeData:
            def get(self, table, *args):
                calls.append((table, args))
                if table == "取得即時分K(最後交易日)":
                    return [
                        {
                            "datetime": "2026-08-19T09:01:00",
                            "開盤價": 100,
                            "最高價": 101,
                            "最低價": 99,
                            "收盤價": 100.5,
                            "成交量(張)": 12,
                        },
                        {
                            "datetime": "2026-08-19T09:02:00",
                            "開盤價": 100.5,
                            "最高價": 102,
                            "最低價": 100,
                            "收盤價": 101,
                            "成交量(張)": 8,
                        },
                    ]
                raise AssertionError(f"unexpected table requested: {table}")

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            kbars = client.live_kbars("2330", 5)

        self.assertIn(("取得即時分K(最後交易日)", ("2330", 5)), calls)
        self.assertEqual(kbars["datetime"], ["2026-08-19T09:01:00", "2026-08-19T09:02:00"])
        self.assertEqual(kbars["Close"], [100.5, 101])
        self.assertEqual(kbars["Volume"], [12, 8])

    def test_real_live_kbars_seed_failure_does_not_break_subscription(self):
        # The REST backfill is best-effort: if it also 403s (or errors for
        # any other reason), subscribing must still succeed so push ticks
        # can build the cache normally.
        class FakeData:
            def get(self, table, *args):
                raise RuntimeError("boom")

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            kbars = client.live_kbars("2330", 5)

        self.assertEqual(kbars, {"datetime": [], "Open": [], "High": [], "Low": [], "Close": [], "Volume": [], "Amount": []})

    def test_real_stock_only_futures_contract_requests_do_not_login(self):
        client = RealKGIClient()
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor") as login_constructor,
        ):
            self.assertEqual(client.contracts("FUT"), [])
            with self.assertRaises(BridgeError) as raised:
                client.contract("TXFR1", "FUT")

        login_constructor.assert_not_called()
        self.assertEqual(raised.exception.status, 404)

    def test_real_stock_contracts_keep_common_stock_symbols_available(self):
        class ContractAPI:
            Contracts = {
                "2330": {"symbol": "2330", "name": "TSMC", "market": "tse"},
                "2454": {"symbol": "2454", "name": "MediaTek", "market": "tse"},
                "2317": {"symbol": "2317", "name": "Hon Hai", "market": "tse"},
                "2603": {"symbol": "2603", "name": "Evergreen", "market": "tse"},
                "0050": {"symbol": "0050", "name": "Yuanta Taiwan 50", "market": "tse"},
            }

        class RecordingQuote(FakeKGIQuote):
            _api = ContractAPI()

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            contracts = client.contracts("STK")

        codes = {row["code"] for row in contracts}
        self.assertTrue({"2330", "2454", "2317", "2603", "0050"}.issubset(codes))

    def test_real_stock_contracts_prefer_order_contract_names_over_quote_contracts(self):
        # Regression: Order.contract("dic") is wired (installed kgisuperpy
        # 2.1.0, kgisuperpy/data/data.py Contract dataclass) from the
        # 台股商品檔 table with a verified name/category field shape.
        # api.Quote.Contracts (or Quote._api.Contracts) is a native
        # TradeCom-DLL-backed dict with an undocumented per-row shape that
        # does not reliably carry "name"/"category" — using it as the
        # PRIMARY source (as the bridge used to) was the verified cause of
        # stock names rendering as their own code in real mode. When both
        # sources are available, Order.contract must win.
        class ContractAPI:
            Contracts = {
                "2330": {"symbol": "2330", "unknown_native_field": "TSMC"},
            }

        class RecordingQuote(FakeKGIQuote):
            _api = ContractAPI()

        class NamedOrder(FakeKGIOrder):
            def contract(self, output_type):
                return {
                    "2330": {
                        "symbol": "2330",
                        "name": "台積電",
                        "market": "tse",
                        "category": "24",
                        "bull_limit": 1320.0,
                        "bear_limit": 1080.0,
                        "ref_price": 1200.0,
                        "day_trade": "Yes",
                        "update_date": "2026-08-18",
                    }
                }

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

            def set_Account(self, account):
                if account == "A123":
                    self.Order = NamedOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            contract = RealKGIClient().contract("2330", "STK")

        self.assertEqual(contract["name"], "台積電")
        self.assertEqual(contract["category"], "24")

    def test_real_stock_contracts_are_cached_across_calls_and_single_lookups(self):
        # Regression: contracts()/contract() used to rebuild the entire
        # ~2700-row catalog (Order.contract("dic") + as_plain() +
        # normalize_contract() per row) on EVERY call — including once per
        # symbol for every individual /data/contracts/{code} lookup (e.g.
        # resolving an N-symbol watchlist did N of these full rebuilds).
        # Verified live: ~130ms of pure CPU per rebuild even with the SDK's
        # own raw-fetch cache warm. Order.contract("dic") must now be called
        # at most once for any number of contracts()/contract() calls.
        calls = []

        class CountingOrder(FakeKGIOrder):
            def contract(self, output_type):
                calls.append(output_type)
                return {
                    "2330": {"symbol": "2330", "name": "台積電", "market": "tse", "category": "24"},
                    "2317": {"symbol": "2317", "name": "鴻海", "market": "tse", "category": "31"},
                }

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = CountingOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            first = client.contracts("STK")
            second = client.contracts("STK")
            single = client.contract("2330", "STK")

        self.assertEqual(len(calls), 1)
        self.assertEqual({row["code"] for row in first}, {"2330", "2317"})
        self.assertEqual(first, second)
        self.assertEqual(single["name"], "台積電")
        self.assertEqual(single["category"], "24")

    def test_real_stock_contracts_refresh_stock_contracts_bypasses_cache(self):
        calls = []

        class CountingOrder(FakeKGIOrder):
            def contract(self, output_type):
                calls.append(output_type)
                name = "台積電" if len(calls) == 1 else "台積電(更新)"
                return {"2330": {"symbol": "2330", "name": name, "market": "tse", "category": "24"}}

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = CountingOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            before = client.contract("2330", "STK")
            refreshed = client.refresh_stock_contracts()
            after = client.contract("2330", "STK")

        self.assertEqual(len(calls), 2)
        self.assertEqual(before["name"], "台積電")
        self.assertEqual(refreshed["2330"]["name"], "台積電(更新)")
        self.assertEqual(after["name"], "台積電(更新)")

    def test_real_order_history_uses_installed_full_keyword(self):
        orders = []

        class RecordingOrder(FakeKGIOrder):
            def get_trades(self, full=False):
                orders.append(full)
                return {
                    "T1": {
                        "order": {"symbol": "2330", "quantity": 1, "price": 100, "action": "Buy"},
                        "order_status": {"status": "Submitted", "nid": "T1"},
                    }
                }

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = RecordingOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            rows = client.orders("S")

        self.assertEqual(orders, [True])
        self.assertEqual(rows[0]["contract"]["code"], "2330")

    def test_real_order_history_ignores_empty_status_buckets(self):
        class RecordingOrder(FakeKGIOrder):
            def get_trades(self, full=False):
                return {"無效單": []}

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = RecordingOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            rows = RealKGIClient().orders("S")

        self.assertEqual(rows, [])

    def test_trade_normalizer_maps_real_kgi_qty_status_and_order_id_fields(self):
        trade = normalize_trade(
            {
                "order": {
                    "stock_no": "2330",
                    "name": "manual",
                    "buy_sell": "Sell",
                    "qty": "3",
                    "price": "2385",
                    "price_type": "LMT",
                    "time_in_force": "ROD",
                    "ordno": "KGI123",
                },
                "order_status": {
                    "ord_status": "PartFilled",
                    "deal_quantity": "1",
                    "cancel_quantity": "0",
                    "message": "ok",
                    "nid": "NID123",
                },
            },
            "fallback",
        )

        self.assertEqual(trade["contract"]["code"], "2330")
        self.assertEqual(trade["order"]["action"], "Sell")
        self.assertEqual(trade["order"]["quantity"], 3)
        self.assertEqual(trade["status"]["deal_quantity"], 1)
        self.assertEqual(trade["status"]["remaining_quantity"], 2)
        self.assertEqual(trade["status"]["status"], "PartFilled")
        self.assertTrue(trade["status"]["order_id_present"])
        self.assertEqual(trade["order"]["ordno"], "KGI123")

    def test_trade_normalizer_marks_missing_real_order_id(self):
        trade = normalize_trade(
            {"order": {"symbol": "2330", "quantity": 1}, "order_status": {"status": "Submitted"}},
            "fallback",
        )

        self.assertFalse(trade["status"]["order_id_present"])

    def test_real_place_stock_order_maps_to_kgisuperpy_enums_and_idempotency(self):
        calls = []

        class FakeAction(Enum):
            Buy = "B"
            Sell = "S"

        class FakePriceType(Enum):
            MKT = "1"

        class FakeTimeInForce(Enum):
            ROD = 0
            IOC = 1
            FOK = 2

        class FakeOrderCond(Enum):
            CASH = 0
            MARGIN = 3
            SHORT_SELLING = 4
            Lend_SELLING = 6
            CASH_SELLING = 9

        class FakeOddLot(Enum):
            Common = 0
            Odd = 4
            Fixing = 2

        class FakeKgi:
            Action = FakeAction
            PriceType = FakePriceType
            TimeInForce = FakeTimeInForce
            OrderCond = FakeOrderCond
            OddLot = FakeOddLot

        class RecordingOrder(FakeKGIOrder):
            def create_order(self, **kwargs):
                calls.append(kwargs)
                return {
                    "order": {
                        "symbol": kwargs["symbol"],
                        "quantity": kwargs["qty"],
                        "price": kwargs["price"],
                        "action": kwargs["action"],
                        "time_in_force": kwargs["time_in_force"],
                        "price_type": "PriceType.LMT",
                        "odd_lot": kwargs["odd_lot"],
                    },
                    "order_status": {"status": "Submitted", "nid": "REQ1"},
                }

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = RecordingOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
            mock.patch("backend.kgi_bridge.clients.importlib.import_module", return_value=FakeKgi),
        ):
            client = RealKGIClient()
            trade = client.place_stock_order(
                {"code": "2330", "security_type": "STK"},
                {
                    "action": "Buy",
                    "quantity": 1,
                    "price": 100,
                    "price_type": "LMT",
                    "order_type": "ROD",
                    "order_lot": "Common",
                    "order_cond": "Cash",
                },
                "REQ1",
            )
            with self.assertRaises(BridgeError) as raised:
                client.place_stock_order(
                    {"code": "2330", "security_type": "STK"},
                    {
                        "action": "Buy",
                        "quantity": 1,
                        "price": 100,
                        "price_type": "LMT",
                        "order_type": "ROD",
                    },
                    "REQ1",
                )

        self.assertEqual(calls[0]["action"].name, "Buy")
        self.assertEqual(calls[0]["time_in_force"].name, "ROD")
        self.assertEqual(calls[0]["order_cond"].name, "CASH")
        self.assertEqual(calls[0]["odd_lot"].name, "Common")
        self.assertEqual(trade["contract"]["code"], "2330")
        self.assertEqual(raised.exception.status, 409)

    def test_real_client_serializes_native_calls_onto_single_dedicated_thread(self):
        # The native TradeCom DLL is not safe to call from arbitrary OS
        # threads (this was the root cause of the create_order "access
        # violation" crash). Every native call must be dispatched onto one
        # dedicated worker thread, regardless of which thread issued the
        # request. Two calls fired concurrently from different threads
        # should both land on that same worker thread.
        thread_ids: list[int] = []
        lock = threading.Lock()

        class RecordingOrder(FakeKGIOrder):
            def create_order(self, **kwargs):
                with lock:
                    thread_ids.append(threading.get_ident())
                return {
                    "order": {"symbol": kwargs["symbol"], "quantity": kwargs["qty"], "price": kwargs["price"]},
                    "order_status": {"status": "Submitted", "nid": "REQ-thread"},
                }

        class RecordingAccount:
            def InventorySum(self, ftype="A"):
                with lock:
                    thread_ids.append(threading.get_ident())
                return []

        class FakeAction(Enum):
            Buy = "B"

        class FakeOrderCond(Enum):
            CASH = 0

        class FakeOddLot(Enum):
            Common = 0

        class FakeTimeInForce(Enum):
            ROD = 0

        class FakeKgi:
            Action = FakeAction
            OrderCond = FakeOrderCond
            OddLot = FakeOddLot
            TimeInForce = FakeTimeInForce

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = RecordingOrder()
                    self.Account = RecordingAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
            mock.patch("backend.kgi_bridge.clients.importlib.import_module", return_value=FakeKgi),
        ):
            client = RealKGIClient()
            with ThreadPoolExecutor(max_workers=2) as pool:
                order_future = pool.submit(
                    client.place_stock_order,
                    {"code": "2330", "security_type": "STK"},
                    {
                        "action": "Buy",
                        "quantity": 1,
                        "price": 100,
                        "price_type": "LMT",
                        "order_type": "ROD",
                        "order_lot": "Common",
                        "order_cond": "Cash",
                    },
                    "REQ-thread",
                )
                positions_future = pool.submit(client.positions)
                order_future.result()
                positions_future.result()

        self.assertEqual(len(thread_ids), 2)
        self.assertEqual(thread_ids[0], thread_ids[1])
        self.assertNotEqual(thread_ids[0], threading.get_ident())

    def test_real_stock_order_validation_rejects_invalid_quantity_and_market_price(self):
        class FakeAPI(FakeKGIStockLogin):
            pass

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            with self.assertRaises(BridgeError) as quantity_error:
                client.place_stock_order(
                    {"code": "2330", "security_type": "STK"},
                    {"action": "Buy", "quantity": 0, "price": 100, "price_type": "LMT", "order_type": "ROD"},
                    "REQ-BADQ",
                )
            with self.assertRaises(BridgeError) as price_error:
                client.place_stock_order(
                    {"code": "2330", "security_type": "STK"},
                    {"action": "Buy", "quantity": 1, "price": 100, "price_type": "MKT", "order_type": "GTC"},
                    "REQ-BADTIF",
                )

        self.assertEqual(quantity_error.exception.status, 400)
        self.assertEqual(price_error.exception.status, 422)

    def test_real_cancel_and_modify_use_mocked_sdk_methods(self):
        calls = []

        class RecordingOrder(FakeKGIOrder):
            def get_trades(self, full=False):
                return {
                    "ORD1": {
                        "order": {"symbol": "2330", "quantity": 2, "price": 100, "action": "Buy", "order_id": "ORD1"},
                        "order_status": {"status": "Submitted", "nid": "NID1"},
                    }
                }

            def cancel_order(self, order_id):
                calls.append(("cancel", order_id))
                return self.get_trades(True)["ORD1"]

            def update_order(self, order_id, price=None, qty=None):
                calls.append(("update", order_id, price, qty))
                return self.get_trades(True)["ORD1"]

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = RecordingOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.cancel_order("ORD1", "REQ-CANCEL")
            client.update_order("ORD1", "REQ-PRICE", price=101)
            client.update_order("ORD1", "REQ-QTY", qty=1)

        self.assertEqual(calls, [("cancel", "ORD1"), ("update", "ORD1", 101, None), ("update", "ORD1", None, 1)])

    def test_real_quote_subscription_is_deduplicated(self):
        subscriptions = []

        class RecordingQuote(FakeKGIQuote):
            def subscribe_tick(self, symbol, odd_lot=False):
                subscriptions.append(("Tick", symbol, odd_lot))

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.subscribe_quote("2330", "Tick")
            client.subscribe_quote("2330", "Tick")

        self.assertEqual(subscriptions, [("Tick", "2330", False)])

    def test_real_bidask_subscribe_replays_last_known_depth(self):
        # KGI only pushes a bidask update when the order book changes, so a
        # panel that (re)subscribes to an already-tracked symbol would
        # otherwise see nothing until the next real change. Subscribing
        # again should immediately replay the last cached depth.
        class RecordingQuote(FakeKGIQuote):
            def subscribe_bidask(self, symbol, odd_lot=False):
                pass

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            client.subscribe_quote("2330", "BidAsk")
            # Drain the initial (empty) queue state from the first subscribe.
            client.poll_stream_events(timeout=0)

            quote = client.api.Quote
            quote.bidask(
                {
                    "symbol": "2330",
                    "bid_prices": ["100", "99.5"],
                    "bid_volumes": [5, 3],
                    "ask_prices": ["100.5", "101"],
                    "ask_volumes": [4, 2],
                }
            )
            client.poll_stream_events(timeout=0)

            # Re-subscribing to the same symbol should replay the cache
            # instead of silently doing nothing.
            client.subscribe_quote("2330", "BidAsk")
            events = client.poll_stream_events(timeout=0)

        bidask_events = [data for name, data in events if name == "bidask_stk"]
        self.assertEqual(len(bidask_events), 1)
        self.assertEqual(bidask_events[0]["code"], "2330")
        self.assertEqual(bidask_events[0]["bid_price"], ["100", "99.5"])
        self.assertEqual(bidask_events[0]["ask_volume"], [4, 2])

    def test_real_stock_api_validation_reports_missing_order(self):
        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                pass

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            health = client.health()

        self.assertEqual(health["status"], "disconnected")
        self.assertIn("KGI stock API is incomplete", health["message"])
        self.assertIn("Order", health["message"])
        self.assertFalse(health["api_diagnostic"]["has_order"])
        self.assertTrue(health["api_diagnostic"]["has_quote"])
        self.assertTrue(health["api_diagnostic"]["has_show_account"])

    def test_real_client_concurrent_initialization_logs_in_once(self):
        login_calls = 0
        login_lock = threading.Lock()

        class FakeAPI(FakeKGIStockLogin):
            def __init__(self, person_id, person_pwd, simulation):
                super().__init__(person_id, person_pwd, simulation)
                nonlocal login_calls
                with login_lock:
                    login_calls += 1
                time.sleep(0.05)

        client = RealKGIClient()
        start = threading.Barrier(8)

        def call_health():
            start.wait(timeout=2)
            return client.health()["status"]

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=False,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
            ThreadPoolExecutor(max_workers=8) as pool,
        ):
            statuses = list(pool.map(lambda _: call_health(), range(8)))

        self.assertEqual(statuses, ["ok"] * 8)
        self.assertEqual(login_calls, 1)

    def test_real_client_concurrent_initialization_failure_is_cached(self):
        login_calls = 0
        login_lock = threading.Lock()

        class FailingAPI:
            def __init__(self, person_id, person_pwd, simulation):
                nonlocal login_calls
                with login_lock:
                    login_calls += 1
                time.sleep(0.05)
                raise RuntimeError("native init failed")

        client = RealKGIClient()
        start = threading.Barrier(8)

        def call_health():
            start.wait(timeout=2)
            return client.health()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=False,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FailingAPI),
            ThreadPoolExecutor(max_workers=8) as pool,
        ):
            healths = list(pool.map(lambda _: call_health(), range(8)))

        self.assertEqual({row["status"] for row in healths}, {"disconnected"})
        self.assertEqual(login_calls, 1)
        self.assertIn("native init failed", client.connection_error)

    def test_load_project_env_sets_missing_values_without_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_path = os.path.join(tmp, ".env")
            with open(env_path, "w", encoding="utf-8") as env_file:
                env_file.write("KGI_PERSON_ID=from-file\n")
                env_file.write("KGI_PERSON_PWD='from-file-password'\n")
                env_file.write("KGI_SIMULATION=false\n")

            with mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "from-shell"},
                clear=False,
            ):
                os.environ.pop("KGI_PERSON_PWD", None)
                os.environ.pop("KGI_SIMULATION", None)
                loaded = load_project_env(path=Path(env_path))

                self.assertTrue(loaded)
                self.assertEqual(os.environ["KGI_PERSON_ID"], "from-shell")
                self.assertEqual(os.environ["KGI_PERSON_PWD"], "from-file-password")
                self.assertEqual(os.environ["KGI_SIMULATION"], "false")

    def test_run_loads_project_root_env_before_real_client_creation(self):
        observed = {}
        health_called = threading.Event()

        class FakeClient:
            mode = "real"

            def health(self):
                observed["health_called"] = True
                health_called.set()
                return {"status": "ok"}

        class FakeServer:
            def __init__(self, server_address, client):
                self.server_address = server_address
                self.client = client

            def serve_forever(self):
                raise KeyboardInterrupt

            def server_close(self):
                observed["closed"] = True

        def fake_make_client(mode):
            observed["mode"] = mode
            observed["person_id"] = os.environ.get("KGI_PERSON_ID")
            observed["person_pwd_present"] = bool(os.environ.get("KGI_PERSON_PWD"))
            observed["account"] = os.environ.get("KGI_ACCOUNT")
            observed["simulation"] = os.environ.get("KGI_SIMULATION")
            return FakeClient()

        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "KGI_PERSON_ID=from-project-root",
                        "KGI_PERSON_PWD=from-project-root-password",
                        "KGI_ACCOUNT=from-project-root-account",
                        "KGI_SIMULATION=false",
                    ]
                ),
                encoding="utf-8",
            )

            out = StringIO()
            err = StringIO()
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(server_module, "_project_root", return_value=Path(tmp)),
                mock.patch.object(server_module, "make_client", side_effect=fake_make_client),
                mock.patch.object(server_module, "KGIHTTPServer", side_effect=FakeServer),
                redirect_stdout(out),
                redirect_stderr(err),
            ):
                server_module.run(mode="real", port=0)

        self.assertEqual(observed["mode"], "real")
        self.assertEqual(observed["person_id"], "from-project-root")
        self.assertTrue(observed["person_pwd_present"])
        self.assertEqual(observed["account"], "from-project-root-account")
        self.assertEqual(observed["simulation"], "false")
        self.assertTrue(observed["closed"])
        # run() must kick off the KGI login warm-up in the background for a
        # real-mode client (see server.py's `run()`) instead of leaving the
        # ~18s CA handshake to happen lazily on the first real request.
        self.assertTrue(health_called.wait(timeout=2), "expected client.health() warm-up to run in the background")
        output = out.getvalue() + err.getvalue()
        self.assertNotIn("from-project-root-password", output)
        self.assertNotIn("from-project-root-account", output)


class KGIBridgeHTTPTests(unittest.TestCase):
    def test_health_accounts_quote_kbar_orders_and_deals_endpoints(self):
        with running_server() as base:
            self.assertEqual(get_json(base, "/api/v1/health")["status"], "ok")
            self.assertEqual(get_json(base, "/api/v1/auth/accounts")[0]["broker_id"], "KGI")

            snapshots = post_json(
                base,
                "/api/v1/data/snapshots",
                {"contracts": [{"code": "2330"}]},
            )
            self.assertEqual(snapshots[0]["code"], "2330")

            kbars = post_json(
                base,
                "/api/v1/data/kbars",
                {
                    "contract": {"code": "2330"},
                    "start": "2026-08-17",
                    "end": "2026-08-17",
                },
            )
            self.assertGreater(len(kbars["datetime"]), 0)

            self.assertEqual(
                post_json(base, "/api/v1/order/trades", {"account_type": "S"}),
                [],
            )
            self.assertEqual(
                post_json(base, "/api/v1/order/deals", {"account_type": "S"}),
                {},
            )

    def test_data_contracts_refresh_query_param_is_a_safe_no_op_in_mock_mode(self):
        # MockKGIClient has no refresh_stock_contracts() (that's a
        # RealKGIClient-only cache-busting escape hatch) — the server must
        # detect that with getattr/callable and just skip it, not crash.
        with running_server() as base:
            page = get_json(base, "/api/v1/data/contracts?security_type=STK&refresh=1")
        self.assertGreater(page["total"], 0)
        self.assertEqual(page["contracts"][0]["security_type"], "STK")

    def test_backend_subscription_endpoint_registers_stream_interest(self):
        client = MockKGIClient()
        with running_server(client) as base:
            response = post_json(
                base,
                "/api/v1/stream/subscribe",
                {"code": "2330", "quote_type": "Tick"},
            )
            self.assertTrue(response["success"])
            events = client.poll_stream_events(timeout=0)
        self.assertEqual(events[0][0], "tick_stk")

    def test_watchlists_persist_across_bridge_restarts(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KGI_BRIDGE_STATE_DIR": tmp}, clear=False):
                with running_server() as base:
                    created = post_json(
                        base,
                        "/api/v1/watchlist",
                        {
                            "name": "長線",
                            "contracts": [{"code": "2330", "security_type": "STK", "exchange": "TSE"}],
                        },
                    )
                    self.assertEqual(created["name"], "長線")

                with running_server() as base:
                    lists = get_json(base, "/api/v1/watchlist")
                    self.assertEqual(len(lists), 1)
                    self.assertEqual(lists[0]["contracts"][0]["code"], "2330")

    def test_broker_neutral_stream_capabilities_are_registered(self):
        with running_server() as base:
            response = post_json(
                base,
                "/api/v1/stream/subscribe/market_signal",
                {"scanner": "VolumeAmount", "exchange": "TSE"},
            )
            self.assertTrue(response["success"])
            self.assertIn("market_signal", response["message"])

    def test_real_stock_only_server_does_not_advertise_futures_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KGI_BRIDGE_STATE_DIR": tmp}, clear=True):
                with running_server(RealKGIClient()) as base:
                    self.assertEqual(get_json(base, "/api/v1/data/contracts/futures/roots"), [])
                    contracts = get_json(base, "/api/v1/data/contracts?security_type=FUT")
        self.assertEqual(contracts["contracts"], [])
        self.assertEqual(contracts["total"], 0)

    def test_real_scanner_maps_stock_rows(self):
        class FakeData:
            def get(self, table):
                return [
                    {"股票代號": "2330", "股票名稱": "TSMC", "成交價": 100, "參考價": 95, "成交量": 10},
                    {"股票代號": "2454", "股票名稱": "MTK", "成交價": 200, "參考價": 198, "成交量": 20},
                ]

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            rows = client.scanner("ChangePercentRank", 2, True)

        self.assertEqual([row["code"] for row in rows], ["2330", "2454"])
        self.assertGreater(rows[0]["change_rate"], rows[1]["change_rate"])

    def test_real_scanner_maps_positional_kgi_dataframe_rows(self):
        class FakeData:
            def get(self, table):
                return [
                    {
                        "c0": "2330",
                        "c1": "TSMC",
                        "c2": 1,
                        "c3": 100,
                        "c4": 105,
                        "c5": 99,
                        "c6": 104,
                        "c7": 1000,
                        "c8": 4,
                        "c9": 4.0,
                        "c10": 50,
                        "c11": 12.5,
                    }
                ]

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            rows = RealKGIClient().scanner("AmountRank", 1, True)

        self.assertEqual(rows[0]["code"], "2330")
        self.assertEqual(rows[0]["name"], "TSMC")
        self.assertEqual(rows[0]["total_amount"], 12_500_000)

    def test_real_scanner_maps_upstream_permission_error(self):
        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access denied"

        class FakeData:
            def get(self, table):
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {
                    "KGI_PERSON_ID": "P123",
                    "KGI_PERSON_PWD": "fake-password",
                    "KGI_ACCOUNT": "A123",
                },
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            with self.assertRaises(BridgeError) as raised:
                client.scanner("AmountRank", 10, True)

        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(raised.exception.message, "此帳戶無排行資料權限")

    def test_real_scanner_d403_backoff_does_not_retry_denied_tables(self):
        calls = []

        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access denied"

        class FakeData:
            def get(self, table):
                calls.append(table)
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            with self.assertRaises(BridgeError):
                client.scanner("VolumeRank", 10, True)
            first_call_count = len(calls)
            with self.assertRaises(BridgeError):
                client.scanner("VolumeRank", 10, True)

        # "VolumeRank" tries 3 tables; the first call must try all 3 (all
        # confirmed D403), the second call must not retry any of them.
        self.assertEqual(first_call_count, 3)
        self.assertEqual(len(calls), 3)

    def test_real_account_values_preserve_zero_and_available_fields(self):
        class FakeAccount:
            def SettleAmtTrial(self, ftype="S"):
                return {"Detail1": [{"NETAMT": "0", "CURRENCY": "TWD"}], "Detail2": []}

            def SettleAmt(self, ftype="SS"):
                return [{"CDate1": "20260818", "CSRPAMT1": "0", "CDate2": "20260819", "CSRPAMT2": "1250"}]

            def InventorySum(self, ftype="A"):
                return [{"Symbol": "2330", "ASSET_REAL": "3000", "NETPL_TWD": "0"}]

            def RealizePL(self, ftype="M"):
                return [{"Symbol": "2330", "NETPL": "75"}]

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = FakeAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            account = RealKGIClient().account_values()

        self.assertEqual(account["acc_balance"], 0)
        self.assertEqual(account["total_assets"], 3000)
        self.assertEqual(account["realized_pnl"], 75)
        self.assertNotEqual(account["acc_balance"], 1_000_000)
        self.assertNotIn("SettleAmtTrial", account["unavailable_fields"])

    def test_real_account_values_settlement_trial_null_is_not_backfilled_from_t0_t2_sum(self):
        # Regression — verified live against the real account: on a day
        # with nothing to settle, SettleAmtTrial returns a bare None (every
        # FType — S/SS/M/D), not an empty structure. The old code treated
        # that as "no trial data" and silently substituted the SUM of
        # SettleAmt's T+0..T+2 net settlement flows as "acc_balance"
        # instead — which happened to be a real number (often 0) but
        # represented a completely different concept (rolling settlement
        # flow, already shown separately via settlements()/SettleSection),
        # making a genuinely-unqueried "balance" look like a successful $0
        # query. acc_balance must stay null here, not fall back to a
        # different KGI field under the same name.
        class FakeAccount:
            def SettleAmtTrial(self, ftype="S"):
                return None

            def SettleAmt(self, ftype="SS"):
                return [{"CDate1": "20260819", "CSRPAMT1": "0", "CDate2": "20260820", "CSRPAMT2": "0", "CDate3": "20260821", "CSRPAMT3": "0"}]

            def InventorySum(self, ftype="A"):
                return [{"Symbol": "2330", "ASSET_REAL": "1053855", "NETPL_TWD": "109519"}]

            def RealizePL(self, ftype="M"):
                return []

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = FakeAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            account = RealKGIClient().account_values()

        self.assertIsNone(account["acc_balance"])
        self.assertIsNone(account["available_balance"])
        self.assertNotEqual(account["acc_balance"], 0)
        # Total assets still reflects the real, known stock market value —
        # a genuinely-unknown settlement-trial component contributes 0 to
        # the sum rather than making the whole total unavailable.
        self.assertEqual(account["total_assets"], 1053855)
        self.assertIn("SettleAmtTrial", account["unavailable_fields"])

    def test_real_account_values_bank_balance_is_always_null(self):
        # kgisuperpy 2.1.0's Account API has no linked-bank-balance field —
        # verified by calling every method main.py wires onto api.Account.
        # This must never be backfilled from settlement/inventory data.
        class FakeAccount:
            def SettleAmtTrial(self, ftype="S"):
                return {"Detail1": [{"NETAMT": "5000"}], "Detail2": []}

            def SettleAmt(self, ftype="SS"):
                return [{"CDate1": "20260819", "CSRPAMT1": "0"}]

            def InventorySum(self, ftype="A"):
                return [{"Symbol": "2330", "ASSET_REAL": "3000"}]

            def RealizePL(self, ftype="M"):
                return []

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = FakeAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            account = RealKGIClient().account_values()

        self.assertIsNone(account["bank_balance"])
        self.assertEqual(account["acc_balance"], 5000)

    def test_real_settlements_map_three_day_kgi_fields(self):
        class FakeAccount:
            def SettleAmt(self, ftype="SS"):
                return [
                    {
                        "CDate1": "20260818",
                        "CSRPAMT1": "0",
                        "CDate2": "20260819",
                        "CSRPAMT2": "-200",
                        "CDate3": "20260820",
                        "CSRPAMT3": "300",
                    }
                ]

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = FakeAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            rows = RealKGIClient().settlements()

        self.assertEqual([row["T"] for row in rows], [0, 1, 2])
        self.assertEqual([row["amount"] for row in rows], [0, -200, 300])

    def test_real_profit_loss_uses_account_realize_pl(self):
        class FakeAccount:
            def RealizePL(self, ftype="D", start=None, end=None):
                self.args = (ftype, start, end)
                return {
                    "Detail": [
                        {"Symbol": "2330", "QTY": "2", "PRICE": "100", "NETPL": "50", "TradeDate": "20260818"}
                    ]
                }

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = FakeAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            rows = client.profit_loss("2026-08-18", "2026-08-18")
            summary = client.profit_loss_summary("2026-08-18", "2026-08-18")

        self.assertEqual(rows[0]["code"], "2330")
        self.assertEqual(rows[0]["pnl"], 50)
        self.assertEqual(rows[0]["quantity_unit"], "shares")
        self.assertEqual(summary["total"]["pnl"], 50)

    def test_real_profit_loss_historical_range_keeps_rows_across_multiple_days(self):
        # Regression: normalize_profit_loss_rows used to filter every row
        # down to a single exact date (the query's start date), silently
        # dropping every other day of a real multi-day historical query.
        # RealizePL(FType='D', StartDate, EndDate) is already scoped
        # server-side to [StartDate, EndDate] (verified against the
        # installed kgisuperpy 2.1.0 SDK) — the bridge's own filter must
        # keep the whole range, not just the first day.
        class FakeAccount:
            def RealizePL(self, ftype="D", start=None, end=None):
                return {
                    "Detail": [
                        {
                            "Symbol": "2330",
                            "SymbolName": "台積電",
                            "QTY": "1000",
                            "PRICE": "100",
                            "COST": "95",
                            "FEE": "10",
                            "TAX": "3",
                            "NETPL": "50",
                            "PNLRATE": "5.2",
                            "BS": "S",
                            "TradeDate": "20260801",
                        },
                        {
                            "Symbol": "2454",
                            "SymbolName": "聯發科",
                            "QTY": "300",
                            "PRICE": "200",
                            "COST": "190",
                            "FEE": "8",
                            "TAX": "2",
                            "NETPL": "-40",
                            "PNLRATE": "-1.1",
                            "BS": "B",
                            "TradeDate": "20260818",
                        },
                    ]
                }

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = FakeAccount()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            rows = RealKGIClient().profit_loss("2026-08-01", "2026-08-18")

        self.assertEqual({row["code"] for row in rows}, {"2330", "2454"})
        self.assertEqual({row["date"] for row in rows}, {"2026-08-01", "2026-08-18"})
        sell_row = next(row for row in rows if row["code"] == "2330")
        buy_row = next(row for row in rows if row["code"] == "2454")
        self.assertEqual(sell_row["direction"], "Sell")
        self.assertEqual(buy_row["direction"], "Buy")

    def test_normalize_profit_loss_rows_drops_rows_outside_requested_range(self):
        raw = {
            "Detail": [
                {"Symbol": "2330", "NETPL": "50", "TradeDate": "20260701"},
                {"Symbol": "2454", "NETPL": "-40", "TradeDate": "20260818"},
            ]
        }
        rows = normalize_profit_loss_rows(raw, "2026-08-01", "2026-08-18")
        self.assertEqual([row["code"] for row in rows], ["2454"])

    def test_normalize_profit_loss_rows_empty_raw_returns_real_empty_state(self):
        # A genuinely empty RealizePL DataFrame (pandas built as
        # pd.DataFrame(columns=col) when no rows match) must normalize to a
        # real empty list, never stale/cached rows from a previous query.
        self.assertEqual(normalize_profit_loss_rows([], "2026-08-01", "2026-08-18"), [])
        self.assertEqual(normalize_profit_loss_rows({}, "2026-08-01", "2026-08-18"), [])
        self.assertEqual(normalize_profit_loss_rows(None, "2026-08-01", "2026-08-18"), [])

    def test_normalize_profit_loss_rows_keeps_distinct_termseqno_rows_same_day(self):
        # Two genuinely separate closing trades on the same symbol/day (each
        # with its own TERMSEQNO) must both survive — this is NOT the same
        # case as a broker-side duplicate record.
        raw = {
            "Detail": [
                {"Symbol": "2330", "NETPL": "50", "TradeDate": "20260818", "TERMSEQNO": "1"},
                {"Symbol": "2330", "NETPL": "-20", "TradeDate": "20260818", "TERMSEQNO": "2"},
            ]
        }
        rows = normalize_profit_loss_rows(raw, "2026-08-18", "2026-08-18")
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["id"] for row in rows}.__len__(), 2)
        self.assertEqual({row["pnl"] for row in rows}, {50, -20})

    def test_number_sanitizes_nan_and_infinity_to_default(self):
        # Regression — verified live: KGI's 台股商品檔 table carries NaN
        # limit-up/down for products that trade without a price limit
        # (e.g. actively managed ETFs like 00402A). float(nan) does not
        # raise, so the old number()/optional_number() let a literal NaN
        # float through. json.dumps() then emits the non-standard `NaN`
        # token, and the browser's JSON.parse() throws on the ENTIRE
        # response — one bad row broke stock-name/category resolution for
        # every symbol in the ~2700-row bulk contracts catalog.
        self.assertEqual(number(float("nan")), 0)
        self.assertEqual(number(float("nan"), default=5), 5)
        self.assertEqual(number(float("inf")), 0)
        self.assertEqual(number(float("-inf")), 0)
        self.assertEqual(number(12.5), 12.5)
        self.assertIsNone(optional_number(float("nan")))
        self.assertIsNone(optional_number(float("inf")))
        self.assertEqual(optional_number(12.5), 12.5)

    def test_normalize_contract_sanitizes_nan_limit_prices_to_json_safe_output(self):
        contract = normalize_contract(
            "00402A",
            {
                "name": "主動安聯美國科技",
                "market": "tse",
                "bull_limit": float("nan"),
                "bear_limit": float("nan"),
                "ref_price": 9.87,
            },
        )
        self.assertEqual(contract["limit_up"], 0)
        self.assertEqual(contract["limit_down"], 0)
        # The real bug wasn't caught by equality checks on a NaN value
        # (NaN != NaN) — it was that json.dumps(..., allow_nan=False)
        # raises on a literal NaN. Proving the whole row round-trips
        # through strict JSON is the actual regression guard.
        json.dumps(contract, allow_nan=False)

    def test_real_positions_use_inventory_sum_share_units(self):
        class FakeAccount:
            def InventorySum(self, ftype="A"):
                self.ftype = ftype
                return [
                    {
                        "Symbol": "2367",
                        "SymbolName": "燿華",
                        "RLPRICE": "20",
                        "NETQTY9": "300",
                        "R_QTY9": "300",
                        "AVG_PRICE0": "18",
                        "NETPL": "60",
                    }
                ]

        fake_account = FakeAccount()

        class FakeAPI(FakeKGIStockLogin):
            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = fake_account

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            rows = RealKGIClient().positions()

        self.assertEqual(fake_account.ftype, "B")
        self.assertEqual(rows[0]["code"], "2367")
        self.assertEqual(rows[0]["quantity"], 300)
        self.assertEqual(rows[0]["position_type"], "cash")
        self.assertEqual(rows[0]["odd_lot_quantity"], 300)

    def test_real_kbars_one_day_uses_daily_history_table(self):
        calls = []

        class FakeData:
            def get(self, table, *args):
                calls.append((table, args))
                return [
                    {"日期": "2026-08-15", "開盤價": 10, "最高價": 11, "最低價": 9, "收盤價": 10.5, "成交量": 100},
                    {"日期": "2026-08-18", "開盤價": 12, "最高價": 13, "最低價": 11, "收盤價": 12.5, "成交量": 200},
                ]

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            kbars = RealKGIClient().kbars("2330", "2026-08-18", "2026-08-18", 1440)

        self.assertEqual(kbars["datetime"], ["2026-08-18"])
        self.assertEqual(kbars["Close"], [12.5])
        self.assertEqual(calls[0][1], ("2330",))

    def test_real_kbars_intraday_d403_returns_capability_state(self):
        class UpstreamCode:
            value = "D403"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Access to the specified request is denied"

        class FakeData:
            def get(self, table, *args):
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            kbars = RealKGIClient().kbars("2330", "2026-08-18", "2026-08-18", 1)

        self.assertEqual(kbars["datetime"], [])
        self.assertEqual(kbars["capability"]["historical"], "denied")
        self.assertEqual(kbars["capability"]["upstream_code"], "D403")

    def test_real_index_contract_snapshot_and_subscription_do_not_require_futures(self):
        calls = []

        class FakeData:
            def get(self, table, symbol, minute):
                calls.append(("data", table, symbol, minute))
                return [{"日期": "20260818133000", "收盤價": 24000, "開盤價": 23900, "最高價": 24050, "最低價": 23880, "昨收": 23800}]

        class FakeQuote(FakeKGIQuote):
            def set_cb_index(self, callback):
                calls.append(("set_cb_index",))
                self.index_callback = callback

            def subscribe_index(self, symbol):
                calls.append(("subscribe_index", symbol))

        class FakeAPI(FakeKGIStockLogin):
            Quote = FakeQuote()
            Data = FakeData()

            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            contract = client.contract("IX0001", "IND")
            snapshot = client.snapshots(["IX0001"])[0]
            subscription = client.subscribe_quote("IX0001", "Quote")

        self.assertEqual(contract["security_type"], "IND")
        self.assertEqual(snapshot["code"], "IX0001")
        self.assertEqual(snapshot["close"], 24000)
        self.assertEqual(subscription["subscription"]["code"], "IX0001")
        self.assertIn(("data", "取得歷史分K(含加權/櫃買指數)", "Y9999", 1), calls)
        self.assertIn(("subscribe_index", "001"), calls)

    def test_unregistered_sector_index_code_is_routed_as_index_not_stock(self):
        # Regression — verified live: the frontend's sector-heatmap overview
        # sends 25 TWSE sub-index codes (IX0028..IX0041 etc, src/lib/
        # stock-index.ts SECTOR_INDICES) that are shaped like IX0001 but
        # have no verified KGI native code in INDEX_SYMBOLS. Before this
        # fix, is_index_symbol() only recognized IX0001, so these codes fell
        # through to api.Data.get_snapshots(stock_symbols) — which raises a
        # raw KeyError('bullBearRefPx') for index codes (indices don't carry
        # that field) and crashed the ENTIRE batch with an unhandled 500,
        # even for the real stock codes requested in the same call.
        from backend.kgi_bridge.clients import is_index_symbol

        self.assertTrue(is_index_symbol("IX0028"))
        self.assertTrue(is_index_symbol("IX0001"))
        self.assertFalse(is_index_symbol("2330"))

        class FakeData:
            def get(self, table, *args):
                raise KeyError("bullBearRefPx")

            def get_snapshots(self, symbols):
                raise AssertionError(
                    f"index codes must not reach get_snapshots(); got {symbols}"
                )

        class FakeAPI(FakeKGIStockLogin):
            Data = FakeData()

            def set_Account(self, account):
                if account == "A123":
                    self.Order = FakeKGIOrder()
                    self.Account = object()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            # A batch of unregistered index codes alone must not raise —
            # each one degrades independently to a real zero/unavailable
            # snapshot rather than taking down the whole request.
            rows = client.snapshots(["IX0028", "IX0029"])

        self.assertEqual([row["code"] for row in rows], ["IX0028", "IX0029"])
        self.assertEqual(rows[0]["close"], 0)

    def test_real_quote_subscription_caches_q010_permission_error(self):
        calls = []

        class UpstreamCode:
            value = "Q010"

        class UpstreamError(Exception):
            code = UpstreamCode()
            message = "Subscription 2330 rejected due to previous permission errors."

        class RecordingQuote(FakeKGIQuote):
            def subscribe_tick(self, symbol, odd_lot=False):
                calls.append((symbol, odd_lot))
                raise UpstreamError()

        class FakeAPI(FakeKGIStockLogin):
            Quote = RecordingQuote()

        with (
            mock.patch.dict(
                os.environ,
                {"KGI_PERSON_ID": "P123", "KGI_PERSON_PWD": "fake-password", "KGI_ACCOUNT": "A123"},
                clear=True,
            ),
            mock.patch("backend.kgi_bridge.clients.kgisuperpy_login_constructor", return_value=FakeAPI),
        ):
            client = RealKGIClient()
            first = client.subscribe_quote("2330", "Tick")
            second = client.subscribe_quote("2330", "Tick")

        self.assertFalse(first["success"])
        self.assertFalse(second["success"])
        self.assertEqual(first["capability"]["upstream_code"], "Q010")
        self.assertEqual(calls, [("2330", False)])


if __name__ == "__main__":
    unittest.main()
