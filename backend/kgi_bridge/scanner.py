from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any

from .clients import KGIClient
from .errors import BridgeError


DISCLAIMER = "篩選候選，不是投資建議"

DEFAULT_CONDITIONS: dict[str, Any] = {
    "price_above_ma20": True,
    "ma20_trending_up": True,
    "rsi_max": 70.0,
    "volume_ratio_min": 1.2,
    "min_liquidity": 30_000_000.0,
    "limit": 20,
    "days": 90,
    "max_universe": 80,
    "universe": [],
}


def _number(raw: Any, default: float) -> float:
    try:
        if raw is None or raw == "":
            return default
        result = float(raw)
        # NaN/inf survive float() without raising but are not valid JSON —
        # see the matching note in backend/kgi_bridge/normalizers.py.
        if not math.isfinite(result):
            return default
        return result
    except (TypeError, ValueError):
        return default


def _integer(raw: Any, default: int) -> int:
    try:
        if raw is None or raw == "":
            return default
        return int(float(raw))
    except (TypeError, ValueError):
        return default


def _bool(raw: Any, default: bool) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() not in {"0", "false", "no", "off"}


def _value(raw: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in raw:
            return raw[name]
    return default


def normalize_conditions(raw: dict[str, Any] | None = None) -> dict[str, Any]:
    data = raw or {}
    universe_value = _value(data, "universe", "symbols", default=[])
    if isinstance(universe_value, str):
        universe = [
            part.strip().upper()
            for part in re.split(r"[\s,，]+", universe_value)
            if part.strip()
        ]
    elif isinstance(universe_value, list):
        universe = [str(part).strip().upper() for part in universe_value if str(part).strip()]
    else:
        universe = []

    return {
        "price_above_ma20": _bool(
            _value(data, "price_above_ma20", "priceAboveMa20", default=True),
            True,
        ),
        "ma20_trending_up": _bool(
            _value(data, "ma20_trending_up", "ma20TrendingUp", default=True),
            True,
        ),
        "rsi_max": _number(
            _value(data, "rsi_max", "rsiMax", "rsi_threshold", "rsiThreshold"),
            DEFAULT_CONDITIONS["rsi_max"],
        ),
        "volume_ratio_min": _number(
            _value(
                data,
                "volume_ratio_min",
                "volumeRatioMin",
                "volume_multiple",
                "volumeMultiple",
            ),
            DEFAULT_CONDITIONS["volume_ratio_min"],
        ),
        "min_liquidity": _number(
            _value(data, "min_liquidity", "minLiquidity"),
            DEFAULT_CONDITIONS["min_liquidity"],
        ),
        "limit": max(1, min(100, _integer(_value(data, "limit"), DEFAULT_CONDITIONS["limit"]))),
        "days": max(65, min(260, _integer(_value(data, "days"), DEFAULT_CONDITIONS["days"]))),
        "max_universe": max(
            1,
            min(
                500,
                _integer(
                    _value(data, "max_universe", "maxUniverse"),
                    DEFAULT_CONDITIONS["max_universe"],
                ),
            ),
        ),
        "universe": universe,
    }


def _series(bars: dict[str, list[Any]], key: str) -> list[float]:
    return [_number(value, 0) for value in bars.get(key, [])]


def _mean(values: list[float]) -> float | None:
    clean = [value for value in values if math.isfinite(value)]
    if not clean:
        return None
    return sum(clean) / len(clean)


def _sma(values: list[float], length: int, end: int | None = None) -> float | None:
    if end is None:
        end = len(values)
    start = end - length
    if start < 0 or end > len(values):
        return None
    return _mean(values[start:end])


def _pct_change(current: float, previous: float) -> float:
    if previous == 0:
        return 0
    return (current / previous - 1) * 100


def _rsi(values: list[float], length: int = 14) -> float | None:
    if len(values) < length + 1:
        return None
    window = values[-(length + 1) :]
    gains: list[float] = []
    losses: list[float] = []
    for previous, current in zip(window, window[1:]):
        diff = current - previous
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = _mean(gains) or 0
    avg_loss = _mean(losses) or 0
    if avg_gain == 0 and avg_loss == 0:
        return 50
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def _volatility(values: list[float], length: int = 20) -> float | None:
    if len(values) < 2:
        return None
    returns = [
        _pct_change(current, previous)
        for previous, current in zip(values, values[1:])
        if previous
    ][-length:]
    if not returns:
        return None
    avg = sum(returns) / len(returns)
    variance = sum((value - avg) ** 2 for value in returns) / len(returns)
    return math.sqrt(variance)


def calculate_indicators_from_bars(bars: dict[str, list[Any]]) -> dict[str, Any]:
    closes = _series(bars, "Close")
    volumes = _series(bars, "Volume")
    amounts = _series(bars, "Amount")
    dates = [str(value) for value in bars.get("datetime", [])]
    if len(closes) < 61 or len(volumes) < 21:
        raise BridgeError(422, "At least 61 daily bars are required for MA60 and volume ratio")

    latest_close = closes[-1]
    latest_volume = volumes[-1]
    ma5 = _sma(closes, 5)
    ma20 = _sma(closes, 20)
    ma60 = _sma(closes, 60)
    prev_ma20 = _sma(closes, 20, len(closes) - 1)
    volume_average_20 = _mean(volumes[-21:-1]) or 0
    volume_ratio = latest_volume / volume_average_20 if volume_average_20 else 0
    amount_average_20 = _mean(amounts[-21:-1]) if len(amounts) >= 21 else None
    if not amount_average_20:
        amount_average_20 = _mean([close * volume for close, volume in zip(closes[-21:-1], volumes[-21:-1])]) or 0
    daily_return = _pct_change(latest_close, closes[-2]) if len(closes) > 1 else 0
    rsi14 = _rsi(closes, 14)
    volatility = _volatility(closes, 20)
    ma20_slope = _pct_change(ma20 or 0, prev_ma20 or 0) if ma20 and prev_ma20 else 0

    return {
        "date": dates[-1] if dates else "",
        "close": latest_close,
        "ma5": ma5,
        "ma20": ma20,
        "ma60": ma60,
        "rsi14": rsi14,
        "volume_average_20": volume_average_20,
        "volume_ratio": volume_ratio,
        "daily_return": daily_return,
        "volatility": volatility,
        "liquidity": amount_average_20,
        "ma20_slope": ma20_slope,
        "ma20_trending_up": bool(ma20 and prev_ma20 and ma20 > prev_ma20),
    }


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def score_indicators(indicators: dict[str, Any], conditions: dict[str, Any]) -> float:
    close = _number(indicators.get("close"), 0)
    ma20 = _number(indicators.get("ma20"), 0)
    rsi14 = _number(indicators.get("rsi14"), 100)
    volume_ratio = _number(indicators.get("volume_ratio"), 0)
    liquidity = _number(indicators.get("liquidity"), 0)
    daily_return = _number(indicators.get("daily_return"), 0)
    volatility = _number(indicators.get("volatility"), 0)
    ma20_slope = _number(indicators.get("ma20_slope"), 0)

    trend_score = _clamp(((close / ma20 - 1) * 100) / 5 * 22, 0, 22) if ma20 else 0
    slope_score = _clamp(ma20_slope / 1.5 * 16, 0, 16)
    rsi_score = _clamp((conditions["rsi_max"] - rsi14) / max(conditions["rsi_max"], 1) * 18, 0, 18)
    volume_score = _clamp((volume_ratio - conditions["volume_ratio_min"]) / 2 * 20, 0, 20)
    liquidity_score = _clamp(liquidity / max(conditions["min_liquidity"], 1), 0, 2) * 8
    return_score = _clamp((daily_return + 1.5) / 4 * 12, 0, 12)
    volatility_penalty = _clamp(volatility / 5 * 8, 0, 8)
    return round(_clamp(trend_score + slope_score + rsi_score + volume_score + liquidity_score + return_score - volatility_penalty, 0, 100), 2)


def failed_filters(indicators: dict[str, Any], conditions: dict[str, Any]) -> list[str]:
    failed: list[str] = []
    close = _number(indicators.get("close"), 0)
    ma20 = _number(indicators.get("ma20"), 0)
    if conditions["price_above_ma20"] and (not ma20 or close <= ma20):
        failed.append("price_above_ma20")
    if conditions["ma20_trending_up"] and not indicators.get("ma20_trending_up"):
        failed.append("ma20_trending_up")
    if _number(indicators.get("rsi14"), 100) > conditions["rsi_max"]:
        failed.append("rsi_below_threshold")
    if _number(indicators.get("volume_ratio"), 0) < conditions["volume_ratio_min"]:
        failed.append("volume_above_average_multiple")
    if _number(indicators.get("liquidity"), 0) < conditions["min_liquidity"]:
        failed.append("minimum_liquidity")
    return failed


def explanation_for_candidate(candidate: dict[str, Any]) -> str:
    ind = candidate["indicators"]
    return (
        f"{candidate['code']} {candidate['name']}：收盤 {ind['close']:.2f}、"
        f"MA20 {ind['ma20']:.2f}、MA20斜率 {ind['ma20_slope']:+.2f}%、"
        f"RSI14 {ind['rsi14']:.1f}、量比 {ind['volume_ratio']:.2f}x、"
        f"20日均額 {ind['liquidity'] / 100_000_000:.2f}億，"
        f" deterministic score {candidate['score']:.2f}。"
    )


def analyze_symbol(
    client: KGIClient,
    symbol: str,
    raw_conditions: dict[str, Any] | None = None,
) -> dict[str, Any]:
    conditions = normalize_conditions(raw_conditions)
    code = symbol.strip().upper()
    if not code:
        raise BridgeError(400, "symbol is required")
    contract = client.contract(code, "STK")
    bars = client.daily_bars(code, conditions["days"])
    indicators = calculate_indicators_from_bars(bars)
    failed = failed_filters(indicators, conditions)
    candidate = {
        "code": code,
        "name": contract.get("name") or code,
        "date": indicators.get("date"),
        "close": indicators.get("close"),
        "score": score_indicators(indicators, conditions),
        "passed": not failed,
        "failed_filters": failed,
        "indicators": indicators,
    }
    candidate["explanation"] = explanation_for_candidate(candidate)
    return candidate


def rank_candidates(candidates: list[dict[str, Any]], limit: int | None = None) -> list[dict[str, Any]]:
    ranked = sorted(candidates, key=lambda item: item.get("score", 0), reverse=True)
    if limit is not None:
        ranked = ranked[:limit]
    return [{**candidate, "rank": index + 1} for index, candidate in enumerate(ranked)]


def run_scanner(client: KGIClient, raw_conditions: dict[str, Any] | None = None) -> dict[str, Any]:
    conditions = normalize_conditions(raw_conditions)
    if conditions["universe"]:
        symbols = conditions["universe"][: conditions["max_universe"]]
        contracts = [client.contract(symbol, "STK") for symbol in symbols]
    else:
        contracts = client.contracts("STK")[: conditions["max_universe"]]

    passed: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    rejected_count = 0
    for contract in contracts:
        code = str(contract.get("code") or "").strip().upper()
        if not code:
            continue
        try:
            analysis = analyze_symbol(client, code, conditions)
        except BridgeError:
            raise
        except Exception as exc:
            errors.append({"code": code, "message": str(exc)})
            continue
        if analysis["passed"]:
            passed.append(analysis)
        else:
            rejected_count += 1

    candidates = rank_candidates(passed, conditions["limit"])
    return {
        "disclaimer": DISCLAIMER,
        "mode": getattr(client, "mode", "unknown"),
        "as_of": datetime.now().isoformat(),
        "conditions": conditions,
        "candidates": candidates,
        "candidate_count": len(candidates),
        "rejected_count": rejected_count,
        "errors": errors,
    }


def parse_conditions_from_prompt(prompt: str) -> dict[str, Any]:
    conditions: dict[str, Any] = {}
    rsi_match = re.search(r"RSI(?:14)?\D{0,8}(\d+(?:\.\d+)?)", prompt, re.IGNORECASE)
    if rsi_match:
        conditions["rsi_max"] = float(rsi_match.group(1))
    volume_match = re.search(r"(?:量比|volume|vol|成交量)\D{0,8}(\d+(?:\.\d+)?)\s*(?:倍|x)?", prompt, re.IGNORECASE)
    if volume_match:
        conditions["volume_ratio_min"] = float(volume_match.group(1))
    limit_match = re.search(r"(?:前|top)\s*(\d+)", prompt, re.IGNORECASE)
    if limit_match:
        conditions["limit"] = int(limit_match.group(1))
    symbols = re.findall(r"\b\d{4}[A-Z]?\b", prompt.upper())
    if symbols:
        conditions["universe"] = symbols
    return conditions
