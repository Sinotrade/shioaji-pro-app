from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


DEFAULT_CODEX = r"C:\Users\yongy\AppData\Roaming\npm\codex.cmd"


class JsonRpcClient:
    def __init__(self, command: list[str], cwd: Path, timeout: float) -> None:
        env = os.environ.copy()
        env.setdefault("NO_COLOR", "1")
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
        self.timeout = timeout
        self.next_id = 1
        self.responses: dict[int, dict[str, Any]] = {}
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self.stderr_lines: queue.Queue[str] = queue.Queue()
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.err_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self.reader.start()
        self.err_reader.start()

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                self.messages.put({"method": "poc/nonJsonStdout", "params": {"line": line}})

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            line = line.rstrip()
            if line:
                self.stderr_lines.put(line)

    def send(self, message: dict[str, Any]) -> None:
        if self.proc.poll() is not None:
            raise RuntimeError(f"codex app-server exited with {self.proc.returncode}")
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        msg: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            message = self.read_message(deadline - time.time())
            if message is None:
                continue
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method} failed: {message['error']}")
                return message.get("result") or {}
            self._handle_background(message)
        raise TimeoutError(f"Timed out waiting for {method}")

    def read_message(self, timeout: float | None = None) -> dict[str, Any] | None:
        try:
            return self.messages.get(timeout=max(timeout or 0, 0.01))
        except queue.Empty:
            if self.proc.poll() is not None:
                err = self.drain_stderr()
                raise RuntimeError(f"codex app-server exited with {self.proc.returncode}\n{err}")
            return None

    def _handle_background(self, message: dict[str, Any]) -> None:
        if "id" in message and "method" in message:
            self.send(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {
                        "code": -32000,
                        "message": "POC client does not service app-server callbacks",
                    },
                }
            )
            return
        method = message.get("method")
        if method in {"warning", "configWarning", "deprecationNotice"}:
            print(f"[{method}] {message.get('params')}")
        elif method == "error":
            print(f"[error] {message.get('params')}")

    def drain_stderr(self) -> str:
        lines: list[str] = []
        while True:
            try:
                lines.append(self.stderr_lines.get_nowait())
            except queue.Empty:
                break
        return "\n".join(lines)

    def close(self) -> None:
        if self.proc.poll() is None:
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


def choose_model(model_result: dict[str, Any]) -> str | None:
    data = model_result.get("data")
    if not isinstance(data, list) or not data:
        return None
    first = data[0]
    if isinstance(first, dict):
        return str(first.get("id") or first.get("name") or "") or None
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal Codex app-server JSON-RPC smoke test.")
    parser.add_argument("--codex", default=os.environ.get("CODEX_CLI", DEFAULT_CODEX))
    parser.add_argument("--cwd", default=str(Path.cwd()))
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--prompt", default="Reply exactly: Codex app-server runtime OK")
    args = parser.parse_args()

    cwd = Path(args.cwd).resolve()
    command = [args.codex, "app-server", "--listen", "stdio://"]
    print(f"launch: {' '.join(command)}")
    client = JsonRpcClient(command, cwd, args.timeout)
    try:
        init = client.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "kgi-codex-app-server-poc",
                    "title": "KGI Codex App Server POC",
                    "version": "0.1.0",
                },
                "capabilities": {"experimentalApi": False},
            },
        )
        print(f"initialize: userAgent={init.get('userAgent')} codexHome={init.get('codexHome')}")
        client.notify("initialized")

        account = client.request("account/read", {"refreshToken": False})
        requires_auth = bool(account.get("requiresOpenaiAuth"))
        account_obj = account.get("account") if isinstance(account.get("account"), dict) else None
        account_label = account_obj.get("email") or account_obj.get("name") if account_obj else None
        print(f"account/read: requiresOpenaiAuth={requires_auth} account={account_label or 'none'}")

        models = client.request("model/list", {"limit": 10})
        model = choose_model(models)
        print(f"model/list: count={len(models.get('data') or [])} first={model or 'none'}")

        thread_params: dict[str, Any] = {
            "cwd": str(cwd),
            "approvalPolicy": "never",
            "sandbox": "read-only",
            "ephemeral": True,
            "developerInstructions": (
                "This is a Codex app-server runtime smoke test. "
                "Do not inspect or modify files. Answer the user's prompt directly."
            ),
        }
        if model:
            thread_params["model"] = model
        thread_result = client.request("thread/start", thread_params)
        thread = thread_result["thread"]
        thread_id = thread["id"]
        print(f"thread/start: threadId={thread_id} model={thread_result.get('model')}")

        turn_result = client.request(
            "turn/start",
            {
                "threadId": thread_id,
                "input": [{"type": "text", "text": args.prompt}],
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
                "cwd": str(cwd),
            },
        )
        turn_id = turn_result["turn"]["id"]
        print(f"turn/start: turnId={turn_id}")
        print("assistant deltas:")

        deadline = time.time() + args.timeout
        completed = False
        while time.time() < deadline:
            message = client.read_message(deadline - time.time())
            if message is None:
                continue
            method = message.get("method")
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            if "id" in message and method:
                client._handle_background(message)
                continue
            if method == "item/agentMessage/delta":
                sys.stdout.write(str(params.get("delta") or ""))
                sys.stdout.flush()
            elif method == "turn/completed":
                if params.get("turn", {}).get("id") == turn_id:
                    completed = True
                    print("\nturn/completed")
                    break
            elif method == "error":
                print(f"\n[error] {params}")
            elif method in {"warning", "configWarning", "deprecationNotice"}:
                print(f"\n[{method}] {params}")

        if not completed:
            raise TimeoutError("Timed out waiting for turn/completed")
        return 0
    finally:
        stderr = client.drain_stderr()
        if stderr:
            print("\napp-server stderr:")
            print(stderr)
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
