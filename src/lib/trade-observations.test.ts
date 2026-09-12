import { afterEach, expect, it, vi } from 'vitest';
import type { Trade } from './types/order';
vi.mock('./runtime', () => ({ getApiBase: () => 'fixture' }));
afterEach(() => vi.unstubAllGlobals());
it('isolates a throwing display listener and closed transport from the accepted Trade', async () => {
    vi.resetModules();
    vi.stubGlobal('BroadcastChannel', class {
        addEventListener() {}
        postMessage() { throw new Error('closed transport'); }
        close() {}
    });
    const { observeTradeResponse, onTradeResponse } = await import('./trade-observations');
    const trade: Trade = {
        contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null },
        order: { id: 'accepted', seqno: 'seq', ordno: 'ord', action: 'Buy', price: 100, quantity: 1 },
        status: { id: 'accepted', status: 'Submitted', status_code: '00', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
    };
    const original = structuredClone(trade);
    const later = vi.fn();
    const a = onTradeResponse(() => { throw new Error('broken display'); });
    const b = onTradeResponse(later);
    await expect(Promise.resolve(trade).then(value => observeTradeResponse(value))).resolves.toBe(trade);
    expect(trade).toEqual(original);
    expect(later).toHaveBeenCalledWith({ trade, account: undefined });
    a(); b();
});
