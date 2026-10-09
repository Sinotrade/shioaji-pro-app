// src/components/conditional-form.test.tsx — 新增條件單 (#226): the trigger
// and 二擇一 forms build exactly the request the engine gets.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const F = { account_type: 'F', broker_id: 'b', account_id: '9804567', person_id: '', signed: true, username: '' };
const TXF = { code: 'TXFJ6', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', tick: 1, target_code: 'TXFJ6', multiplier: 200 };

const m = vi.hoisted(() => ({ add: vi.fn(), group: vi.fn(), bracket: vi.fn() }));
vi.mock('../lib/trigger-engine', () => ({ addTrigger: m.add, addTriggerGroup: m.group }));
vi.mock('../lib/contracts-cache', () => ({ useContract: (c: string | null) => c ? TXF : undefined, ensureContract: async () => TXF }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [F], selectedFutures: F, selectedStock: null }) }));
vi.mock('../lib/account-tradable', () => ({ canTrade: () => true }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => true, usePrivacyMoney: () => false, maskMoney: (t: string) => t,
    maskAccountId: (id: string) => `•••••${id.slice(-2)}` }));
vi.mock('../lib/stream', () => ({ getQuote: () => ({ tick: { close: 48212 } }), subscribeQuoteStore: () => () => undefined }));
vi.mock('../hooks/use-esc-close', () => ({ useEscClose: () => undefined }));
vi.mock('../lib/conditional/panel-bracket', () => ({ placePanelBracket: m.bracket }));

const { NewConditionalDialog } = await import('./conditional-form');

function render() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(NewConditionalDialog, { contract: TXF as never, onClose: () => undefined })); });
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
});
