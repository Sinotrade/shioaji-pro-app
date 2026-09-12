import { getApiBase } from './runtime';
import { subscribeQuote, unsubscribeQuote } from './shioaji';
import { getStreamStatus, subscribeStatusStore } from './stream';
import type { ContractBase } from './types/contract';
import type { QuoteTypeName } from './types/market';

// The main WebView owns broker subscriptions. Popouts publish their desired
// sets, so closing one consumer cannot unsubscribe another panel's quote.
const mirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
const client = typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Math.random());
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-quote-owners:${getApiBase()}`) : null;
type Desired = { contract: ContractBase; type: QuoteTypeName };
const local = new Map<string, { desired: Desired; refs: number }>();
const clients = new Map<string, Map<string, Desired>>();
const active = new Map<string, Desired>();
let queue = Promise.resolve();
const keyOf = (d: Desired) => JSON.stringify([d.contract.security_type, d.contract.exchange, d.contract.target_code || d.contract.code, d.type]);
function sync() {
    if (mirror) { channel?.postMessage({ kind: 'desired', client, desired: [...local.values()].map(v => v.desired) }); return; }
    clients.set(client, new Map([...local].map(([k, v]) => [k, v.desired])));
    queue = queue.catch(() => undefined).then(async () => {
        const desired = new Map<string, Desired>();
        for (const set of clients.values()) for (const [key, value] of set) desired.set(key, value);
        // Legacy trigger execution is explicitly deferred to #102. Preserve
        // its existing tick feed when a viewing panel closes; this only keeps
        // an already-active subscription, and does not start/change a strategy.
        try {
            const triggers: unknown = JSON.parse(localStorage.getItem('sj-pro-triggers') ?? '[]');
            if (Array.isArray(triggers)) for (const [key, value] of active) {
                if (value.type === 'Tick' && triggers.some(t => t?.code === value.contract.code)) desired.set(key, value);
            }
        } catch { /* no persisted legacy consumer */ }
        for (const [key, value] of active) if (!desired.has(key)) {
            try { await unsubscribeQuote(value.contract, value.type); active.delete(key); } catch { /* preserve ownership for a later retry */ }
        }
        for (const [key, value] of desired) if (!active.has(key)) {
            try { await subscribeQuote(value.contract, value.type); active.set(key, value); } catch { /* reconnect registry/manual re-acquire retries */ }
        }
    });
}
channel?.addEventListener('message', e => {
    if (e.data?.kind === 'hello') { if (mirror) sync(); return; }
    if (mirror || e.data?.kind !== 'desired' || typeof e.data.client !== 'string' || !Array.isArray(e.data.desired)) return;
    const desired = (e.data.desired as Desired[]).filter(d => d?.contract?.code && ['Tick', 'BidAsk', 'Quote'].includes(d.type));
    clients.set(e.data.client, new Map(desired.map(d => [keyOf(d), d])));
    sync();
});
if (!mirror) channel?.postMessage({ kind: 'hello' });
const stopStatus = subscribeStatusStore(() => {
    if (getStreamStatus() === 'live') sync();
});
export function retainQuote(contract: ContractBase, type: QuoteTypeName): () => void {
    const desired = { contract, type };
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
export function retainContractQuotes(contract: ContractBase): () => void {
    const releases = (contract.security_type === 'IND' ? ['Quote'] as const : ['Tick', 'BidAsk'] as const).map(t => retainQuote(contract, t));
    return () => releases.forEach(release => release());
}
function dispose() {
    stopStatus();
    local.clear();
    sync();
    channel?.close();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);
