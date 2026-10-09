// src/lib/conditional/panel-bracket.test.ts — 括號單 from the panel (#226):
// rules and derived prices are refused before anything is sent.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ place: vi.fn(), host: vi.fn(), register: vi.fn(), add: vi.fn(), env: 'http://x|simulation' as string | null }));
vi.mock('../bracket', () => ({ ensureBracketHost: m.host, registerBracket: m.register, registrationFailureText: (e: unknown) => String(e) }));
vi.mock('../protection-env', () => ({ currentProtectionEnv: () => m.env }));
vi.mock('../trade', () => ({ notify: vi.fn(), placeQuickOrder: m.place }));
vi.mock('../trigger-engine', () => ({ addTrigger: m.add }));

const { placePanelBracket } = await import('./panel-bracket');
const STK = { code: '1234', security_type: 'STK', exchange: 'TSE' };
const TXF = { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', tick: 1 };
const A = { account_type: 'F', broker_id: 'b', account_id: 'a', person_id: '', signed: true, username: '' };
const plan = { tiers: [{ quantity: 1, takeTicks: 10 }], stopTicks: 40, trail: null, breakeven: null };

beforeEach(() => {
    for (const f of [m.place, m.host, m.register, m.add]) f.mockReset();
    m.place.mockResolvedValue({ order: { id: 'o1', seqno: '1' }, contract: { code: 'TXFJ6' } });
    m.env = 'http://x|simulation';
});

describe('placePanelBracket', () => {
    it('a stop that would be ≤ 0 is refused before sending', async () => {
        const r = await placePanelBracket({ contract: STK as never, account: A as never, action: 'Buy', entry: { type: 'LMT', price: 1 },
            plan: { ...plan, stopTicks: 200 }, refPrice: 1 });
        expect(r).toEqual({ error: expect.stringContaining('停損價小於等於 0') });
        expect(m.place).not.toHaveBeenCalled();
    });

    it('invalid rules are refused before sending', async () => {
        const r = await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', entry: { type: 'MKT' },
            plan: { ...plan, tiers: [{ quantity: 1, takeTicks: null }] }, refPrice: 48000 });
        expect(r).toEqual({ error: expect.stringContaining('移動停損') });
        expect(m.place).not.toHaveBeenCalled();
    });

    it('sends the entry, then registers each tier; the entry never goes out in another environment', async () => {
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', entry: { type: 'LMT', price: 48150 },
            plan, refPrice: 48150 })).toBe('placed');
        expect(m.host).toHaveBeenCalledTimes(1);
        expect(m.register).toHaveBeenCalledTimes(1);
        const opts = m.place.mock.calls[0]![4] as { beforeSend: () => void; source: string; orderType: string };
        expect([opts.source, opts.orderType]).toEqual(['manual', 'ROD']);
        m.env = 'http://x|production';
        expect(() => opts.beforeSend()).toThrow('已切換');
    });
});
