import { sessionWindowFor } from './intraday-session';
import type { ContractBase, SecurityType } from './types/contract';
import type { Candle } from './types/market';
import type { ResearchDataStatus } from './research-decision';

/** Includes the actual month: a continuous symbol can roll without changing code. */
export function chartScopeKey(contract: ContractBase, minutes: number): string {
    return JSON.stringify([contract.security_type, contract.exchange, contract.code, contract.target_code, minutes]);
}

/** Never expose the previous symbol/timeframe while a new request is in flight. */
export function scopedResearchSource(bars: Candle[], loadedKey: string, activeKey: string, loading: boolean): Candle[] {
    return !loading && loadedKey === activeKey ? bars.slice() : [];
}

/** Broker change is relative to its own reference, not the prior chart session. */
export function quoteChangePercent(close: number | undefined, change: number | undefined, reference?: number): number | undefined {
    if (close === undefined || change === undefined || !Number.isFinite(close) || !Number.isFinite(change)) return undefined;
    const base = reference ?? close - change;
    return Number.isFinite(base) && base > 0 ? change / base * 100 : undefined;
}

/** Display safety only; does not start downloads, subscribe, or execute a strategy.
 * Weekends are known; exchange holidays require an authoritative calendar and
 * conservatively remain 'no current-session data', never assumed live.
 */
export function researchDataStatus(bars: Candle[], securityType: SecurityType, now: number, loading: boolean,
    streamStatus?: 'live' | 'connecting' | 'down'): ResearchDataStatus {
    if (loading) return { state: 'loading', reason: '正在載入同商品 K 棒' };
    if (!Number.isFinite(now)) return { state: 'unknown', reason: '資料時間無法確認' };
    const win = sessionWindowFor(securityType, now);
    const weekday = new Date(win.start * 1000).getUTCDay();
    const inSession = now >= win.start && now <= win.end && weekday >= 1 && weekday <= 5;
    if (!inSession) return { state: 'closed', reason: '非交易時段，僅供休市回顧' };
    if (streamStatus && streamStatus !== 'live') return { state: 'unknown', reason: streamStatus === 'down'
        ? '行情串流中斷，暫停即時盤勢判讀' : '行情串流連線中，尚未確認即時資料' };
    const latest = bars.filter(bar => Number.isFinite(bar.time) && bar.time <= now && bar.time > win.start && bar.time <= win.end).at(-1)?.time;
    if (latest === undefined) return { state: 'unknown', reason: '尚無本時段已收一分 K；低流動性或休市亦可能無成交' };
    const age = Math.max(0, now - latest);
    if (age >= 180) return { state: 'stale', reason: `已收 K 棒落後 ${Math.floor(age / 60)} 分鐘，無法確認即時盤勢` };
    return { state: 'fresh', reason: `本時段已收 K 棒落後 ${Math.floor(age)} 秒` };
}
