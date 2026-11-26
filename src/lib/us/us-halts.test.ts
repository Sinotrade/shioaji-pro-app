import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), cap: vi.fn() }));
vi.mock('../api', () => ({ apiGet: m.get, apiPost: m.post }));
vi.mock('../stream', () => ({ registerCapabilitySubscription: m.cap }));
vi.mock('../runtime', () => ({ getApiBase: () => 'http://fixture.invalid' }));

import { resetUsStreamNamesForTest } from './us-stream-names';
import { resetUsHaltsForTest, retainUsHalts, usHaltFor, usHaltLabel, type UsHaltEntry } from './us-halts';

const h = (p: Partial<UsHaltEntry>): UsHaltEntry => ({ scope: 'Symbol', exchange: 'NASDAQ', code: 'AAPL', tradable_status: 2, halt_reason: 4, ...p });

afterEach(() => { resetUsHaltsForTest(); resetUsStreamNamesForTest(); vi.resetAllMocks(); });

describe('US halt book', () => {
    it('matches market, exchange and symbol halts', () => {
        const aapl = { exchange: 'NASDAQ', code: 'AAPL' };
        expect(usHaltFor(aapl, [h({ code: 'MSFT' })])).toBeNull();
        expect(usHaltFor(aapl, [h({})])).not.toBeNull();
        expect(usHaltFor(aapl, [h({ scope: 'Exchange', code: '', exchange: 'NYSE' })])).toBeNull();
        expect(usHaltFor(aapl, [h({ scope: 'Exchange', code: '' })])?.scope).toBe('Exchange');
        expect(usHaltFor(aapl, [h({ scope: 'Market', code: '', exchange: '' })])?.scope).toBe('Market');
        expect(usHaltLabel(h({}))).toBe('停牌');
        expect(usHaltLabel(h({ tradable_status: 3 }))).toBe('暫停交易');
    });
    it('subscribes the halt feed once, registers it for replay and polls us_halts', async () => {
        m.post.mockResolvedValue({ success: true });
        m.get.mockResolvedValue({ subscribed: true, last_seq: 1, halts: [h({})] });
        const release = retainUsHalts();
        const release2 = retainUsHalts();
        await vi.waitFor(() => expect(m.get).toHaveBeenCalledWith('/api/v1/stream/us_halts'));
        expect(m.post).toHaveBeenCalledTimes(1);
        expect(m.post).toHaveBeenCalledWith('/api/v1/stream/subscribe/halt_stk_us', {});
        expect(m.cap).toHaveBeenCalledWith('halt_stk_us', 'halt_stk_us', {});
        expect(usHaltFor({ exchange: 'NASDAQ', code: 'AAPL' })).not.toBeNull();
        release(); release2();
    });
    it('falls back to subscribe/us_halt on a 1.8.0b1–b3 sidecar that 404s the new path', async () => {
        m.post.mockImplementation(async (path: string) => {
            if (path.endsWith('/halt_stk_us')) throw Object.assign(new Error('404 Not Found'), { status: 404 });
            return { success: true };
        });
        m.get.mockResolvedValue({ subscribed: true, last_seq: 1, halts: [] });
        const release = retainUsHalts();
        await vi.waitFor(() => expect(m.get).toHaveBeenCalled());
        expect(m.post.mock.calls.map(c => c[0])).toEqual([
            '/api/v1/stream/subscribe/halt_stk_us',
            '/api/v1/stream/subscribe/us_halt',
        ]);
        expect(m.cap).toHaveBeenCalledWith('halt_stk_us', 'halt_stk_us', {});
        release();
    });
    it('does not fall back on a non-404 failure', async () => {
        m.post.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
        m.get.mockResolvedValue({ subscribed: false, last_seq: 0, halts: [] });
        const release = retainUsHalts();
        await vi.waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        expect(m.post).toHaveBeenCalledTimes(1);
        expect(m.cap).not.toHaveBeenCalled();
        release();
    });
});
