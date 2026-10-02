// issue #150 — combo manual send and the 到價監控 auto-send go through the
// same shared risk checks (Kill Switch / per-order cap / daily loss cap) as
// the order ticket, flash order and grid. Uses the real risk module.
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const m = vi.hoisted(() => {
    // risk.ts reads localStorage and listens on window at module load
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    return {
        place: vi.fn(),
        notify: vi.fn(),
        quotes: {} as Record<string, unknown>,
        account: { account_type: 'F', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' },
    };
});

vi.mock('../hooks/use-query', () => ({ useQuery: () => ({ data: [], loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (code: string | null) => (code ? m.quotes[code] : undefined), useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: undefined, book: undefined }) }));
vi.mock('../hooks/use-hotkeys', () => ({ TICKET_ACTION_EVENT: 'sj-ticket-action' }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ selectedFutures: m.account }), getAccountState: () => ({ accounts: [m.account] }) }));
vi.mock('../lib/order-account', () => ({ captureSelectedAccount: () => m.account, usableCapturedAccount: (a: unknown) => a }));
vi.mock('../lib/combo-pick', () => ({ useComboPick: () => null }));
vi.mock('../lib/option-pick', () => ({ useOptionLegPick: () => null }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, maskAccountId: (id: string) => id, getPrivacyMoney: () => false, maskMoney: (t: string) => t }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => contracts[code] }));
vi.mock('../lib/shioaji', () => ({
    buildComboContract: vi.fn(),
    cancelComboOrder: vi.fn(),
    comboLegReq: (c: ContractInfo) => ({ code: c.code }),
    fetchComboSnapshot: vi.fn(),
    fetchComboTrades: vi.fn(),
    placeComboOrder: m.place,
}));
vi.mock('../lib/trade', () => ({ notify: m.notify, assertTradingLive: () => undefined }));
vi.mock('./depth-ladder', () => ({ DepthLadder: () => null }));
vi.mock('./combo-strategy', () => ({ OptionStrategyBuilder: () => null }));
vi.mock('./refresh-button', () => ({ RefreshButton: () => null }));

import { reportDailyPnl, setRiskSettings } from '../lib/risk';
import { ComboTicket } from './combo-ticket';

// 價格價差 Call：canonical 腳序 [高履約, 低履約]
const opt = (code: string, strike: number) => ({
    code, name: code, security_type: 'OPT', exchange: 'TAIFEX', strike_price: strike, option_right: 'C',
    delivery_month: '202610', delivery_date: '2026/10/21', reference: 0, limit_up: 0, limit_down: 0,
}) as unknown as ContractInfo;
const contracts: Record<string, ContractInfo> = { TXO17100J6: opt('TXO17100J6', 17100), TXO17000J6: opt('TXO17000J6', 17000) };
const bidask = (bid: number, ask: number) => ({ bidask: { bid_price: [bid], ask_price: [ask], bid_volume: [5], ask_volume: [5] } });
// 合成：bid = 低C.bid − 高C.ask、ask = 低C.ask − 高C.bid
const setLegQuotes = (hiBid: number, hiAsk: number, loBid: number, loAsk: number) => {
    m.quotes = { TXO17100J6: bidask(hiBid, hiAsk), TXO17000J6: bidask(loBid, loAsk) };
};

const text = (n: ReactTestInstance): string => n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find((b) => text(b).includes(label))!;
const input = (placeholder: string) => view.root.findAllByType('input').filter((i) => i.props.placeholder === placeholder);
const qtyInput = () => view.root.findAllByType('input').find((i) => i.props.inputMode === 'numeric')!;
const lastNotice = () => m.notify.mock.calls.at(-1)![0];
const rerender = async () => { await act(async () => { view.update(createElement(ComboTicket)); }); };

const render = async () => {
    await act(async () => { view = create(createElement(ComboTicket)); });
    const codes = ['TXO17100J6', 'TXO17000J6'];
    for (let i = 0; i < 2; i++) {
        await act(async () => { input('代碼 如 TXFF6 / TX417000C6')[i]!.props.onChange({ target: { value: codes[i] } }); });
        await act(async () => { input('代碼 如 TXFF6 / TX417000C6')[i]!.props.onBlur(); });
    }
    expect(text(btn('組合下單'))).toBe('買進組合下單');
};
const setQty = async (q: number) => { await act(async () => { qtyInput().props.onChange({ target: { value: String(q) } }); }); };
const sendManual = async () => {
    await act(async () => { await btn('買進組合下單').props.onClick(); });
    await act(async () => { await btn('確認買進組合').props.onClick(); });
};
const startWatch = async (target: number) => {
    await act(async () => { input('目標淨價')[0]!.props.onChange({ target: { value: String(target) } }); });
    await act(async () => { btn('啟動監控').props.onClick(); });
};

type Rule = { name: string; qty: number; apply: () => void; reason: RegExp };
const rules: Rule[] = [
    { name: 'Kill Switch', qty: 1, apply: () => setRiskSettings({ locked: true }), reason: /風控鎖啟動中/ },
    { name: 'per-order limit', qty: 3, apply: () => setRiskSettings({ enabled: true, maxQty: 2 }), reason: /超過單筆上限 2（本筆 3）/ },
    { name: 'daily loss limit', qty: 1, apply: () => { setRiskSettings({ enabled: true, maxDailyLoss: 3000 }); reportDailyPnl(-3500); }, reason: /當日虧損 -3500 已達上限 -3000/ },
];

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setRiskSettings({ enabled: false, maxQty: 0, maxDailyLoss: 0, locked: false });
    reportDailyPnl(0);
    setLegQuotes(50, 52, 100, 102); // 合成 買 48／賣 52
    m.place.mockResolvedValue({ order: { id: 'c1', seqno: '001' }, status: { status: 'Submitted' } });
});
afterEach(async () => { await act(async () => view?.unmount()); });

describe('manual combo send', () => {
    it('sends unchanged when risk checks pass', async () => {
        setRiskSettings({ enabled: true, maxQty: 5, maxDailyLoss: 3000 });
        reportDailyPnl(-1000);
        await render();
        await setQty(2);
        await sendManual();
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![1]).toMatchObject({ action: 'Buy', price: 50, quantity: 2, price_type: 'LMT', order_type: 'IOC' });
        expect(lastNotice()).toMatchObject({ kind: 'ok', title: '🧩 組合單已送出' });
    });

    it.each(rules)('is blocked by the $name and shows the reason', async ({ qty, apply, reason }) => {
        await render();
        await setQty(qty);
        apply();
        await sendManual();
        expect(m.place).not.toHaveBeenCalled();
        expect(lastNotice()).toMatchObject({ kind: 'err', title: '風控阻擋', body: expect.stringMatching(reason) });
    });
});

describe('到價監控 auto-send', () => {
    it('fires unchanged when risk checks pass', async () => {
        setRiskSettings({ enabled: true, maxQty: 5, maxDailyLoss: 3000 });
        await render();
        await startWatch(40); // ask 52 > 40：尚未觸發
        expect(m.place).not.toHaveBeenCalled();
        setLegQuotes(62, 64, 100, 102); // ask 跌到 40
        await rerender();
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![1]).toMatchObject({ action: 'Buy', price: 40, quantity: 1, order_type: 'IOC' });
        expect(lastNotice()).toMatchObject({ kind: 'ok', title: '🎯 到價觸發第 1 次' });
        expect(text(btn('監控中'))).toContain('監控中 1/3');
    });

    it.each(rules)('stops and notifies when the $name blocks the trigger', async ({ qty, apply, reason }) => {
        await render();
        await setQty(qty);
        await startWatch(40);
        expect(text(btn('監控中'))).toContain('監控中 0/3');
        apply();
        setLegQuotes(62, 64, 100, 102);
        await rerender();
        expect(m.place).not.toHaveBeenCalled();
        expect(lastNotice()).toMatchObject({ kind: 'err', title: '🎯 到價監控停止', body: expect.stringMatching(reason) });
        expect(lastNotice().body).toMatch(/^風控阻擋：.*，未送單$/);
        expect(btn('啟動監控')).toBeDefined(); // monitor is off
    });

    it.each(rules)('refuses to start while the $name blocks orders', async ({ qty, apply, reason }) => {
        await render();
        await setQty(qty);
        apply();
        await startWatch(55); // 已觸及價位 — 啟動就會送單，必須先擋
        expect(m.place).not.toHaveBeenCalled();
        expect(lastNotice()).toMatchObject({ kind: 'err', title: '到價監控未啟動', body: expect.stringMatching(reason) });
        expect(btn('啟動監控')).toBeDefined();
    });
});
