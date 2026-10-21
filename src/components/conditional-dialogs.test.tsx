// src/components/conditional-dialogs.test.tsx — 全平並取消 (#226): scope,
// what it will do, and the second deliberate click.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const F = { account_type: 'F', broker_id: 'b', account_id: '9804567', person_id: '', signed: true, username: '' };
const TXF = { code: 'TXFJ6', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const m = vi.hoisted(() => ({ env: 'srv|simulation', run: vi.fn(), preview: vi.fn(), desktop: false, reachable: true, getPolicy: vi.fn(), setPolicy: vi.fn(), setLocal: vi.fn() }));

vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [F], selectedFutures: F, selectedStock: null }) }));
vi.mock('../lib/trading-state', () => ({ useTradingState: () => ({
    positions: [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 1, last_price: 1, pnl: 0, account: F }],
    trades: [{ contract: { code: 'TXFJ6', target_code: 'TXFJ6' }, order: { id: 'w1', account: F, quantity: 1 },
        status: { status: 'Submitted', deal_quantity: 0, cancel_quantity: 0, deals: [] } }],
}) }));
vi.mock('../lib/conditional/runtime', () => ({ runFlatten: m.run, flattenSummary: () => '完成摘要',
    remainingText: (r: { remaining: { code: string; quantity: number }[] }) => r.remaining.map(o => `${o.code} 仍有 ${o.quantity}`) }));
vi.mock('../lib/conditional/flatten', async (orig) => ({ ...(await orig<typeof import('../lib/conditional/flatten')>()), loadFlattenPreview: m.preview }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => m.env }));
vi.mock('../lib/shioaji', () => ({}));
vi.mock('../lib/trade', () => ({}));
vi.mock('../lib/execution/background', () => ({ backgroundSupported: () => m.desktop, useBackgroundHealth: () => (m.desktop && m.reachable ? {} : null),
    getBracketPolicy: m.getPolicy, setBracketPolicy: m.setPolicy }));
vi.mock('../lib/main-window-commands', () => ({ isMainWindow: () => true }));
vi.mock('../lib/conditional/settings', () => ({ useConditionalSettings: () => ({ defaultValidity: 'today', defaultSend: 'MKP', ocoMode: 'trigger',
    notify: true, quickQty: [1, 5, 10], pauseStopsExits: false }), setConditionalSettings: m.setLocal }));
vi.mock('./background-execution-setting', () => ({ BackgroundExecutionSetting: () => null }));
vi.mock('../lib/risk', () => ({ useRiskSettings: () => ({ confirmManualOrders: false, escCancelAll: false }), setRiskSettings: vi.fn() }));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMode: () => true, maskAccountId: (id: string) => `•••••${id.slice(-2)}` }));
vi.mock('../hooks/use-esc-close', () => ({ useEscClose: () => undefined }));
vi.mock('./conditional-form', () => ({ Seg: ({ options, onChange }: { options: { id: string; label: string }[]; onChange: (v: string) => void }) =>
    createElement('span', null, options.map(o => createElement('button', { key: o.id, onClick: () => onChange(o.id) }, o.label))) }));

const { ConditionalSettingsDialog, FlattenDialog } = await import('./conditional-dialogs');

const row = { id: 'r', kind: 'trigger', code: 'TXFJ6', orderCode: 'TXFJ6', account: { account_type: 'F', broker_id: 'b', account_id: '9804567' },
    actions: { cancel: true }, attention: false, source: { type: 'trigger' } } as never;

function render() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(FlattenDialog, { contract: TXF as never, rows: [row], onClose: () => undefined })); });
    return r;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b) === label)!;

// the broker's answer when the dialog opens: 1 lot (the window still shows 2)
const FRESH = { positions: [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1, price: 1, last_price: 1, pnl: 0, account: F }],
    trades: [{ contract: { code: 'TXFJ6', target_code: 'TXFJ6' }, order: { id: 'w1', account: F, quantity: 1 },
        status: { status: 'Submitted', deal_quantity: 0, cancel_quantity: 0, deals: [] } }], failed: [] as string[] };
beforeEach(() => {
    vi.useFakeTimers();
    m.run.mockReset().mockResolvedValue({ stopped: 1, cancelled: 1, cancelFailed: [], sent: [], notSent: [], skipped: [], remaining: [] });
    m.preview.mockReset().mockResolvedValue(FRESH);
});
async function settle() { await act(async () => { await Promise.resolve(); }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('FlattenDialog', () => {
    it('shows what it will do for this product and needs a second, deliberate click', async () => {
        const r = render();
        await settle();
        const all = text(r.root);
        expect(all).toContain('預覽');
        expect(all).toContain('暫停並取消 1 張條件單（觸價 1）');
        expect(all).toContain('刪除 1 張未成交委託');
        expect(all).toContain('TXFJ6 多單 1 口');
        expect(all).toContain('範圍市價');
        expect(all).toContain('不會反手開倉');
        await act(async () => { button(r, '確認全平').props.onClick(); });
        expect(m.run).not.toHaveBeenCalled();
        await act(async () => { button(r, '再按一次：確認全平').props.onClick(); }); // too fast: ignored
        expect(m.run).not.toHaveBeenCalled();
        vi.advanceTimersByTime(500);
        await act(async () => { button(r, '再按一次：確認全平').props.onClick(); });
        expect(m.run).toHaveBeenCalledWith({ type: 'code', codes: ['TXFJ6'], account: null });
        expect(text(r.root)).toContain('完成摘要');
    });

    it('opening reads positions fresh: loading first, confirm disabled until the answer (QA 10/12 stale counts)', async () => {
        let answer!: (v: typeof FRESH) => void;
        m.preview.mockReturnValue(new Promise(r => { answer = r; }));
        const r = render();
        expect(m.preview).toHaveBeenCalledWith({ type: 'code', codes: ['TXFJ6'], account: null });
        expect(text(r.root)).toContain('查詢最新委託與持倉中');
        expect(button(r, '確認全平').props.disabled).toBe(true);
        await act(async () => { answer(FRESH); });
        expect(text(r.root)).toContain('TXFJ6 多單 1 口');
        expect(text(r.root)).not.toContain('多單 2 口');
        expect(button(r, '確認全平').props.disabled).toBe(false);
    });

    it('a failed query says so and falls back to what the window shows', async () => {
        m.preview.mockResolvedValue({ positions: [], trades: [], failed: ['期貨帳戶查詢失敗：timeout'] });
        const r = render();
        await settle();
        expect(text(r.root)).toContain('部分查詢失敗');
        expect(text(r.root)).toContain('TXFJ6 多單 2 口');
    });

    it('stocks: 8 張＋6 股 shown as 整股市價、零股限價', async () => {
        m.preview.mockResolvedValue({ positions: [{ id: 1, code: '2330', direction: 'Buy', quantity: 8006, cond: 'Cash', price: 1, last_price: 1, pnl: 0,
            account: { ...F, account_type: 'S' } }], trades: [], failed: [] });
        const r = render();
        await act(async () => { button(r, '全部帳戶').props.onClick(); });
        await settle();
        expect(text(r.root)).toContain('2330 多單 8 張＋6 股（整股市價、零股限價）');
    });

    it('what is still held after sending is shown, with 再平倉剩餘部位', async () => {
        const acct = { account_type: 'S', broker_id: 'b', account_id: '9804567' };
        m.run.mockResolvedValueOnce({ stopped: 0, cancelled: 0, cancelFailed: [], sent: [{ code: '2330', action: 'Sell', quantity: 8006, market: 'stock', account: acct }],
            notSent: [], skipped: [], remaining: [{ account: acct, code: '2330', action: 'Sell', quantity: 7000, market: 'stock' }] });
        const r = render();
        await settle();
        await act(async () => { button(r, '確認全平').props.onClick(); });
        vi.advanceTimersByTime(500);
        await act(async () => { button(r, '再按一次：確認全平').props.onClick(); });
        expect(text(r.root)).toContain('2330 仍有 7000');
        await act(async () => { button(r, '再平倉剩餘部位').props.onClick(); });
        expect(m.run).toHaveBeenLastCalledWith({ type: 'code', codes: ['2330'], account: acct });
    });

    it('再平倉 after a run across accounts: one run per account with only its products; never 全部帳戶 (review)', async () => {
        const a1 = { account_type: 'S', broker_id: 'b', account_id: '1' };
        const a2 = { account_type: 'S', broker_id: 'b2', account_id: '1' };
        m.run.mockResolvedValueOnce({ stopped: 0, cancelled: 0, cancelFailed: [], sent: [], notSent: [], skipped: [],
            remaining: [{ account: a1, code: '2330', action: 'Sell', quantity: 7000, market: 'stock' },
                { account: a2, code: '2317', action: 'Sell', quantity: 1000, market: 'stock' }] });
        const r = render();
        await settle();
        await act(async () => { button(r, '全部帳戶').props.onClick(); });
        await settle();
        await act(async () => { button(r, '確認全平').props.onClick(); });
        vi.advanceTimersByTime(500);
        await act(async () => { button(r, '再按一次：確認全平').props.onClick(); });
        m.run.mockClear();
        await act(async () => { button(r, '再平倉剩餘部位').props.onClick(); });
        expect(m.run.mock.calls.map(c => c[0])).toEqual([
            { type: 'code', codes: ['2330'], account: a1 }, { type: 'code', codes: ['2317'], account: a2 }]);
    });

    it('再平倉 refuses after a server / mode switch (review)', async () => {
        const acct = { account_type: 'S', broker_id: 'b', account_id: '1' };
        m.run.mockResolvedValueOnce({ stopped: 0, cancelled: 0, cancelFailed: [], sent: [], notSent: [], skipped: [],
            remaining: [{ account: acct, code: '2330', action: 'Sell', quantity: 7000, market: 'stock' }] });
        const r = render();
        await settle();
        await act(async () => { button(r, '確認全平').props.onClick(); });
        vi.advanceTimersByTime(500);
        await act(async () => { button(r, '再按一次：確認全平').props.onClick(); });
        m.run.mockClear();
        m.env = 'srv|production';
        try {
            await act(async () => { button(r, '再平倉剩餘部位').props.onClick(); });
            expect(m.run).not.toHaveBeenCalled();
            expect(text(r.root)).toContain('伺服器或模擬／正式模式已和全平時不同');
        } finally { m.env = 'srv|simulation'; }
    });

    it('scope 全部帳戶 runs for every account', async () => {
        const r = render();
        await settle();
        await act(async () => { button(r, '全部帳戶').props.onClick(); });
        await act(async () => { button(r, '確認全平').props.onClick(); });
        vi.advanceTimersByTime(500);
        await act(async () => { button(r, '再按一次：確認全平').props.onClick(); });
        expect(m.run).toHaveBeenCalledWith({ type: 'all' });
    });
});

describe('ConditionalSettingsDialog — 括號單規則', () => {
    const switchOf = (r: ReactTestRenderer, label: string) => r.root.findAll(n => n.props.role === 'switch' && n.props['aria-label'] === label)[0]!;
    function open() {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        let r!: ReactTestRenderer;
        act(() => { r = create(createElement(ConditionalSettingsDialog, { onClose: () => undefined })); });
        return r;
    }

    const labels = ['換盤別後自動重新啟用保護', '保護結束後才成交的口數自動補上保護', '暫停時連停損停利一起暫停'];
    it('not available (web, or the engine unreachable): all three switches are disabled and say why', () => {
        m.desktop = false;
        let r = open();
        for (const l of labels) expect(switchOf(r, l).props.disabled).toBe(true);
        expect(text(r.root)).toContain('只在桌面版提供');
        act(() => r.unmount());
        m.desktop = true;
        m.reachable = false;
        r = open();
        for (const l of labels) expect(switchOf(r, l).props.disabled).toBe(true);
        expect(text(r.root)).toContain('背景執行目前無法使用');
        expect(m.getPolicy).not.toHaveBeenCalled();
        m.reachable = true;
    });

    it('desktop: read from the engine, saved through it; pause-all follows the saved value', async () => {
        m.desktop = true;
        m.getPolicy.mockResolvedValue({ autoRearm: false, autoProtectLateFill: true, pauseStopsExits: false });
        m.setPolicy.mockImplementation(async (p: unknown) => p);
        vi.useRealTimers();
        const r = open();
        await act(async () => { await Promise.resolve(); });
        expect(switchOf(r, '保護結束後才成交的口數自動補上保護').props['aria-checked']).toBe(true);
        expect(text(r.root)).toContain('暫停前已觸發、正在送出的平倉單照常送出');
        await act(async () => { switchOf(r, '暫停時連停損停利一起暫停').props.onClick(); });
        expect(m.setPolicy).toHaveBeenCalledWith({ autoRearm: false, autoProtectLateFill: true, pauseStopsExits: true });
        expect(m.setLocal).toHaveBeenLastCalledWith({ pauseStopsExits: true });
    });
});
