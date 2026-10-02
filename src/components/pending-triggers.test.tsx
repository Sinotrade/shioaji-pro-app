// src/components/pending-triggers.test.tsx — #144 待確認 panel actions.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TriggerOrder } from '../lib/trigger-engine';

const SIM = 'http://sim.invalid|simulation';
const m = vi.hoisted(() => ({
    triggers: [] as unknown[],
    prices: {} as Record<string, number>,
    sending: [] as string[],
    env: 'http://sim.invalid|simulation' as string | null,
    resolve: vi.fn(),
    request: vi.fn(),
    dismiss: vi.fn(),
    focus: vi.fn(),
    reconcile: vi.fn(), ackUnknown: vi.fn(), stopUnknown: vi.fn(),
    priv: false,
    contracts: {} as Record<string, { name: string; delivery_month?: string }>,
}));

vi.mock('../lib/trigger-engine', () => ({
    useTriggers: () => m.triggers,
    usePendingPrices: () => m.prices,
    useSendingTriggers: () => m.sending,
    resolvePendingTrigger: m.resolve,
    requestPendingPrices: m.request,
    isPendingUnpast: (t: TriggerOrder, price: number) => t.condition === 'below' ? price > t.price : price < t.price,
    priceKeyOf: (t: TriggerOrder) => (t.kind !== 'alert' && t.orderLot === 'IntradayOdd' ? `${t.code}#odd` : t.code),
    RESTORE_REASON_TEXT: { restart: 'R-restart', disconnect: 'R-disconnect', env: 'R-env', unknownNotSent: 'R-unknownNotSent' },
}));
vi.mock('../lib/execution/native',()=>({reconcileNativeProgram:m.reconcile,acknowledgeNativeUnknown:m.ackUnknown,removeNativeProgram:m.stopUnknown}));
vi.mock('../lib/window-role', () => ({ focusMainWindow: m.focus }));
vi.mock('../lib/bracket', () => ({ dismissBracket: m.dismiss }));
vi.mock('../lib/privacy', () => ({
    usePrivacyMode: () => m.priv,
    maskAccountId: (id: string, priv: boolean) => priv ? `••${id.slice(-2)}` : id,
}));
vi.mock('../lib/contracts-cache', () => ({
    useContract: (code: string) => m.contracts[code],
    ensureContract: async () => undefined,
}));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null }));
vi.mock('../lib/protection-env', () => ({
    currentProtectionEnv: () => m.env,
    protectionEnvLabel: (env: string) => env.endsWith('|simulation') ? '模擬' : '正式',
}));

const { PendingTriggers } = await import('./pending-triggers');

const stop = (over: Partial<TriggerOrder> = {}): TriggerOrder => ({
    id: 'tg-1', code: 'TXFR1', condition: 'below', price: 48000, action: 'Sell', quantity: 1, kind: 'stop',
    env: SIM, account: { account_type: 'F', broker_id: 'b', account_id: 'a1' }, orderCode: 'TXFJ6',
    pending: { price: 47900, at: Date.now() }, ...over,
});

function render(props: { compact?: boolean } = {}) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(PendingTriggers, props)); });
    return r;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const buttons = (r: ReactTestRenderer) => r.root.findAllByType('button');
const button = (r: ReactTestRenderer, label: string) => buttons(r).find(b => text(b).includes(label))!;
/** A deliberate click: a moment after the previous one. `quick` = a double-click. */
const click = async (b: ReactTestInstance, quick = false) => {
    if (!quick) vi.advanceTimersByTime(500);
    await act(async () => { b.props.onClick(); });
};

afterEach(() => { vi.useRealTimers(); });

beforeEach(() => {
    vi.useFakeTimers();
    m.triggers = [stop()];
    m.prices = { TXFR1: 47900 };
    m.sending = [];
    m.env = SIM;
    m.priv = false;
    m.contracts = { TXFR1: { name: '臺股期貨', delivery_month: '202610' } };
    for (const f of [m.resolve, m.request, m.dismiss, m.focus,m.reconcile,m.ackUnknown,m.stopUnknown]) { f.mockReset(); f.mockResolvedValue(true); }
});

it('renders nothing without pending triggers', () => {
    m.triggers = [stop({ pending: undefined })];
    expect(render().toJSON()).toBeNull();
});

it('send needs two clicks; the armed label follows the latest price', async () => {
    const r = render();
    await click(button(r, '送出'));
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.request).toHaveBeenCalledTimes(1); // executor publishes the latest price now
    expect(text(button(r, '再按一次'))).toContain('目前 47,900');
    m.prices = { TXFR1: 47850 };
    act(() => { r.update(createElement(PendingTriggers)); });
    expect(text(button(r, '再按一次'))).toContain('目前 47,850'); // still armed
    await click(button(r, '再按一次'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'send', { allowUnpast: false });
});

it('native unknownNotSent: warns the original may still exist and needs one more confirmation', async () => {
    m.triggers = [stop({ pending: { price: 47900, at: Date.now(), reason: 'unknownNotSent' } })];
    const r = render();
    expect(text(r.root)).toContain('原委託可能仍在券商');
    await click(button(r, '送出'));
    await click(button(r, '再按一次'));
    expect(m.resolve).not.toHaveBeenCalled();
    expect(text(button(r, '原委託可能仍存在'))).toContain('再按一次仍重新送出');
    // a double-click never passes it
    await click(button(r, '原委託可能仍存在'), true);
    expect(m.resolve).not.toHaveBeenCalled();
    await click(button(r, '原委託可能仍存在'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'send', { allowUnpast: false });
});

it('native unknownNotSent while unpast: the extra step covers both and allows unpast', async () => {
    m.triggers = [stop({ pending: { price: 47900, at: Date.now(), reason: 'unknownNotSent' } })];
    m.prices = { TXFR1: 48100 };
    const r = render();
    await click(button(r, '送出'));
    await click(button(r, '再按一次'));
    expect(text(button(r, '原委託可能仍存在'))).toContain('已未穿價');
    await click(button(r, '原委託可能仍存在'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'send', { allowUnpast: true });
});

it('cancel needs two clicks; keep is a single click', async () => {
    const r = render();
    await click(button(r, '取消'));
    expect(m.resolve).not.toHaveBeenCalled();
    await click(button(r, '再按一次：取消'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'cancel');
    await click(button(r, '保留'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'keep', { allowUnpast: false });
});

it('a bracket exit is removed with its whole bracket, never one side', async () => {
    m.triggers = [stop({ bracketId: 'plan-1', group: 'bracket:g' })];
    const r = render();
    await click(button(r, '移除括號單'));
    await click(button(r, '再按一次：移除括號單保護'));
    expect(m.dismiss).toHaveBeenCalledWith('plan-1');
    expect(m.resolve).not.toHaveBeenCalled();
});

it('another environment: labelled, no current price, send disabled; old detections show the date', () => {
    m.triggers = [stop({ env: 'http://sim.invalid|production', pending: { price: 47900, at: new Date(2026, 0, 2, 9, 5).getTime() } })];
    const r = render();
    const all = text(r.root);
    expect(all).toContain('正式環境');
    expect(all).toContain('目前價格未知');
    expect(all).toContain('2026-01-02');
    expect(button(r, '送出').props.disabled).toBe(true);
});

it('losing the current price disarms a pending 送出 (never shows "目前 undefined")', async () => {
    const r = render();
    await click(button(r, '送出'));
    expect(button(r, '再按一次')).toBeTruthy();
    m.prices = {};
    act(() => { r.update(createElement(PendingTriggers)); });
    expect(text(r.root)).not.toContain('undefined');
    expect(buttons(r).some(b => text(b).includes('再按一次'))).toBe(false);
    expect(button(r, '送出').props.disabled).toBe(true);
    m.prices = { TXFR1: 47800 };
    act(() => { r.update(createElement(PendingTriggers)); });
    await click(button(r, '送出')); // first click again, not a send
    expect(m.resolve).not.toHaveBeenCalled();
});

it('shows 送出處理中 while the main window is still processing a send', () => {
    m.sending = ['tg-1'];
    const r = render();
    expect(text(r.root)).toContain('送出處理中');
    expect(button(r, '送出處理中').props.disabled).toBe(true);
});

it('a double-click never passes the two-step confirmation (送出, 取消, 移除括號單)', async () => {
    const r = render();
    await click(button(r, '送出'));
    await click(button(r, '再按一次'), true); // second click of a double-click
    expect(m.resolve).not.toHaveBeenCalled();
    await click(button(r, '取消'));
    await click(button(r, '再按一次：取消'), true);
    expect(m.resolve).not.toHaveBeenCalled();
    m.triggers = [stop({ bracketId: 'plan-1' })];
    const b = render();
    await click(button(b, '移除括號單'));
    await click(button(b, '再按一次：移除括號單保護'), true);
    expect(m.dismiss).not.toHaveBeenCalled();
    await click(button(b, '再按一次：移除括號單保護')); // a deliberate second click works
    expect(m.dismiss).toHaveBeenCalledWith('plan-1');
});

it('an armed confirmation times out after 10 s', async () => {
    const r = render();
    await click(button(r, '送出'));
    act(() => { vi.advanceTimersByTime(10_100); });
    expect(buttons(r).some(b => text(b).includes('再按一次'))).toBe(false);
    await click(button(r, '送出'));
    expect(m.resolve).not.toHaveBeenCalled();
});

it('price back on the non-trigger side: 目前已未穿價 and one extra confirmation', async () => {
    m.prices = { TXFR1: 48100 }; // stop ≤ 48000 no longer crossed
    const r = render();
    expect(text(r.root)).toContain('目前已未穿價');
    await click(button(r, '送出'));
    await click(button(r, '再按一次'));
    expect(m.resolve).not.toHaveBeenCalled();
    expect(text(button(r, '目前已未穿價：再按一次'))).toContain('目前 48,100');
    await click(button(r, '目前已未穿價：再按一次'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'send', { allowUnpast: true });
});

it('shows the specific reason of each pending trigger', () => {
    m.triggers = [stop({ pending: { price: 47900, at: Date.now(), reason: 'disconnect' } })];
    expect(text(render().root)).toContain('R-disconnect');
});

it('collapsible in the main window; popouts show only a badge that focuses the main window', async () => {
    const r = render();
    await click(button(r, '收合'));
    expect(buttons(r).map(b => text(b))).toEqual(['展開']);
    const p = render({ compact: true });
    expect(buttons(p)).toHaveLength(1);
    expect(text(p.root)).toContain('觸價單待確認 1 筆');
    await click(buttons(p)[0]!);
    expect(m.focus).toHaveBeenCalled();
});

it('reads as plain language: product name, action, condition and distance; account masked in privacy mode', () => {
    m.priv = true;
    m.triggers = [stop({ condition: 'above', price: 48151, action: 'Buy', account: { account_type: 'F', broker_id: 'b', account_id: '9151121' } })];
    m.prices = { TXFR1: 48169 };
    const all = text(render().root);
    expect(all).toContain('臺股期貨 202610');
    expect(all).toContain('TXFR1');
    expect(all).toContain('停損');
    expect(all).toContain('買進 1 口');
    expect(all).toContain('漲到 48,151 以上');
    expect(all).toContain('48,169');
    expect(all).toContain('已超過 18 點');
    expect(all).toContain('期貨帳戶 ••21');
    expect(all).not.toContain('9151121');
});

it('falls back to the code while the contract is not loaded', () => {
    m.contracts = {};
    const r = render();
    expect(r.root.findAll(n => n.type === 'span' && text(n) === 'TXFR1')).toHaveLength(1);
});

it('odd-lot exits are described as a limit at the price limit that waits for odd-lot matching, not a market order (#204)', () => {
    m.triggers = [stop({ code: '2330', orderCode: '2330', quantity: 300, orderLot: 'IntradayOdd',
        account: { account_type: 'S', broker_id: 'b', account_id: 'a1' } })];
    // odd-lot triggers price on the odd-lot feed (priceKeyOf)
    m.prices = { '2330#odd': 48100 };
    m.contracts = { '2330': { name: '台積電' } };
    const r = render();
    const t = text(r.root);
    expect(t).toContain('目前已未穿價');
    expect(t).toContain('零股限價 ROD，等下一次零股撮合');
    expect(t).not.toContain('立刻以市價成交');
    expect(String(button(r, '立即送出').props.title)).toContain('零股限價單');
    expect(String(button(r, '立即送出').props.title)).not.toContain('市價單');
});

it('whole-lot / futures exits keep the market-order wording', () => {
    m.prices = { TXFR1: 48100 };
    const r = render();
    expect(text(r.root)).toContain('立刻以市價成交');
    expect(String(button(r, '立即送出').props.title)).toContain('市價單');
});

it('r36 persistent unknown has scoped reconcile/Stop/explicit ACK, never send or keep, and guards a double click',async()=>{
    const native={programId:'P',levelId:'L',version:2,leg:'entry'};
    m.triggers=[stop({pending:undefined,unresolved:{detail:'ambiguous order, no resend',at:1},...{native}})];
    const r=render();expect(JSON.stringify(r.toJSON())).toContain('委託結果待確認');
    expect(buttons(r).some(b=>text(b).includes('立即送出')||text(b).includes('等再次穿價'))).toBe(false);
    await click(button(r,'更新對帳'));expect(m.reconcile).toHaveBeenCalledWith('P');expect(m.resolve).not.toHaveBeenCalled();
    await click(button(r,'停止追蹤'));expect(m.stopUnknown).toHaveBeenCalledWith('P');
    await click(button(r,'已人工核對'));expect(m.ackUnknown).not.toHaveBeenCalled();
    await click(button(r,'再按一次'),true);expect(m.ackUnknown).not.toHaveBeenCalled();
    await click(button(r,'再按一次'));expect(m.ackUnknown).toHaveBeenCalledWith('P','L');
    expect(m.resolve).not.toHaveBeenCalled();act(()=>r.unmount());
});

it('r36 native standalone pending does not advertise manual send admission; protective/window controls keep their existing send action',()=>{
    m.triggers=[{...stop(),native:{programId:'P',levelId:'L',version:1,leg:'entry'}}];
    const r=render();expect(button(r,'手動送出暫不支援').props.disabled).toBe(true);
    expect(button(r,'保留')).toBeDefined();expect(button(r,'取消這筆')).toBeDefined();act(()=>r.unmount());
});
