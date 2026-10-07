import { DAYTRADE_DEFAULTS, evaluateDaytrade, type DaytradeInput, type DaytradeResult, type DaytradeSide } from './daytrade-picker';
import type { Candle, Snapshot } from './types/market';
import type { FrameComparison, ReplayPortfolio, ReplayPosition, ReplayTrade, StrategyComparison, StrategyFrame, StrategySettings } from './strategy-lab-types';
import { DEFAULT_STRATEGY_SETTINGS, STRATEGY_ENGINE_VERSIONS, type StrategyEngineVersion } from './strategy-lab-types';
import { engineVersionLabel, resolveStrategyEngine } from './strategy-engines';

const OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;
const MAX_GAP = 5 * 60_000;
const MAX_AGE = DAYTRADE_DEFAULTS.quoteAgeSeconds * 1_000;
const positive = (value: number) => Number.isFinite(value) && value > 0;
const dateAt = (time: number) => new Date(time + OFFSET).toISOString().slice(0, 10);
const dayAt = (time: number) => Math.floor((time + OFFSET) / DAY) * DAY - OFFSET;
const cutoffAt = (time: number) => dayAt(time) + (13 * 60 + 25) * 60_000;

/** Adapter timestamps without an explicit zone are Taipei wall-clock timestamps. */
function timestamp(value: string): number | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(normalized)) return null;
    const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`);
    return Number.isFinite(parsed) ? parsed : null;
}

function fresh(value: string, now: number, date: string): number | null {
    const parsed = timestamp(value);
    return parsed !== null && parsed <= now && now - parsed <= MAX_AGE && dateAt(parsed) === date ? parsed : null;
}

function validateSettings(settings: StrategySettings): void {
    if (![1.5, 2, 2.5].includes(settings.candidateRvol)) throw new Error('candidateRvol must be 1.5, 2, or 2.5');
    for (const field of ['feeBps', 'taxBps', 'slippageBps'] as const) {
        if (!Number.isFinite(settings[field]) || settings[field] < 0 || settings[field] > 1_000) {
            throw new Error(`${field} must be finite and between 0 and 1000`);
        }
    }
    if (!Number.isFinite(settings.minFeeTwd) || settings.minFeeTwd < 0 || settings.minFeeTwd > 10_000) {
        throw new Error('minFeeTwd must be finite and between 0 and 10000');
    }
    if (!STRATEGY_ENGINE_VERSIONS.includes(settings.baselineEngineVersion!)) throw new Error('Unknown baselineEngineVersion');
    if (!STRATEGY_ENGINE_VERSIONS.includes(settings.candidateEngineVersion!)) throw new Error('Unknown candidateEngineVersion');
}

function validateFrame(frame: StrategyFrame): void {
    if (frame.schemaVersion !== 1 || !frame.id?.trim() || !frame.sourceKey?.trim()
        || !Number.isSafeInteger(frame.capturedAt) || frame.capturedAt <= 0) throw new Error('Invalid strategy frame identity or timestamp');
    if (!STRATEGY_ENGINE_VERSIONS.includes(frame.engineVersion)) throw new Error('Unknown strategy engineVersion: ' + frame.engineVersion);
    if (!Array.isArray(frame.inputs) || !Array.isArray(frame.poolCodes) || !Array.isArray(frame.warnings)
        || !Array.isArray(frame.decisions)
        || frame.poolCodes.length > DAYTRADE_DEFAULTS.maxPool
        || frame.poolCodes.some(code => typeof code !== 'string' || !code)
        || new Set(frame.poolCodes).size !== frame.poolCodes.length) throw new Error('Invalid or duplicate frame pool');
    const codes = frame.inputs.map(input => input.contract.code);
    if (new Set(codes).size !== codes.length || codes.some(code => !frame.poolCodes.includes(code))) {
        throw new Error('Duplicate inputs or input outside recorded pool');
    }
}

/**
 * 以指定引擎版本評估一筆已記錄 frame（預設用 frame 錄製時的引擎版本）。
 * 相同 inputs／clock 下，不同 engineVersion 即代表不同策略邏輯；
 * rvol 僅在同引擎內作為候選門檻參數。
 */
export function evaluateStrategyFrame(frame: StrategyFrame, rvol: 1.5 | 2 | 2.5 = 1.5,
    engineVersion: StrategyEngineVersion = frame.engineVersion): DaytradeResult {
    validateFrame(frame);
    if (!STRATEGY_ENGINE_VERSIONS.includes(engineVersion)) throw new Error('Unknown strategy engineVersion: ' + engineVersion);
    const indexFresh = Number.isFinite(frame.indexChangeRate) && Number.isFinite(frame.indexAsOf)
        && frame.indexAsOf! <= frame.capturedAt && frame.capturedAt - frame.indexAsOf! <= MAX_AGE
        && dateAt(frame.indexAsOf!) === dateAt(frame.capturedAt);
    const inputs = new Map(frame.inputs.map(input => [input.contract.code, input]));
    return resolveStrategyEngine(engineVersion).evaluate(
        frame.poolCodes.flatMap(code => inputs.has(code) ? [inputs.get(code)!] : []),
        frame.capturedAt, indexFresh ? frame.indexChangeRate : undefined, { minimumRvol: rvol });
}

interface EntryIntent {
    code: string;
    name: string;
    side: DaytradeSide;
    signalAt: number;
    tradeDate: string;
}

interface ExitIntent { signalAt: number; reason: string }
interface PositionState {
    position: ReplayPosition;
    observedEntryAt: number;
    tradeDate: string;
    entryFees: number;
    entryTax: number;
    entrySlippage: number;
    exit?: ExitIntent;
    cutoffExpired: boolean;
}

function eligible(input: DaytradeInput, date: string, side: DaytradeSide): boolean {
    const contract = input.contract;
    return contract.region === 'TW' && contract.security_type === 'STK' && contract.currency === 'TWD'
        && ['TSE', 'OTC'].includes(contract.exchange ?? '') && /^[1-9]\d{3}$/.test(contract.code)
        && contract.update_date === date && contract.trading_suspended === false && contract.disposition_level === 0
        && (contract.day_trade === 'Yes' || (side === 'long' && contract.day_trade === 'OnlyBuy'))
        && Number.isSafeInteger(contract.unit) && positive(contract.unit!)
        && positive(contract.limit_up) && positive(contract.limit_down) && contract.limit_up > contract.limit_down;
}

/** A quote is not a trade. This conservative book-price estimate never imputes a missing quote. */
function fillQuote(input: DaytradeInput | undefined, frame: StrategyFrame, side: DaytradeSide,
    signalAt: number, date: string, entry: boolean, notBefore?: number): { quote: Snapshot; at: number } | null {
    if (!input || frame.capturedAt <= signalAt || dateAt(frame.capturedAt) !== date || !eligible(input, date, side)) return null;
    const quote = input.snapshot;
    if (!quote || quote.code !== input.contract.code || quote.exchange !== input.contract.exchange) return null;
    const at = fresh(quote.datetime, frame.capturedAt, date);
    if (at === null || at <= signalAt || (notBefore !== undefined && at < notBefore)) return null;
    if (at >= dayAt(frame.capturedAt) + (13 * 60 + 30) * 60_000) return null;
    if (![quote.open, quote.high, quote.low, quote.close, quote.buy_price, quote.sell_price,
        quote.buy_volume, quote.sell_volume, quote.total_volume, quote.total_amount].every(positive)
        || quote.high < Math.max(quote.open, quote.close, quote.low)
        || quote.low > Math.min(quote.open, quote.close, quote.high)
        || quote.sell_price <= quote.buy_price) return null;
    const { limit_up: up, limit_down: down } = input.contract;
    if (quote.close >= up || quote.close <= down || quote.buy_price <= down || quote.sell_price >= up) return null;
    const spread = (quote.sell_price - quote.buy_price) / ((quote.sell_price + quote.buy_price) / 2) * 100;
    if (spread > DAYTRADE_DEFAULTS.maximumSpreadPct + 1e-9) return null;
    if (entry && side === 'short' && (!input.shortSource || !positive(input.shortSource.quantity)
        || fresh(input.shortSource.datetime, frame.capturedAt, date) === null)) return null;
    return { quote, at };
}

function validCandle(bar: Candle): boolean {
    return Number.isInteger(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(positive)
        && Number.isFinite(bar.volume) && bar.volume >= 0
        && bar.high >= Math.max(bar.open, bar.low, bar.close) && bar.low <= Math.min(bar.open, bar.high, bar.close);
}

/** Same completed-prefix convention as the picker: candle.time stores Taipei wall seconds. */
function trendExit(input: DaytradeInput | undefined, now: number, side: DaytradeSide): string | null {
    if (!input) return null;
    const wallNow = (now + OFFSET) / 1_000;
    const today = Math.floor(wallNow / 86_400) * 86_400;
    const open = today + 9 * 3_600;
    const count = Math.floor((wallNow - open) / 300) * 5;
    if (count < 40 || count > 270) return null;
    const bars = input.minutes.filter(bar => bar.time > open && bar.time <= open + count * 60);
    if (bars.length !== count || bars.some((bar, i) => !validCandle(bar) || bar.time !== open + (i + 1) * 60)) return null;
    const volume = bars.reduce((sum, bar) => sum + bar.volume, 0);
    if (!positive(volume)) return null;
    const vwap = bars.reduce((sum, bar) => sum + (bar.high + bar.low + bar.close) / 3 * bar.volume, 0) / volume;
    const closes = bars.filter((_, i) => i % 5 === 4).map(bar => bar.close);
    let ema8 = closes.slice(0, 8).reduce((sum, close) => sum + close, 0) / 8;
    for (const close of closes.slice(8)) ema8 += (close - ema8) * 2 / 9;
    const last = closes.at(-1)!;
    return (side === 'long' ? last < vwap || last < ema8 : last > vwap || last > ema8)
        ? '最近完整 5 分K跌破／站回 VWAP 或 EMA8' : null;
}

const fee = (notional: number, settings: StrategySettings) => Math.max(settings.minFeeTwd, notional * settings.feeBps / 10_000);
const slipped = (price: number, buy: boolean, settings: StrategySettings) => price * (1 + (buy ? 1 : -1) * settings.slippageBps / 10_000);

function replay(frames: StrategyFrame[], comparisons: FrameComparison[], version: 'baseline' | 'candidate',
    settings: StrategySettings): ReplayPortfolio {
    const positions = new Map<string, PositionState>();
    const entries = new Map<string, EntryIntent>();
    const trades: ReplayTrade[] = [];
    let skippedFills = 0;
    let totalCosts = 0;
    let netPnl = 0;
    let peak = 0;
    let maxRealizedDrawdown = 0;

    const closePosition = (state: PositionState, quote: Snapshot, at: number, reason: string) => {
        const position = state.position;
        const raw = position.side === 'long' ? quote.buy_price : quote.sell_price;
        const exitPrice = slipped(raw, position.side === 'short', settings);
        const exitNotional = exitPrice * position.quantity;
        const exitFee = fee(exitNotional, settings);
        const exitTax = position.side === 'long' ? exitNotional * settings.taxBps / 10_000 : 0;
        const fees = state.entryFees + exitFee;
        const tax = state.entryTax + exitTax;
        const gross = (exitPrice - position.entryPrice) * position.quantity * (position.side === 'long' ? 1 : -1);
        const pnl = gross - fees - tax;
        trades.push({ ...position, exitAt: at, exitPrice, fees, tax, netPnl: pnl,
            returnPct: pnl / (position.entryPrice * position.quantity) * 100, exitReason: reason });
        netPnl += pnl;
        totalCosts += fees + tax + state.entrySlippage + Math.abs(exitPrice - raw) * position.quantity;
        peak = Math.max(peak, netPnl);
        maxRealizedDrawdown = Math.max(maxRealizedDrawdown, peak - netPnl);
        positions.delete(position.code);
    };

    frames.forEach((frame, frameIndex) => {
        const inputs = new Map(frame.inputs.map(input => [input.contract.code, input]));
        // Codes occupied at event start cannot reverse/re-enter in that same event.
        const occupied = new Set([...positions.keys(), ...entries.keys()]);
        const previousPositions = [...positions.values()];
        for (const [code, intent] of entries) {
            if (dateAt(frame.capturedAt) !== intent.tradeDate || frame.capturedAt - intent.signalAt > MAX_GAP
                || frame.capturedAt >= cutoffAt(intent.signalAt)) {
                entries.delete(code);
                skippedFills++;
                continue;
            }
            const input = inputs.get(code);
            const fill = fillQuote(input, frame, intent.side, intent.signalAt, intent.tradeDate, true);
            if (!fill || !input) { skippedFills++; continue; }
            const raw = intent.side === 'long' ? fill.quote.sell_price : fill.quote.buy_price;
            const entryPrice = slipped(raw, intent.side === 'long', settings);
            if (entryPrice >= input.contract.limit_up || entryPrice <= input.contract.limit_down) { skippedFills++; continue; }
            const quantity = input.contract.unit!;
            positions.set(code, { position: { code, name: intent.name, side: intent.side,
                signalAt: intent.signalAt, entryAt: fill.at, entryPrice, quantity },
            observedEntryAt: frame.capturedAt, tradeDate: intent.tradeDate,
            entryFees: fee(entryPrice * quantity, settings),
            entryTax: intent.side === 'short' ? entryPrice * quantity * settings.taxBps / 10_000 : 0,
            entrySlippage: Math.abs(entryPrice - raw) * quantity, cutoffExpired: false });
            entries.delete(code);
        }

        for (const state of previousPositions) {
            const { position } = state;
            const input = inputs.get(position.code);
            const cutoff = cutoffAt(position.signalAt);
            // The time exit was scheduled at entry, hence it may use the 13:25 quote
            // only when that quote was not yet known at the recorded entry event.
            if (frame.capturedAt >= cutoff) {
                if (state.cutoffExpired) continue;
                if (frame.capturedAt - cutoff > MAX_GAP || dateAt(frame.capturedAt) !== state.tradeDate) {
                    state.cutoffExpired = true;
                    state.exit = undefined;
                    skippedFills++;
                    continue;
                }
                const fill = fillQuote(input, frame, position.side, state.observedEntryAt, state.tradeDate, false, cutoff);
                if (!fill || input!.contract.unit !== position.quantity) { skippedFills++; continue; }
                closePosition(state, fill.quote, fill.at, '13:25 預定退出（後續有效報價估算）');
                continue;
            }
            if (state.exit) {
                if (frame.capturedAt - state.exit.signalAt > MAX_GAP) {
                    state.exit = undefined;
                    skippedFills++;
                    continue;
                }
                const fill = fillQuote(input, frame, position.side, state.exit.signalAt, state.tradeDate, false);
                if (!fill || input!.contract.unit !== position.quantity) { skippedFills++; continue; }
                closePosition(state, fill.quote, fill.at, state.exit.reason);
                continue;
            }
            const observed = fillQuote(input, frame, position.side, state.observedEntryAt, state.tradeDate, false);
            const stop = observed && (position.side === 'long'
                ? observed.quote.close <= position.entryPrice * 0.98
                : observed.quote.close >= position.entryPrice * 1.02);
            const reason = stop ? '相對模擬進場價達 2% 停損' : trendExit(input, frame.capturedAt, position.side);
            if (reason) state.exit = { signalAt: frame.capturedAt, reason };
        }

        if (frame.capturedAt >= cutoffAt(frame.capturedAt)) return;
        const result = comparisons[frameIndex]![version];
        for (const side of ['long', 'short'] as const) {
            let count = [...positions.values()].filter(state => state.position.side === side).length
                + [...entries.values()].filter(intent => intent.side === side).length;
            for (const row of result[side]) {
                if (count >= DAYTRADE_DEFAULTS.maxPerSide) break;
                const code = row.contract.code;
                if (occupied.has(code) || positions.has(code) || entries.has(code)) continue;
                entries.set(code, { code, name: row.contract.name, side, signalAt: frame.capturedAt, tradeDate: result.tradeDate });
                count++;
            }
        }
    });
    const lastAt = frames.at(-1)?.capturedAt ?? 0;
    return { trades, openPositions: [...positions.values()].map(state => ({ ...state.position })),
        pendingCount: entries.size + [...positions.values()].filter(state => state.exit
            || (!state.cutoffExpired && lastAt >= cutoffAt(state.position.signalAt))).length,
        netPnl, totalCosts, winRate: trades.length ? trades.filter(trade => trade.netPnl > 0).length / trades.length * 100 : null,
        maxRealizedDrawdown, skippedFills };
}

/** Pure causal comparison. No network, storage, synthetic quotes, subscriptions, or order APIs. */
export function compareStrategyFrames(recorded: StrategyFrame[], settings: StrategySettings): StrategyComparison {
    // 未指定引擎版本時補為目前版本（向後相容既有呼叫／UI 草稿）。
    const merged: StrategySettings = { ...DEFAULT_STRATEGY_SETTINGS, ...settings };
    validateSettings(merged);
    const frames = [...recorded].sort((a, b) => a.capturedAt - b.capturedAt);
    const ids = new Set<string>();
    const times = new Set<number>();
    for (const frame of frames) {
        validateFrame(frame);
        if (ids.has(frame.id) || times.has(frame.capturedAt)) throw new Error('Duplicate strategy frame id or capturedAt');
        if (frame.sourceKey !== frames[0]!.sourceKey) throw new Error('Cannot compare mixed sourceKey datasets');
        ids.add(frame.id);
        times.add(frame.capturedAt);
    }
    const comparisons: FrameComparison[] = frames.map(frame => {
        const baseline = evaluateStrategyFrame(frame, 1.5, merged.baselineEngineVersion);
        const candidate = evaluateStrategyFrame(frame, merged.candidateRvol, merged.candidateEngineVersion);
        const codes = (result: DaytradeResult, side: DaytradeSide) => result[side].map(row => row.contract.code);
        const difference = (left: string[], right: string[]) => left.filter(code => !right.includes(code));
        return { id: frame.id, capturedAt: frame.capturedAt, baseline, candidate,
            baselineVersion: merged.baselineEngineVersion!, candidateVersion: merged.candidateEngineVersion!,
            addedLong: difference(codes(candidate, 'long'), codes(baseline, 'long')),
            removedLong: difference(codes(baseline, 'long'), codes(candidate, 'long')),
            addedShort: difference(codes(candidate, 'short'), codes(baseline, 'short')),
            removedShort: difference(codes(baseline, 'short'), codes(candidate, 'short')) };
    });
    const baseline = replay(frames, comparisons, 'baseline', merged);
    const candidate = replay(frames, comparisons, 'candidate', merged);
    const warnings = [...new Set([
        '僅研究：回放是定時快照估算，不是逐筆成交、實際可成交數量或券源保證；不得視為已驗證績效。',
        '訊號使用當時資料；進出場使用之後新鮮且更新的買賣報價，等待上限 5 分鐘，未成交不補價。',
        '每檔最多一筆一張、每側最多 10 筆（含待進場）；候選門檻只影響該版本的新進場。',
        '成本為設定假設；總成本含已完成交易雙邊手續費、賣出稅及雙邊滑價。未平倉成本未計入已實現損益。',
        '最大已實現回撤僅按已完成交易損益計算，並非持倉淨值回撤；未平倉及待成交另列。',
        '13:25 退出計畫在進場時即確定，仍須後續有效報價；資料結尾或跨日不強制平倉。',
        '略過成交數按無法成交的快照嘗試／逾期意圖計數，同一意圖可能計數多次。',
        `比較引擎版本：固定版「${engineVersionLabel(merged.baselineEngineVersion!)}」 vs 候選版「${engineVersionLabel(merged.candidateEngineVersion!)}」；不同版本代表不同策略邏輯，不只參數差異。`,
        ...frames.flatMap(frame => frame.warnings),
        ...(baseline.openPositions.length || candidate.openPositions.length ? ['仍有未平倉部位，已實現損益不代表完整策略結果。'] : []),
    ])];
    return { frames: comparisons, baseline, candidate, settings: { ...merged }, warnings };
}
