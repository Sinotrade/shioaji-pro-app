// src/lib/us/us-tape.ts — 成交明細（TickTape）的美股資料轉接
//
// 成交明細面板台股、美股共用同一個元件；美股差在資料來源：
//   - 歷史：最近一個有成交的美東交易日的最後 N 筆，時間到微秒（美東）。
//     SDK 1.8.0 起要全部時段（盤前／盤中／盤後／夜盤），今天盤前的成交重開
//     App 也看得到；成交種類跟即時訂閱同一個設定（漏斗鈕）：一般成交
//     full=false（Tick／TICL）、完整成交 full=true（TickFull）。舊 sidecar
//     忽略這些參數，只回一般盤（含收盤競價）。
//   - 即時：每筆成交的通知（recordUsTick），帶微秒時間與內外盤；盤前／盤中／
//     盤後都列（明細是逐筆紀錄，不像走勢只畫一般盤）。
// 歷史回來時與載入期間收到的即時列去重，跨日時標日期分隔。

import type { ContractBase } from '../types/contract';
import { fetchUsTicks, US_TAPE_SESSIONS, type UsHistoryTick } from './us-history';
import type { UsTickDetail } from './us-tick-prefs';
import { isUsTiclTrade, nyDateTime, usTradeDateOf, type UsTickMeta } from './us-quotes';

/** 成交明細的一列（台股、美股共用；美股另帶 ts／date 供去重與跨日分隔） */
export interface TapeRow {
    id: number; // monotonic — stable React key
    time: string; // HH:MM:SS.ffffff
    close: number | string;
    volume: number;
    tick_type: number; // 1=buy 2=sell 0=unknown
    /** 美股：epoch µs（去重與排序用，保留原始精度） */
    ts?: number;
    /** 美股：美東日期 YYYY-MM-DD（跨日分隔用） */
    date?: string;
    /** 美股即時列：是不是一般成交（Tick／TICL 的定義，見 isUsTiclTrade）；false＝零股、特殊條件成交 */
    ticl?: boolean;
}

let rowSeq = 0;
export const nextTapeRowId = () => rowSeq++;

function fmtTime(t: string): string {
    const [hms = '', frac = ''] = t.split('.');
    return `${hms}.${frac.padEnd(6, '0').slice(0, 6)}`;
}

/** 歷史列（時間遞增）→ 明細列（新的在上） */
export function usTapeRowsFromHistory(ticks: readonly UsHistoryTick[], max: number): TapeRow[] {
    const out: TapeRow[] = [];
    for (let i = ticks.length - 1; i >= 0 && out.length < max; i--) {
        const t = ticks[i]!;
        out.push({ id: nextTapeRowId(), ts: t.tsUs, time: fmtTime(t.time), date: nyDateTime(t.tsUs).date, close: String(t.price), volume: t.volume, tick_type: t.tickType });
    }
    return out;
}

/** 即時成交 → 明細列（美東時間到微秒） */
export function usTapeRowFromMeta(meta: UsTickMeta): TapeRow {
    const us = meta.tsUs ?? meta.ts * 1000;
    const { date, time } = nyDateTime(us);
    return { id: nextTapeRowId(), ts: Math.floor(us), time: `${time}.${String(Math.floor(us) % 1_000_000).padStart(6, '0')}`, date, close: meta.price, volume: meta.volume, tick_type: meta.tickType ?? 0, ticl: isUsTiclTrade(meta) };
}

/**
 * 明細要列的即時列：一般成交（Tick）只列 TICL 定義的成交。設定剛從完整成交切回來時，
 * 改訂還沒完成（排隊、限速、退訂失敗）前 TickFull 的零股、特殊條件成交仍會進來，
 * 不能混進重抓的一般成交歷史裡。
 */
export const usTapeRowShown = (row: Pick<TapeRow, 'ticl'>, detail: UsTickDetail) => detail === 'TickFull' || row.ticl !== false;

/** 歷史的 ns 時間經 JSON 數字傳遞後只準到 ±1 µs（見 us-history usTimeToUs） */
export const TAPE_DEDUPE_TOLERANCE_US = 1;

/**
 * 歷史回來時與載入期間收到的即時列合併：即時列若與某筆歷史同價、同量、時間
 * 相差不超過 1 µs，就視為同一筆丟掉（每筆歷史只抵銷一筆）；合併後依時間
 * 新到舊、取前 max 筆。
 */
export function mergeUsTape(live: readonly TapeRow[], hist: readonly TapeRow[], max: number): TapeRow[] {
    const pool = new Map<string, number[]>();
    const keyOf = (r: TapeRow) => `${Number(r.close)}|${r.volume}`;
    for (const r of hist) {
        const list = pool.get(keyOf(r)) ?? [];
        list.push(r.ts ?? 0);
        pool.set(keyOf(r), list);
    }
    // 先配完全相同的 µs，再配 ±1 µs 的剩餘列 — 即時列可能不按時間到達，
    // 一次貪婪配對會讓近似配對搶走別人的完全配對
    const matched = new Set<TapeRow>();
    for (const tol of [0, TAPE_DEDUPE_TOLERANCE_US]) {
        for (const r of live) {
            if (matched.has(r)) continue;
            const list = pool.get(keyOf(r));
            const i = list ? list.findIndex(ts => Math.abs(ts - (r.ts ?? 0)) <= tol) : -1;
            if (i < 0) continue;
            list!.splice(i, 1);
            matched.add(r);
        }
    }
    const fresh = live.filter(r => !matched.has(r));
    return [...fresh, ...hist]
        .map((r, i) => [r, i] as const)
        .sort((a, b) => (b[0].ts ?? 0) - (a[0].ts ?? 0) || a[1] - b[1])
        .map(([r]) => r)
        .slice(0, max);
}

/**
 * 明細跨日時要標日期：盤前只有即時列、歷史是前一交易日，兩天的列接在一起。
 * 回傳要在哪一列之前插入日期分隔（第一列不是美東今天時也標）。沒有 date 的列
 * （台股）不標。
 */
export function usTapeDayBreaks(rows: readonly Pick<TapeRow, 'date'>[], today: string): Map<number, string> {
    const out = new Map<number, string>();
    rows.forEach((r, i) => {
        if (!r.date) return;
        const prev = i === 0 ? today : rows[i - 1]!.date;
        if (r.date !== prev) out.set(i, r.date);
    });
    return out;
}

/**
 * 從目前的交易日往前找最近一個有成交的交易日（跳過週末，最多 6 天）。交易日照
 * usTradeDateOf：美東 20:00 之後的夜盤成交歸下一個交易日，所以晚上先查明天（週日
 * 晚上查週一）；那天還沒有成交（夜盤還沒開、或這個 sidecar 沒有夜盤）就照舊往前找。
 * detail 是即時訂閱的成交種類（us-tick-prefs）：歷史與即時用同一個定義，去重才對得上。
 * count 遠小於一次上限（US_TICKS_MAX_ROWS），不必用 offset 分頁。
 */
export async function loadUsTapeHistory(contract: Pick<ContractBase, 'code' | 'exchange'>, count: number, detail: UsTickDetail = 'Tick', nowMs = Date.now()): Promise<UsHistoryTick[]> {
    const start = Date.parse(`${usTradeDateOf(nowMs * 1000, 'Overnight')}T12:00:00Z`);
    for (let d = 0; d <= 6; d++) {
        const date = new Date(start - d * 86_400_000).toISOString().slice(0, 10);
        const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const ticks = await fetchUsTicks(contract, date, { lastCnt: count, full: detail === 'TickFull', sessions: US_TAPE_SESSIONS });
        if (ticks.length > 0) return ticks;
    }
    return [];
}
