// src/components/pending-confirm.test.tsx — 委託待確認卡 (#201 ③, A 方案):
// show the order, send the user to the order list, record their decision.
// The card never sends or resends an order.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PendingConfirmItem, PendingConfirmSnapshot } from '../lib/execution/pending-confirm-contract';
import { mockPendingConfirmItem, mockPendingConfirmSnapshot } from '../lib/execution/pending-confirm-mock';

const SIM = 'http://127.0.0.1:1|simulation';
const m = vi.hoisted(() => ({
    state: { snapshot: null as PendingConfirmSnapshot | null, error: null as string | null, subscriptionError: null as string | null, loading: false, generation: 1 },
    resolve: vi.fn(),
    refresh: vi.fn(),
    focus: vi.fn(),
    openOrders: vi.fn(),
    env: 'http://127.0.0.1:1|simulation' as string | null,
    priv: false,
    bgOn: true as boolean | null,
    fetchPos: vi.fn(),
}));
vi.mock('../lib/execution/background', () => ({ useBackgroundSetting: () => m.bgOn }));
vi.mock('../lib/execution/rearm', async () => ({ ...(await vi.importActual<object>('../lib/execution/rearm')),
    fetchAccountPositions: m.fetchPos }));
vi.mock('../lib/trading-state', () => ({}));
vi.mock('../lib/shioaji', () => ({}));
vi.mock('../lib/account-query', () => ({}));

vi.mock('../lib/execution/pending-confirm', () => ({
    usePendingConfirm: () => m.state,
    resolvePendingConfirm: m.resolve,
    refreshPendingConfirm: m.refresh,
}));
vi.mock('../lib/dock-events', () => ({ requestOpenOrdersTab: m.openOrders }));
vi.mock('../lib/window-role', () => ({ focusMainWindow: m.focus }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null }));
vi.mock('../lib/privacy', () => ({
    usePrivacyMode: () => m.priv,
    maskAccountId: (id: string, priv: boolean) => priv ? `••${id.slice(-2)}` : id,
}));
vi.mock('../lib/protection-env', () => ({
    currentProtectionEnv: () => m.env,
    protectionEnvLabel: (env: string) => env.endsWith('|simulation') ? '模擬' : '正式',
}));

const { PendingConfirmPanel } = await import('./pending-confirm');

function render(props: { compact?: boolean } = {}) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(PendingConfirmPanel, props)); });
    return r;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const buttons = (r: ReactTestRenderer) => r.root.findAllByType('button');
const button = (r: ReactTestRenderer, label: string) => buttons(r).find(b => text(b).includes(label))!;
const radios = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
const click = async (b: ReactTestInstance) => { await act(async () => { b.props.onClick(); }); };
const choose = (r: ReactTestRenderer, i: number) => act(() => { radios(r)[i]!.props.onChange({ target: { checked: true } }); });
const show = (items: PendingConfirmItem[], over: Partial<PendingConfirmSnapshot> = {}) => {
    m.state = { snapshot: mockPendingConfirmSnapshot({ items, ...over }), error: null, subscriptionError: null, loading: false, generation: 1 };
};

beforeEach(() => {
    m.bgOn = true;
    m.fetchPos.mockReset();
    m.fetchPos.mockResolvedValue({ known: true, positions: [] });
    m.env = SIM;
    m.priv = false;
    show([mockPendingConfirmItem({ id: 'a', env: SIM })]);
    for (const f of [m.resolve, m.refresh, m.focus, m.openOrders]) { f.mockReset(); f.mockResolvedValue(undefined); }
});
afterEach(() => { vi.unstubAllGlobals(); });

it('renders nothing when nothing needs confirmation', () => {
    show([]);
    expect(render().toJSON()).toBeNull();
    m.state = { snapshot: null, error: null, subscriptionError: null, loading: false, generation: 1 };
    expect(render().toJSON()).toBeNull();
});

it('shows what was sent: product, side, quantity, price, time, owner', () => {
    show([mockPendingConfirmItem({
        id: 'a', env: SIM,
        order: { code: 'TXFK6', name: '台指期 11', action: 'Sell', quantity: 2, quantityUnit: 'contract', priceType: 'LMT', price: 17850, orderType: 'ROD', triggerPrice: 17860, triggerCondition: 'above' },
        owner: { kind: 'trigger', id: 't', leg: 'stop' },
        submittedAt: new Date(2026, 9, 8, 13, 41, 7).getTime(),
    })]);
    const all = text(render().root);
    expect(all).toContain('台指期 11');
    expect(all).toContain('TXFK6');
    expect(all).toContain('賣出 2 口');
    expect(all).toContain('限價 17,850');
    expect(all).toContain('13:41:07');
    expect(all).toContain('停損觸價單');
    expect(all).toContain('觸發價 17,860');
    expect(all).toContain('不會自動重送');
});

it('the card offers no way to send or resend an order', () => {
    const r = render();
    const labels = buttons(r).map(text);
    expect(labels.some(l => /重送|重新送出|立即送出|下單/.test(l))).toBe(false);
    expect(text(r.root)).toContain('請到下單面板');
});

it('confirming needs a choice first; "已送出" records confirmedSent', async () => {
    const r = render();
    const primary = button(r, '請先選擇');
    expect(primary.props.disabled).toBe(true);
    choose(r, 0);
    await click(button(r, '確認已送出'));
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'confirmedSent');
});

it('"沒有送出" records confirmedNotSent (cancel, never resend)', async () => {
    const r = render();
    choose(r, 1);
    await click(button(r, '確認沒有送出'));
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'confirmedNotSent');
});

it('a failed resolution is shown and the card stays', async () => {
    m.resolve.mockRejectedValue(new Error('待確認狀態已更新，請重新核對'));
    const r = render();
    choose(r, 1);
    await click(button(r, '確認沒有送出'));
    expect(text(r.root)).toContain('待確認狀態已更新');
});

it('opens the order list to check; says so when the layout has no orders dock', async () => {
    m.openOrders.mockReturnValue(true);
    const r = render();
    await click(button(r, '開啟委託'));
    expect(m.openOrders).toHaveBeenCalled();
    expect(text(r.root)).not.toContain('目前版面沒有委託區');
    m.openOrders.mockReturnValue(false);
    await click(button(r, '開啟委託'));
    expect(text(r.root)).toContain('目前版面沒有委託區');
});

it('the choices say that "not found" alone is not "not sent"', async () => {
    const r = render();
    const all = text(r.root);
    expect(all).toContain('無法確定就先不要選');
    await click(buttons(r).find(b => b.props['aria-label'] === '為什麼要確認')!);
    expect(text(r.root)).toContain('查不到不代表沒有送出');
});

it('shows stock units (張／股), not 口', () => {
    show([mockPendingConfirmItem({ id: 'a', env: SIM, order: { ...mockPendingConfirmItem().order, code: '2330', name: '台積電', quantity: 30, quantityUnit: 'share' } })]);
    expect(text(render().root)).toContain('賣出 30 股');
});

it('an expired order (session changed) shows 已失效 without confirm choices', async () => {
    show([mockPendingConfirmItem({ id: 'x', env: SIM, state: 'expired', expiredAt: Date.now() })]);
    const r = render();
    const all = text(r.root);
    expect(all).toContain('已失效');
    expect(all).toContain('成交');
    expect(radios(r)).toHaveLength(0);
    await click(button(r, '知道了'));
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'x' }), 'acknowledgeExpired');
});

it('counts items needing confirmation separately from expired ones', () => {
    show([
        mockPendingConfirmItem({ id: 'a', env: SIM }),
        mockPendingConfirmItem({ id: 'b', env: SIM }),
        mockPendingConfirmItem({ id: 'c', env: SIM, state: 'expired', expiredAt: 1 }),
    ]);
    const all = text(render().root);
    expect(all).toContain('待確認 2 筆');
    expect(all).toContain('已失效 1 筆');
});

it('after an unclean shutdown a banner explains why', () => {
    show([mockPendingConfirmItem({ id: 'a', env: SIM })], { uncleanShutdown: true });
    expect(text(render().root)).toContain('上次 App 沒有正常關閉');
});

it('another environment: choices are disabled until switching back', () => {
    show([mockPendingConfirmItem({ id: 'a', env: 'http://127.0.0.1:1|production' })]);
    const r = render();
    expect(text(r.root)).toContain('切回正式環境');
    expect(radios(r).every(i => i.props.disabled)).toBe(true);
});

it('privacy mode masks the account', () => {
    m.priv = true;
    show([mockPendingConfirmItem({ id: 'a', env: SIM, account: { accountType: 'F', accountId: '0000123', brokerId: 'F002000' } })]);
    const all = text(render().root);
    expect(all).toContain('••23');
    expect(all).not.toContain('0000123');
});

it('popouts show a badge that focuses the main window', async () => {
    const r = render({ compact: true });
    expect(radios(r)).toHaveLength(0);
    const badge = button(r, '委託待確認');
    expect(text(badge)).toContain('主視窗');
    await click(badge);
    expect(m.focus).toHaveBeenCalled();
});

it('a broken list is visible with a retry', async () => {
    m.state = { snapshot: null, error: '待確認清單讀取失敗：x', subscriptionError: null, loading: false, generation: 1 };
    const r = render();
    expect(text(r.root)).toContain('待確認清單讀取失敗');
    await click(button(r, '重新整理'));
    expect(m.refresh).toHaveBeenCalled();
});

it('a broken change listener stays visible even with an empty list', () => {
    m.state = { snapshot: mockPendingConfirmSnapshot({ items: [] }), error: null, subscriptionError: '待確認清單不會自動更新', loading: false, generation: 1 };
    expect(text(render().root)).toContain('不會自動更新');
    const badge = render({ compact: true });
    expect(text(badge.root)).toContain('不會自動更新');
});

it('a popout never shows "0 筆" when the list could not be read', () => {
    m.state = { snapshot: null, error: '待確認清單讀取失敗：x', subscriptionError: null, loading: false, generation: 1 };
    const badge = text(render({ compact: true }).root);
    expect(badge).toContain('無法取得');
    expect(badge).not.toContain('0 筆');
});

const expiredTrigger = (over = {}) => mockPendingConfirmItem({ id: 'x', env: SIM, state: 'expired', expiredAt: Date.now(),
    owner: { kind: 'trigger', id: 't', leg: null },
    order: { ...mockPendingConfirmItem().order, action: 'Sell', quantity: 3, triggerPrice: 17860, triggerCondition: 'below' }, ...over });
const long = (quantity: number) => ({ known: true, positions: [{ code: 'TXFK6', direction: 'Buy', quantity,
    account: { account_type: 'F', broker_id: 'F002000', account_id: '0000001' } }] });
const qtyInput = (r: ReactTestRenderer) => r.root.find(n => n.type === 'input' && n.props['aria-label'] === '重新啟用口數');

it('opening the rearm reads this account\'s positions; nothing is prefilled or confirmable until they answer', async () => {
    show([expiredTrigger()], { version: 2 });
    let answer!: (v: unknown) => void;
    m.fetchPos.mockReturnValue(new Promise(res => { answer = res; }));
    const r = render();
    await click(button(r, '在新盤別重新啟用'));
    expect(m.fetchPos).toHaveBeenCalledWith(expect.objectContaining({ id: 'x' }));
    expect(qtyInput(r).props.value).toBe('');
    expect(button(r, '確認重新啟用').props.disabled).toBe(true);
    expect(text(r.root)).toContain('正在查詢');
    await act(async () => { answer(long(2)); });
    const all = text(r.root);
    expect(all).toContain('觸發價 ≤ 17,860');
    expect(all).toContain('目前可平倉 2 口');
    expect(all).toContain('不會立即送單');
    expect(qtyInput(r).props.value).toBe('2');
    await click(button(r, '確認重新啟用'));
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'x' }), 'rearmInNewSession', { quantity: 2 });
    expect(buttons(r).some(b => text(b).includes('知道了'))).toBe(true);
});

it('more than the closable position is refused; the suggestion stays visible', async () => {
    show([expiredTrigger()], { version: 2 });
    m.fetchPos.mockResolvedValue(long(2));
    const r = render();
    await click(button(r, '在新盤別重新啟用'));
    act(() => { qtyInput(r).props.onChange({ target: { value: '3' } }); });
    expect(text(r.root)).toContain('建議 2 口，目前輸入 3 口');
    await click(button(r, '確認重新啟用'));
    expect(m.resolve).not.toHaveBeenCalled();
    expect(text(r.root)).toContain('不能超過');
});

it('a failed position read: 無法確認持倉, the user types the quantity', async () => {
    show([expiredTrigger()], { version: 2 });
    m.fetchPos.mockRejectedValue(new Error('timeout'));
    const r = render();
    await click(button(r, '在新盤別重新啟用'));
    expect(text(r.root)).toContain('無法確認持倉');
    expect(qtyInput(r).props.value).toBe('');
    expect(button(r, '確認重新啟用').props.disabled).toBe(true);
    act(() => { qtyInput(r).props.onChange({ target: { value: '1' } }); });
    await click(button(r, '確認重新啟用'));
    expect(m.resolve).toHaveBeenCalledWith(expect.anything(), 'rearmInNewSession', { quantity: 1 });
});

it('an unfinished rearm that already sent is shown, and cannot be redone here', () => {
    show([expiredTrigger({ rearmed: { programId: 'rearm:t:abc:1', quantity: 3, working: true } })], { version: 2 });
    const r = render();
    expect(text(r.root)).toContain('已經送出委託');
    expect(text(r.root)).toContain('3 口');
    expect(buttons(r).some(b => text(b).includes('在新盤別重新啟用'))).toBe(false);
});

it('no rearm when the setting is off, for a v1 engine, or for a bracket (not yet)', () => {
    m.bgOn = false;
    show([expiredTrigger()], { version: 2 });
    let r = render();
    expect(button(r, '在新盤別重新啟用').props.disabled).toBe(true);
    expect(text(r.root)).toContain('背景持續執行');
    m.bgOn = true;
    show([expiredTrigger()], { version: 1 });
    r = render();
    expect(buttons(r).some(b => text(b).includes('在新盤別重新啟用'))).toBe(false);
    show([expiredTrigger({ owner: { kind: 'bracket', id: 'b', leg: 'stop' } })], { version: 2 });
    r = render();
    expect(buttons(r).some(b => text(b).includes('在新盤別重新啟用'))).toBe(false);
});
