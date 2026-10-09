// src/components/conditional-panel.test.tsx — 條件單管理面板 (#226): rows,
// sections, tabs and the per-row actions (every one a command to the engine).

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerOrder } from '../lib/trigger-engine';
import type { Sources } from '../lib/conditional/rows';

const ENV = 'http://sim.invalid|simulation';
const F = { account_type: 'F' as const, broker_id: 'b', account_id: '9804567' };

const m = vi.hoisted(() => ({
    sources: null as unknown as Sources,
    pause: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    modify: vi.fn(async () => undefined),
    priv: true,
}));

vi.mock('../lib/conditional/use-conditional', async () => {
    const { projectRows } = await import('../lib/conditional/rows');
    return {
        useConditionalView: () => ({ ...projectRows(m.sources), stream: 'live', envNow: ENV, executing: true }),
        useStreamStatus: () => 'live',
    };
});
vi.mock('../lib/trigger-engine', () => ({
    setTriggerPaused: m.pause,
    removeTrigger: m.remove,
    resolvePendingTrigger: m.resolve,
    modifyTrigger: m.modify,
    acknowledgeExit: vi.fn(),
    requestPendingPrices: vi.fn(async () => undefined),
    addTrigger: vi.fn(),
}));
vi.mock('../lib/bracket', () => ({
    acknowledgeBracketExit: vi.fn(), dismissBracket: vi.fn(), modifyBracket: vi.fn(), reconcileBracket: vi.fn(),
}));
vi.mock('../lib/privacy', () => ({
    usePrivacyMode: () => m.priv,
    maskAccountId: (id: string, priv: boolean) => priv ? `•••••${id.slice(-2)}` : id,
}));
vi.mock('../lib/contracts-cache', () => ({ useContract: () => undefined, ensureContract: async () => undefined }));
vi.mock('../lib/stream', () => ({ getQuote: () => ({ tick: { close: 48212 } }), subscribeQuoteStore: () => () => undefined,
    subscribeStatusStore: () => () => undefined, getStreamStatus: () => 'live' }));
vi.mock('../lib/execution/background', () => ({
    useBackgroundPrograms: () => [], markBackgroundHandled: vi.fn(), pauseBackgroundProgram: vi.fn(), removeBackgroundBracket: vi.fn(),
    resolveBackgroundTrigger: vi.fn(), resumeBackgroundProgram: vi.fn(),
}));
vi.mock('./background-bracket-status', () => ({ BracketRearm: () => null }));
vi.mock('./pending-confirm', () => ({ PendingConfirmItemCard: () => null }));
vi.mock('./conditional-form', async () => ({
    ...(await vi.importActual<typeof import('./conditional-form')>('./conditional-form')),
    NewConditionalDialog: () => createElement('div', { id: 'new-dialog' }),
}));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [], selectedFutures: null, selectedStock: null }) }));

const { ConditionalPanel } = await import('./conditional-panel');

const trig = (over: Partial<TriggerOrder> = {}): TriggerOrder => ({
    id: 'tg-1', code: 'TXFJ6', orderCode: 'TXFJ6', condition: 'below', price: 47900, action: 'Sell', quantity: 1, kind: 'stop',
    env: ENV, account: F, createdAt: 1, ...over,
});

const sources = (over: Partial<Sources> = {}): Sources => ({
    triggers: [], brackets: [], exits: [], ended: [], pendingConfirm: [], feedMissing: [], executing: true,
    envNow: ENV, streamLive: true, now: Date.now(), ...over,
});

function render() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(ConditionalPanel, { contract: null })); });
    return r;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const byLabel = (r: ReactTestRenderer, label: string) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === label);
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b).includes(label))!;
const click = async (b: ReactTestInstance, quick = false) => {
    if (!quick) vi.advanceTimersByTime(500);
    await act(async () => { b.props.onClick(); });
};

beforeEach(() => {
    vi.useFakeTimers();
    m.priv = true;
    for (const f of [m.pause, m.remove, m.resolve, m.modify]) f.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('ConditionalPanel', () => {
    it('empty: the empty state with 新增條件單', async () => {
        m.sources = sources();
        const r = render();
        expect(text(r.root)).toContain('目前沒有條件單');
        await click(button(r, '新增條件單'));
        expect(r.root.findAll(n => n.props.id === 'new-dialog')).toHaveLength(1);
    });

    it('pins 需要你處理 above 執行中, masks accounts and counts per tab', () => {
        m.sources = sources({ triggers: [trig(), trig({ id: 'p', code: '2330', orderCode: '2330', price: 1080, quantity: 2,
            account: { account_type: 'S', broker_id: 'b', account_id: '0418812' }, pending: { price: 1072, at: 1, reason: 'restart' } })] });
        const r = render();
        const all = text(r.root);
        const sections = r.root.findAll(n => n.type === 'td' && n.props.colSpan === 9).map(text);
        expect(sections).toEqual(['需要你處理', '執行中']);
        expect(all).toContain('恢復時已穿價，未自動送出');
        expect(all).toContain('[期] •••••67');
        expect(all).not.toContain('9804567');
        expect(all).toContain('待確認 1');
        expect(text(button(r, '觸價單'))).toBe('觸價單2');
        expect(all).toContain('−312'); // 47,900 vs last 48,212
    });

    it('pause / resume / cancel go to the engine; cancel needs a second, deliberate click', async () => {
        m.sources = sources({ triggers: [trig()] });
        let r = render();
        await click(byLabel(r, '暫停')[0]!);
        expect(m.pause).toHaveBeenCalledWith('tg-1', true);
        await click(byLabel(r, '取消')[0]!);
        expect(m.remove).not.toHaveBeenCalled();
        await click(button(r, '再按一次：取消'), true); // a double-click does not pass
        expect(m.remove).not.toHaveBeenCalled();
        await click(button(r, '再按一次：取消'));
        expect(m.remove).toHaveBeenCalledWith('tg-1');
        m.sources = sources({ triggers: [trig({ paused: true })] });
        act(() => r.unmount());
        r = render();
        expect(byLabel(r, '暫停')).toHaveLength(0);
        await click(byLabel(r, '恢復')[0]!);
        expect(m.pause).toHaveBeenCalledWith('tg-1', false);
    });

    it('a 待確認 trigger: 現在送出 needs a confirm click; 保留盯價 keeps it', async () => {
        m.sources = sources({ triggers: [trig({ pending: { price: 47800, at: 1, reason: 'restart' } })] });
        const r = render();
        await click(button(r, '現在送出'));
        expect(m.resolve).not.toHaveBeenCalled();
        await click(button(r, '再按一次確認送出'));
        expect(m.resolve).toHaveBeenCalledWith('tg-1', 'send', { allowUnpast: false });
        await click(button(r, '保留盯價'));
        expect(m.resolve).toHaveBeenCalledWith('tg-1', 'keep');
    });

    it('the pencil opens the edit form and history; saving sends a modify', async () => {
        m.sources = sources({ triggers: [trig({ history: [{ at: 1, text: '建立 · 測試' }] })] });
        const r = render();
        await click(byLabel(r, '修改')[0]!);
        expect(text(r.root)).toContain('歷程');
        expect(text(r.root)).toContain('建立 · 測試');
        const input = r.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '觸發價')[0]!;
        await act(async () => { input.props.onChange({ target: { value: '47,850' } }); });
        await click(button(r, '儲存修改'));
        expect(m.modify).toHaveBeenCalledWith('tg-1', { price: 47850, quantity: 1, send: { type: 'MKT' }, validity: null });
    });

    it('已結束（今日） tab lists finished ones without actions', async () => {
        m.sources = sources({ triggers: [trig()], ended: [{ id: 'x', trigger: trig({ id: 'x' }), reason: 'cancelled', at: Date.now() }] });
        const r = render();
        await click(button(r, '已結束（今日）'));
        expect(text(r.root)).toContain('已取消');
        expect(byLabel(r, '取消')).toHaveLength(0);
    });
});
