import json
import io
import sys
import threading
import unittest
from contextlib import contextmanager
from urllib.request import Request, urlopen

from backend.kgi_bridge.agent_tools import list_agent_tools
from backend.kgi_bridge.clients import MockKGIClient
from backend.kgi_bridge import mcp_server
from backend.kgi_bridge.scanner import calculate_indicators_from_bars, run_scanner
from backend.kgi_bridge.server import KGIHTTPServer


class FakeConversation:
    id = "conversation-test"
    thread_id = "thread-test"


class FakeCodexBridge:
    def shutdown(self):
        pass

    def status(self):
        return {
            "connected": True,
            "authenticated": True,
            "model": "gpt-test",
            "models": [{"id": "gpt-test"}],
            "account": {"authenticated": True},
            "error": None,
        }

    def create_conversation(self):
        return FakeConversation()

    def collect_chat(self, payload):
        return {
            "id": "turn-test",
            "conversation_id": "conversation-test",
            "thread_id": "thread-test",
            "role": "assistant",
            "content": "Codex 已成功連線",
            "tool_calls": [],
            "policy": {
                "market_data_source": "unavailable_in_phase_1",
                "tool_access_exposed": False,
                "order_execution_exposed": False,
            },
        }

    def stream_chat(self, message, context=None, conversation_id=None, thread_id=None, new_conversation=False):
        yield {"type": "conversation", "conversation_id": "conversation-test", "thread_id": "thread-test", "model": "gpt-test"}
        yield {"type": "assistant_delta", "delta": "Codex "}
        yield {"type": "assistant_delta", "delta": "已成功連線"}
        yield {
            "type": "turn_completed",
            "conversation_id": "conversation-test",
            "thread_id": "thread-test",
            "turn_id": "turn-test",
            "content": "Codex 已成功連線",
            "tool_calls": [],
        }


@contextmanager
def running_server(client=None, codex_bridge=None):
    server = KGIHTTPServer(("127.0.0.1", 0), client or MockKGIClient(), codex_bridge=codex_bridge or FakeCodexBridge())
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


class ScannerTests(unittest.TestCase):
    def test_calculates_required_indicators_from_mock_daily_bars(self):
        client = MockKGIClient()
        indicators = calculate_indicators_from_bars(client.daily_bars("2330", 90))

        self.assertIn("ma5", indicators)
        self.assertIn("ma20", indicators)
        self.assertIn("ma60", indicators)
        self.assertIn("rsi14", indicators)
        self.assertIn("volume_average_20", indicators)
        self.assertIn("volume_ratio", indicators)
        self.assertIn("daily_return", indicators)
        self.assertIn("volatility", indicators)
        self.assertGreater(indicators["ma60"], 0)

    def test_scanner_returns_filtered_ranked_candidates(self):
        result = run_scanner(
            MockKGIClient(),
            {
                "limit": 5,
                "rsi_max": 90,
                "volume_ratio_min": 1.0,
                "min_liquidity": 1_000_000,
            },
        )

        self.assertEqual(result["disclaimer"], "篩選候選，不是投資建議")
        self.assertGreaterEqual(result["candidate_count"], 1)
        first = result["candidates"][0]
        self.assertTrue(first["passed"])
        self.assertIn("score", first)
        self.assertIn("explanation", first)


class AgentToolTests(unittest.TestCase):
    def test_agent_tool_manifest_is_read_only(self):
        manifest = list_agent_tools()
        names = {tool["name"] for tool in manifest["tools"]}

        self.assertIn("get_quote", names)
        self.assertIn("scan_market", names)
        self.assertIn("calculate_indicators", names)
        self.assertNotIn("place_order", names)
        self.assertTrue(all(tool["read_only"] for tool in manifest["tools"]))
        self.assertFalse(manifest["trade_proposal_pipeline"]["enabled"])

    def test_codex_http_status_and_chat_routes(self):
        with running_server() as base:
            status = get_json(base, "/api/v1/codex/status")
            self.assertTrue(status["connected"])
            self.assertEqual(status["model"], "gpt-test")

            conversation = post_json(base, "/api/v1/codex/conversations", {})
            self.assertEqual(conversation["thread_id"], "thread-test")

            chat = post_json(
                base,
                "/api/v1/codex/chat",
                {"message": "請只回答：Codex 已成功連線"},
            )
            self.assertEqual(chat["policy"]["market_data_source"], "unavailable_in_phase_1")
            self.assertFalse(chat["policy"]["tool_access_exposed"])
            self.assertFalse(chat["policy"]["order_execution_exposed"])
            self.assertEqual(chat["tool_calls"], [])
            self.assertIn("Codex", chat["content"])

    def test_codex_chat_streams_sse_events(self):
        with running_server() as base:
            request = Request(
                f"{base}/api/v1/codex/chat",
                data=json.dumps({"message": "請只回答：Codex 已成功連線", "stream": True}).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
                method="POST",
            )
            with urlopen(request, timeout=5) as response:
                body = response.read().decode("utf-8")
            self.assertIn("event: assistant_delta", body)
            self.assertIn("event: turn_completed", body)

    def test_mcp_server_invokes_existing_agent_tool_endpoint(self):
        with running_server() as base:
            old_base = mcp_server.BASE_URL
            try:
                mcp_server.BASE_URL = base
                tools = mcp_server._list_tools()
                self.assertIn("get_quote", {tool["name"] for tool in tools})

                result = mcp_server._call_tool("get_quote", {"symbol": "2330"})
                payload = json.loads(result["content"][0]["text"])
                self.assertEqual(payload["tool"], "get_quote")
                self.assertEqual(payload["result"]["code"], "2330")
            finally:
                mcp_server.BASE_URL = old_base

    def test_mcp_server_writes_utf8_json_rpc(self):
        class FakeStdout:
            def __init__(self):
                self.buffer = io.BytesIO()

        old_stdout = sys.stdout
        fake_stdout = FakeStdout()
        try:
            sys.stdout = fake_stdout  # type: ignore[assignment]
            mcp_server._write({"jsonrpc": "2.0", "id": 1, "result": {"name": "台積電"}})
        finally:
            sys.stdout = old_stdout

        decoded = fake_stdout.buffer.getvalue().decode("utf-8")
        self.assertEqual(json.loads(decoded)["result"]["name"], "台積電")


if __name__ == "__main__":
    unittest.main()
