// src/lib/us/us-session-view.ts — 美股報價的一般盤／延長時段顯示（自選清單、報價板共用）
//
// 照 TradingView／Robinhood 的慣例：
// - 主行：一般盤最新價（收盤後是一般盤收盤），漲跌與幅度對參考價（reference）。
//   盤前、夜盤（今天一般盤還沒開）主行是前一個交易日的收盤；當天漲跌是 0 時標「昨收」。
//   排序用的漲跌幅也是這一行。
// - 副行：只在有延長時段價時出現，盤前／盤後／夜盤圖示＋價格＋漲跌與幅度。
//   盤前與夜盤的基準是參考價（新交易日的參考價＝前一日一般盤收盤），盤後的基準是
//   當天一般盤收盤。
// - 一般盤沒有副行。盤後結束後保留最後的盤後價、轉灰，直到新交易日的資料
//   （夜盤或盤前成交）出現；沒有夜盤資料時（2026-12-06 前、週末）照 04:00 換日清掉。
//
// 交易日 D＝[D−1 20:00, D 20:00) ET：夜盤 20:00–24:00 的成交屬於下一個交易日。
//
// 資料（SDK UsTick）：close／open／high／low／price_chg／pct_chg 是一般盤狀態，只有
// updates_last 的成交會動（零股、盤前盤後夜盤不動；收盤競價 session 可能是盤後但
// updates_last=true，算一般盤）；ext_close／ext_high／ext_low 是目前延長時段的值
// （只算整股），一般盤時是空的。快照另有 ext_close（沒有時 0）。

import type { SseTick } from '../types/market';
import type { UsSnapshot } from './us-history';
import { nextUsWeekday, nyDateTime, usChangeFrom, US_SESSION_LABEL } from './us-quotes';

/**
 * 美東時鐘的時段：
 * - pre 04:00–09:30、regular 09:30–16:00、post 16:00–20:00（週一到週五）
 * - overnight 夜盤：週日到週四 20:00 起到隔天 04:00（2026-12-06 前沒有夜盤成交，
 *   這段等於收盤：保留轉灰的盤後價）
 * - closed：週五 20:00 到週日 20:00
 */
export type UsClockPhase = 'pre' | 'regular' | 'post' | 'overnight' | 'closed';

export interface UsClock {
    phase: UsClockPhase;
    /** 目前的交易日（夜盤 20:00 後是下一個交易日；週末是下週一） */
    date: string;
    /** 最近一段已開始的盤後屬於哪個交易日（收盤、夜盤時保留它的盤後價用） */
    lastPost: string;
}

const H = 3600;
/** 時段界線（美東當地，距午夜秒數）；20:00 同時是盤後結束與夜盤開始 */
export const US_SESSION_BOUNDARIES = [4 * H, 9.5 * H, 16 * H, 20 * H] as const;

const prevWeekday = (d: string) => {
    let t = Date.parse(`${d}T00:00:00Z`) - 86_400_000;
    while ([0, 6].includes(new Date(t).getUTCDay())) t -= 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
};

/** nowMs 當下的美東時段、交易日 */
export function usMarketPhase(nowMs: number): UsClock {
    const { date, time } = nyDateTime(nowMs * 1000);
    if (!date) return { phase: 'closed', date: '', lastPost: '' };
    const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number];
    const tod = hh * H + mm * 60 + ss;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [pre, open, close, end] = US_SESSION_BOUNDARIES;
    // 週五 20:00 到週日 20:00：收盤，交易日是下週一，保留週五的盤後
    if (dow === 6 || (dow === 0 && tod < end) || (dow === 5 && tod >= end)) {
        return { phase: 'closed', date: nextUsWeekday(date, dow === 5 ? 1 : 0), lastPost: dow === 5 ? date : prevWeekday(date) };
    }
    if (tod >= end) {
        // 週日到週四晚上：夜盤，交易日是下一個平日；盤後是今天的（週日是上週五的）
        return { phase: 'overnight', date: nextUsWeekday(date, 1), lastPost: dow === 0 ? prevWeekday(date) : date };
    }
    if (tod < pre) return { phase: 'overnight', date, lastPost: prevWeekday(date) };
    const phase: UsClockPhase = tod < open ? 'pre' : tod < close ? 'regular' : 'post';
    return { phase, date, lastPost: phase === 'post' ? date : prevWeekday(date) };
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
    /**
     * 這是前一個交易日的一般盤收盤（今天一般盤還沒成交：盤前、夜盤、或今天還沒有整股成交），
     * 而且當天的漲跌沒有意義（0 或沒有）：漲跌欄改標「昨收」，不顯示 0.00 0.00%
     */
    prevClose?: boolean;
}

export type UsExtSession = 'PreMarket' | 'AfterHours' | 'Overnight';

export interface UsExtLine {
    session: UsExtSession;
    label: string;
    price: number;
    chg?: number;
    pct?: number;
    /** 漲跌的基準（盤前、夜盤＝參考價，盤後＝當天一般盤收盤）；沒有基準時 null */
    base: number | null;
    high?: number;
    low?: number;
    /** 美東時間（HH:MM:SS），提示用 */
    time?: string;
    /** 盤後已結束（夜盤時段沒有夜盤資料、週末）：保留最後的值，畫面轉灰 */
    closed: boolean;
    /** 交易日 */
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

type ExtCandidate = { session: UsExtSession; price: number; high?: number; low?: number; date: string; ts: number; time?: string };

const isExtSession = (s: string | null | undefined): s is UsExtSession => s === 'PreMarket' || s === 'AfterHours' || s === 'Overnight';
/** 同一個交易日裡的先後：夜盤 → 盤前 → 盤後 */
const SESSION_ORDER: Record<UsExtSession, number> = { Overnight: 0, PreMarket: 1, AfterHours: 2 };

type ViewTick = Pick<SseTick, 'date' | 'close' | 'open' | 'price_chg' | 'pct_chg' | 'us'> & { time?: string };

/** tick 的交易日：新版帶 us.tradeDate，舊形狀用美東日期 */
export const usTickTradeDate = (tick: Pick<SseTick, 'date' | 'us'> | undefined) => tick?.us?.tradeDate || tick?.date || '';

function tickExt(tick: ViewTick | undefined): ExtCandidate | null {
    const us = tick?.us;
    if (!us || !isExtSession(us.session)) return null;
    const price = pos(us.extClose);
    const date = usTickTradeDate(tick);
    if (price === undefined || !date) return null;
    return { session: us.session, price, high: pos(us.extHigh), low: pos(us.extLow), date, ts: us.ts ?? 0, time: tick!.time?.slice(0, 8) };
}

function snapExt(snap: UsSnapshot | null | undefined): ExtCandidate | null {
    if (!snap?.tradeDate || snap.session === 'Regular') return null;
    // 只有正的 ext_close 才算延長時段價（last_price 可能是零股或收盤競價）
    const price = pos(snap.extClose);
    if (price === undefined) return null;
    // 20:00 後快照的 session 可能不再標盤後：有 ext_close 又不是盤前、夜盤，就是那天的盤後
    const session: UsExtSession = isExtSession(snap.session) ? snap.session : 'AfterHours';
    const time = snap.ts ? nyDateTime(snap.ts * 1000).time : undefined;
    return { session, price, high: pos(snap.extHigh), low: pos(snap.extLow), date: snap.tradeDate, ts: snap.ts ?? 0, time };
}

/**
 * 這一筆延長時段值現在要不要顯示，以及是否轉灰（null＝不顯示）。
 * 以資料的交易日與 session 為準：新交易日的夜盤或盤前成交一到就取代前一日的盤後；
 * 沒有新資料時才照時鐘（04:00 盤前開始）清掉。
 */
function extState(c: ExtCandidate, now: UsClock): 'live' | 'closed' | null {
    const { phase, date } = now;
    if (phase === 'pre') return (c.session === 'PreMarket' || c.session === 'Overnight') && c.date === date ? 'live' : null;
    // 一般盤時段 ext_close 本來就是空的；提早收盤日 13:00 起的盤後成交照樣顯示
    if (phase === 'regular' || phase === 'post') return c.session === 'AfterHours' && c.date === date ? 'live' : null;
    if (phase === 'overnight' && c.session === 'Overnight' && c.date === date) return 'live';
    // 夜盤時段還沒有夜盤成交、週末：留最近那段盤後，轉灰
    return c.session === 'AfterHours' && c.date === now.lastPost ? 'closed' : null;
}

/**
 * 一般盤主行與延長時段副行。reference 是現在這個交易日的參考價（pickUsReference）；
 * now 是 usMarketPhase 的結果。
 */
export function usSessionView(args: {
    tick?: ViewTick;
    snap?: UsSnapshot | null;
    reference: string | null;
    now: UsClock;
}): UsSessionView {
    const { tick, snap, reference, now } = args;
    const us = tick?.us;
    // 一般盤價：新版 tick 看 us.regular（SDK close）；舊形狀（測試、沒有 us 欄位）就是 close
    const regular = us ? pos(us.regular) : pos(tick?.close);
    // 這個交易日的一般盤開始了沒：SDK 的 open 在一般盤第一筆成交前是空的（盤前、夜盤）
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
    // 主行：較新的那一個（先比交易日，同一天再比時間；斷線後的舊 tick 不蓋過新快照）。
    // 盤前、夜盤（一般盤還沒開）用快照；都沒有才退回 tick 帶的一般盤值
    const tickDate = usTickTradeDate(tick);
    const tickNewer = !snap?.tradeDate || !tickDate || tickDate > snap.tradeDate
        || (tickDate === snap.tradeDate && (!snapMain || !(snap.open > 0) || !snap.ts || !us?.ts || us.ts >= snap.ts));
    const live = started && tickNewer ? tickMain() : null;
    // tick 已是較新的交易日（夜盤、盤前，快照還是前一天）：用 tick 帶的一般盤值（＝前一日收盤），
    // 不留前一天快照的漲跌
    const tickNewerDay = !!tickDate && !!snap?.tradeDate && tickDate > snap.tradeDate;
    // 新交易日的參考價＝前一日一般盤收盤，比前一天的舊快照（可能停在盤中）準
    const refMain: UsMainLine | null = tickNewerDay && pos(reference) ? { price: pos(reference)! } : null;
    const fallback = live ? null : (tickNewerDay ? tickMain() ?? refMain ?? snapMain : snapMain ?? tickMain());
    // 退回的值是不是前一日收盤：快照當天還沒有一般盤開盤價（盤前快照 close＝前一日收盤），
    // 或用的是還沒開盤的 tick 帶的一般盤值
    const fromPrev = !!fallback && (fallback === snapMain ? !(snap!.open > 0) : !started);
    // tick 已進入新交易日（夜盤）而一般盤值只能取前一天的快照：那天的漲跌不屬於新交易日，一律標昨收
    const main = live ?? (fallback && ((fromPrev && !fallback.chg) || (tickNewerDay && (fallback === snapMain || fallback === refMain)))
        ? { ...fallback, chg: undefined, pct: undefined, prevClose: true }
        : fallback);

    // 同一個交易日裡較新的資料已換到別的時段（例如夜盤 → 盤前、ext_* 已歸零），舊時段的值不再顯示；
    // session 不明（20:00 後的快照）不算換時段
    const markers: { date: string; session: string; ts: number }[] = [];
    if (us && tickDate) markers.push({ date: tickDate, session: us.session, ts: us.ts ?? 0 });
    if (snap?.tradeDate && snap.session) markers.push({ date: snap.tradeDate, session: snap.session, ts: snap.ts ?? 0 });
    // 兩邊都有時間才比（沒有時間的舊形狀資料不判定）
    const superseded = (c: ExtCandidate) => c.ts > 0 && markers.some(m => m.date === c.date && m.ts > c.ts
        && m.session !== 'Unknown' && m.session !== c.session);
    const shown = [tickExt(tick), snapExt(snap)]
        .filter((c): c is ExtCandidate => !!c && !superseded(c))
        .map(c => ({ c, state: extState(c, now) }))
        .filter((x): x is { c: ExtCandidate; state: 'live' | 'closed' } => !!x && x.state !== null);
    // 交易日較新的優先，同一天先比時段先後，再比時間
    shown.sort((a, b) => (a.c.date !== b.c.date ? (a.c.date < b.c.date ? 1 : -1)
        : SESSION_ORDER[b.c.session] - SESSION_ORDER[a.c.session] || b.c.ts - a.c.ts));
    const top = shown[0];
    if (!top) return { main, ext: null };
    const pick = top.c;
    // 盤前、夜盤對參考價（新交易日的參考價＝前一日收盤；沒有就用主行，那時主行就是前一日收盤）；
    // 盤後對當天一般盤收盤
    const base = pick.session === 'AfterHours'
        ? main?.price ?? null
        : pos(reference) ?? main?.price ?? null;
    const chg = base !== null ? pick.price - base : undefined;
    return {
        main,
        ext: {
            session: pick.session,
            label: US_SESSION_LABEL[pick.session],
            price: pick.price,
            chg,
            pct: chg !== undefined && base ? (chg / base) * 100 : undefined,
            base,
            high: pick.high,
            low: pick.low,
            ...(pick.time ? { time: pick.time } : {}),
            closed: top.state === 'closed',
            date: pick.date,
        },
    };
}

/** 副行／副區塊的滑過提示（自選與報價板共用）：時段、價格、時間、高低、漲跌基準 */
export function usExtTitle(ext: UsExtLine, fmt: (v: number) => string): string {
    return [
        `${ext.label}${ext.closed ? '（已收盤）' : ''} ${fmt(ext.price)}${ext.time ? `　美東 ${ext.time}` : ''}`,
        ext.high !== undefined && ext.low !== undefined ? `${ext.label}高 ${fmt(ext.high)}　低 ${fmt(ext.low)}` : undefined,
        ext.base !== null ? `${ext.session === 'AfterHours' ? '對一般盤收盤' : '對參考價（前一日收盤）'} ${fmt(ext.base)}` : undefined,
    ].filter(Boolean).join('\n');
}
