// src/lib/daily-candles.ts — 把「只供 1 分 K」的 kbars API 聚合為日 K，
// 並用 IndexedDB 持久快取：首次拉約 90 日、之後只增量補最近數日，
// 讓「多檔選股」不必每次重拉龐大 1 分 K。IDB 不可用時降級為記憶體。

import { fetchChartHistory, nextChartHistoryRevision } from './chart-history';
import type { ContractBase } from './types/contract';
import type { Candle } from './types/market';
import { aggregate, dateStrOffset, kbarsToCandles } from './utils/kbars';

const DB_NAME = 'sj-daily-v1';
const STORE = 'daily';
const MAX_DAILY = 150;
const CONCURRENCY = 4;

// ---- tiny IndexedDB wrapper (graceful in-memory fallback) ----
let dbPromise: Promise<IDBDatabase> | null = null;
const memory = new Map<string, { candles: Candle[]; updatedAt: number }>();

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('indexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function idbGet(key: string): Promise<{ candles: Candle[]; updatedAt: number } | null> {
    return openDb()
        .then(
            (db) =>
                new Promise<{ candles: Candle[]; updatedAt: number } | null>(
                    (resolve, reject) => {
                        const rq = db
                            .transaction(STORE)
                            .objectStore(STORE)
                            .get(key);
                        rq.onsuccess = () =>
                            resolve(
                                (rq.result ?? null) as {
                                    candles: Candle[];
                                    updatedAt: number;
                                } | null,
                            );
                        rq.onerror = () => reject(rq.error);
                    },
                ),
        )
        .catch(() => memory.get(key) ?? null);
}

function idbSet(key: string, value: { candles: Candle[]; updatedAt: number }) {
    return openDb()
        .then(
            (db) =>
                new Promise<void>((resolve, reject) => {
                    const rq = db
                        .transaction(STORE, 'readwrite')
                        .objectStore(STORE)
                        .put(value, key);
                    rq.onsuccess = () => resolve();
                    rq.onerror = () => reject(rq.error);
                }),
        )
        .catch(() => {
            memory.set(key, value);
        });
}

// ---- global concurrency limiter ----
let active = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
    if (active < CONCURRENCY) {
        active++;
        return Promise.resolve();
    }
    return new Promise((resolve) =>
        waiters.push(() => resolve()),
    );
}
function release() {
    const next = waiters.shift();
    if (next) next();
    else active--;
}

export function dailyKey(contract: { exchange?: string | null; code: string }) {
    return `${contract.exchange ?? 'TSE'}:${contract.code}`;
}

function pad2(n: number) {
    return n < 10 ? '0' + n : String(n);
}
// 日 K time 是把台灣牆鐘當 UTC 編碼、落在該日 00:00；用 UTC getter 取回日曆日。
function dayToStr(t: number) {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
        d.getUTCDate(),
    )}`;
}

export interface GetDailyOptions {
    calendarDays?: number;
    force?: boolean;
}

/** 取該商品的日 K（已聚合、已快取）。預設首次回推 90 日曆日。 */
export async function getDailyCandles(
    contract: ContractBase,
    opts: GetDailyOptions = {},
): Promise<Candle[]> {
    const calendarDays = opts.calendarDays ?? 90;
    const force = opts.force ?? false;
    await acquire();
    try {
        const key = dailyKey(contract);
        const cached = await idbGet(key);
        let start: string;
        if (force || !cached?.candles?.length) {
            start = dateStrOffset(calendarDays);
        } else {
            // 增量：從最後一根日 K 所屬日（含、重拉以更新當日 partial）到今天
            start = dayToStr(cached.candles.at(-1)!.time);
        }
        const end = dateStrOffset(0);
        const fetchOpts = force
            ? { revision: nextChartHistoryRevision() }
            : undefined;
        const kb = await fetchChartHistory(contract, start, end, fetchOpts);
        const fresh = aggregate(
            kbarsToCandles(kb),
            1440,
            contract.security_type,
        );
        let merged: Candle[];
        if (cached?.candles?.length) {
            const map = new Map(cached.candles.map((c) => [c.time, c]));
            for (const c of fresh) map.set(c.time, c);
            merged = [...map.values()].sort((a, b) => a.time - b.time);
        } else {
            merged = fresh;
        }
        if (merged.length > MAX_DAILY) merged = merged.slice(-MAX_DAILY);
        await idbSet(key, { candles: merged, updatedAt: Date.now() });
        return merged;
    } finally {
        release();
    }
}
