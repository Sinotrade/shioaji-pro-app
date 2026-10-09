// src/components/conditional-dialogs.test.tsx — 全平並取消 (#226): scope,
// what it will do, and the second deliberate click.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const F = { account_type: 'F', broker_id: 'b', account_id: '9804567', person_id: '', signed: true, username: '' };
const TXF = { code: 'TXFJ6', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const m = vi.hoisted(() => ({ run: vi.fn(), desktop: false, getPolicy: vi.fn(), setPolicy: vi.fn(), setLocal: vi.fn() }));

vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [F], selectedFutures: F, selectedStock: null }) }));
vi.mock('../lib/trading-state', () => ({ useTradingState: () => ({
    positions: [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 1, last_price: 1, pnl: 0, account: F }],
    trades: [{ contract: { code: 'TXFJ6', target_code: 'TXFJ6' }, order: { id: 'w1', account: F, quantity: 1 },
        status: { status: 'Submitted', deal_quantity: 0, cancel_quantity: 0, deals: [] } }],
}) }));
vi.mock('../lib/conditional/runtime', () => ({ runFlatten: m.run, flattenSummary: () => '完成摘要' }));
vi.mock('../lib/execution/background', () => ({ backgroundSupported: () => m.desktop, useBackgroundHealth: () => (m.desktop ? {} : null),
    getBracketPolicy: m.getPolicy, setBracketPolicy: m.setPolicy }));
vi.mock('../lib/main-window-commands', () => ({ isMainWindow: () => true }));
vi.mock('../lib/conditional/settings', () => ({ useConditionalSettings: () => ({ defaultValidity: 'today', defaultSend: 'MKP', ocoMode: 'trigger',
    notify: true, quickQty: [1, 5, 10], pauseStopsExits: false }), setConditionalSettings: m.setLocal }));
vi.mock('./background-execution-setting', () => ({ BackgroundExecutionSetting: () => null }));
vi.mock('../lib/risk', () => ({ useRiskSettings: () => ({ confirmManualOrders: false, escCancelAll: false }), setRiskSettings: vi.fn() }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => true, maskAccountId: (id: string) => `•••••${id.slice(-2)}` }));
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

beforeEach(() => { vi.useFakeTimers(); m.run.mockReset().mockResolvedValue({ stopped: 1, cancelled: 1, cancelFailed: [], sent: [], notSent: [], skipped: [] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('FlattenDialog', () => {
    it('shows what it will do for this product and needs a second, deliberate click', async () => {
        const r = render();
        const all = text(r.root);
        expect(all).toContain('暫停並取消 1 張條件單（觸價 1）');
        expect(all).toContain('刪除 1 張未成交委託');
        expect(all).toContain('TXFJ6 多單 2 口');
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

    it('scope 全部帳戶 runs for every account', async () => {
        const r = render();
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

    it('not available (web, or the engine unreachable): the three switches are disabled and say why', () => {
        m.desktop = false;
        const r = open();
        expect(switchOf(r, '換盤別後自動重新啟用保護').props.disabled).toBe(true);
        expect(switchOf(r, '暫停時連停損停利一起暫停').props.disabled).toBe(true);
        expect(text(r.root)).toContain('只在桌面版提供');
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
