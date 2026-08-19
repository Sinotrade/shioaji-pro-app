from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from .errors import BridgeError


DEFAULT_CODEX_COMMAND = r"C:\Users\yongy\AppData\Roaming\npm\codex.cmd"

CODEX_CHAT_INSTRUCTIONS = """
You are Codex inside the KGI Pro trading terminal.

Rules:
- Respond directly to the user's message.
- This phase is chat-only. No KGI tools or market/account tools are available.
- Do not claim to have market data, account data, positions, orders, or scanner output.
- Do not request or reveal credentials, tokens, environment variables, or secrets.
- Do not execute trades or provide order-routing actions.
- If the user asks for unavailable live data, say it is not available in this phase.
""".strip()


class RpcConnection(Protocol):
    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]: ...
    def notify(self, method: str, params: dict[str, Any] | None = None) -> None: ...
    def next_event(self, timeout: float) -> dict[str, Any] | None: ...
    def respond_error(self, request_id: Any, message: str) -> None: ...
    def is_running(self) -> bool: ...
    def close(self) -> None: ...


class JsonRpcProcess:
    def __init__(
        self,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
        timeout: float = 120,
    ) -> None:
        self.command = command
        self.timeout = timeout
        self.proc = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
        self._next_id = 1
        self._write_lock = threading.Lock()
        self._messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stderr: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._messages.put(json.loads(line))
            except json.JSONDecodeError:
                self._messages.put({"method": "codex/non_json_stdout", "params": {"line": line}})

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            line = line.rstrip()
            if line:
                self._stderr.put(line)

    def _send(self, message: dict[str, Any]) -> None:
        if not self.is_running():
            raise CodexProcessError("Codex app-server is not running")
        assert self.proc.stdin is not None
        with self._write_lock:
            self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)
        deadline = time.time() + self.timeout
        pending: list[dict[str, Any]] = []
        while time.time() < deadline:
            event = self.next_event(max(0.01, deadline - time.time()))
            if event is None:
                continue
            if event.get("id") == request_id and "method" not in event:
                for item in pending:
                    self._messages.put(item)
                if "error" in event:
                    raise CodexProtocolError(f"{method} failed: {event['error']}")
                return event.get("result") or {}
            pending.append(event)
        for item in pending:
            self._messages.put(item)
        raise TimeoutError(f"Timed out waiting for {method}")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def next_event(self, timeout: float) -> dict[str, Any] | None:
        try:
            return self._messages.get(timeout=timeout)
        except queue.Empty:
            if not self.is_running():
                stderr = self._drain_stderr()
                raise CodexProcessError(f"Codex app-server exited with {self.proc.returncode}: {stderr}")
            return None

    def respond_error(self, request_id: Any, message: str) -> None:
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32000, "message": message},
            }
        )

    def is_running(self) -> bool:
        return self.proc.poll() is None

    def _drain_stderr(self) -> str:
        lines: list[str] = []
        while True:
            try:
                lines.append(self._stderr.get_nowait())
            except queue.Empty:
                break
        return "\n".join(_redact(line) for line in lines)

    def close(self) -> None:
        if self.is_running():
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()


class CodexBridgeError(RuntimeError):
    pass


class CodexProcessError(CodexBridgeError):
    pass


class CodexProtocolError(CodexBridgeError):
    pass


class CodexAuthenticationError(CodexBridgeError):
    pass


@dataclass
class Conversation:
    id: str
    thread_id: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


def _redact(value: str) -> str:
    lowered = value.lower()
    if "token" in lowered or "secret" in lowered or "password" in lowered:
        return "[redacted]"
    return value


def _resolve_codex_command() -> str:
    explicit = os.environ.get("CODEX_CLI")
    if explicit:
        return explicit
    if Path(DEFAULT_CODEX_COMMAND).exists():
        return DEFAULT_CODEX_COMMAND
    return shutil.which("codex.cmd") or shutil.which("codex") or DEFAULT_CODEX_COMMAND


def _safe_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    allowed = {
        "APPDATA",
        "COMSPEC",
        "HOME",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env["NO_COLOR"] = "1"
    if extra:
        env.update(extra)
    return env


class CodexBridge:
    def __init__(
        self,
        workspace: Path,
        tool_base_url: str,
        codex_command: str | None = None,
        rpc_factory: Callable[[list[str], Path, dict[str, str]], RpcConnection] | None = None,
        request_timeout: float = 240,
    ) -> None:
        self.workspace = workspace.resolve()
        self.tool_base_url = tool_base_url.rstrip("/")
        self.codex_command = codex_command or _resolve_codex_command()
        self.request_timeout = request_timeout
        self._preferred_model = os.environ.get("CODEX_MODEL") or None
        self.rpc_factory = rpc_factory or (
            lambda command, cwd, env: JsonRpcProcess(command, cwd, env, timeout=request_timeout)
        )
        self._rpc: RpcConnection | None = None
        self._lock = threading.RLock()
        self._turn_lock = threading.Lock()
        self._conversations: dict[str, Conversation] = {}
        self._account: dict[str, Any] | None = None
        self._models: list[dict[str, Any]] = []
        self._selected_model: str | None = None
        self._last_error: str | None = None
        self._started_at: float | None = None

    def _command(self) -> list[str]:
        return [self.codex_command, "app-server", "--listen", "stdio://"]

    def ensure_started(self) -> None:
        with self._lock:
            if self._rpc is not None and self._rpc.is_running():
                return
            if self._rpc is not None:
                self._rpc.close()
            if self._started_at is not None:
                self._conversations.clear()
            self._rpc = self.rpc_factory(self._command(), self.workspace, _safe_env())
            self._initialize_locked()

    def _initialize_locked(self) -> None:
        assert self._rpc is not None
        init = self._rpc.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "kgi-pro-terminal",
                    "title": "KGI Pro Terminal",
                    "version": "0.1.0",
                },
                "capabilities": {"experimentalApi": False},
            },
        )
        self._rpc.notify("initialized")
        account = self._rpc.request("account/read", {"refreshToken": False})
        account_obj = account.get("account") if isinstance(account.get("account"), dict) else None
        self._account = _public_account(account_obj) if account_obj else None
        models = self._rpc.request("model/list", {"limit": 20})
        data = models.get("data") if isinstance(models.get("data"), list) else []
        self._models = [_public_model(row) for row in data if isinstance(row, dict)]
        self._selected_model = _select_model_id(self._models, self._preferred_model)
        self._started_at = time.time()
        self._last_error = None
        if not init.get("codexHome"):
            self._last_error = "Codex app-server initialized without codexHome"
        if self._preferred_model and self._selected_model != self._preferred_model:
            self._last_error = f"Configured CODEX_MODEL was not listed by app-server: {self._preferred_model}"

    def shutdown(self) -> None:
        with self._lock:
            if self._rpc is not None:
                self._rpc.close()
            self._rpc = None

    def status(self) -> dict[str, Any]:
        try:
            self.ensure_started()
        except Exception as exc:
            self._last_error = str(exc)
            return {
                "connected": False,
                "authenticated": False,
                "model": None,
                "models": [],
                "account": None,
                "error": str(exc),
            }
        return {
            "connected": self._rpc is not None and self._rpc.is_running(),
            "authenticated": self._account is not None,
            "model": self._selected_model,
            "models": self._models,
            "account": self._account,
            "started_at": self._started_at,
            "error": self._last_error,
        }

    def create_conversation(self) -> Conversation:
        self.ensure_started()
        if self._account is None:
            raise CodexAuthenticationError("ChatGPT authentication was not detected")
        result = self._request_thread_start()
        thread_id = result["thread"]["id"]
        conversation = Conversation(id=str(uuid.uuid4()), thread_id=thread_id)
        self._conversations[conversation.id] = conversation
        return conversation

    def stream_chat(
        self,
        message: str,
        context: dict[str, Any] | None = None,
        conversation_id: str | None = None,
        thread_id: str | None = None,
        new_conversation: bool = False,
    ) -> Iterator[dict[str, Any]]:
        text = message.strip()
        if not text:
            raise BridgeError(400, "message is required")
        with self._turn_lock:
            self.ensure_started()
            if self._account is None:
                raise CodexAuthenticationError("ChatGPT authentication was not detected")
            conversation = self._resolve_conversation(conversation_id, thread_id, new_conversation)
            yield {
                "type": "conversation",
                "conversation_id": conversation.id,
                "thread_id": conversation.thread_id,
                "model": self._selected_model,
            }

            turn_result = self._request_turn_start(conversation.thread_id, text, context or {})
            turn_id = turn_result["turn"]["id"]
            yield {"type": "turn_started", "conversation_id": conversation.id, "thread_id": conversation.thread_id, "turn_id": turn_id}

            content_parts: list[str] = []
            tool_calls: dict[str, dict[str, Any]] = {}
            deadline = time.time() + self.request_timeout
            while time.time() < deadline:
                assert self._rpc is not None
                event = self._rpc.next_event(timeout=max(0.01, deadline - time.time()))
                if event is None:
                    continue
                if "id" in event and event.get("method"):
                    self._rpc.respond_error(event["id"], "KGI Agent bridge does not service Codex app-server callbacks")
                    yield {
                        "type": "error",
                        "message": f"Unsupported Codex callback: {event.get('method')}",
                    }
                    continue
                method = event.get("method")
                params = event.get("params") if isinstance(event.get("params"), dict) else {}
                if params.get("turnId") and params.get("turnId") != turn_id:
                    continue
                if method == "item/agentMessage/delta":
                    delta = str(params.get("delta") or "")
                    if delta:
                        content_parts.append(delta)
                        yield {"type": "assistant_delta", "delta": delta}
                elif method == "item/mcpToolCall/progress":
                    item_id = str(params.get("itemId") or "")
                    call = tool_calls.setdefault(item_id, {"id": item_id, "name": "kgi", "status": "running"})
                    call["message"] = params.get("message")
                    yield {"type": "tool_call", **call}
                elif method in {"item/started", "item/completed"}:
                    call = _tool_call_from_item(params.get("item"))
                    if call:
                        if method == "item/started":
                            call["status"] = "running"
                        tool_calls[call["id"]] = {**tool_calls.get(call["id"], {}), **call}
                        yield {"type": "tool_call", **tool_calls[call["id"]]}
                elif method == "turn/completed":
                    turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
                    if turn.get("id") != turn_id:
                        continue
                    conversation.updated_at = time.time()
                    final_calls = list(tool_calls.values())
                    yield {
                        "type": "turn_completed",
                        "conversation_id": conversation.id,
                        "thread_id": conversation.thread_id,
                        "turn_id": turn_id,
                        "content": "".join(content_parts),
                        "tool_calls": final_calls,
                    }
                    return
                elif method == "error":
                    yield {"type": "error", "message": _error_message(params)}
                elif method in {"warning", "configWarning", "deprecationNotice"}:
                    yield {"type": "warning", "message": _error_message(params)}
            raise TimeoutError("Timed out waiting for Codex turn completion")

    def collect_chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        events = list(
            self.stream_chat(
                str(payload.get("message") or ""),
                payload.get("context") if isinstance(payload.get("context"), dict) else {},
                payload.get("conversation_id") or payload.get("conversationId"),
                payload.get("thread_id") or payload.get("threadId"),
                bool(payload.get("new_conversation") or payload.get("newConversation")),
            )
        )
        completed = next((event for event in reversed(events) if event.get("type") == "turn_completed"), None)
        if not completed:
            raise CodexProtocolError("Codex turn did not complete")
        return {
            "id": completed["turn_id"],
            "conversation_id": completed["conversation_id"],
            "thread_id": completed["thread_id"],
            "role": "assistant",
            "content": completed.get("content") or "",
            "tool_calls": completed.get("tool_calls") or [],
            "policy": {
                "market_data_source": "unavailable_in_phase_1",
                "tool_access_exposed": False,
                "order_execution_exposed": False,
            },
        }

    def _resolve_conversation(
        self,
        conversation_id: str | None,
        thread_id: str | None,
        new_conversation: bool,
    ) -> Conversation:
        if new_conversation:
            return self.create_conversation()
        if conversation_id:
            existing = self._conversations.get(conversation_id)
            if existing is not None:
                return existing
        if thread_id:
            for conversation in self._conversations.values():
                if conversation.thread_id == thread_id:
                    return conversation
        return self.create_conversation()

    def _request_thread_start(self) -> dict[str, Any]:
        assert self._rpc is not None
        params: dict[str, Any] = {
            "cwd": str(self.workspace),
            "approvalPolicy": "never",
            "sandbox": "read-only",
            "ephemeral": False,
            "developerInstructions": CODEX_CHAT_INSTRUCTIONS,
        }
        if self._selected_model:
            params["model"] = self._selected_model
        return self._rpc.request("thread/start", params)

    def _request_turn_start(self, thread_id: str, text: str, context: dict[str, Any]) -> dict[str, Any]:
        assert self._rpc is not None
        prompt = _prompt_with_context(text, context)
        return self._rpc.request(
            "turn/start",
            {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
                "cwd": str(self.workspace),
            },
        )


def _prompt_with_context(text: str, context: dict[str, Any]) -> str:
    selected = context.get("selectedCode") or context.get("selected_code")
    if selected:
        return f"{text}\n\nSelected symbol in terminal: {selected}"
    return text


def _public_account(account: dict[str, Any]) -> dict[str, Any]:
    return {"authenticated": bool(account)}


def _public_model(model: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": model.get("id") or model.get("name"),
        "name": model.get("name") or model.get("id"),
        "description": model.get("description"),
    }


def _first_model_id(models: list[dict[str, Any]]) -> str | None:
    for model in models:
        model_id = model.get("id")
        if model_id:
            return str(model_id)
    return None


def _select_model_id(models: list[dict[str, Any]], preferred: str | None = None) -> str | None:
    if preferred:
        for model in models:
            model_id = model.get("id")
            if model_id == preferred:
                return str(model_id)
    return _first_model_id(models)


def _error_message(params: dict[str, Any]) -> str:
    for key in ("message", "error", "summary"):
        value = params.get(key)
        if isinstance(value, str):
            return _redact(value)
    return _redact(json.dumps(params, ensure_ascii=False))


def _tool_call_from_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict) or item.get("type") != "mcpToolCall":
        return None
    result = item.get("result") if isinstance(item.get("result"), dict) else None
    parsed_result: Any = None
    if result:
        parsed_result = _parse_tool_result(result)
    error = item.get("error") if isinstance(item.get("error"), dict) else None
    status = item.get("status") or "running"
    if error:
        status = "failed"
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("tool") or ""),
        "args": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
        "status": status,
        "ok": status == "completed" and not error,
        "result": parsed_result,
        "error": error,
        "elapsed_ms": item.get("durationMs") or 0,
    }


def _parse_tool_result(result: dict[str, Any]) -> Any:
    content = result.get("content")
    if not isinstance(content, list):
        return result
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = item.get("text")
        if not isinstance(text, str):
            continue
        try:
            decoded = json.loads(text)
            if isinstance(decoded, dict) and "result" in decoded:
                return decoded["result"]
            return decoded
        except json.JSONDecodeError:
            return text
    return result
