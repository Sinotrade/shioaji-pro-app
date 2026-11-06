import { getApiBase } from './runtime';
import { subscribeQuote, unsubscribeQuote } from './shioaji';
import { getStreamStatus, isStreamOwner, subscribeStatusStore, subscribeStreamOwner } from './stream';
import type { ContractBase } from './types/contract';
import type { QuoteTypeName } from './types/market';

// The main WebView owns broker subscriptions. Popouts publish their desired
// sets, so closing one consumer cannot unsubscribe another panel's quote.
const mirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
const client = typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Math.random());
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-quote-owners:${getApiBase()}`) : null;
// `odd`: 盤中零股 feed (intraday_odd) — a separate broker subscription with
// its own consumers; releasing the last odd-lot panel never touches the
// regular-lot feed of the same code and vice versa (#204).
type Desired = { contract: ContractBase; type: QuoteTypeName; odd?: boolean };
const local = new Map<string, { desired: Desired; refs: number }>();
const clients = new Map<string, Map<string, Desired>>();
const active = new Map<string, Desired>();
const canOwn = () => !mirror || isStreamOwner();
// #386 pagehide 時退訂是一筆接一筆 await，實測頁面卸載後只送得出第一筆，重新整理
// 留下的訂閱會在 sidecar 累積。所以記下這個頁面訂閱過什麼（sessionStorage：重新
// 整理還在、分頁之間不共用），下一次載入等消費者都掛上後，只退掉記錄裡沒人要的。
// 不向 sidecar 查全部訂閱來對帳：Agent、外部程式與其他分頁的訂閱不是我們的。
export const ORPHAN_SWEEP_DELAY_MS = 5000;
const HELD_REPLY_MS = 300;
const LEDGER_KEY = `sj-quote-ledger:${getApiBase()}`;
type LedgerEntry = { contract: ContractBase; type: QuoteTypeName; odd?: boolean };
function readLedger(): Map<string, LedgerEntry> {
    try {
        const raw = JSON.parse(sessionStorage.getItem(LEDGER_KEY) ?? '[]') as [string, LedgerEntry][];
        return new Map(Array.isArray(raw) ? raw : []);
    } catch {
        return new Map();
    }
}
const ledger = mirror ? new Map<string, LedgerEntry>() : readLedger();
// 上一次載入留下、這次還沒處理的訂閱
const orphans = new Map(ledger);
function saveLedger() {
    if (mirror) return; // 彈出視窗不訂閱，接手 SSE 後也沒有下一次載入可以清
    try {
        sessionStorage.setItem(LEDGER_KEY, JSON.stringify([...ledger]));
    } catch {
        // 無法寫入時只是少了下次的清理
    }
}
function remember(key: string, { contract, type, odd }: Desired) {
    const { security_type, exchange, code, target_code, region, combo } = contract as ContractBase & { combo?: unknown };
    ledger.set(key, { contract: { security_type, exchange, code, target_code, region, ...(combo ? { combo } : {}) } as ContractBase, type, ...(odd ? { odd } : {}) });
    saveLedger();
}
function forget(key: string) {
    if (ledger.delete(key)) saveLedger();
}
let queue = Promise.resolve();
const keyOf = (d: Desired) => JSON.stringify([d.contract.security_type, d.contract.exchange, d.contract.target_code || d.contract.code, d.type, ...(d.odd ? ['odd'] : [])]);
const oddOpts = (d: Desired) => (d.odd ? [{ oddLot: true }] as const : [] as const);
// A consumer that remounts (e.g. contract metadata refreshed after a
// reconnect) releases and re-retains asynchronously. Unsubscribing in that
// gap caused an unsubscribe+subscribe pair per quote on every reconnect, on
// top of the registry replay. Releases therefore wait briefly and only
// unsubscribe what is still unwanted.
export const RELEASE_GRACE_MS = 1500;
// #201: quotes the App's background engine watches. A page going away
// (reload, closed main window) never unsubscribes them: the engine keeps
// watching while no window is open.
const pinned = new Map<string, { desired: Desired; refs: number }>();
function desiredNow() {
    const desired = new Map<string, Desired>();
    for (const set of clients.values()) for (const [key, value] of set) desired.set(key, value);
    for (const [key, value] of pinned) desired.set(key, value.desired);
    // #102: protection triggers hold their Tick feed explicitly through
    // retainQuote() in the main-window trigger engine (no localStorage peek).
    return desired;
}
function sync(immediate = false) {
    if (!canOwn()) { channel?.postMessage({ kind: 'desired', client, desired: [...local.values()].map(v => v.desired) }); return; }
    clients.set(client, new Map([...local].map(([k, v]) => [k, v.desired])));
    queue = queue.catch(() => undefined).then(async () => {
        if (!canOwn()) return;
        const desired = desiredNow();
        for (const [key, value] of desired) if (!active.has(key)) {
            if (!canOwn()) return;
            // 先記再送：請求送出後頁面才卸載，訂閱也不會漏記
            remember(key, value);
            channel?.postMessage({ kind: 'held', keys: [key] }); // 別的分頁正準備清理時也要看得到
            try { await subscribeQuote(value.contract, value.type, ...oddOpts(value)); active.set(key, value); } catch { /* reconnect registry/manual re-acquire retries */ }
        }
        if (![...active.keys()].some(key => !desired.has(key))) return;
        if (!immediate) await new Promise(resolve => setTimeout(resolve, RELEASE_GRACE_MS));
        const still = immediate ? desired : desiredNow();
        for (const [key, value] of active) if (!still.has(key)) {
            if (!canOwn()) return;
            try { await unsubscribeQuote(value.contract, value.type, ...oddOpts(value)); active.delete(key); forget(key); } catch { /* preserve ownership for a later retry */ }
        }
    });
}
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
// 其他分頁還在用的不能退：sidecar 的訂閱不分頁面，退了對方也斷。退之前先問一聲
const heldElsewhere = new Set<string>();
function sweepOrphans() {
    sweepTimer = undefined;
    queue = queue.catch(() => undefined).then(async () => {
        if (!canOwn()) return;
        for (const [key, entry] of orphans) {
            orphans.delete(key);
            // 每一筆都重看：退訂在等回應的時候，可能又有人要了這個商品
            if (desiredNow().has(key) || active.has(key)) continue;
            if (heldElsewhere.has(key)) { forget(key); continue; }
            try {
                await unsubscribeQuote(entry.contract, entry.type, ...oddOpts(entry));
                forget(key);
            } catch { /* 留在記錄裡，下一次載入再試 */ }
        }
    });
}
function scheduleOrphanSweep() {
    if (orphans.size === 0 || sweepTimer !== undefined || getStreamStatus() !== 'live') return;
    sweepTimer = setTimeout(() => {
        channel?.postMessage({ kind: 'held?' });
        sweepTimer = setTimeout(sweepOrphans, HELD_REPLY_MS);
    }, ORPHAN_SWEEP_DELAY_MS - HELD_REPLY_MS);
}
channel?.addEventListener('message', e => {
    if (e.data?.kind === 'hello') { if (!canOwn()) sync(); return; }
    if (e.data?.kind === 'held?') {
        if (canOwn()) channel?.postMessage({ kind: 'held', keys: [...active.keys(), ...desiredNow().keys()] });
        return;
    }
    if (e.data?.kind === 'held') {
        if (Array.isArray(e.data.keys)) for (const key of e.data.keys) if (typeof key === 'string') heldElsewhere.add(key);
        return;
    }
    if (!canOwn() || e.data?.kind !== 'desired' || typeof e.data.client !== 'string' || !Array.isArray(e.data.desired)) return;
    const desired = (e.data.desired as Desired[]).filter(d => d?.contract?.code && ['Tick', 'BidAsk', 'Quote'].includes(d.type))
        .map((d): Desired => (d.odd === true ? { contract: d.contract, type: d.type, odd: true } : { contract: d.contract, type: d.type }));
    clients.set(e.data.client, new Map(desired.map(d => [keyOf(d), d])));
    sync();
});
if (!mirror) channel?.postMessage({ kind: 'hello' });
const stopStatus = subscribeStatusStore(() => {
    if (getStreamStatus() === 'live') { sync(); scheduleOrphanSweep(); }
});
const stopOwner = subscribeStreamOwner(() => {
    if (!canOwn()) { active.clear(); clients.clear(); }
    if (canOwn()) channel?.postMessage({ kind: 'hello' });
    sync();
});
scheduleOrphanSweep();
export interface RetainOptions {
    /** 盤中零股行情（intraday_odd），與整股分開計數 */
    oddLot?: boolean;
}
export function retainQuote(contract: ContractBase, type: QuoteTypeName, options?: RetainOptions): () => void {
    const desired: Desired = options?.oddLot ? { contract, type, odd: true } : { contract, type };
    const key = keyOf(desired);
    const old = local.get(key);
    local.set(key, { desired, refs: (old?.refs ?? 0) + 1 });
    sync();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const current = local.get(key);
        if (current && current.refs > 1) current.refs--;
        else local.delete(key);
        sync();
    };
}
/** Like retainQuote, but kept when this page goes away (main window only;
 * for the background engine's watched contracts). */
export function pinQuote(contract: ContractBase, type: QuoteTypeName, options?: { oddLot?: boolean }): () => void {
    // 盤中零股 (#226 背景零股條件): a separate subscription, stocks only
    const desired: Desired = options?.oddLot && contract.security_type === 'STK' ? { contract, type, odd: true } : { contract, type };
    const key = keyOf(desired);
    pinned.set(key, { desired, refs: (pinned.get(key)?.refs ?? 0) + 1 });
    sync();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const current = pinned.get(key);
        if (current && current.refs > 1) current.refs--;
        else pinned.delete(key);
        sync();
    };
}
export function retainContractQuotes(contract: ContractBase, options?: RetainOptions): () => void {
    // 零股只有股票（Tick／BidAsk）；其他商品沒有零股行情
    if (options?.oddLot && contract.security_type !== 'STK') return () => undefined;
    const releases = (contract.security_type === 'IND' ? ['Quote'] as const : ['Tick', 'BidAsk'] as const).map(t => retainQuote(contract, t, options));
    return () => releases.forEach(release => release());
}
function dispose() {
    stopStatus();
    stopOwner();
    clearTimeout(sweepTimer);
    // 釘住的留給背景引擎，不算孤兒
    for (const key of pinned.keys()) ledger.delete(key);
    saveLedger();
    local.clear();
    sync(true);
    channel?.close();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);
