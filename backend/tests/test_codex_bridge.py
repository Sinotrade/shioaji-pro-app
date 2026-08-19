from __future__ import annotations

import os
import unittest
from pathlib import Path
from typing import Any

from backend.kgi_bridge.codex_bridge import (
    CodexAuthenticationError,
    CodexBridge,
    DEFAULT_CODEX_COMMAND,
)


class FakeRpc:
    def __init__(
        self,
        account: dict[str, Any] | None = None,
        turn_events: list[dict[str, Any]] | None = None,
        models: list[dict[str, Any]] | None = None,
    ):
        self.account = account
        self.turn_events = turn_events or []
        self.models = models or [{"id": "gpt-test", "name": "gpt-test"}]
        self.requests: list[tuple[str, dict[str, Any] | None]] = []
        self.notifications: list[str] = []
        self.running = True
        self.thread_count = 0
        self.turn_count = 0
        self.closed = False
        self.fail_turn_start = False

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.requests.append((method, params))
        if method == "initialize":
            return {"codexHome": str(Path.home() / ".codex"), "userAgent": "fake", "platformOs": "windows", "platformFamily": "windows"}
        if method == "account/read":
            return {"requiresOpenaiAuth": True, "account": self.account}
        if method == "model/list":
            return {"data": self.models}
        if method == "thread/start":
            self.thread_count += 1
            return {"thread": {"id": f"thread-{self.thread_count}"}, "model": "gpt-test"}
        if method == "thread/resume":
            return {"thread": {"id": params["threadId"] if params else "thread-1"}}
        if method == "turn/start":
            if self.fail_turn_start:
                raise RuntimeError("turn/start failed: thread unavailable")
            self.turn_count += 1
            turn_id = f"turn-{self.turn_count}"
            thread_id = params["threadId"] if params else "thread-1"
            if not self.turn_events:
                self.turn_events.extend(
                    [
                        {"method": "item/agentMessage/delta", "params": {"threadId": thread_id, "turnId": turn_id, "itemId": "msg-1", "delta": "hello "}},
                        {"method": "item/agentMessage/delta", "params": {"threadId": thread_id, "turnId": turn_id, "itemId": "msg-1", "delta": "world"}},
                        {"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}}},
                    ]
                )
            return {"turn": {"id": turn_id, "items": [], "status": "running"}}
        raise AssertionError(f"unexpected method {method}")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.notifications.append(method)

    def next_event(self, timeout: float) -> dict[str, Any] | None:
        if self.turn_events:
            return self.turn_events.pop(0)
        return None

    def respond_error(self, request_id: Any, message: str) -> None:
        self.requests.append(("respond_error", {"id": request_id, "message": message}))

    def is_running(self) -> bool:
        return self.running

    def close(self) -> None:
        self.closed = True
        self.running = False


class FakeFactory:
    def __init__(self, *connections: FakeRpc):
        self.connections = list(connections)
        self.commands: list[list[str]] = []

    def __call__(self, command: list[str], cwd: Path, env: dict[str, str]) -> FakeRpc:
        self.commands.append(command)
        if not self.connections:
            raise AssertionError("no fake rpc connection left")
        return self.connections.pop(0)


def bridge_for(fake: FakeRpc, factory: FakeFactory | None = None) -> CodexBridge:
    return CodexBridge(
        workspace=Path.cwd(),
        tool_base_url="http://127.0.0.1:21323",
        codex_command=DEFAULT_CODEX_COMMAND,
        rpc_factory=factory or FakeFactory(fake),
        request_timeout=1,
    )


class CodexBridgeTests(unittest.TestCase):
    def test_initializes_account_and_models(self):
        fake = FakeRpc(account={"email": "user@example.com"})
        bridge = bridge_for(fake)

        status = bridge.status()

        self.assertTrue(status["connected"])
        self.assertTrue(status["authenticated"])
        self.assertEqual(status["model"], "gpt-test")
        self.assertIn("initialized", fake.notifications)

    def test_uses_validated_codex_cli_path(self):
        fake = FakeRpc(account={"email": "user@example.com"})
        factory = FakeFactory(fake)
        bridge = bridge_for(fake, factory)

        bridge.status()

        self.assertEqual(
            factory.commands[0],
            [DEFAULT_CODEX_COMMAND, "app-server", "--listen", "stdio://"],
        )

    def test_uses_configured_model_when_listed(self):
        old_model = os.environ.get("CODEX_MODEL")
        os.environ["CODEX_MODEL"] = "gpt-fast"
        try:
            fake = FakeRpc(
                account={"email": "user@example.com"},
                models=[{"id": "gpt-test", "name": "gpt-test"}, {"id": "gpt-fast", "name": "gpt-fast"}],
            )
            bridge = bridge_for(fake)

            self.assertEqual(bridge.status()["model"], "gpt-fast")
        finally:
            if old_model is None:
                os.environ.pop("CODEX_MODEL", None)
            else:
                os.environ["CODEX_MODEL"] = old_model

    def test_creates_thread_and_streams_deltas(self):
        fake = FakeRpc(account={"email": "user@example.com"})
        bridge = bridge_for(fake)

        events = list(bridge.stream_chat("hello"))

        self.assertEqual([event["type"] for event in events if event["type"] == "assistant_delta"], ["assistant_delta", "assistant_delta"])
        completed = events[-1]
        self.assertEqual(completed["type"], "turn_completed")
        self.assertEqual(completed["content"], "hello world")

    def test_create_conversation_returns_thread_id(self):
        fake = FakeRpc(account={"email": "user@example.com"})
        bridge = bridge_for(fake)

        conversation = bridge.create_conversation()

        self.assertEqual(conversation.thread_id, "thread-1")

    def test_multi_turn_reuses_conversation_thread(self):
        fake = FakeRpc(account={"email": "user@example.com"})
        bridge = bridge_for(fake)

        first = list(bridge.stream_chat("first"))[-1]
        second = list(bridge.stream_chat("second", conversation_id=first["conversation_id"]))[-1]

        self.assertEqual(first["conversation_id"], second["conversation_id"])
        self.assertEqual(first["thread_id"], second["thread_id"])
        thread_starts = [method for method, _ in fake.requests if method == "thread/start"]
        self.assertEqual(len(thread_starts), 1)

    def test_streams_error_events_from_app_server(self):
        fake = FakeRpc(
            account={"email": "user@example.com"},
            turn_events=[
                {"method": "error", "params": {"message": "app-server test error"}},
                {
                    "method": "turn/completed",
                    "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}},
                },
            ],
        )
        bridge = bridge_for(fake)

        events = list(bridge.stream_chat("查 2330"))
        errors = [event for event in events if event["type"] == "error"]

        self.assertEqual(errors[0]["message"], "app-server test error")

    def test_restarts_when_process_exits(self):
        first = FakeRpc(account={"email": "user@example.com"})
        second = FakeRpc(account={"email": "user@example.com"})
        factory = FakeFactory(first, second)
        bridge = bridge_for(first, factory)

        self.assertTrue(bridge.status()["connected"])
        first.running = False
        self.assertTrue(bridge.status()["connected"])

        self.assertEqual(len(factory.commands), 2)
        self.assertTrue(first.closed)

    def test_missing_authentication_blocks_chat(self):
        fake = FakeRpc(account=None)
        bridge = bridge_for(fake)

        with self.assertRaises(CodexAuthenticationError):
            list(bridge.stream_chat("hello"))

    def test_process_exit_followed_by_old_thread_id_starts_new_conversation(self):
        first = FakeRpc(account={"email": "user@example.com"})
        second = FakeRpc(account={"email": "user@example.com"})
        second.thread_count = 1
        factory = FakeFactory(first, second)
        bridge = bridge_for(first, factory)

        first_result = list(bridge.stream_chat("first"))[-1]
        first.running = False

        second_result = list(
            bridge.stream_chat(
                "second",
                conversation_id=first_result["conversation_id"],
                thread_id=first_result["thread_id"],
            )
        )[-1]

        self.assertNotEqual(first_result["conversation_id"], second_result["conversation_id"])
        self.assertNotEqual(first_result["thread_id"], second_result["thread_id"])


if __name__ == "__main__":
    unittest.main()
