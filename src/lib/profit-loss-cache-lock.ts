// src/lib/profit-loss-cache-lock.ts — 同帳戶的 profit_loss／profit_loss_detail 依序執行
//
// SDK 的 list_profit_loss_detail 以 detail_id 對照 sidecar 程序內「最近一次」profit_loss 的結果
// （快取 key 是 broker_id:account_id，不分日期區間）。今日損益、30 日損益與沖銷明細各自查
// profit_loss；若在「重查某天 → 用該 id 查明細」之間插進另一個區間的查詢，明細會對到別筆。
// 這裡把本 App 內同帳戶的這些查詢排成一列（失敗不卡住後面的）。其他程式（CLI、Agent）
// 直接打同一個 sidecar 時不在此保護內。

const tails = new Map<string, Promise<void>>();

export function profitLossCacheKey(account: { broker_id: string; account_id: string } | undefined, fallback: string): string {
    return account ? `${account.broker_id}:${account.account_id}` : `default:${fallback}`;
}

export function withProfitLossCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key);
    // 沒有排隊時同步開始（呼叫端的帳戶／模式檢查與送出時機不變）
    const run = prev ? prev.then(fn) : start(fn);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
}

function start<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return Promise.resolve(fn());
    } catch (e) {
        return Promise.reject(e);
    }
}
