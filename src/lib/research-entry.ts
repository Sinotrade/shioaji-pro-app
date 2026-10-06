import { ema, v9AtrDefense } from './indicators';
import { sessionBarBucket, sessionWindowFor } from './intraday-session';
import type { SecurityType } from './types/contract';
import type { Candle } from './types/market';
import { supertrendShortTradeMarkers, supertrendTradeMarkers } from './utils/v9-chart-markers';

/** Inputs are shared across chart views. Five-minute timestamps are minute-END
 * labels, not candle-open timestamps. No API request, execution or parameter
 * optimization is performed by this display-only inspection. */
export interface ResearchEntryContext {
    closedFiveMinuteBars: Candle[];
    securityType: SecurityType;
    now: number;
}

export interface ResearchEntryCheck {
    id: 'data' | 'ema' | 'atr' | 'trigger';
    label: string;
    state: 'pass' | 'wait' | 'missing';
    detail: string;
}

export interface ResearchEntryEvaluation {
    side: 'long' | 'short';
    label: '等待資料' | '等待確認' | '等待觸發' | '研究觸發多' | '研究觸發空';
    checks: ResearchEntryCheck[];
    asOf?: number;
}

/** Inspect existing EMA3/8, V9 ATR14/2 and SuperTrend10/3 on one fixed,
 * closed five-minute series. This is NOT the formal entry strategy. A prior
 * flip is never recycled as a new trigger, even if directions later align. */
export function researchEntry(context: ResearchEntryContext, side: 'long' | 'short'): ResearchEntryEvaluation {
    const { now, securityType } = context;
    const minuteBars = new Map<number, Candle>();
    for (const bar of context.closedFiveMinuteBars) {
        if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
            || bar.time > now || bar.volume < 0 || bar.low > Math.min(bar.open, bar.close)
            || bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low) continue;
        const win = sessionWindowFor(securityType, bar.time);
        if (bar.time <= win.start || bar.time > win.end || sessionBarBucket(securityType, bar.time, 5) !== bar.time) continue;
        minuteBars.set(bar.time, bar);
    }
    const bars = [...minuteBars.values()].sort((a, b) => a.time - b.time);
    const last = bars.at(-1);
    const win = sessionWindowFor(securityType, now);
    const expected = Math.min(win.end, win.start + Math.floor((now - win.start) / 300) * 300);
    const sessionCount = bars.filter(bar => bar.time > win.start && bar.time <= win.end).length;
    // v9AtrDefense's unchanged ATR14 warmup requires sessionBar > period.
    const warmupBars = 15;
    const dataReady = Number.isFinite(now) && !!last && last.time === expected
        && last.volume > 0 && sessionCount >= warmupBars;
    const checks: ResearchEntryCheck[] = [{
        id: 'data', label: '固定已收5分K', state: dataReady ? 'pass' : 'missing',
        detail: !Number.isFinite(now) ? '研究時鐘未確認'
            : !last || last.time !== expected ? '尚無本時段最新已收5分K，不沿用舊觸發'
              : last.volume <= 0 ? '最新5分K無成交量，不確認觸發'
                : sessionCount < warmupBars ? `ATR暖機：本時段 ${sessionCount}/${warmupBars} 根已收5分K`
                  : `本時段 ${sessionCount} 根已收5分K；切圖不改檢核週期`,
    }];
    if (!dataReady || !last) {
        checks.push(
            { id: 'ema', label: 'EMA3／EMA8', state: 'missing', detail: '等待固定5分K資料' },
            { id: 'atr', label: 'ATR(14,2)防守', state: 'missing', detail: '等待本時段ATR完成暖機' },
            { id: 'trigger', label: '最新SuperTrend(10,3)', state: 'missing', detail: '未評估最新收棒翻轉' },
        );
        return { side, label: '等待資料', checks, asOf: last?.time };
    }
    const fast = ema(bars, 3).at(-1)?.value;
    const slow = ema(bars, 8).at(-1)?.value;
    const emaReady = fast !== undefined && slow !== undefined;
    const emaAligned = emaReady && (side === 'long' ? fast > slow : fast < slow);
    checks.push({ id: 'ema', label: 'EMA3／EMA8', state: !emaReady ? 'missing' : emaAligned ? 'pass' : 'wait',
        detail: !emaReady ? 'EMA暖機資料不足'
            : emaAligned ? `5分EMA3${side === 'long' ? '＞' : '＜'}EMA8，與研究方向同向`
              : fast === slow ? '5分EMA3＝EMA8，方向中性' : `5分EMA排列尚未與${side === 'long' ? '多' : '空'}方同向`,
    });
    const rails = v9AtrDefense(bars, 14, 2, securityType, 5);
    const rail = (side === 'long' ? rails.up : rails.down).at(-1)?.value;
    const otherRail = (side === 'long' ? rails.down : rails.up).at(-1)?.value;
    const atrAligned = rail !== undefined && (side === 'long' ? last.close > rail : last.close < rail);
    checks.push({ id: 'atr', label: 'ATR(14,2)防守', state: atrAligned ? 'pass' : otherRail !== undefined ? 'wait' : 'missing',
        detail: atrAligned ? `5分${side === 'long' ? '多' : '空'}方ATR防守有效`
            : otherRail !== undefined ? `5分ATR目前為${side === 'long' ? '空' : '多'}方防守`
              : '5分ATR中性、零波動或防守已失效，尚無同向有效防守',
    });
    const markers = side === 'long' ? supertrendTradeMarkers(bars, 10, 3) : supertrendShortTradeMarkers(bars, 10, 3);
    const trigger = markers.some(marker => marker.time === last.time && marker.text === (side === 'long' ? '買' : '賣'));
    checks.push({ id: 'trigger', label: '最新SuperTrend(10,3)', state: trigger ? 'pass' : 'wait',
        detail: trigger ? `最新已收5分K新出現${side === 'long' ? '買' : '賣'}翻轉；僅研究觸發`
            : '最新已收5分K沒有同向新翻轉；歷史買／賣標記不重複當觸發',
    });
    const label = !emaAligned || !atrAligned ? '等待確認'
        : !trigger ? '等待觸發' : side === 'long' ? '研究觸發多' : '研究觸發空';
    return { side, label, checks, asOf: last.time };
}
