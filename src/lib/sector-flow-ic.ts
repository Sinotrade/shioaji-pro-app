// src/lib/sector-flow-ic.ts — 族群（官方產業別）資金流，取自 產業全景 已在用的
// index_components 群組指標串流（IX0001 加權／IX0043 櫃買 × 成交值、加權漲跌）。
//
// 為什麼不用 1 分 K：產業別成員上千檔，1 分 K 只訂了產業鏈／題材的成分股；
// 群組指標由伺服器直接彙總整個產業，串流 ≤1 秒一包，與 產業全景 共用同一組
// ref-count 訂閱（產業全景開著時不多任何請求）。
//
// 每分鐘的估算（與 1 分 K 的 amount × sign(close − 前收) 同一個規則）：
// - 成交值：該分鐘最後一包的累計成交值 − 前一分鐘最後一包（或開始記錄時的基準）。
// - 方向：該分鐘最後的加權漲跌 vs 前一分鐘；漲＝流入、跌＝流出、平＝0。
// - 族群漲跌：各市場同產業別的加權漲跌，依累計成交值加權（加權與櫃買的
//   權重分母不同，無法直接用參考權重合併）。
// 只在面板開著（retain）期間記錄；中斷後重設基準，不把空窗的成交值灌進一分鐘。

import { useEffect, useSyncExternalStore } from 'react';
import { SESSION_SLOTS, WINDOW, type GroupFlow } from './chain-flow';
import { getIcState, parseCalculatedAtNs, projectionKey, retainIndexComponents, subscribeIcStore } from './index-components';
import { streamConnectionEpoch } from './stream';
import type { ContractBase } from './types/contract';
import type { IcProjection } from './types/market';

export const IC_INDICES = {
    IX0001: { security_type: 'IND', region: 'TW', exchange: 'TSE', code: 'IX0001', target_code: null },
    IX0043: { security_type: 'IND', region: 'TW', exchange: 'OTC', code: 'IX0043', target_code: null },
} as const satisfies Record<string, ContractBase>;
export type IcIndexCode = keyof typeof IC_INDICES;

export const GM_AMOUNT: IcProjection = { kind: 'group_metric', metric: 'amount' };
export const GM_WPERF: IcProjection = { kind: 'group_metric', metric: 'weighted_performance' };

/** Group key in the index_components stream: `${index}:${category}`. */
export type IcKey = string;

/** The group of a stock in the index_components stream (market → index, industry code → category). */
export function icKeyOf(market: string | null | undefined, industryCode: string | null | undefined): IcKey | null {
    const index: IcIndexCode | null = market === 'twse' ? 'IX0001' : market === 'tpex' ? 'IX0043' : null;
    if (!index || !industryCode) return null;
    const n = Number(industryCode);
    if (!Number.isInteger(n) || n <= 0) return null;
    return `${index}:${n}`;
}

/** Taipei wall-clock minute slot of a calculated_at timestamp (09:00 = 0), closing auction folded into 13:30. */
export function icSlot(calculatedAt: string | undefined): number | null {
    const ns = parseCalculatedAtNs(calculatedAt);
    if (ns === null) return null;
    const minutes = Math.floor(Number(ns / 1_000_000n) / 60_000);
    const local = (((minutes + 8 * 60) % 1440) + 1440) % 1440;
    const slot = local - 9 * 60;
    if (slot < 0) return null;
    if (slot < SESSION_SLOTS) return slot;
    return slot < SESSION_SLOTS + 4 ? SESSION_SLOTS - 1 : null;
}

interface Series {
    count: number;
    /** Last amount / weighted change seen in each minute (NaN = none). */
    endA: Float64Array;
    endP: Float64Array;
    /** Baseline of a recording span starting in that minute (NaN = no span starts there). */
    startA: Float64Array;
    startP: Float64Array;
    /** Minute the current span started in. */
    floor: number;
    lastA: number;
    lastP: number | null;
    /** The next amount / change sample starts a new span (first sample or after a gap). */
    rebaseA: boolean;
    rebaseP: boolean;
}

function newSeries(): Series {
    const blank = () => new Float64Array(SESSION_SLOTS).fill(NaN);
    return {
        count: 0,
        endA: blank(),
        endP: blank(),
        startA: blank(),
        startP: blank(),
        floor: 0,
        lastA: 0,
        lastP: null,
        rebaseA: true,
        rebaseP: true,
    };
}

export interface IcGroupSample {
    category: string;
    item_count: number;
    value: number;
}

/** Minute-by-minute flow of index_components groups, rebuilt from cumulative group metrics. */
export class IcFlowRecorder {
    date: string | null = null;
    private series = new Map<IcKey, Series>();

    private at(key: IcKey) {
        let s = this.series.get(key);
        if (!s) {
            s = newSeries();
            this.series.set(key, s);
        }
        return s;
    }

    /** Adopt a newer trading day (clears); a state from an older day is ignored (false). */
    private day(date: string): boolean {
        if (this.date === date) return true;
        if (this.date !== null && date < this.date) return false;
        this.date = date;
        this.series.clear();
        return true;
    }

    /** Recording stopped (panel released the stream): the next samples start new spans. */
    rebase() {
        for (const s of this.series.values()) {
            s.rebaseA = true;
            s.rebaseP = true;
        }
    }

    sampleAmount(index: IcIndexCode, date: string, slot: number, groups: readonly IcGroupSample[]) {
        if (!this.day(date)) return;
        for (const g of groups) {
            if (!Number.isFinite(g.value)) continue;
            const s = this.at(`${index}:${g.category}`);
            s.count = g.item_count;
            if (s.rebaseA) {
                s.rebaseA = false;
                s.rebaseP = true;
                s.floor = slot;
                s.startA[slot] = g.value;
                s.startP[slot] = NaN;
            }
            s.endA[slot] = g.value;
            s.lastA = g.value;
        }
    }

    samplePerf(index: IcIndexCode, date: string, slot: number, groups: readonly IcGroupSample[]) {
        if (!this.day(date)) return;
        for (const g of groups) {
            if (!Number.isFinite(g.value)) continue;
            const s = this.at(`${index}:${g.category}`);
            s.lastP = g.value;
            // a change needs an amount span to belong to
            if (s.rebaseA) continue;
            if (s.rebaseP) {
                s.rebaseP = false;
                s.startP[s.floor] = g.value;
            }
            if (slot >= s.floor) s.endP[slot] = g.value;
        }
    }

    /** Weighted change in effect at the end of `slot`, never reaching back past its span's start. */
    private perfAt(s: Series, slot: number): number | null {
        for (let i = slot; i >= 0; i -= 1) {
            if (!Number.isNaN(s.endP[i]!)) return s.endP[i]!;
            if (!Number.isNaN(s.startA[i]!)) return Number.isNaN(s.startP[i]!) ? null : s.startP[i]!;
        }
        return null;
    }

    /**
     * GroupFlow-shaped aggregate of the given groups up to `now` (the latest
     * completed minute). Null before any of them has a sample. Breadth is not
     * in the group metrics (zeros); `count` is the groups' member count.
     */
    groupFlow(keys: Iterable<IcKey>, now: number | null): GroupFlow | null {
        const turnover = new Float64Array(SESSION_SLOTS);
        const net = new Float64Array(SESSION_SLOTS);
        let count = 0;
        let total = 0;
        let wSum = 0;
        let wPct = 0;
        let seen = false;
        for (const key of keys) {
            const s = this.series.get(key);
            if (!s || (s.rebaseA && s.lastA === 0)) continue;
            seen = true;
            count += s.count;
            total += s.lastA;
            if (s.lastP !== null && s.lastA > 0) {
                wSum += s.lastA;
                wPct += s.lastA * s.lastP;
            }
            let prevA = NaN;
            let prevP: number | null = null;
            for (let i = 0; i < SESSION_SLOTS; i += 1) {
                const a = s.endA[i]!;
                if (Number.isNaN(a)) continue;
                if (!Number.isNaN(s.startA[i]!)) {
                    // a new span: diff against its own baseline, never across the gap
                    prevA = s.startA[i]!;
                    prevP = Number.isNaN(s.startP[i]!) ? null : s.startP[i]!;
                }
                if (Number.isNaN(prevA)) continue;
                const d = a - prevA;
                const p = this.perfAt(s, i);
                if (d > 0) {
                    turnover[i] = turnover[i]! + d;
                    if (p !== null && prevP !== null) net[i] = net[i]! + (p > prevP ? d : p < prevP ? -d : 0);
                }
                prevA = a;
                prevP = p;
            }
        }
        if (!seen) return null;
        const cumNet = new Float64Array(SESSION_SLOTS);
        let run = 0;
        for (let i = 0; i < SESSION_SLOTS; i += 1) {
            run += net[i]!;
            cumNet[i] = run;
        }
        let flow5 = 0;
        let turnover5 = 0;
        if (now !== null) {
            for (let i = Math.max(0, now - WINDOW + 1); i <= now; i += 1) {
                flow5 += net[i]!;
                turnover5 += turnover[i]!;
            }
        }
        return {
            count,
            turnover,
            net,
            cumNet,
            flow5,
            turnover5,
            accel: null,
            total,
            pct: wSum > 0 ? wPct / wSum : null,
            breadth: { up: 0, flat: 0, down: 0 },
        };
    }
}

/** Shared recorder: one per app, fed while any 持股 panel retains the stream. */
export const icFlowRecorder = new IcFlowRecorder();

const STREAMS = (Object.keys(IC_INDICES) as IcIndexCode[]).flatMap((index) =>
    [GM_AMOUNT, GM_WPERF].map((projection) => ({ index, projection, key: projectionKey(projection) })),
);
/** calculated_at of the state last fed (or skipped as stale) per stream. */
const fed = new Map<string, string>();
let epoch = -1;

function stateOf(index: IcIndexCode, key: string) {
    const st = getIcState(index, key);
    if (!st || !('groups' in st) || !st.groups || !st.date) return null;
    return { date: st.date, calculatedAt: st.calculatedAt, groups: st.groups };
}

/**
 * Start a new recording span: the next fresh sample of every group becomes
 * its baseline. States already in the store predate the span (cached from
 * before a release or a reconnect, possibly with a gap after them), so they
 * are marked as seen and never diffed against.
 */
function restart() {
    icFlowRecorder.rebase();
    for (const { index, key } of STREAMS) {
        const st = stateOf(index, key);
        if (st) fed.set(`${index}|${key}`, st.calculatedAt);
        else fed.delete(`${index}|${key}`);
    }
}

function feed(): boolean {
    // a reconnect may have dropped packets: never diff across it
    const e = streamConnectionEpoch();
    if (e !== epoch) {
        epoch = e;
        restart();
        return false;
    }
    let changed = false;
    for (const { index, projection, key } of STREAMS) {
        const st = stateOf(index, key);
        if (!st) continue;
        const id = `${index}|${key}`;
        if (fed.get(id) === st.calculatedAt) continue;
        fed.set(id, st.calculatedAt);
        const slot = icSlot(st.calculatedAt);
        if (slot === null) continue;
        const rows = st.groups.map((g) => ({ category: g.category, item_count: g.item_count, value: Number(g.value) }));
        if (projection === GM_AMOUNT) icFlowRecorder.sampleAmount(index, st.date, slot, rows);
        else icFlowRecorder.samplePerf(index, st.date, slot, rows);
        changed = true;
    }
    return changed;
}

/** Revision refresh at most this often: the stream publishes ≤1/s, the chart moves per minute. */
const BUMP_MS = 3000;

// one shared feeder for every holder; each holder reads the shared revision
let holders = 0;
let revision = 0;
let releases: (() => void)[] = [];
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastBump = 0;
const revListeners = new Set<() => void>();

function bumpNow() {
    lastBump = Date.now();
    revision += 1;
    revListeners.forEach((l) => l());
}

function bump() {
    const wait = lastBump + BUMP_MS - Date.now();
    if (wait <= 0) bumpNow();
    else
        timer ??= setTimeout(() => {
            timer = null;
            bumpNow();
        }, wait);
}

function hold(): () => void {
    holders += 1;
    if (holders === 1) {
        releases = STREAMS.map(({ index, projection }) => retainIndexComponents(IC_INDICES[index], projection));
        epoch = streamConnectionEpoch();
        restart();
        unsubscribe = subscribeIcStore(() => {
            if (feed()) bump();
        });
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        unsubscribe?.();
        unsubscribe = null;
        if (timer) clearTimeout(timer);
        timer = null;
        releases.forEach((release) => release());
        releases = [];
        // the next holder starts a new span (restart on hold)
    };
}

/**
 * Keep the group-metric streams retained while `enabled` and return a
 * revision that changes when new samples arrived (throttled, shared by
 * every holder).
 */
export function useIcSectorFlow(enabled: boolean): number {
    useEffect(() => (enabled ? hold() : undefined), [enabled]);
    return useSyncExternalStore(
        (l) => {
            revListeners.add(l);
            return () => revListeners.delete(l);
        },
        () => revision,
    );
}
