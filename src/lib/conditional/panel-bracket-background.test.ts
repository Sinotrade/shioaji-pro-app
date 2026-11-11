// src/lib/conditional/panel-bracket-background.test.ts — a panel 括號單 with
// 「背景持續執行（實驗）」 on (#226 step 3): one owner decided before anything
// is sent; the engine gets the tiers and rules (it prices them from the
// actual fill) and either the window's accepted entry or a 觸價 entry it fires.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ place: vi.fn(), register: vi.fn(), add: vi.fn(), create: vi.fn(), owner: 'background' as unknown,
    notify: vi.fn(), risk: { enabled: false, maxDailyLoss: 0 } }));
vi.mock('../risk', () => ({ getRiskSettings: () => m.risk }));
vi.mock('../bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: m.register, registrationFailureText: (e: unknown) => String(e) }));
vi.mock('../protection-env', () => ({ currentProtectionEnv: () => 'http://x|simulation' }));
vi.mock('../trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('../trigger-engine', () => ({ addTrigger: m.add }));
vi.mock('../tick-bands', () => ({ ensureTickBands: async () => [{ min: 0, max: 10, tick: 0.1 }, { min: 10, max: null, tick: 0.5 }],
    prefetchTickBands: () => undefined, bandTickFor: (_r: string, p: number) => (p < 10 ? 0.1 : 0.5) }));
vi.mock('../execution/background', () => ({ backgroundSupported: () => true, backgroundOwnerForNew: async () => m.owner,
    createBackgroundBracket: m.create }));

const { placePanelBracket } = await import('./panel-bracket');
const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', tick: 1 };
const TXO = { code: 'TXO20000J6', security_type: 'OPT', exchange: 'TAIFEX', tick_rule: 'txo', tick: 0.5 };
const A = { account_type: 'F', broker_id: 'b', account_id: 'a', person_id: '', signed: true, username: '' };
const plan = { tiers: [{ quantity: 1, takeTicks: 10 }, { quantity: 2, takeTicks: null }], stopTicks: 4,
    trail: { activateTicks: 5, distanceTicks: 3, stepTicks: 1 }, breakeven: { afterTier: 1, offsetTicks: 1 } };

beforeEach(() => {
    for (const f of [m.place, m.register, m.add, m.create, m.notify]) f.mockReset();
    m.owner = 'background';
    m.risk = { enabled: false, maxDailyLoss: 0 };
    m.create.mockResolvedValue('created');
    m.place.mockResolvedValue({ order: { id: 'E1', seqno: 'S1', ordno: '' }, contract: { code: 'TXFR1', target_code: 'TXFJ6' } });
});

describe('panel bracket in the background', () => {
    it('a 觸價 entry is fired by the engine (an opening order) with the tiers; nothing in this window', async () => {
        const validity = { type: 'today' as const, until: Date.now() + 60_000 };
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 20000,
            entry: { type: 'touch', condition: 'above', price: 20100, send: { type: 'LMT', ticks: 2 }, validity } })).toBe('trigger');
        expect(m.add).not.toHaveBeenCalled();
        expect(m.place).not.toHaveBeenCalled();
        const [request] = m.create.mock.calls[0]!;
        expect(request).toMatchObject({ side: 'Buy', qty: 3, stop: null, take: null,
            binding: { env: 'simulation', serverId: 'http://x', account: { accountType: 'F', brokerId: 'b', accountId: 'a' },
                contract: { quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
            trigger: { condition: 'above', price: 20100, order: { priceType: 'LMT', timeInForce: 'ROD' }, limitTicks: 2, validity },
            plan: { tiers: [{ quantity: 1, takeTicks: 10 }, { quantity: 2, takeTicks: null }], stopTicks: 4,
                trail: plan.trail, breakeven: plan.breakeven },
            tickTable: [{ min: 0, max: null, tick: 1 }] });
        expect(request.entry).toBeUndefined();
    });

    it('a limit entry is sent here first, then handed over with its trade id and the exchange band table', async () => {
        expect(await placePanelBracket({ contract: TXO as never, account: A as never, action: 'Sell', plan, refPrice: 120,
            entry: { type: 'LMT', price: 120 } })).toBe('placed');
        expect(m.register).not.toHaveBeenCalled();
        const [request] = m.create.mock.calls[0]!;
        expect(request).toMatchObject({ side: 'Sell', entry: { tradeId: 'E1', seqno: 'S1', ordno: null },
            tickTable: [{ min: 0, max: 10, tick: 0.1 }, { min: 10, max: null, tick: 0.5 }] });
        expect(request.trigger).toBeUndefined();
    });

    it('the entry session is when it really leaves (after the order confirmation)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        m.place.mockImplementation(async (_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
            vi.setSystemTime(9_000_000); // the user confirmed much later
            opts.beforeSend();
            return { order: { id: 'E1', seqno: 'S1', ordno: '' }, contract: { code: 'TXFR1', target_code: 'TXFJ6' } };
        });
        await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 20000, entry: { type: 'MKT' } });
        expect(m.create.mock.calls[0]![0].entry.sentAt).toBe(9_000_000);
        vi.useRealTimers();
    });

    it('refused by the engine after the entry went out: said so, never resent', async () => {
        m.create.mockResolvedValue({ refused: '這張進場單已有括號單保護' });
        const r = await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 20000,
            entry: { type: 'MKT' } });
        expect(r).toEqual({ error: expect.stringContaining('進場單已送出') });
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledTimes(1);
    });

    it('the engine cannot take it: refused before anything is sent (never silently in this window)', async () => {
        m.owner = { refused: '背景執行目前無法使用' };
        const r = await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 20000,
            entry: { type: 'MKT' } });
        expect(r).toEqual({ error: '背景執行目前無法使用' });
        expect(m.place).not.toHaveBeenCalled();
        expect(m.register).not.toHaveBeenCalled();
    });

    it('a stock bracket (現股 整股) goes to the engine on a securities account with the stock tick table', async () => {
        const STK = { code: '2330', security_type: 'STK', exchange: 'TSE' };
        const SA = { ...A, account_type: 'S' };
        expect(await placePanelBracket({ contract: STK as never, account: SA as never, action: 'Buy', plan: { ...plan, trail: null, breakeven: null,
            tiers: [{ quantity: 1, takeTicks: 10 }] }, refPrice: 600,
            entry: { type: 'touch', condition: 'above', price: 600, send: { type: 'MKT' }, validity: { type: 'today', until: Date.now() + 60_000 } } })).toBe('trigger');
        const [request] = m.create.mock.calls[0]!;
        expect(request).toMatchObject({ binding: { account: { accountType: 'S' }, contract: { market: 'stock', securityType: 'STK' } },
            trigger: { order: { priceType: 'MKT', timeInForce: 'IOC', stockCond: 'Cash', stockLot: 'Common' } } });
        expect(request.tickTable[4]).toEqual({ min: 500, max: 1000, tick: 1 });
    });

    it('stock: a sell bracket, or an immediate entry under a daily loss limit, sends nothing', async () => {
        const STK = { code: '2330', security_type: 'STK', exchange: 'TSE' };
        const SA = { ...A, account_type: 'S' };
        const one = { ...plan, trail: null, breakeven: null, tiers: [{ quantity: 1, takeTicks: 10 }] };
        const sell = await placePanelBracket({ contract: STK as never, account: SA as never, action: 'Sell', plan: one, refPrice: 600, entry: { type: 'MKT' } });
        expect(sell).toEqual({ error: expect.stringContaining('股票賣出括號單') });
        m.risk = { enabled: true, maxDailyLoss: 5000 };
        const buy = await placePanelBracket({ contract: STK as never, account: SA as never, action: 'Buy', plan: one, refPrice: 600, entry: { type: 'MKT' } });
        expect(buy).toEqual({ error: expect.stringContaining('股票帳戶的當日損益') });
        expect(m.place).not.toHaveBeenCalled();
        expect(m.create).not.toHaveBeenCalled();
    });
});
