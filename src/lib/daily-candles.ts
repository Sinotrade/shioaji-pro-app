// src/lib/daily-candles.ts — 把「只供 1 分 K」的 kbars API 聚合為日 K，
// 並用 IndexedDB 持久快取：首次拉約 90 日、之後只增量補最近數日，
// 讓「多檔選股」不必每次重拉龐大 1 分 K。IDB 不可用時降級為記憶體。

import { fetchChartHistory, nextChartHistoryRevision } from './chart-history';
import type { ContractBase, SecurityType } from './types/contract';
import type { Candle } from './types/market';
import { aggregate, dateStrOffset, kbarsToCandles, wallClockToUtc } from './utils/kbars';
import { dailyBarConfirmedAt, tradingDayFor } from './intraday-session';
import { researchBackgroundKey, researchBackgroundStore } from './research-background';
import { getApiBase } from './runtime';

const DB_NAME = 'sj-daily-v1';
const STORE = 'daily';
const MAX_DAILY = 150;
const CONCURRENCY = 4;

interface IsolatedDailyCandle extends Candle {
    isolationReason: 'legacy-weekend-label' | 'legacy-paired-monday';
}
export interface DailyCacheValue {
    candles: Candle[];
    updatedAt: number;
    sessionConvention?: 2;
    // Preserve ambiguous legacy rows, but do not feed them to indicators.
    // A weekend row may already overlap a newer Monday row; adding volume
    // would double-count. No full-history download is triggered to repair it.
    isolatedCandles?: IsolatedDailyCandle[];
    historyQuality?: 'bounded-month-warmup';
    legacySourceKey?: string;
    // Latest observed minute-END label for each daily bucket. A wall clock
    // passing the close is not evidence that a cached partial has closed.
    sourceMinuteEnds?: Record<string, number>;
    // Source proof is per daily bucket: legacy rows may have no known API.
    // Preserve them, but do not reuse them as verified background elsewhere.
    sourceApis?: Record<string, string>;
}

// ---- tiny IndexedDB wrapper (graceful in-memory fallback) ----
let dbPromise: Promise<IDBDatabase> | null = null;
const memory = new Map<string, DailyCacheValue>();

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

function idbGet(key: string): Promise<DailyCacheValue | null> {
    return openDb()
        .then(
            (db) =>
                new Promise<DailyCacheValue | null>(
                    (resolve, reject) => {
                        const rq = db
                            .transaction(STORE)
                            .objectStore(STORE)
                            .get(key);
                        rq.onsuccess = () =>
                            resolve(
                                (rq.result ?? null) as DailyCacheValue | null,
                            );
                        rq.onerror = () => reject(rq.error);
                    },
                ),
        )
        .catch(() => memory.get(key) ?? null);
}

function idbSet(key: string, value: DailyCacheValue) {
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

export function dailyKey(contract: ContractBase) {
    return JSON.stringify([contract.security_type, contract.exchange, contract.code, contract.target_code]);
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

/** Non-destructive migration: only proven legacy weekend labels and their
 * paired Monday are isolated. Other cached history remains unchanged.
 * Official exchange holiday calendars are not available to this module.
 */
export function prepareDailyCache(value: DailyCacheValue, securityType: SecurityType): DailyCacheValue {
    if ((securityType !== 'FUT' && securityType !== 'OPT') || value.sessionConvention === 2) {
        return { ...value, candles: [...value.candles].sort((a, b) => a.time - b.time) };
    }
    const weekend = new Set(value.candles.filter(c => [0, 6].includes(new Date(c.time * 1000).getUTCDay())).map(c => c.time));
    const pairedMondays = new Set([...weekend].map(time => tradingDayFor(securityType, time)));
    const candles: Candle[] = [];
    const isolated = [...(value.isolatedCandles ?? [])];
    for (const candle of value.candles) {
        const isolationReason = weekend.has(candle.time) ? 'legacy-weekend-label'
            : pairedMondays.has(candle.time) ? 'legacy-paired-monday' : null;
        if (isolationReason) isolated.push({ ...candle, isolationReason });
        else candles.push({ ...candle });
    }
    return { ...value, candles: candles.sort((a, b) => a.time - b.time), isolatedCandles: isolated };
}

/** Bounded incremental source range. Fetch the night before the latest
 * daily label (Friday for Monday), never a start later than today. The
 * earlier source day's partial daily bar must not overwrite cached history.
 */
export function dailyIncrementalPlan(cached: Candle[], securityType: SecurityType, today: string) {
    const latest = Math.max(...cached.map(c => c.time));
    const futures = securityType === 'FUT' || securityType === 'OPT';
    const replaceFrom = futures ? tradingDayFor(securityType, latest) : Math.floor(latest / 86400) * 86400;
    const previousDays = futures ? new Date(replaceFrom * 1000).getUTCDay() === 1 ? 3 : 1 : 0;
    const sourceStart = replaceFrom - previousDays * 86400;
    const start = dayToStr(Math.min(sourceStart, wallClockToUtc(today)));
    return { start, replaceFrom };
}

export interface GetDailyOptions {
    calendarDays?: number;
    force?: boolean;
    completedOnly?: boolean;
}

function confirmedCacheCandles(value: DailyCacheValue, securityType: SecurityType, apiBase: string): Candle[] {
    return prepareDailyCache(value, securityType).candles.filter(c =>
        value.sourceApis?.[String(c.time)] === apiBase
        && (value.sourceMinuteEnds?.[String(c.time)] ?? -Infinity) >= dailyBarConfirmedAt(c.time, securityType));
}

/** Read existing storage only, without migration writes or broker requests.
 * Unknown-month continuous legacy history is not reusable for another month. */
export async function readCachedDailyCandles(
    contract: ContractBase,
    options: { stockRegularCloseOnly?: boolean; nowMs?: number } = {},
): Promise<Candle[]> {
    const apiBase = getApiBase();
    let cached = await idbGet(dailyKey(contract));
    const continuous = (contract.security_type === 'FUT' || contract.security_type === 'OPT')
        && ((contract.target_code !== null && contract.target_code !== contract.code) || /R\d$/.test(contract.code));
    if (!cached && !continuous) cached = await idbGet(`${contract.exchange ?? 'TSE'}:${contract.code}`);
    if (!cached) return [];
    const confirmed = confirmedCacheCandles(cached, contract.security_type, apiBase);
    // New stock swing research is conservative: a later minute-end could
    // contain after-hours/odd-lot observations. Keep legacy/default callers
    // unchanged, but do not feed that date into the new research module.
    // Exact closing evidence still does not prove every earlier minute exists.
    if (!options.stockRegularCloseOnly) return confirmed;
    if (contract.security_type !== 'STK') return [];
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs)) return [];
    const taipeiWall = Math.floor(nowMs / 1000) + 8 * 3600;
    // Apply the clock before finding gaps: a future closing-claimed row must
    // not turn today's partial tail into an interior gap and erase history.
    const closedByClock = (c: Candle) => dailyBarConfirmedAt(c.time, 'STK') <= taipeiWall;
    const regular = confirmed.filter(c => closedByClock(c)
        && cached!.sourceMinuteEnds?.[String(c.time)] === dailyBarConfirmedAt(c.time, 'STK'));
    if (!regular.length) return [];
    const validTimes = new Set(regular.map(c => c.time));
    const lastValidTime = regular.at(-1)!.time;
    // A known cache date without proof inside the history is a real evidence
    // gap. Reset at that point, rather than treating two separated chunks as
    // the previous 10/20 trading days. An unclosed tail need not erase history.
    const lastGap = prepareDailyCache(cached, 'STK').candles.filter(closedByClock).reduce((gap, c) =>
        c.time < lastValidTime && !validTimes.has(c.time) ? Math.max(gap, c.time) : gap,
    -Infinity);
    return regular.filter(c => c.time > lastGap);
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
        const apiBase = getApiBase();
        const backgroundKey = researchBackgroundKey(contract, apiBase);
        const sourceRevision = researchBackgroundStore.nextRevision();
        let cached = await idbGet(key);
        const legacyKey = `${contract.exchange ?? 'TSE'}:${contract.code}`;
        const legacy = cached ? null : await idbGet(legacyKey);
        const continuous = (contract.security_type === 'FUT' || contract.security_type === 'OPT')
            && ((contract.target_code !== null && contract.target_code !== contract.code) || /R\d$/.test(contract.code));
        // Unknown-target legacy continuous history is preserved under its old
        // key but never fed to another month. Migration uses at most four
        // calendar days, not an automatic 90/180-day download. Explicit force
        // retains the existing user-requested full refresh behavior.
        const boundedMonthWarmup = !cached?.candles?.length && continuous && !force;
        if (!cached && legacy && !continuous) cached = legacy;
        const prepared = cached ? prepareDailyCache(cached, contract.security_type) : null;
        const end = dateStrOffset(0);
        let start: string;
        let replaceFrom = Number.NEGATIVE_INFINITY;
        if (force || !cached?.candles?.length) {
            start = dateStrOffset(boundedMonthWarmup ? Math.min(calendarDays, 4) : calendarDays);
        } else {
            const plan = dailyIncrementalPlan(cached.candles, contract.security_type, end);
            start = plan.start;
            replaceFrom = plan.replaceFrom;
        }
        const fetchOpts = force
            ? { revision: nextChartHistoryRevision() }
            : undefined;
        const kb = await fetchChartHistory(contract, start, end, fetchOpts);
        const raw = kbarsToCandles(kb);
        const freshSourceEnds: Record<string, number> = {};
        for (const minute of raw) {
            const label = String(tradingDayFor(contract.security_type, minute.time));
            freshSourceEnds[label] = Math.max(freshSourceEnds[label] ?? -Infinity, minute.time);
        }
        let fresh = aggregate(
            raw,
            1440,
            contract.security_type,
        );
        if (boundedMonthWarmup) {
            // The first date can contain only the 00:00 night tail or day
            // session, because its preceding evening is outside this range.
            fresh = fresh.slice(1);
        }
        let merged: Candle[];
        const updatedTimes = new Set<number>();
        if (cached?.candles?.length) {
            const map = new Map(prepared!.candles.map((c) => [c.time, c]));
            for (const c of fresh) {
                if (c.time < replaceFrom) continue;
                // An old cached history Promise must not overwrite a known
                // newer daily snapshot, or inherit that snapshot's proof.
                if ((prepared?.sourceMinuteEnds?.[String(c.time)] ?? -Infinity)
                    > (freshSourceEnds[String(c.time)] ?? -Infinity)) continue;
                map.set(c.time, c);
                updatedTimes.add(c.time);
            }
            merged = [...map.values()].sort((a, b) => a.time - b.time);
        } else {
            merged = fresh;
            fresh.forEach(c => updatedTimes.add(c.time));
        }
        if (merged.length > MAX_DAILY) merged = merged.slice(-MAX_DAILY);
        const sourceEnds = { ...(prepared?.sourceMinuteEnds ?? {}) };
        const sourceApis = { ...(prepared?.sourceApis ?? {}) };
        for (const label of updatedTimes) {
            sourceEnds[String(label)] = freshSourceEnds[String(label)] ?? -Infinity;
            sourceApis[String(label)] = apiBase;
        }
        const sourceMinuteEnds = Object.fromEntries(merged
            .filter(c => Number.isFinite(sourceEnds[String(c.time)]))
            .map(c => [String(c.time), sourceEnds[String(c.time)]!]));
        await idbSet(key, { candles: merged, updatedAt: Date.now(), sessionConvention: 2,
            isolatedCandles: prepared?.isolatedCandles,
            historyQuality: !force && (boundedMonthWarmup || prepared?.historyQuality) ? 'bounded-month-warmup' : undefined,
            legacySourceKey: boundedMonthWarmup && legacy ? legacyKey : prepared?.legacySourceKey,
            sourceMinuteEnds, sourceApis: Object.fromEntries(merged
                .filter(c => sourceApis[String(c.time)] !== undefined)
                .map(c => [String(c.time), sourceApis[String(c.time)]!])) });
        // Legacy rows without source-minute evidence are still preserved in
        // cache/default callers, but cannot be promoted to confirmed signals.
        const confirmed = merged.filter(c =>
            sourceApis[String(c.time)] === apiBase
            && (sourceMinuteEnds[String(c.time)] ?? -Infinity) >= dailyBarConfirmedAt(c.time, contract.security_type),
        );
        researchBackgroundStore.replaceDaily(backgroundKey, confirmed, sourceRevision);
        return opts.completedOnly ? confirmed : merged;
    } finally {
        release();
    }
}
