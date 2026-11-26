// src/lib/us/us-stream-names.ts — 美股串流的 SSE 事件名稱與路徑（新舊兩套）
//
// SDK 1.8.0（shioaji MR !525）把美股串流改名，與台股 tick_stk／bidask_stk 同一種命名：
//   - GET  /api/v1/stream/data/us_tick    → /api/v1/stream/data/tick_stk_us
//   - GET  /api/v1/stream/data/us_bidask  → /api/v1/stream/data/bidask_stk_us
//   - GET  /api/v1/stream/data/us_halt    → /api/v1/stream/data/halt_stk_us
//   - POST /api/v1/stream/{subscribe,unsubscribe}/us_halt → .../halt_stk_us
//   - 彙總串流 /api/v1/stream/data 的事件名稱同樣改成 tick_stk_us／bidask_stk_us／halt_stk_us
// 沒改：/api/v1/stream/us_halts、/api/v1/stream/us_tradable。
//
// 內建的是 1.8.0（新名稱），但外接的 1.8.0b1–b3 與開發版 sidecar 還是舊名稱：
//   - 事件名稱：兩套都收（同一則事件只會用其中一個名字送）。
//   - 路徑：先用新路徑，被 404／405 拒絕就記下這個 sidecar（API base）用舊名稱，之後直接走舊路徑；
//     舊路徑也 404（sidecar 換成新版）就改回新名稱。記錄在 /info 被清掉（斷線、換位址，
//     sidecar 可能換了版本重啟）時作廢，與 us-tick-wire.ts 的 TickFull 退回同一個模式。

import { apiGet, apiPost } from '../api';
import { getApiBase } from '../runtime';
import { knownServerInfo, subscribeServerInfo } from '../server-info-store';

export type UsStreamKind = 'tick' | 'bidask' | 'halt';

/** SDK 1.8.0 起的名稱 */
export const US_STREAM_NAMES: Record<UsStreamKind, string> = {
    tick: 'tick_stk_us',
    bidask: 'bidask_stk_us',
    halt: 'halt_stk_us',
};
/** 1.8.0b1–b3 的舊名稱 */
export const US_STREAM_LEGACY_NAMES: Record<UsStreamKind, string> = {
    tick: 'us_tick',
    bidask: 'us_bidask',
    halt: 'us_halt',
};

/** 收到這個 SSE 事件名稱是哪一種美股事件（新舊都認）；不是美股事件回 null */
export function usStreamKindOfEvent(name: string): UsStreamKind | null {
    for (const kind of Object.keys(US_STREAM_NAMES) as UsStreamKind[]) {
        if (name === US_STREAM_NAMES[kind] || name === US_STREAM_LEGACY_NAMES[kind]) return kind;
    }
    return null;
}

/** 這一種美股事件的兩個 SSE 事件名稱（新、舊） */
export function usStreamEventNames(kind: UsStreamKind): readonly [string, string] {
    return [US_STREAM_NAMES[kind], US_STREAM_LEGACY_NAMES[kind]];
}

/** 確定用舊名稱的 sidecar（API base） */
const legacyBases = new Set<string>();
/**
 * 每個 API base 的記錄世代：作廢時加一。探測／退回送出時記下世代，回來時世代變了
 * （sidecar 已換掉，或 A→B→A 切換）就丟掉結果，不讓舊 sidecar 的答案蓋回記錄。
 */
const generations = new Map<string, number>();
const generationOf = (base: string) => generations.get(base) ?? 0;

function invalidateAll() {
    legacyBases.clear();
    for (const [base, gen] of generations) generations.set(base, gen + 1);
}

// /info 被清掉＝sidecar 可能重啟成別的版本：記錄作廢，下一次重新從新名稱試
// （測試若整個 mock 掉 server-info-store 可能沒有 subscribeServerInfo：略過即可）
try {
    subscribeServerInfo(() => {
        if (!knownServerInfo()) invalidateAll();
    });
} catch {
    // no server-info store in this context
}

export function usStreamUsesLegacyNames(base = getApiBase()): boolean {
    return legacyBases.has(base);
}

export function noteUsStreamNames(base: string, legacy: boolean) {
    if (legacy) legacyBases.add(base);
    else legacyBases.delete(base);
}

/** 目前對 base 這個 sidecar 要用的名稱 */
export function usStreamName(kind: UsStreamKind, base = getApiBase()): string {
    return (legacyBases.has(base) ? US_STREAM_LEGACY_NAMES : US_STREAM_NAMES)[kind];
}

/** 獨立 SSE 路徑（GET /api/v1/stream/data/<name>） */
export function usStreamDataPath(kind: UsStreamKind, base = getApiBase()): string {
    return `/api/v1/stream/data/${usStreamName(kind, base)}`;
}

/**
 * apiGet／apiPost 丟出的錯誤是不是「sidecar 沒有這個路徑」：GET 未知路徑回 404；
 * POST 未知的 /stream/subscribe/<name> 回 405（實測 !525 sidecar 對 subscribe/us_halt）。
 */
export function isNotFoundError(reason: unknown): boolean {
    if (!reason || typeof reason !== 'object') return false;
    const status = (reason as { status?: unknown }).status;
    if (status === 404 || status === 405) return true;
    return reason instanceof Error && /^40[45]\b/.test(reason.message);
}

/**
 * POST /api/v1/stream/{subscribe,unsubscribe}/<halt 名稱>：先用目前記錄的名稱，
 * 404／405 就換另一套名稱再送一次並記下。其他錯誤照原樣丟出。
 */
export async function postUsStreamAction<T>(
    action: 'subscribe' | 'unsubscribe',
    kind: UsStreamKind,
    body: Record<string, unknown>,
    base = getApiBase(),
): Promise<T> {
    const legacy = legacyBases.has(base);
    generations.set(base, generationOf(base));
    const gen = generationOf(base);
    const first = (legacy ? US_STREAM_LEGACY_NAMES : US_STREAM_NAMES)[kind];
    try {
        return await apiPost<T>(`/api/v1/stream/${action}/${first}`, body);
    } catch (e) {
        // 記錄已作廢（sidecar 換了）或換了位址：這個 404 不代表目前的 sidecar，不換名稱
        if (!isNotFoundError(e) || getApiBase() !== base || generationOf(base) !== gen) throw e;
    }
    const other = (legacy ? US_STREAM_NAMES : US_STREAM_LEGACY_NAMES)[kind];
    const result = await apiPost<T>(`/api/v1/stream/${action}/${other}`, body);
    if (generationOf(base) === gen) noteUsStreamNames(base, !legacy);
    return result;
}

export const US_STREAM_PROBE_TIMEOUT_MS = 3000;

/**
 * 獨立 SSE 還沒開成功就斷：EventSource 看不到 HTTP 狀態碼，另外 GET 一次同一路徑。
 * 回 404 ＝這個 sidecar 不認得這套名稱，換另一套並回 true（呼叫端馬上重開）。
 * 連得上（SSE 本身）或其他錯誤一律回 false，照原本的重連節奏。
 */
export async function probeUsStreamPath(kind: UsStreamKind, base = getApiBase()): Promise<boolean> {
    const legacy = legacyBases.has(base);
    generations.set(base, generationOf(base));
    const gen = generationOf(base);
    const path = usStreamDataPath(kind, base);
    const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), US_STREAM_PROBE_TIMEOUT_MS) : null;
    try {
        await apiGet<unknown>(path, ctrl ? { signal: ctrl.signal } : undefined);
        return false;
    } catch (e) {
        if (!isNotFoundError(e) || getApiBase() !== base || generationOf(base) !== gen
            || legacyBases.has(base) !== legacy) return false;
        noteUsStreamNames(base, !legacy);
        return true;
    } finally {
        if (timer) clearTimeout(timer);
        ctrl?.abort();
    }
}

export function resetUsStreamNamesForTest() {
    invalidateAll();
}
