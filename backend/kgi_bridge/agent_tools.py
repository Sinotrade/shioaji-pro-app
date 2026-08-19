from __future__ import annotations

from datetime import date
from typing import Any, Callable

from .clients import KGIClient
from .errors import BridgeError
from .scanner import (
    analyze_symbol,
    run_scanner,
)


ToolHandler = Callable[[KGIClient, dict[str, Any]], Any]

FUTURE_TRADE_PROPOSAL_PIPELINE = {
    "enabled": False,
    "stages": ["agent_trade_proposal", "risk_manager", "explicit_user_confirmation", "order_gateway"],
    "message": "Order execution is not exposed to the agent. Future trading must enter as a proposal first.",
}


def _symbol(args: dict[str, Any]) -> str:
    symbol = str(args.get("symbol") or args.get("code") or "").strip().upper()
    if not symbol:
        raise BridgeError(400, "symbol is required")
    return symbol


def _account_type(args: dict[str, Any]) -> str | None:
    raw = args.get("account_type") or args.get("accountType")
    return str(raw).upper() if raw else None


def _today() -> str:
    return date.today().isoformat()


def tool_get_quote(client: KGIClient, args: dict[str, Any]) -> dict[str, Any]:
    symbol = _symbol(args)
    snapshots = client.snapshots([symbol])
    return snapshots[0] if snapshots else {}


def tool_get_kbars(client: KGIClient, args: dict[str, Any]) -> dict[str, list[Any]]:
    symbol = _symbol(args)
    start = str(args.get("start") or _today())
    end = str(args.get("end") or start)
    return client.kbars(symbol, start, end)


def tool_get_bidask(client: KGIClient, args: dict[str, Any]) -> dict[str, Any]:
    return client.bidask_snapshot(_symbol(args))


def tool_get_positions(client: KGIClient, args: dict[str, Any]) -> list[dict[str, Any]]:
    return client.positions(_account_type(args))


def tool_get_account(client: KGIClient, args: dict[str, Any]) -> list[dict[str, Any]]:
    return client.accounts()


def tool_get_orders(client: KGIClient, args: dict[str, Any]) -> list[dict[str, Any]]:
    return client.orders(_account_type(args))


def tool_get_deals(client: KGIClient, args: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    return client.deals(_account_type(args))


def tool_scan_market(client: KGIClient, args: dict[str, Any]) -> dict[str, Any]:
    return run_scanner(client, args)


def tool_calculate_indicators(client: KGIClient, args: dict[str, Any]) -> dict[str, Any]:
    symbol = _symbol(args)
    return analyze_symbol(client, symbol, args)


AGENT_TOOLS: dict[str, dict[str, Any]] = {
    "get_quote": {
        "description": "Read the latest quote snapshot for one symbol.",
        "read_only": True,
        "handler": tool_get_quote,
        "parameters": {"symbol": "string"},
    },
    "get_kbars": {
        "description": "Read historical K bars for one symbol.",
        "read_only": True,
        "handler": tool_get_kbars,
        "parameters": {"symbol": "string", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
    },
    "get_bidask": {
        "description": "Read bid/ask book data for one symbol when the client supports it.",
        "read_only": True,
        "handler": tool_get_bidask,
        "parameters": {"symbol": "string"},
    },
    "get_positions": {
        "description": "Read account positions.",
        "read_only": True,
        "handler": tool_get_positions,
        "parameters": {"account_type": "S|F"},
    },
    "get_account": {
        "description": "Read available KGI accounts.",
        "read_only": True,
        "handler": tool_get_account,
        "parameters": {},
    },
    "get_orders": {
        "description": "Read order/trade report rows.",
        "read_only": True,
        "handler": tool_get_orders,
        "parameters": {"account_type": "S|F"},
    },
    "get_deals": {
        "description": "Read deal/fill rows.",
        "read_only": True,
        "handler": tool_get_deals,
        "parameters": {"account_type": "S|F"},
    },
    "scan_market": {
        "description": "Run deterministic market screening and ranking.",
        "read_only": True,
        "handler": tool_scan_market,
        "parameters": {
            "rsi_max": "number",
            "volume_ratio_min": "number",
            "min_liquidity": "number",
            "universe": "string[]",
        },
    },
    "calculate_indicators": {
        "description": "Calculate indicators from broker-provided daily bars for one symbol.",
        "read_only": True,
        "handler": tool_calculate_indicators,
        "parameters": {"symbol": "string"},
    },
}


def list_agent_tools() -> dict[str, Any]:
    tools = []
    for name, spec in AGENT_TOOLS.items():
        tools.append(
            {
                "name": name,
                "description": spec["description"],
                "read_only": spec["read_only"],
                "parameters": spec["parameters"],
            }
        )
    return {
        "tools": tools,
        "trade_proposal_pipeline": FUTURE_TRADE_PROPOSAL_PIPELINE,
    }


def execute_agent_tool(client: KGIClient, name: str, args: dict[str, Any] | None = None) -> Any:
    spec = AGENT_TOOLS.get(name)
    if spec is None:
        raise BridgeError(404, f"Unknown agent tool: {name}")
    if spec.get("read_only") is not True:
        raise BridgeError(403, f"Agent tool is not read-only: {name}")
    return spec["handler"](client, args or {})

