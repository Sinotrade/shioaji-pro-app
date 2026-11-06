import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), status: 'live', changed: undefined as (() => void) | undefined, owner: false, ownerChanged: undefined as (() => void) | undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => 'test-api' }));
vi.mock('./shioaji', () => ({ subscribeQuote: mocks.subscribe, unsubscribeQuote: mocks.unsubscribe }));
vi.mock('./stream', () => ({ getStreamStatus: () => mocks.status, subscribeStatusStore: (fn: () => void) => { mocks.changed = fn; return () => {}; }, isStreamOwner: () => mocks.owner, subscribeStreamOwner: (fn: () => void) => { mocks.ownerChanged = fn; return () => {}; } }));
const contract = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };

describe('quote ownership shared consumers', () => {
    beforeEach(() => {
        vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('BroadcastChannel', undefined);
        mocks.status = 'live'; mocks.changed = undefined; mocks.owner = false; mocks.ownerChanged = undefined;
        mocks.subscribe.mockResolvedValue({ success: true }); mocks.unsubscribe.mockResolvedValue({ success: true });
    });
    afterEach(() => vi.unstubAllGlobals());
    it('shares alias and physical-contract ownership in one broker subscription', async () => {
        const { retainQuote } = await import('./quote-ownership');
        const physical = { ...contract, code: 'TXFI6', security_type: 'FUT' as const, exchange: 'TAIFEX' as const };
        const alias = { ...physical, code: 'TXFR1', target_code: 'TXFI6' };
        const a = retainQuote(alias, 'Tick');
        const b = retainQuote(physical, 'Tick');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        a(); await Promise.resolve(); await Promise.resolve();
        expect(mocks.unsubscribe).not.toHaveBeenCalled();
        b(); await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
    });
    it('keeps a protection trigger Tick held by the main-window engine when the last panel closes (#102)', async () => {
        const { retainQuote } = await import('./quote-ownership');
        const engineHold = retainQuote(contract, 'Tick'); // trigger-engine syncQuotes()
        const tick = retainQuote(contract, 'Tick'); const book = retainQuote(contract, 'BidAsk');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        tick(); book();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
        expect(mocks.unsubscribe).toHaveBeenCalledWith(contract, 'BidAsk');
        engineHold();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(2), { timeout: 4000 });
        expect(mocks.unsubscribe).toHaveBeenLastCalledWith(contract, 'Tick');
    });
    it('a quote pinned for the background engine survives the page going away (#201)', async () => {
        const handlers: Record<string, () => void> = {};
        vi.stubGlobal('window', { addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; } });
        const { pinQuote, retainQuote } = await import('./quote-ownership');
        pinQuote(contract, 'Tick');
        retainQuote(contract, 'BidAsk');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        handlers.pagehide!();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
        expect(mocks.unsubscribe).toHaveBeenCalledWith(contract, 'BidAsk');
        await new Promise(r => setTimeout(r, 50));
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    });
    it('subscribes once and releases only when the last local consumer leaves', async () => {
        const { retainQuote } = await import('./quote-ownership');
        const first = retainQuote(contract, 'Tick');
        const second = retainQuote(contract, 'Tick');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        first();
        await Promise.resolve(); await Promise.resolve();
        expect(mocks.unsubscribe).not.toHaveBeenCalled();
        second();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
        second();
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    });
    it('retries an initially failed subscription when the stream becomes live', async () => {
        mocks.subscribe.mockRejectedValueOnce(new Error('temporary unavailable'));
        const { retainQuote } = await import('./quote-ownership');
        const release = retainQuote(contract, 'Tick');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        mocks.changed?.();
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        release();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
    });
    it('does not churn unsubscribe+subscribe when a consumer re-retains within the grace (reconnect remount)', async () => {
        vi.useFakeTimers();
        try {
            const { retainQuote, RELEASE_GRACE_MS } = await import('./quote-ownership');
            const first = retainQuote(contract, 'Tick');
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.subscribe).toHaveBeenCalledTimes(1);
            first(); // remount: release now, re-retain after an async lookup
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS / 3);
            const again = retainQuote(contract, 'Tick');
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS * 2);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            expect(mocks.subscribe).toHaveBeenCalledTimes(1);
            again();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });
    it('lets a popout subscribe its quotes after it becomes the SSE owner', async () => {
        vi.stubGlobal('location', { search: '?popout=chart' });
        const { retainQuote } = await import('./quote-ownership');
        const release = retainQuote(contract, 'Tick');
        await Promise.resolve();
        expect(mocks.subscribe).not.toHaveBeenCalled();
        mocks.owner = true;
        mocks.ownerChanged?.();
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith(contract, 'Tick'));
        release();
    });
    it('counts 盤中零股 consumers apart from regular-lot ones of the same code (#204)', async () => {
        vi.useFakeTimers();
        try {
            const { retainQuote, retainContractQuotes, RELEASE_GRACE_MS } = await import('./quote-ownership');
            const round = retainQuote(contract, 'Tick');
            const oddA = retainQuote(contract, 'Tick', { oddLot: true });
            const oddB = retainQuote(contract, 'Tick', { oddLot: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.subscribe.mock.calls).toEqual([[contract, 'Tick'], [contract, 'Tick', { oddLot: true }]]);
            oddA();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            expect(mocks.unsubscribe).not.toHaveBeenCalled(); // oddB still holds the odd feed
            oddB();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            // only the odd-lot feed goes; the round-lot panel keeps its feed
            expect(mocks.unsubscribe.mock.calls).toEqual([[contract, 'Tick', { oddLot: true }]]);
            round();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            expect(mocks.unsubscribe.mock.calls.at(-1)).toEqual([contract, 'Tick']);
            // futures have no odd-lot feed
            retainContractQuotes({ ...contract, code: 'TXFJ6', security_type: 'FUT' as const, exchange: 'TAIFEX' as const }, { oddLot: true })();
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.subscribe).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });
    describe('subscriptions left behind by a reload (#386)', () => {
        let session: Map<string, string>;
        const other = { ...contract, code: '2317' };
        const reload = async () => { vi.resetModules(); return import('./quote-ownership'); };
        beforeEach(() => {
            session = new Map();
            vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); } });
            vi.useFakeTimers();
        });
        afterEach(() => { vi.useRealTimers(); });
        const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
        const subscribeOne = async (c: typeof contract) => {
            const mod = await import('./quote-ownership');
            mod.retainQuote(c, 'Tick');
            await flush();
            return mod;
        };
        it('after a reload, unsubscribes what the old page held and nobody wants now', async () => {
            await subscribeOne(contract);
            expect(mocks.unsubscribe).not.toHaveBeenCalled(); // the page unloaded before it could release
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS - 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled(); // consumers still mounting
            await vi.advanceTimersByTimeAsync(1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
            expect(mocks.unsubscribe.mock.calls[0]!.slice(0, 2)).toEqual([expect.objectContaining({ code: '2330' }), 'Tick']);
            await reload();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1); // cleared from the ledger, no repeat
        });
        it('keeps what the new page wants again', async () => {
            await subscribeOne(contract);
            const next = await reload();
            next.retainQuote(contract, 'Tick');
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
        it('never touches a subscription this page did not make', async () => {
            await subscribeOne(contract);
            session.clear(); // a different tab or a fresh start has its own ledger
            const next = await reload();
            next.retainQuote(other, 'Tick');
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
        it('leaves a quote pinned for the background engine', async () => {
            const handlers: Record<string, () => void> = {};
            vi.stubGlobal('window', { addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; } });
            const { pinQuote } = await import('./quote-ownership');
            pinQuote(contract, 'Tick');
            await flush();
            handlers.pagehide!();
            await flush();
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
        it('waits for the stream, and retries on a later load if the unsubscribe fails', async () => {
            await subscribeOne(contract);
            mocks.status = 'connecting';
            mocks.unsubscribe.mockRejectedValueOnce(new Error('down'));
            let next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            mocks.status = 'live'; mocks.changed!();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
            next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
        });
        it('keeps a quote another page still holds, and stops tracking it', async () => {
            await subscribeOne(contract);
            const key = (JSON.parse([...session.values()][0]!) as [string][])[0]![0];
            const sent: unknown[] = [];
            let listener: ((e: { data: unknown }) => void) | undefined;
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener(_: string, fn: (e: { data: unknown }) => void) { listener = fn; }
                postMessage(data: { kind: string }) { sent.push(data); if (data.kind === 'held?') queueMicrotask(() => listener!({ data: { kind: 'held', keys: [key] } })); }
                close() {}
            });
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(sent).toContainEqual({ kind: 'held?' });
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            expect(JSON.parse([...session.values()][0]!)).toEqual([]);
        });
        it('answers another page that is about to sweep', async () => {
            const sent: { kind: string; keys?: string[] }[] = [];
            let listener: ((e: { data: unknown }) => void) | undefined;
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener(_: string, fn: (e: { data: unknown }) => void) { listener = fn; }
                postMessage(data: { kind: string }) { sent.push(data); }
                close() {}
            });
            await subscribeOne(contract);
            listener!({ data: { kind: 'held?' } });
            expect(sent.find(m => m.kind === 'held')!.keys!.length).toBeGreaterThan(0);
        });
        it('announces a new subscription, so a sweep in progress elsewhere leaves it alone', async () => {
            const sent: { kind: string; keys?: string[] }[] = [];
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener() {}
                postMessage(data: { kind: string }) { sent.push(data); }
                close() {}
            });
            await subscribeOne(contract);
            expect(sent.filter(m => m.kind === 'held').map(m => m.keys)).toHaveLength(1);
        });
        it('does not unsubscribe a quote wanted while the sweep is waiting on an earlier one', async () => {
            await subscribeOne(contract);
            await subscribeOne(other);
            let finish!: (v: unknown) => void;
            mocks.unsubscribe.mockImplementationOnce(() => new Promise(r => { finish = r; }));
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
            next.pinQuote(other, 'Tick');
            finish({ success: true });
            await flush();
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
        });
        it('a popout leaves the ledger alone', async () => {
            await subscribeOne(contract);
            vi.stubGlobal('location', { search: '?popout=1' });
            mocks.owner = true;
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
    });
});
