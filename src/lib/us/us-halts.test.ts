import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), cap: vi.fn() }));
vi.mock('../api', () => ({ apiGet: m.get, apiPost: m.post }));
vi.mock('../stream', () => ({ registerCapabilitySubscription: m.cap }));

import { resetUsHaltsForTest, retainUsHalts, usHaltFor, usHaltLabel, type UsHaltEntry } from './us-halts';

const h = (p: Partial<UsHaltEntry>): UsHaltEntry => ({ scope: 'Symbol', exchange: 'NASDAQ', code: 'AAPL', tradable_status: 2, halt_reason: 4, ...p });

afterEach(() => { resetUsHaltsForTest(); vi.clearAllMocks(); });

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
        expect(m.post).toHaveBeenCalledWith('/api/v1/stream/subscribe/us_halt', {});
        expect(m.cap).toHaveBeenCalledWith('us_halt', 'us_halt', {});
        expect(usHaltFor({ exchange: 'NASDAQ', code: 'AAPL' })).not.toBeNull();
        release(); release2();
    });
});
