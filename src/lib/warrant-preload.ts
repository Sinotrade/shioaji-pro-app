// src/lib/warrant-preload.ts — 委託成交查詢前先載入權證合約表（#409）
//
// SDK 1.8.0 起，權證委託在委託成交查詢（update_status／list_trades）、下單／改單
// ／刪單回應、股票委託回報、order_deal_records 都標 security_type=WRT — 前提是
// sidecar 已載入權證合約表；沒載入時仍是 STK（上游只認 STK）。sidecar 的合約表
// 是用到才載（contracts v2 已拿掉 /data/contracts/preload 端點），所以每個
// sidecar 第一次查證券帳戶委託成交（fetchTrades）前先查一次權證清單（一筆），
// 讓整張權證表載進來。
//
// - 每個 sidecar（API base）只做一次；/info 被清掉（斷線、重啟、換位址）時作廢，
//   下一次查詢前重做。
// - 失敗不擋委託成交查詢（權證照舊可能標 STK，App 本來就把 STK／WRT 當同一個
//   市場，見 contract-market.ts）；失敗的那次不記，下一次再試。
// - 舊 sidecar（1.8.0b1 等）同一個端點也能用，只是沒有 WRT 還原，結果一樣無害。

import { apiGet } from './api';
import { getApiBase } from './runtime';
import { knownServerInfo, subscribeServerInfo } from './server-info-store';

export const WARRANT_PRELOAD_PATH = '/api/v1/data/contracts?security_type=WRT&region=TW&page=1&page_size=1';
/** 權證表首次載入要下載整張表；超過這個時間就先放行查詢，載入在背景繼續 */
export const WARRANT_PRELOAD_WAIT_MS = 15_000;

const done = new Set<string>();
const inflight = new Map<string, Promise<void>>();

try {
    subscribeServerInfo(() => {
        if (!knownServerInfo()) {
            done.clear();
            inflight.clear();
        }
    });
} catch {
    // 測試整個 mock 掉 server-info-store 時沒有 subscribeServerInfo
}

/** 目前的 sidecar 已確定載入過權證合約表 */
export function warrantContractsReady(): boolean {
    try {
        return done.has(getApiBase());
    } catch {
        return true;
    }
}

/**
 * 確保目前的 sidecar 已載入權證合約表；最多等 WARRANT_PRELOAD_WAIT_MS。
 * 永遠 resolve（失敗只代表權證可能仍標 STK）。
 */
export function ensureWarrantContracts(): Promise<void> {
    let base: string;
    try {
        base = getApiBase();
    } catch {
        return Promise.resolve();
    }
    if (done.has(base)) return Promise.resolve();
    let p = inflight.get(base);
    if (!p) {
        let request: Promise<unknown>;
        try {
            const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(60_000) : undefined;
            request = Promise.resolve(apiGet<unknown>(WARRANT_PRELOAD_PATH, signal ? { signal } : undefined));
        } catch (e) {
            request = Promise.reject(e);
        }
        p = request.then(
            () => {
                if (inflight.get(base) === p) done.add(base);
            },
            () => {},
        ).finally(() => {
            if (inflight.get(base) === p) inflight.delete(base);
        });
        inflight.set(base, p);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WARRANT_PRELOAD_WAIT_MS);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function resetWarrantPreloadForTest() {
    done.clear();
    inflight.clear();
}
