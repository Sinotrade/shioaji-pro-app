// src/lib/us/us-contracts.ts — 美股商品清單、代碼搜尋與商品資訊快取
//
// - 清單：GET /data/contracts?security_type=STK&region=US，只有代碼與交易所
//   （約 1.3 萬檔，SDK 目前沒有名稱，也沒有整批名稱 API）。
// - 名稱與前一日參考價：GET /data/contracts/{code}/info?region=US，只對畫面上
//   看得到的幾筆建議或選取的商品逐筆查；同時最多 US_INFO_CONCURRENCY 筆，
//   結果存 localStorage（以代碼為 key、每天更新一次）。
// - 名稱來源可抽換（registerUsNameSource）：之後有名稱表就從那裡來，
//   清單本身若帶 name 也會直接用。
// - 1.7.11 等舊 sidecar 沒有美股商品：清單失敗或為空 → 視為不支援，搜尋隱藏。

import { getApiBase } from '../runtime';
import { todayStr } from '../utils/date';
import { decNormalize } from './decimal';
import { fetchUsContractInfo, fetchUsContractList } from './us-api';
import type { UsContractInfo, UsContractRecord } from '../types/us';

export const US_INFO_CONCURRENCY = 4;
const INFO_STORAGE_KEY = 'sj-pro-us-contract-info:v1';
const INFO_CACHE_LIMIT = 500;

export interface UsContractSummary {
    code: string;
    exchange: string;
    name?: string;
    shortName?: string;
    /** 前一日參考價（decimal 字串） */
    reference?: string;
    referenceDate?: string;
    currency?: string;
    tradingSuspended?: boolean;
    /** 查詢日（本地 yyyy-mm-dd 字串，todayStr） */
    fetchedOn: string;
}

// ---- 清單 ----

type ListState =
    | { status: 'idle' }
    | { status: 'loading'; promise: Promise<void> }
    | { status: 'ready'; codes: string[]; byCode: Map<string, UsContractRecord> }
    | { status: 'unsupported'; reason: string };

let listBase = '';
let list: ListState = { status: 'idle' };
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach(l => l()); };

/** 清單或 info 快取每次變動遞增（React useSyncExternalStore 用） */
export function usContractsVersion(): number {
    return version;
}

export function subscribeUsContracts(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function currentList(): ListState {
    const base = getApiBase();
    if (base !== listBase) {
        listBase = base;
        list = { status: 'idle' };
    }
    return list;
}

export type UsCatalogStatus = 'idle' | 'loading' | 'ready' | 'unsupported';
export function usCatalogStatus(): UsCatalogStatus {
    return currentList().status;
}

/** 載入代碼清單（每個伺服器位址一次）；失敗或空清單 → unsupported */
export function ensureUsContracts(): Promise<void> {
    const state = currentList();
    if (state.status === 'loading') return state.promise;
    if (state.status === 'ready' || state.status === 'unsupported') return Promise.resolve();
    const base = listBase;
    const promise = fetchUsContractList().then(res => {
        if (base !== getApiBase()) return;
        const rows = (res?.contracts ?? []).filter(r => r && typeof r.code === 'string' && r.code
            && (r.region === undefined || r.region === 'US'));
        if (!rows.length) {
            list = { status: 'unsupported', reason: '這個伺服器版本沒有美股商品' };
            return;
        }
        const byCode = new Map<string, UsContractRecord>();
        for (const r of rows) byCode.set(r.code.toUpperCase(), r);
        list = { status: 'ready', codes: [...byCode.keys()].sort(), byCode };
    }, () => {
        if (base !== getApiBase()) return;
        list = { status: 'unsupported', reason: '這個伺服器版本沒有美股商品' };
    }).finally(emit);
    list = { status: 'loading', promise };
    emit();
    return promise;
}

/** 測試用：直接放入清單 */
export function setUsContractsForTest(rows: UsContractRecord[] | null) {
    listBase = getApiBase();
    if (!rows) { list = { status: 'unsupported', reason: 'test' }; emit(); return; }
    const byCode = new Map(rows.map(r => [r.code.toUpperCase(), r] as const));
    list = { status: 'ready', codes: [...byCode.keys()].sort(), byCode };
    emit();
}

export function resetUsContractsForTest() {
    listBase = '';
    list = { status: 'idle' };
    infoMemory = null;
    inflight.clear();
    queue.length = 0;
    active = 0;
    nameSources.length = 0;
}

export function getUsContractRecord(code: string): UsContractRecord | undefined {
    const state = currentList();
    return state.status === 'ready' ? state.byCode.get(code.trim().toUpperCase()) : undefined;
}

function lowerBound(codes: string[], prefix: string): number {
    let lo = 0;
    let hi = codes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (codes[mid]! < prefix) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * 代碼前綴搜尋（不分大小寫）。完全相同排第一，其餘依代碼長度、字母排序。
 * 清單未載入或不支援回空陣列。
 */
export function searchUsCodes(query: string, limit = 8): UsContractRecord[] {
    const state = currentList();
    const q = query.trim().toUpperCase();
    if (state.status !== 'ready' || !q || !/^[A-Z0-9.\-/ ]+$/.test(q)) return [];
    const start = lowerBound(state.codes, q);
    const hits: string[] = [];
    for (let i = start; i < state.codes.length && state.codes[i]!.startsWith(q); i++) {
        hits.push(state.codes[i]!);
        if (hits.length >= 200) break; // 長度排序前先收一批即可
    }
    hits.sort((a, b) => (a === q ? -1 : b === q ? 1 : a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)));
    return hits.slice(0, limit).map(code => state.byCode.get(code)!);
}

// ---- 名稱來源（可抽換） ----

export type UsNameSource = (code: string) => string | undefined;
const nameSources: UsNameSource[] = [];

/** 加一個名稱來源（例如之後的美股名稱表）；優先於清單與 info 快取 */
export function registerUsNameSource(source: UsNameSource): () => void {
    nameSources.push(source);
    return () => {
        const i = nameSources.indexOf(source);
        if (i >= 0) nameSources.splice(i, 1);
    };
}

/** 目前知道的名稱；不知道回 undefined（畫面只顯示代碼） */
export function usContractName(code: string): string | undefined {
    const c = code.trim().toUpperCase();
    for (const source of nameSources) {
        const name = source(c);
        if (name) return name;
    }
    const fromList = getUsContractRecord(c)?.name;
    if (fromList) return fromList;
    const info = readInfoCache()[c];
    return info?.name || info?.shortName || undefined;
}

// ---- 商品資訊（逐筆、限流、localStorage 每日快取） ----

let infoMemory: Record<string, UsContractSummary> | null = null;

function readInfoCache(): Record<string, UsContractSummary> {
    if (infoMemory) return infoMemory;
    try {
        const raw = localStorage.getItem(INFO_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : null;
        infoMemory = parsed && typeof parsed === 'object' ? parsed as Record<string, UsContractSummary> : {};
    } catch {
        infoMemory = {};
    }
    return infoMemory;
}

function writeInfoCache(entry: UsContractSummary) {
    const cache = { ...readInfoCache(), [entry.code]: entry };
    const keys = Object.keys(cache);
    if (keys.length > INFO_CACHE_LIMIT) {
        // 丟掉最舊的查詢日
        keys.sort((a, b) => (cache[a]!.fetchedOn < cache[b]!.fetchedOn ? -1 : 1))
            .slice(0, keys.length - INFO_CACHE_LIMIT).forEach(k => { delete cache[k]; });
    }
    infoMemory = cache;
    try { localStorage.setItem(INFO_STORAGE_KEY, JSON.stringify(cache)); } catch { /* 配額滿：只留記憶體 */ }
}

export function summarizeUsInfo(info: UsContractInfo, fetchedOn = todayStr()): UsContractSummary {
    const reference = info.reference === null || info.reference === undefined ? undefined : decNormalize(info.reference) ?? undefined;
    return {
        code: info.code.toUpperCase(),
        exchange: info.exchange,
        name: info.name ?? undefined,
        shortName: info.short_name ?? undefined,
        reference,
        referenceDate: info.reference_date ?? undefined,
        currency: info.currency ?? undefined,
        tradingSuspended: info.trading_suspended ?? undefined,
        fetchedOn,
    };
}

/** 今天查過的快取（同步讀，不發請求） */
export function cachedUsInfo(code: string): UsContractSummary | undefined {
    const entry = readInfoCache()[code.trim().toUpperCase()];
    return entry && entry.fetchedOn === todayStr() ? entry : undefined;
}

const inflight = new Map<string, Promise<UsContractSummary>>();
const queue: (() => void)[] = [];
let active = 0;

function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const run = () => {
            active++;
            task().then(resolve, reject).finally(() => {
                active--;
                queue.shift()?.();
            });
        };
        if (active < US_INFO_CONCURRENCY) run(); else queue.push(run);
    });
}

/** 查一檔的名稱與參考價；今天查過就用快取。force 會重查（例如選取時刷新參考價）。 */
export function loadUsInfo(code: string, opts: { force?: boolean } = {}): Promise<UsContractSummary> {
    const c = code.trim().toUpperCase();
    if (!opts.force) {
        const cached = cachedUsInfo(c);
        if (cached) return Promise.resolve(cached);
    }
    const existing = inflight.get(c);
    if (existing) return existing;
    const promise = schedule(() => fetchUsContractInfo(c)).then(info => {
        const summary = summarizeUsInfo(info);
        writeInfoCache(summary);
        emit();
        return summary;
    }).finally(() => { inflight.delete(c); });
    inflight.set(c, promise);
    return promise;
}

/** 目前排隊與進行中的 info 請求數（測試用） */
export function usInfoLoadStats() {
    return { active, queued: queue.length };
}
