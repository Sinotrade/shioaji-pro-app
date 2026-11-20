// src/lib/us/us-session-view.ts — 美股報價的一般盤／延長時段顯示（自選清單、報價板共用）
//
// 照 TradingView／Robinhood 的慣例：
// - 主行：一般盤最新價（收盤後是一般盤收盤），漲跌與幅度對參考價（reference）。
//   盤前主行是前一個交易日的收盤與它的漲跌（快照 close／change_price）。
//   排序用的漲跌幅也是這一行。
// - 副行：只在有延長時段成交時出現，「盤前」或「盤後」＋延長時段價＋漲跌與幅度。
//   盤前的基準是參考價（前一日收盤），盤後的基準是當天一般盤收盤。
// - 一般盤沒有副行。盤後結束（20:00–04:00 ET、週末）保留最後的盤後價、轉灰；
//   04:00 新的盤前開始（新的交易日）時清掉。
//
// 資料（SDK UsTick）：close／open／high／low／price_chg／pct_chg 是一般盤狀態，只有
// updates_last 的成交會動（零股、盤前盤後不動；收盤競價 session 可能是盤後但
// updates_last=true，算一般盤）；ext_close／ext_high／ext_low 是目前盤前或盤後
// 的值（只算整股），一般盤時是空的。快照另有 ext_close 與 last_price。

import type { SseTick } from '../types/market';
import type { UsSnapshot } from './us-history';
import { nyDateTime, usChangeFrom } from './us-quotes';

/** 美東時鐘的時段：盤前 04:00–09:30、一般盤 09:30–16:00、盤後 16:00–20:00，其餘（含週末）為收盤 */
export type UsClockPhase = 'pre' | 'regular' | 'post' | 'closed';

const H = 3600;
/** 時段界線（美東當地，距午夜秒數） */
export const US_SESSION_BOUNDARIES = [4 * H, 9.5 * H, 16 * H, 20 * H] as const;

/** nowMs 當下的美東日期與時段 */
export function usMarketPhase(nowMs: number): { phase: UsClockPhase; date: string } {
    const { date, time } = nyDateTime(nowMs * 1000);
    if (!date) return { phase: 'closed', date: '' };
    const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number];
    const tod = hh * H + mm * 60 + ss;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return { phase: 'closed', date };
    const [pre, open, close, end] = US_SESSION_BOUNDARIES;
    const phase: UsClockPhase = tod < pre || tod >= end ? 'closed' : tod < open ? 'pre' : tod < close ? 'regular' : 'post';
    return { phase, date };
}

/**
 * 距離下一個時段界線（或美東午夜）的毫秒數，最多 30 分鐘（夏令時間切換那天
 * 牆鐘會跳一小時，分段重算就不會錯過界線）。
 */
export function msToNextUsBoundary(nowMs: number): number {
    const { time } = nyDateTime(nowMs * 1000);
    const [hh, mm, ss] = (time || '0:0:0').split(':').map(Number) as [number, number, number];
    const tod = hh * H + mm * 60 + ss + (nowMs % 1000) / 1000;
    const next = [...US_SESSION_BOUNDARIES, 24 * H].find(b => b > tod) ?? 24 * H;
    return Math.min(30 * 60_000, Math.max(1000, Math.ceil((next - tod) * 1000) + 250));
}

export interface UsMainLine {
    price: number;
    chg?: number;
    pct?: number;
}

export interface UsExtLine {
    session: 'PreMarket' | 'AfterHours';
    label: '盤前' | '盤後';
    price: number;
    chg?: number;
    pct?: number;
    /** 漲跌的基準（盤前＝參考價，盤後＝當天一般盤收盤）；沒有基準時 null */
    base: number | null;
    high?: number;
    low?: number;
    /** 盤後已結束（20:00–04:00、週末）：保留最後的值，畫面轉灰 */
    closed: boolean;
    /** 美東交易日 */
    date: string;
}

export interface UsSessionView {
    main: UsMainLine | null;
    ext: UsExtLine | null;
}

const pos = (v: string | number | null | undefined) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
};
const fin = (v: string | number | null | undefined) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : undefined;
};

type ExtCandidate = { session: UsExtLine['session']; price: number; high?: number; low?: number; date: string };

function tickExt(tick: Pick<SseTick, 'date' | 'us'> | undefined): ExtCandidate | null {
    const us = tick?.us;
    if (!us || (us.session !== 'PreMarket' && us.session !== 'AfterHours')) return null;
    const price = pos(us.extClose);
    if (price === undefined || !tick!.date) return null;
    return { session: us.session, price, high: pos(us.extHigh), low: pos(us.extLow), date: tick!.date };
}

function snapExt(snap: UsSnapshot | null | undefined): ExtCandidate | null {
    if (!snap?.tradeDate || snap.session === 'Regular') return null;
    const ext = pos(snap.extClose);
    const explicit = snap.session === 'PreMarket' || snap.session === 'AfterHours';
    // 快照的延長時段價：ext_close 優先；session 明確是盤前／盤後時才拿 last_price 墊
    const price = ext ?? (explicit ? pos(snap.lastPrice) : undefined);
    if (price === undefined) return null;
    // 20:00 後快照的 session 可能不再標盤後：有 ext_close 又不是盤前，就是那天的盤後
    const session = snap.session === 'PreMarket' ? 'PreMarket' : 'AfterHours';
    return { session, price, high: pos(snap.extHigh), low: pos(snap.extLow), date: snap.tradeDate };
}

/** 這一筆延長時段值在現在的時段要不要顯示 */
function extShows(c: ExtCandidate, phase: UsClockPhase, today: string): boolean {
    if (phase === 'pre') return c.session === 'PreMarket' && c.date === today;
    // 一般盤時段 ext_close 本來就是空的；提早收盤日 13:00 起的盤後成交照樣顯示
    if (phase === 'regular' || phase === 'post') return c.session === 'AfterHours' && c.date === today;
    // 收盤（20:00–04:00、週末）：留最後的盤後價，到 04:00 新的盤前才清
    return c.session === 'AfterHours' && (!today || c.date <= today);
}

/**
 * 一般盤主行與延長時段副行。reference 是 tick（或快照）交易日的參考價
 * （pickUsReference）；now 是 usMarketPhase 的結果。
 */
export function usSessionView(args: {
    tick?: Pick<SseTick, 'date' | 'close' | 'open' | 'price_chg' | 'pct_chg' | 'us'>;
    snap?: UsSnapshot | null;
    reference: string | null;
    now: { phase: UsClockPhase; date: string };
}): UsSessionView {
    const { tick, snap, reference, now } = args;
    const us = tick?.us;
    // 一般盤價：新版 tick 看 us.regular（SDK close）；舊形狀（測試、沒有 us 欄位）就是 close
    const regular = us ? pos(us.regular) : pos(tick?.close);
    // 今天的一般盤開始了沒：SDK 的 open 在一般盤第一筆成交前是空的（盤前）
    const started = !!tick && regular !== undefined && (!us || pos(tick.open) !== undefined);
    const snapMain: UsMainLine | null = snap && snap.close > 0
        ? { price: snap.close, chg: fin(snap.changePrice), pct: fin(snap.changeRate) }
        : null;
    const tickMain = (): UsMainLine | null => {
        if (!tick || regular === undefined) return null;
        const own = usChangeFrom(String(us ? us.regular : tick.close), reference);
        const chg = fin(own.priceChg ?? (us ? us.regularChg : tick.price_chg));
        const pct = fin(own.pctChg ?? (us ? us.regularPct : tick.pct_chg));
        return { price: regular, chg, pct };
    };
    // 主行：今天一般盤已開始的即時值優先；盤前（還沒開）或 tick 比快照舊時用快照
    //（盤前快照的 close 是前一日收盤、漲跌也是前一日的）；都沒有才退回 tick 帶的一般盤值
    const tickNewer = !snap?.tradeDate || !tick?.date || tick.date >= snap.tradeDate;
    const main = (started && tickNewer ? tickMain() : null) ?? snapMain ?? tickMain();

    const candidates = [tickExt(tick), snapExt(snap)].filter((c): c is ExtCandidate => !!c && extShows(c, now.phase, now.date));
    // 兩個都可以顯示時取交易日較新的；同一天以即時為準
    const pick = candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
    if (!pick) return { main, ext: null };
    // 盤前對參考價（前一日收盤；沒有就用主行，盤前主行就是前一日收盤）；盤後對當天一般盤收盤
    const base = pick.session === 'PreMarket'
        ? pos(reference) ?? main?.price ?? null
        : main?.price ?? null;
    const chg = base !== null ? pick.price - base : undefined;
    return {
        main,
        ext: {
            session: pick.session,
            label: pick.session === 'PreMarket' ? '盤前' : '盤後',
            price: pick.price,
            chg,
            pct: chg !== undefined && base ? (chg / base) * 100 : undefined,
            base,
            high: pick.high,
            low: pick.low,
            closed: now.phase === 'closed',
            date: pick.date,
        },
    };
}
