// src/lib/us/us-tick-wire.ts — 美股逐筆訂閱要送哪一種 quote_type（SDK 1.8.0b2 起）
//
// 1.8.0b2 起美股 `Tick` 改成 TICL：只送 updates_last=true 的成交（沒有盤前、盤後、
// 夜盤與零股）。Pro 的成交明細、延長時段 K 線、自選／報價板的盤前盤後副行都要
// 每一筆成交，所以美股逐筆改訂 `TickFull`（推送仍是 us_tick 事件、欄位同 b1）。
// 同一個商品不可同時訂 Tick 與 TickFull（會收到重複成交）。
//
// 外接 sidecar 可能還是 b1：b1 的 TickFull 會被 400 拒絕（parse http data failed），
// 而 b1 的 Tick 本來就是全部成交。判斷順序：
//   1. /info 版本已知 → ≥ 1.8.0-beta.2 用 TickFull，更舊用 Tick（不先送一次失敗請求）
//   2. 版本不明 → 先試 TickFull；被 4xx 拒絕就記下這個 sidecar 不支援，改用 Tick
//
// 台股不受影響：台股 sidecar 拒收 TickFull，這裡只處理美股。
//
// 注意：TickFull 與 BidAsk 共用 serial_num 計數器，美股 tick 的序號跳號是正常的；
// 本 App 的美股漏收判斷用 total_volume 前後差（intraday-chart），不看 serial_num。

import { getApiBase, serverVersionAtLeast180b2 } from '../runtime';
import { knownServerInfo } from '../server-info-store';

export type UsTickWire = 'TickFull' | 'Tick';

/** SDK 版本字串 → 是否支援美股 TickFull；認不得回 null */
export function sdkSupportsUsTickFull(version: string | undefined | null): boolean | null {
    return serverVersionAtLeast180b2(version);
}

/** 版本不明時實際被拒絕過的 sidecar（base＋當時的版本字串） */
const rejected = new Set<string>();
const rejectKey = (base: string) => `${base}|${knownServerInfo()?.version ?? ''}`;

/** 現在對目前 sidecar 訂美股逐筆要送的 quote_type */
export function usTickWire(): UsTickWire {
    const supported = sdkSupportsUsTickFull(knownServerInfo()?.version);
    if (supported !== null) return supported ? 'TickFull' : 'Tick';
    return rejected.has(rejectKey(getApiBase())) ? 'Tick' : 'TickFull';
}

/** TickFull 被目前 sidecar 拒絕：之後（版本仍不明時）改用 Tick */
export function noteUsTickFullRejected(base = getApiBase()) {
    rejected.add(rejectKey(base));
}

/** 被拒絕是請求本身的問題（4xx）：舊 sidecar 不認得 TickFull 時回 400 */
export function isUsTickFullRejection(reason: unknown): boolean {
    return reason instanceof Error && /^4\d\d\b/.test(reason.message);
}

/** registry key（US:CODE:Tick）是不是美股逐筆訂閱 */
export function isUsTickRegistryKey(key: string): boolean {
    return /^US:[^:]+:Tick$/.test(key);
}

export function resetUsTickWireForTest() {
    rejected.clear();
}
