import { ema } from './indicators';
import { sessionWindowFor } from './intraday-session';
import { researchSessionVwap, validResearchMinutes } from './research-vwap';
import type { SecurityType } from './types/contract';
import type { Candle } from './types/market';
import { aggregate } from './utils/kbars';

export interface ResearchSetupEvaluation {
    state: 'waiting-data' | 'observing' | 'waiting-confirmation' | 'confirmed';
    label: string;
    detail: string;
    side?: 'long' | 'short';
    setup?: 'pullback' | 'failed-reclaim';
    asOf?: number;
    confirmedAt?: number;
    patternTime?: number;
    vwap?: number;
}

type Side = 'long' | 'short';
interface Candidate { side: Side; index: number; time: number; high: number; low: number }
const EXPIRY_BARS = 3;

/** Two independent, display-only shadow setups on fixed closed 5m bars.
 * Neither changes the existing entry checks, score, MACD/EMA settings or
 * trading path. A confirmation is only returned on the latest closed bar;
 * no backfill of a pullback low, and no reuse of a historical confirmation.
 * The initial 3-bar expiry and strict close-through definitions are research
 * definitions, not demonstrated profitability. EMA3/8 uses all loaded,
 * same-security closed 5m background bars (the existing entry convention);
 * candidate events and VWAP belong only to the current session. */
export function researchSetups(rawMinutes: readonly Candle[], securityType: SecurityType, now: number): ResearchSetupEvaluation {
    const source = researchSessionVwap(rawMinutes, securityType, now);
    const waiting = (detail: string, asOf = source.asOf): ResearchSetupEvaluation => ({
        state: 'waiting-data', label: '等待資料', detail, asOf,
    });
    if (!Number.isFinite(now)) return waiting('研究時鐘未確認');
    const win = sessionWindowFor(securityType, now);
    if (now <= win.start || now > win.end) return waiting('目前非本時段交易時間，不沿用舊型態');
    if (source.status !== 'ready') return waiting(source.reason);
    const expected = win.start + Math.floor((now - win.start) / 300) * 300;
    const allClosedBars = aggregate(validResearchMinutes(rawMinutes, securityType, now), 5, securityType)
        .filter(bar => bar.time <= now);
    const bars = allClosedBars.filter(bar => bar.time > win.start && bar.time <= Math.min(expected, win.end));
    const last = bars.at(-1);
    if (!last || expected <= win.start || last.time !== expected) return waiting('尚無本時段最新已收5分K，不沿用舊型態');
    if (last.volume <= 0) return waiting('最新已收5分K無成交量，暫不確認型態', last.time);
    const values = new Map(source.points.filter(point => point.value !== undefined).map(point => [point.time, point.value!]));
    const fast = new Map(ema(allClosedBars, 3).map(point => [point.time, point.value!]));
    const slow = new Map(ema(allClosedBars, 8).map(point => [point.time, point.value!]));
    const sideAt = (index: number): Side | undefined => {
        const bar = bars[index];
        if (!bar || bar.volume <= 0) return undefined;
        const mean = values.get(bar.time);
        return mean === undefined || bar.close === mean ? undefined : bar.close > mean ? 'long' : 'short';
    };
    const aligned = (index: number, side: Side) => {
        const time = bars[index]!.time;
        const f = fast.get(time), s = slow.get(time);
        return f !== undefined && s !== undefined && (side === 'long' ? f > s : f < s);
    };
    const build = (candidate: Candidate, setup: 'pullback' | 'failed-reclaim', confirmed: boolean, time: number): ResearchSetupEvaluation => ({
        state: confirmed ? 'confirmed' : 'waiting-confirmation',
        label: setup === 'pullback' ? confirmed ? `回踩後重新走${candidate.side === 'long' ? '強' : '弱'}` : '順勢回踩，等待確認'
            : confirmed ? candidate.side === 'short' ? '站回VWAP失敗' : '跌破VWAP後收復' : 'VWAP穿越，等待後續確認',
        detail: setup === 'pullback' ? confirmed ? '後續已收5分K收盤突破回踩K高／低；僅研究，不下單'
            : '前2根同側且EMA3／8同向，回踩EMA8後等待3根內重新走強／弱'
            : confirmed ? '穿越後3根內已收5分K再次收回原側；僅研究，不下單'
                : '先穿越VWAP，等待之後3根已收5分K是否返回原側',
        side: candidate.side, setup, asOf: time, patternTime: candidate.time,
        confirmedAt: confirmed ? time : undefined, vwap: values.get(time),
    });
    let pullback: Candidate | undefined;
    let reclaim: Candidate | undefined;
    let pullbackResult: ResearchSetupEvaluation | undefined;
    let reclaimResult: ResearchSetupEvaluation | undefined;
    for (let index = 0; index < bars.length; index++) {
        const bar = bars[index]!;
        if (bar.volume <= 0) {
            pullback = undefined;
            reclaim = undefined;
            continue;
        }
        const currentSide = sideAt(index);
        let pullbackConfirmed = false;
        let reclaimConfirmed = false;
        // Existing candidates are inspected BEFORE new candidates can be armed:
        // the initial bar can never also confirm itself.
        if (pullback) {
            const age = index - pullback.index;
            if (age > EXPIRY_BARS || currentSide !== pullback.side || !aligned(index, pullback.side)) pullback = undefined;
            else if (age >= 1 && (pullback.side === 'long' ? bar.close > pullback.high : bar.close < pullback.low)) {
                if (index === bars.length - 1) pullbackResult = build(pullback, 'pullback', true, bar.time);
                pullback = undefined;
                pullbackConfirmed = true;
            }
        }
        if (reclaim) {
            const age = index - reclaim.index;
            if (age > EXPIRY_BARS) reclaim = undefined;
            else if (age >= 1 && currentSide === reclaim.side) {
                if (index === bars.length - 1) reclaimResult = build(reclaim, 'failed-reclaim', true, bar.time);
                reclaim = undefined;
                reclaimConfirmed = true;
            }
        }
        if (!pullback && !pullbackConfirmed && index >= 2 && currentSide && aligned(index, currentSide)
            && sideAt(index - 1) === currentSide && sideAt(index - 2) === currentSide
            && aligned(index - 1, currentSide) && aligned(index - 2, currentSide)) {
            const line = slow.get(bar.time)!;
            if (bar.low <= line && bar.high >= line) pullback = {
                side: currentSide, index, time: bar.time, high: bar.high, low: bar.low,
            };
        }
        if (!reclaim && !reclaimConfirmed && currentSide && index >= 1) {
            const previousSide = sideAt(index - 1);
            if (previousSide && previousSide !== currentSide) reclaim = {
                side: previousSide, index, time: bar.time, high: bar.high, low: bar.low,
            };
        }
    }
    // The state machines are independent. This compact card shows a latest
    // confirmation before a pending pattern; a tie uses failed-reclaim first.
    if (reclaimResult || pullbackResult) return reclaimResult ?? pullbackResult!;
    if (reclaim) return build(reclaim, 'failed-reclaim', false, last.time);
    if (pullback) return build(pullback, 'pullback', false, last.time);
    const side = sideAt(bars.length - 1);
    return { state: 'observing', label: '觀察中', asOf: last.time, side,
        vwap: values.get(last.time), detail: !side ? '收盤位於VWAP，方向中性，不確認型態'
            : !slow.has(last.time) ? '固定5分EMA3／8暖機中；VWAP型態獨立觀察'
                : '尚無最新已收5分K型態確認；歷史確認不重複亮燈' };
}
