// src/components/conditional-form.test.tsx — 新增條件單 (#226): the trigger
// and 二擇一 forms build exactly the request the engine gets.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const F = { account_type: 'F', broker_id: 'b', account_id: '9804567', person_id: '', signed: true, username: '' };
const TXF = { code: 'TXFJ6', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', tick: 1, target_code: 'TXFJ6', multiplier: 200 };

const S = { ...F, account_type: 'S', account_id: '1234567' };
const STK = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', tick: 5, target_code: null };
const m = vi.hoisted(() => ({ add: vi.fn(), group: vi.fn(), bracket: vi.fn(), contract: null as unknown }));
vi.mock('../lib/trigger-engine', () => ({ addTrigger: m.add, addTriggerGroup: m.group }));
vi.mock('../lib/contracts-cache', () => ({ useContract: (c: string | null) => c ? (m.contract ?? TXF) : undefined, ensureContract: async () => m.contract ?? TXF }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [F, S], selectedFutures: F, selectedStock: S }) }));
vi.mock('../lib/account-tradable', () => ({ canTrade: () => true }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => true, usePrivacyMoney: () => false, maskMoney: (t: string) => t,
    maskAccountId: (id: string) => `•••••${id.slice(-2)}` }));
vi.mock('../lib/stream', () => ({ getQuote: () => ({ tick: { close: 48212 } }), subscribeQuoteStore: () => () => undefined }));
vi.mock('../hooks/use-esc-close', () => ({ useEscClose: () => undefined }));
vi.mock('../lib/conditional/panel-bracket', () => ({ placePanelBracket: m.bracket, derivedPriceProblem: () => null }));

const { NewConditionalDialog } = await import('./conditional-form');
const { WARRANT_FLASH_TEXT } = await import('../lib/warrant-rules');

function render(contract: unknown = TXF) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.contract = contract;
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(NewConditionalDialog, { contract: contract as never, onClose: () => undefined })); });
    return r;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b) === label)!;
const input = (r: ReactTestRenderer, label: string) => r.root.findAll(n => n.type === 'input' && n.props['aria-label'] === label)[0]!;
const type = async (r: ReactTestRenderer, label: string, value: string) => {
    await act(async () => { input(r, label).props.onChange({ target: { value } }); });
};
const click = async (r: ReactTestRenderer, label: string) => { await act(async () => { button(r, label).props.onClick(); }); };

beforeEach(() => {
    m.add.mockReset().mockResolvedValue({ id: 'x' });
    m.group.mockReset().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    m.bracket.mockReset().mockResolvedValue('placed');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('NewConditionalDialog', () => {
    it('觸價單: 下穿, 限價 −2 檔, 本盤 — one entry trigger; the summary reads as a sentence', async () => {
        const r = render();
        await type(r, '觸發價', '47900');
        await click(r, '下穿');
        await click(r, '限價');
        expect(text(r.root)).toContain('賣出 1 口 限價 47,898');
        expect(text(r.root)).toContain('按「建立」即核可這筆下單');
        await click(r, '建立');
        expect(m.add).toHaveBeenCalledTimes(1);
        const [req, , opts] = m.add.mock.calls[0]!;
        expect(req).toMatchObject({ code: 'TXFJ6', condition: 'below', price: 47900, action: 'Sell', quantity: 1, kind: 'stop',
            role: 'entry', cross: true, send: { type: 'LMT', ticks: -2 }, validity: { type: 'session' } });
        expect(req.validity.until).toBeGreaterThan(Date.now());
        expect(opts.account.account_id).toBe('9804567');
    });

    it('a price off the tick grid or a bad quantity cannot be created', async () => {
        const r = render();
        await type(r, '觸發價', '47900.5');
        expect(button(r, '建立').props.disabled).toBe(true);
        expect(text(r.root)).toContain('不在跳動點上');
        await type(r, '觸發價', '47900');
        await type(r, '數量', '0');
        expect(button(r, '建立').props.disabled).toBe(true);
    });

    it('二擇一: both sides in one request, 成交後刪對應口數; refuses upper ≤ lower', async () => {
        const r = render();
        await click(r, '二擇一');
        await type(r, '上方價', '47800');
        await type(r, '下方價', '47900');
        expect(text(r.root)).toContain('上方價必須高於下方價');
        await type(r, '上方價', '48400');
        await click(r, '成交後刪對應口數');
        expect(text(r.root)).toContain('另一邊就扣掉多少口數');
        await click(r, '建立');
        expect(m.group).toHaveBeenCalledTimes(1);
        const legs = m.group.mock.calls[0]![0] as Record<string, unknown>[];
        expect(legs.map(l => [l.condition, l.price, l.action, l.ocoMode])).toEqual([['above', 48400, 'Buy', 'fill'], ['below', 47900, 'Sell', 'fill']]);
        expect(legs[0]!.group).toBe(legs[1]!.group);
        expect(legs[0]!.send).toEqual({ type: 'MKP' });
    });

    it('括號單: tiers must add up; stop / tiers / 移動停損 / 保本 go out as one plan', async () => {
        const r = render();
        await click(r, '括號單');
        await type(r, '進場限價', '48150');
        await type(r, '停損檔數', '40');
        expect(text(r.root)).toContain('≈ 48,110');
        expect(text(r.root)).toContain('每口風險');
        await type(r, '第 1 層停利檔數', '30');
        await type(r, '第 1 層數量', '1');
        expect(text(r.root)).toContain('各層數量合計 1，要等於進場 3 口');
        await click(r, '加一層');
        await type(r, '第 2 層停利檔數', '80');
        await click(r, '加一層');
        await type(r, '第 3 層數量', '1');
        await act(async () => { r.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox')[2]!.props.onChange({ target: { checked: true } }); });
        expect(text(r.root)).toContain('移動停損的啟動、距離與移動檔數要填正整數'); // never pre-filled
        await type(r, '移動停損啟動檔數', '20');
        await type(r, '移動停損距離檔數', '15');
        await type(r, '移動停損步長檔數', '5');
        await act(async () => { r.root.findAll(n => n.props.role === 'switch' && n.props['aria-label'] === '保本')[0]!.props.onClick(); });
        await click(r, '建立');
        expect(m.bracket).toHaveBeenCalledTimes(1);
        const req = m.bracket.mock.calls[0]![0];
        expect(req).toMatchObject({ action: 'Buy', entry: { type: 'LMT', price: 48150 }, refPrice: 48150, plan: {
            stopTicks: 40, tiers: [{ quantity: 1, takeTicks: 30 }, { quantity: 1, takeTicks: 80 }, { quantity: 1, takeTicks: null }],
            trail: { activateTicks: 20, distanceTicks: 15, stepTicks: 5 }, breakeven: { afterTier: 1, offsetTicks: 0 } } });
    });

    it('stocks: 整股／盤中零股 like the order ticket; 盤後零股 and 融資券 say why they are not offered (QA 10/12)', async () => {
        const r = render(STK);
        const all = text(r.root);
        expect(all).toContain('整股');
        expect(button(r, '盤後零股').props.disabled).toBe(true);
        expect(button(r, '融資').props.disabled).toBe(true);
        expect(button(r, '融券').props.disabled).toBe(true);
        expect(button(r, '融資').props.title).toContain('下單面板');
        await type(r, '觸發價', '1000');
        expect(text(r.root)).toContain('賣出 1 張');
        await click(r, '盤中零股');
        expect(text(r.root)).toContain('賣出 1 股（零股，漲跌停價限價）');
        // 零股: the send style is fixed, the price source is the last trade
        expect(r.root.findAll(n => n.props['aria-label'] === '觸發後')).toHaveLength(0);
        await type(r, '數量', '1000');
        expect(button(r, '建立').props.disabled).toBe(true);
        expect(text(r.root)).toContain('零股數量須為 1～999 股');
        await type(r, '數量', '300');
        await click(r, '建立');
        const [req, , opts] = m.add.mock.calls[0]!;
        expect(req).toMatchObject({ code: '2330', quantity: 300, orderLot: 'IntradayOdd', role: 'entry' });
        expect(req.send).toBeUndefined();
        expect(req.source).toBeUndefined();
        expect(opts.account.account_type).toBe('S');
    });

    it('stocks 二擇一 in 盤中零股: both legs carry the odd lot', async () => {
        const r = render(STK);
        await click(r, '二擇一');
        await click(r, '盤中零股');
        await type(r, '上方價', '1100');
        await type(r, '下方價', '900');
        await type(r, '上方數量', '5');
        await type(r, '下方數量', '5');
        await click(r, '建立');
        const legs = m.group.mock.calls[0]![0];
        expect(legs.map((l: { orderLot?: string; quantity: number }) => [l.orderLot, l.quantity])).toEqual([['IntradayOdd', 5], ['IntradayOdd', 5]]);
    });

    it('stocks: 括號單 in 盤中零股 is refused with the reason (整股 only)', async () => {
        const r = render(STK);
        await click(r, '盤中零股');
        await click(r, '括號單');
        expect(button(r, '建立').props.disabled).toBe(true);
        expect(text(r.root)).toContain('括號單目前只支援整股');
    });

    it('stocks: 收盤前平倉 says 整股市價、零股限價', async () => {
        const r = render(STK);
        await click(r, '時間');
        expect(text(r.root)).toContain('整股市價、零股限價');
    });

    it('stocks 指定時間送單: 限價 then 盤中零股 is not blocked by the hidden send style (review)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-12T01:00:00Z')); // 09:00 台北
        try {
            const r = render(STK);
            await click(r, '時間');
            await click(r, '指定時間');
            await type(r, '送單時間', '12:00');
            await click(r, '限價');
            expect(text(r.root)).toContain('指定時間送單沒有觸發價');
            await click(r, '盤中零股');
            expect(text(r.root)).not.toContain('指定時間送單沒有觸發價');
            expect(button(r, '建立').props.disabled).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it('stocks 二擇一 成交後刪對應口數 in 盤中零股: the summary says ROD and that the other side waits (engine rule)', async () => {
        const r = render(STK);
        await click(r, '二擇一');
        await click(r, '盤中零股');
        await click(r, '成交後刪對應口數');
        await type(r, '上方價', '1100');
        await type(r, '下方價', '900');
        const all = text(r.root);
        expect(all).toContain('零股以漲跌停價限價（ROD）送出');
        expect(all).not.toContain('IOC');
    });

    describe('warrants (WRT, private engine #217)', () => {
        const WRT = { code: '030392', name: '台積電群益64購09', security_type: 'WRT', exchange: 'TSE', target_code: null, reference: 12 };
        const FOREIGN = { ...WRT, code: '03001F', name: '外國標的購' };

        it('a native WRT contract creates a whole-lot trigger on the securities account', async () => {
            const r = render(WRT);
            expect(button(r, '盤中零股')).toBeUndefined();
            expect(text(r.root.findAll(n => n.props['data-testid'] === 'cond-warrant-note')[0]!)).toContain('權證只能整張現股');
            await click(r, '限價');
            await type(r, '觸發價', '12.05'); // the 10–50 warrant band steps 0.1
            expect(text(r.root)).toContain('不在跳動點上');
            await type(r, '觸發價', '12.1');
            await click(r, '建立');
            const [req, c, opts] = m.add.mock.calls[0]!;
            expect(req).toMatchObject({ code: '030392', price: 12.1, quantity: 1 });
            expect(req.orderLot).toBeUndefined();
            expect(c).toMatchObject({ security_type: 'WRT' });
            expect(opts.account.account_type).toBe('S');
        });

        it('a market trigger price is never sent: off the warrant grid is fine at 市價, refused at 限價 (trigger and 二擇一)', async () => {
            const r = render(WRT);
            await type(r, '觸發價', '12.05');
            expect(text(r.root)).not.toContain('不在跳動點上');
            await click(r, '建立');
            expect(m.add.mock.calls[0]![0]).toMatchObject({ price: 12.05 });
            expect(m.add.mock.calls[0]![0].send).toBeUndefined();
            await click(r, '限價');
            expect(button(r, '建立').props.disabled).toBe(true);
            expect(text(r.root)).toContain('不在跳動點上');

            const o = render(WRT);
            await click(o, '二擇一');
            await type(o, '上方價', '12.25');
            await type(o, '下方價', '11.95');
            expect(button(o, '建立').props.disabled).toBeFalsy();
            await click(o, '限價');
            expect(button(o, '建立').props.disabled).toBe(true);
            expect(text(o.root)).toContain('不在跳動點上');
        });

        it('a foreign WRT time order cannot be created (always a market order), with the reason', async () => {
            const r = render(FOREIGN);
            await click(r, '時間');
            expect(button(r, '建立').props.disabled).toBe(true);
            expect(text(r.root)).toContain('外國標的權證不能用時間條件');
        });

        it.each(['觸價單', '二擇一'])('a foreign WRT %s: 市價 is disabled with the reason', async (form) => {
            const r = render(FOREIGN);
            if (form !== '觸價單') await click(r, form);
            const mkt = r.root.findAll(n => n.type === 'button' && text(n) === '市價')[0]!;
            expect(mkt.props.disabled).toBe(true);
            expect(mkt.props.title).toBe(WARRANT_FLASH_TEXT.foreignTriggerMenu);
            expect(r.root.findAll(n => n.props['data-testid'] === 'cond-warrant-market' && typeof n.type === 'string')).toHaveLength(1);
        });

        it('a foreign WRT whose send is market anyway (stale state) cannot be created', async () => {
            const r = render(FOREIGN);
            await type(r, '觸發價', '3.5');
            expect(button(r, '建立').props.disabled).toBeFalsy();
            // the disabled button's own handler (as if it were reached anyway)
            const mkt = r.root.findAll(n => n.type === 'button' && text(n) === '市價')[0]!;
            await act(async () => { mkt.props.onClick(); });
            expect(button(r, '建立').props.disabled).toBe(true);
            expect(text(r.root)).toContain(WARRANT_FLASH_TEXT.foreignTrigger);
        });

        it('a domestic WRT bracket can be created', async () => {
            const r = render(WRT);
            await click(r, '括號單');
            expect(text(r.root)).not.toContain(WARRANT_FLASH_TEXT.foreignProtect);
        });

        it('a foreign WRT: 觸發後 starts at 限價, says why; no bracket', async () => {
            const r = render(FOREIGN);
            expect(text(r.root.findAll(n => n.props['data-testid'] === 'cond-warrant-note')[0]!)).toContain(WARRANT_FLASH_TEXT.foreignTriggerMenu);
            await type(r, '觸發價', '3.5');
            await click(r, '建立');
            expect(m.add.mock.calls[0]![0].send).toMatchObject({ type: 'LMT' });
            await click(r, '括號單');
            expect(button(r, '建立').props.disabled).toBe(true);
            expect(text(r.root)).toContain(WARRANT_FLASH_TEXT.foreignProtect);
        });
    });
});
