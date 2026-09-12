import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), status: 'live', changed: undefined as (() => void) | undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => 'test-api' }));
vi.mock('./shioaji', () => ({ subscribeQuote: mocks.subscribe, unsubscribeQuote: mocks.unsubscribe }));
vi.mock('./stream', () => ({ getStreamStatus: () => mocks.status, subscribeStatusStore: (fn: () => void) => { mocks.changed = fn; return () => {}; } }));
const contract = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };

describe('quote ownership shared consumers', () => {
    beforeEach(() => {
        vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('BroadcastChannel', undefined);
        mocks.status = 'live'; mocks.changed = undefined;
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
        b(); await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
    });
    it('preserves an already-active legacy trigger Tick when the last panel closes', async () => {
        vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'sj-pro-triggers' ? JSON.stringify([{ code: contract.code, enabled: true }]) : null });
        const { retainQuote } = await import('./quote-ownership');
        const tick = retainQuote(contract, 'Tick'); const book = retainQuote(contract, 'BidAsk');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        tick(); book();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
        expect(mocks.unsubscribe).toHaveBeenCalledWith(contract, 'BidAsk');
        expect(mocks.subscribe).toHaveBeenCalledTimes(2);
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
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
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
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
    });
});
