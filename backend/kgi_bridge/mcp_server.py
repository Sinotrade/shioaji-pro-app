from __future__ import annotations

import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_URL = os.environ.get("KGI_AGENT_TOOL_BASE_URL", "http://127.0.0.1:21323").rstrip("/")
SERVER_NAME = "kgi-readonly-tools"
SERVER_VERSION = "0.1.0"
MAX_KBARS_FOR_CODEX = 80
MAX_ROWS_FOR_CODEX = 50
MAX_CANDIDATES_FOR_CODEX = 20

INSTRUCTIONS = (
    "KGI read-only market/account tools. Market, account, position, order, deal, "
    "scanner, and indicator facts must come from these tools. For broad screening "
    "requests, call scan_market first; it returns a bounded deterministic candidate "
    "set. Never invent prices, positions, indicators, orders, deals, or scanner results. "
    "Do not execute trades."
)


def _write(message: dict[str, Any]) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(payload + b"\n")
    sys.stdout.buffer.flush()


def _result(request_id: Any, result: Any) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id: Any, code: int, message: str, data: Any | None = None) -> None:
    body: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        body["data"] = data
    _write({"jsonrpc": "2.0", "id": request_id, "error": body})


def _http_json(path: str, payload: dict[str, Any] | None = None) -> Any:
    url = f"{BASE_URL}{path}"
    if payload is None:
        request = Request(url, method="GET")
    else:
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            details = json.loads(exc.read().decode("utf-8"))
        except Exception:
            details = {"message": str(exc)}
        raise RuntimeError(details.get("message") or str(exc)) from exc
    except URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc


def _json_schema(parameters: dict[str, str]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    for name, hint in parameters.items():
        lower = hint.lower()
        if "number" in lower:
            schema: dict[str, Any] = {"type": "number"}
        elif "[]" in lower:
            schema = {"type": "array", "items": {"type": "string"}}
        else:
            schema = {"type": "string"}
        schema["description"] = hint
        properties[name] = schema
    required = [name for name in ("symbol", "code") if name in parameters]
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _list_tools() -> list[dict[str, Any]]:
    manifest = _http_json("/api/v1/agent/tools")
    tools = []
    for tool in manifest.get("tools", []):
        name = tool.get("name")
        if not name:
            continue
        tools.append(
            {
                "name": name,
                "description": tool.get("description", ""),
                "inputSchema": _json_schema(tool.get("parameters") or {}),
                "annotations": {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "idempotentHint": True,
                },
            }
        )
    return tools


def _call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    result = _bounded_tool_result(name, _http_json(f"/api/v1/agent/tools/{name}", arguments))
    elapsed_ms = round((time.time() - started) * 1000)
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {"tool": name, "elapsed_ms": elapsed_ms, "result": result},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            }
        ],
        "isError": False,
    }


def _bounded_tool_result(name: str, result: Any) -> Any:
    if name == "get_kbars" and isinstance(result, dict):
        count = _series_length(result)
        if count <= MAX_KBARS_FOR_CODEX:
            return result
        start = count - MAX_KBARS_FOR_CODEX
        bounded = {
            key: value[start:] if isinstance(value, list) else value
            for key, value in result.items()
        }
        bounded["_meta"] = {
            "original_count": count,
            "returned_count": MAX_KBARS_FOR_CODEX,
            "truncated": True,
            "note": "K bars are truncated to the most recent rows before sending to Codex.",
        }
        return bounded
    if name == "scan_market" and isinstance(result, dict):
        candidates = result.get("candidates")
        if isinstance(candidates, list) and len(candidates) > MAX_CANDIDATES_FOR_CODEX:
            return {
                **result,
                "candidates": candidates[:MAX_CANDIDATES_FOR_CODEX],
                "_meta": {
                    "original_candidate_count": len(candidates),
                    "returned_candidate_count": MAX_CANDIDATES_FOR_CODEX,
                    "truncated": True,
                },
            }
    if name in {"get_positions", "get_orders"} and isinstance(result, list) and len(result) > MAX_ROWS_FOR_CODEX:
        return {
            "rows": result[:MAX_ROWS_FOR_CODEX],
            "_meta": {
                "original_count": len(result),
                "returned_count": MAX_ROWS_FOR_CODEX,
                "truncated": True,
            },
        }
    if name == "get_deals" and isinstance(result, dict):
        bounded: dict[str, Any] = {}
        for key, rows in result.items():
            bounded[key] = rows[:MAX_ROWS_FOR_CODEX] if isinstance(rows, list) else rows
        return bounded
    return result


def _series_length(result: dict[str, Any]) -> int:
    for key in ("datetime", "ts", "Date", "date"):
        value = result.get(key)
        if isinstance(value, list):
            return len(value)
    for value in result.values():
        if isinstance(value, list):
            return len(value)
    return 0


def _handle_request(message: dict[str, Any]) -> None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    if method == "initialize":
        _result(
            request_id,
            {
                "protocolVersion": params.get("protocolVersion") or "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": INSTRUCTIONS,
            },
        )
        return
    if method == "tools/list":
        _result(request_id, {"tools": _list_tools()})
        return
    if method == "tools/call":
        name = str(params.get("name") or "")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if not name:
            _error(request_id, -32602, "tool name is required")
            return
        try:
            _result(request_id, _call_tool(name, args))
        except Exception as exc:
            _result(
                request_id,
                {
                    "content": [{"type": "text", "text": str(exc)}],
                    "isError": True,
                },
            )
        return
    if request_id is not None:
        _error(request_id, -32601, f"Unsupported MCP method: {method}")


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError as exc:
            _error(None, -32700, str(exc))
            continue
        if "id" not in message:
            continue
        _handle_request(message)


if __name__ == "__main__":
    main()
