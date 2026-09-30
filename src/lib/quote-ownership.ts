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
let queue = Promise.resolve();
const keyOf = (d: Desired) => JSON.stringify([d.contract.security_type, d.contract.exchange, d.contract.target_code || d.contract.code, d.type, ...(d.odd ? ['odd'] : [])]);
const oddOpts = (d: Desired) => (d.odd ? [{ oddLot: true }] as const : [] as const);
// A consumer that remounts (e.g. contract metadata refreshed after a
// reconnect) releases and re-retains asynchronously. Unsubscribing in that
// gap caused an unsubscribe+subscribe pair per quote on every reconnect, on
// top of the registry replay. Releases therefore wait briefly and only
// unsubscribe what is still unwanted.
export const RELEASE_GRACE_MS = 1500;
function desiredNow() {
    const desired = new Map<string, Desired>();
    for (const set of clients.values()) for (const [key, value] of set) desired.set(key, value);
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
            try { await subscribeQuote(value.contract, value.type, ...oddOpts(value)); active.set(key, value); } catch { /* reconnect registry/manual re-acquire retries */ }
        }
        if (![...active.keys()].some(key => !desired.has(key))) return;
        if (!immediate) await new Promise(resolve => setTimeout(resolve, RELEASE_GRACE_MS));
        const still = immediate ? desired : desiredNow();
        for (const [key, value] of active) if (!still.has(key)) {
            if (!canOwn()) return;
            try { await unsubscribeQuote(value.contract, value.type, ...oddOpts(value)); active.delete(key); } catch { /* preserve ownership for a later retry */ }
        }
    });
}
channel?.addEventListener('message', e => {
    if (e.data?.kind === 'hello') { if (!canOwn()) sync(); return; }
    if (!canOwn() || e.data?.kind !== 'desired' || typeof e.data.client !== 'string' || !Array.isArray(e.data.desired)) return;
    const desired = (e.data.desired as Desired[]).filter(d => d?.contract?.code && ['Tick', 'BidAsk', 'Quote'].includes(d.type))
        .map((d): Desired => (d.odd === true ? { contract: d.contract, type: d.type, odd: true } : { contract: d.contract, type: d.type }));
    clients.set(e.data.client, new Map(desired.map(d => [keyOf(d), d])));
    sync();
});
if (!mirror) channel?.postMessage({ kind: 'hello' });
const stopStatus = subscribeStatusStore(() => {
    if (getStreamStatus() === 'live') sync();
});
const stopOwner = subscribeStreamOwner(() => {
    if (!canOwn()) { active.clear(); clients.clear(); }
    if (canOwn()) channel?.postMessage({ kind: 'hello' });
    sync();
});
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
export function retainContractQuotes(contract: ContractBase, options?: RetainOptions): () => void {
    // 零股只有股票（Tick／BidAsk）；其他商品沒有零股行情
    if (options?.oddLot && contract.security_type !== 'STK') return () => undefined;
    const releases = (contract.security_type === 'IND' ? ['Quote'] as const : ['Tick', 'BidAsk'] as const).map(t => retainQuote(contract, t, options));
    return () => releases.forEach(release => release());
}
function dispose() {
    stopStatus();
    stopOwner();
    local.clear();
    sync(true);
    channel?.close();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);
