from __future__ import annotations

from typing import Any

UNKNOWN = "unknown"
AVAILABLE = "available"
FORBIDDEN = "forbidden"
TEMPORARY_ERROR = "temporary_error"


class CapabilityRegistry:
    """Session-scoped cache of upstream KGI table/API entitlement outcomes.

    KGI returns D403 for Data/MSMP tables an account has no entitlement for.
    Once a key is confirmed forbidden for this login session, callers should
    stop retrying it on every render/timeframe click and fall back to
    another source instead of hammering the upstream API (and the backend
    console) repeatedly. States: unknown -> available | forbidden |
    temporary_error. A confirmed `forbidden` outcome is sticky for the
    session; a `temporary_error` never downgrades a prior `forbidden`.
    """

    def __init__(self) -> None:
        self._state: dict[str, str] = {}
        self._detail: dict[str, dict[str, Any]] = {}

    def state(self, key: str) -> str:
        return self._state.get(key, UNKNOWN)

    def is_forbidden(self, key: str) -> bool:
        return self._state.get(key) == FORBIDDEN

    def detail(self, key: str) -> dict[str, Any] | None:
        return self._detail.get(key)

    def mark_available(self, key: str) -> None:
        self._state[key] = AVAILABLE
        self._detail.pop(key, None)

    def mark_forbidden(self, key: str, detail: dict[str, Any] | None = None) -> None:
        self._state[key] = FORBIDDEN
        if detail is not None:
            self._detail[key] = detail

    def mark_temporary_error(self, key: str, detail: dict[str, Any] | None = None) -> None:
        if self._state.get(key) == FORBIDDEN:
            return
        self._state[key] = TEMPORARY_ERROR
        if detail is not None:
            self._detail[key] = detail

    def snapshot(self) -> dict[str, str]:
        return dict(self._state)
