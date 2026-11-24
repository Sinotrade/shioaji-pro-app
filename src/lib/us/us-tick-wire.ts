// src/lib/us/us-tick-wire.ts — 美股逐筆訂閱要送哪一種 quote_type
//
// 預設訂 `Tick`（TICL）：正規盤會更新最新價的成交，加上盤前、盤後、夜盤（session
// 1/3/4）的整股成交。延長時段那幾筆 updates_last=false、close／high／low 維持一般盤
// 值，成交價＝ext_close，ext_high／ext_low 是該時段高低（us-session-view 直接用）。
// 使用者在 設定 → 行情「美股成交資料」選「完整成交」時改訂 `TickFull`（另含碎股與
// 特殊條件成交的每一筆；推送同樣是 us_tick、欄位相同），見 us-tick-prefs.ts。
// 同一個商品不可同時訂 Tick 與 TickFull（會收到重複成交）。
//
// 選了完整成交但外接 sidecar 可能還是 b1：b1 的 TickFull 會被 400 拒絕
// （parse http data failed），這時退回 Tick（b1 的 Tick 本來就是全部成交）。判斷順序：
//   1. /info 版本已知 → ≥ 1.8.0-beta.2 用 TickFull，更舊用 Tick（不先送一次失敗請求）
//   2. 版本不明 → 先試 TickFull；被 400 拒絕就記下這個 sidecar 不支援，改用 Tick。
//      這個記錄在 /info 被清掉（斷線、換位址，sidecar 可能換了版本重啟）時作廢。
//
// 台股不受影響：台股 sidecar 拒收 TickFull，這裡只處理美股。
//
// 注意：TickFull 與 BidAsk 共用 serial_num 計數器，美股 tick 的序號跳號是正常的；
// 本 App 的美股漏收判斷用 total_volume 前後差（intraday-chart），不看 serial_num。

import { getApiBase, serverVersionAtLeast180b2 } from '../runtime';
import { knownServerInfo, subscribeServerInfo } from '../server-info-store';
import { getUsTickDetail } from './us-tick-prefs';

export type UsTickWire = 'TickFull' | 'Tick';

/** SDK 版本字串 → 是否支援美股 TickFull；認不得回 null */
export function sdkSupportsUsTickFull(version: string | undefined | null): boolean | null {
    return serverVersionAtLeast180b2(version);
}

/** 版本不明時實際拒絕過 TickFull 的 sidecar（base） */
const rejected = new Set<string>();

// /info 被清掉＝sidecar 可能重啟成別的版本：拒絕記錄作廢，下一次重新試
// （測試若整個 mock 掉 server-info-store 可能沒有 subscribeServerInfo：略過即可）
try {
    subscribeServerInfo(() => {
        if (!knownServerInfo()) rejected.clear();
    });
} catch {
    // no server-info store in this context
}

/** 現在對目前 sidecar 訂美股逐筆要送的 quote_type：預設 Tick；選了完整成交才依 sidecar 能力用 TickFull */
export function usTickWire(): UsTickWire {
    if (getUsTickDetail() !== 'TickFull') return 'Tick';
    const supported = sdkSupportsUsTickFull(knownServerInfo()?.version);
    if (supported !== null) return supported ? 'TickFull' : 'Tick';
    return rejected.has(getApiBase()) ? 'Tick' : 'TickFull';
}

/** base 上確定不會有 TickFull：/info 是不支援的舊版，或版本不明但拒絕過 TickFull */
export function usTickFullKnownAbsent(base: string): boolean {
    const supported = sdkSupportsUsTickFull(knownServerInfo()?.version);
    return supported === false || (supported === null && rejected.has(base));
}

/** TickFull 被 base 這個 sidecar 拒絕：之後（版本仍不明時）改用 Tick */
export function noteUsTickFullRejected(base: string) {
    rejected.add(base);
}

/**
 * 這個失敗是不是「sidecar 不認得 TickFull」：只認 400（b1 回 parse http data failed），
 * 而且 /info 不能已知是支援的版本。401／403／429 等其他錯誤照原樣丟出，不降級。
 */
export function isUsTickFullRejection(reason: unknown): boolean {
    if (!(reason instanceof Error) || !/^400\b/.test(reason.message)) return false;
    return sdkSupportsUsTickFull(knownServerInfo()?.version) !== true;
}

/** registry key（US:CODE:Tick）是不是美股逐筆訂閱 */
export function isUsTickRegistryKey(key: string): boolean {
    return /^US:[^:]+:Tick$/.test(key);
}

// ---- 上一次載入實際送出的 quote_type（重新整理後退訂／換種類用） ----
//
// 頁面重新整理後 sidecar 上的訂閱還在，但本頁 registry 是空的。記在 sessionStorage
// （與 quote-ownership 的 ledger 同一個生命週期），退訂時用當初的種類，訂閱時發現
// 種類不同就先退掉舊的，避免同一商品同時有 Tick 與 TickFull。

const wireStoreKey = (base: string) => `sj-us-tick-wire:${base}`;

function readWires(base: string): Record<string, UsTickWire> {
    try {
        const raw = JSON.parse(sessionStorage.getItem(wireStoreKey(base)) ?? '{}') as Record<string, unknown>;
        const out: Record<string, UsTickWire> = {};
        for (const [k, v] of Object.entries(raw ?? {})) if (v === 'Tick' || v === 'TickFull') out[k] = v;
        return out;
    } catch {
        return {};
    }
}

/** 上一次（含本頁）在 base 對 key 實際訂閱成功的種類 */
export function rememberedUsTickWire(base: string, key: string): UsTickWire | undefined {
    return readWires(base)[key];
}

export function rememberUsTickWire(base: string, key: string, wire: UsTickWire | null) {
    try {
        const wires = readWires(base);
        if (wire) wires[key] = wire;
        else delete wires[key];
        sessionStorage.setItem(wireStoreKey(base), JSON.stringify(wires));
    } catch {
        // 無法寫入時只是少了重新整理後的對照
    }
}

export function resetUsTickWireForTest() {
    rejected.clear();
}
