// 可否融資／融券（閃電信用條件）：用 App 已有的 credit_enquire（籌碼卡在用）。
// 只有「確定不可」（成數或單位為 0）才擋；查詢失敗或欄位缺漏＝無法確認，不擋。
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ post: vi.fn(), base: 'http://a' }));
vi.mock('./api', () => ({ apiPost: m.post }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
import { creditSideBlocks, creditStatus, loadCreditEnquire, prepareCreditOrder, resetCreditEnquireCache, type CreditEnquire } from './credit-eligibility';

const row = (patch: Partial<CreditEnquire> = {}): CreditEnquire => ({
    stock_id: '2330', system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90, ...patch,
});
const stk = { code: '2330', security_type: 'STK', exchange: 'TSE' } as const;

beforeEach(() => {
    vi.useRealTimers();
    m.post.mockReset();
    m.base = 'http://a';
    resetCreditEnquireCache();
});

it('blocks only when the ratio or the unit is exactly 0', () => {
    expect(creditStatus(row(), 'MarginTrading')).toBe('ok');
    expect(creditStatus(row(), 'ShortSelling')).toBe('ok');
    expect(creditStatus(row({ margin_unit: 0 }), 'MarginTrading')).toBe('blocked');
    expect(creditStatus(row({ margin_loan_ratio: 0 }), 'MarginTrading')).toBe('blocked');
    expect(creditStatus(row({ short_unit: 0 }), 'ShortSelling')).toBe('blocked');
    expect(creditStatus(row({ short_margin_ratio: 0 }), 'ShortSelling')).toBe('blocked');
    // the other side does not matter
    expect(creditStatus(row({ short_unit: 0 }), 'MarginTrading')).toBe('ok');
    // negative units come back from the server (meaning unconfirmed) — not a definite 0
    expect(creditStatus(row({ margin_unit: -95, short_unit: -1 }), 'ShortSelling')).toBe('ok');
});

it('missing or malformed answers are "unknown", never blocked', () => {
    expect(creditStatus(undefined, 'MarginTrading')).toBe('unknown');
    expect(creditStatus(row({ short_unit: undefined as unknown as number }), 'ShortSelling')).toBe('unknown');
    expect(creditStatus(row({ margin_loan_ratio: 'x' as unknown as number }), 'MarginTrading')).toBe('unknown');
});

it('queries once per stock per day and server, and does not cache a failure', async () => {
    m.post.mockResolvedValue([row()]);
    await loadCreditEnquire(stk);
    await loadCreditEnquire(stk);
    expect(m.post).toHaveBeenCalledOnce();
    expect(m.post.mock.calls[0]).toEqual(['/api/v1/data/credit_enquire', { contracts: [stk] }]);
    m.base = 'http://b';
    await loadCreditEnquire(stk);
    expect(m.post).toHaveBeenCalledTimes(2);
    m.post.mockRejectedValueOnce(new Error('down'));
    await expect(loadCreditEnquire({ ...stk, code: '2317' })).rejects.toThrow('down');
    m.post.mockResolvedValue([row({ stock_id: '2317' })]);
    await expect(loadCreditEnquire({ ...stk, code: '2317' })).resolves.toMatchObject({ stock_id: '2317' });
});

it('a new Taipei trading day queries again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T15:00:00+08:00'));
    m.post.mockResolvedValue([row()]);
    await loadCreditEnquire(stk);
    vi.setSystemTime(new Date('2026-10-09T08:30:00+08:00'));
    await loadCreditEnquire(stk);
    expect(m.post).toHaveBeenCalledTimes(2);
});

it('an empty answer, or one for another stock only, resolves to undefined (unknown)', async () => {
    m.post.mockResolvedValue([]);
    await expect(loadCreditEnquire(stk)).resolves.toBeUndefined();
    m.post.mockResolvedValue([row({ stock_id: '2317', short_unit: 0 })]);
    await expect(loadCreditEnquire({ ...stk, code: '2454' })).resolves.toBeUndefined();
});

it('a fresh load bypasses the cached answer and replaces it', async () => {
    m.post.mockResolvedValue([row()]);
    await loadCreditEnquire(stk);
    m.post.mockResolvedValue([row({ margin_unit: 0 })]);
    await expect(loadCreditEnquire(stk, { fresh: true })).resolves.toMatchObject({ margin_unit: 0 });
    await expect(loadCreditEnquire(stk)).resolves.toMatchObject({ margin_unit: 0 });
    expect(m.post).toHaveBeenCalledTimes(2);
});

// 閃電與圖表下單共用：每一邊的停用原因、點下去時的可否融資券檢查
const cash = { cond: 'Cash', daytradeShort: false } as const;
const margin = { cond: 'MarginTrading', daytradeShort: false } as const;
const short = { cond: 'ShortSelling', daytradeShort: false } as const;

it('side blocks: 融券／借券 never buy, 融資 0 stops only 融資買進, 現沖 needs a day-tradable stock', () => {
    const c = { code: '2330', day_trade: 'Yes' };
    expect(creditSideBlocks(c, cash, 'ok')).toMatchObject({ buy: null, sell: null });
    expect(creditSideBlocks(c, short, 'ok').buy).toMatch(/只能賣出/);
    expect(creditSideBlocks(c, { cond: 'SBLShort', daytradeShort: false }, 'ok')).toMatchObject({ sell: null, sellOnly: true });
    const m0 = creditSideBlocks(c, margin, 'blocked');
    expect(m0.buy).toMatch(/不能融資買進/);
    expect(m0.sell).toBeNull();
    expect(creditSideBlocks(c, short, 'blocked').sell).toMatch(/不能融券賣出/);
    expect(creditSideBlocks({ code: '2330', day_trade: 'OnlyBuy' }, { cond: 'Cash', daytradeShort: true }, 'ok'))
        .toMatchObject({ buy: null, sell: expect.stringMatching(/只能先買後賣/) });
    expect(creditSideBlocks({ code: '2330', day_trade: 'No' }, { cond: 'Cash', daytradeShort: true }, 'ok').sell).toMatch(/不可當沖/);
    // unknown / loading never block
    expect(creditSideBlocks(c, margin, 'unknown')).toMatchObject({ buy: null, sell: null });
});

it('prepareCreditOrder checks eligibility only for 融資買進／融券賣出 and re-checks after the confirmation', async () => {
    expect(await prepareCreditOrder(stk, 'Sell', margin)).toEqual({ check: expect.any(Function) });
    expect(m.post).not.toHaveBeenCalled();
    m.post.mockResolvedValue([row()]);
    const gate = await prepareCreditOrder(stk, 'Buy', margin);
    expect(gate.afterConfirm).toBeTypeOf('function');
    m.post.mockResolvedValue([row({ margin_unit: 0 })]);
    await expect(gate.afterConfirm!()).rejects.toThrow('2330 目前不能融資買進，已停止送單');
    // a cached 0 is re-queried once at the click; still 0 refuses
    await expect(prepareCreditOrder(stk, 'Buy', margin)).rejects.toThrow('不能融資買進');
    // failures never block (the broker decides)
    m.post.mockRejectedValue(new Error('down'));
    resetCreditEnquireCache();
    await expect(prepareCreditOrder(stk, 'Sell', short)).resolves.toMatchObject({ afterConfirm: expect.any(Function) });
});

it('prepareCreditOrder: a server switch during the check refuses; the dispatch check catches a new day or server', async () => {
    let release!: (v: unknown) => void;
    m.post.mockImplementation(() => new Promise(r => { release = r; }));
    const p = prepareCreditOrder(stk, 'Buy', margin);
    m.base = 'http://b';
    release([row()]);
    await expect(p).rejects.toThrow('伺服器已切換');
    m.base = 'http://a';
    m.post.mockResolvedValue([row()]);
    const gate = await prepareCreditOrder(stk, 'Buy', margin);
    expect(() => gate.check()).not.toThrow();
    m.base = 'http://c';
    expect(() => gate.check()).toThrow('可否融資券需重新確認');
});

it('prepareCreditOrder: a 現沖 sell confirmation left open past Taipei midnight is refused at dispatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T23:59:50+08:00'));
    const gate = await prepareCreditOrder(stk, 'Sell', { cond: 'Cash', daytradeShort: true });
    expect(() => gate.check()).not.toThrow();
    vi.setSystemTime(new Date('2026-10-09T00:00:10+08:00'));
    expect(() => gate.check()).toThrow('可否當沖需重新確認');
});
