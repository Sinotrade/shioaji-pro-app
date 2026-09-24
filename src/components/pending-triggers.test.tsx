// src/components/pending-triggers.test.tsx — #144 待確認 panel actions.

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
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
}));

vi.mock('../lib/trigger-engine', () => ({
    useTriggers: () => m.triggers,
    usePendingPrices: () => m.prices,
    useSendingTriggers: () => m.sending,
    resolvePendingTrigger: m.resolve,
    requestPendingPrices: m.request,
    describePending: (t: TriggerOrder, price: number | undefined) => `${t.code} 目前 ${price ?? '未知'}`,
}));
vi.mock('../lib/bracket', () => ({ dismissBracket: m.dismiss }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false }));
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

function render() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(PendingTriggers)); });
    return r;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const buttons = (r: ReactTestRenderer) => r.root.findAllByType('button');
const button = (r: ReactTestRenderer, label: string) => buttons(r).find(b => text(b).includes(label))!;
const click = async (b: ReactTestInstance) => { await act(async () => { b.props.onClick(); }); };

beforeEach(() => {
    m.triggers = [stop()];
    m.prices = { TXFR1: 47900 };
    m.sending = [];
    m.env = SIM;
    for (const f of [m.resolve, m.request, m.dismiss]) { f.mockReset(); f.mockResolvedValue(true); }
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
    expect(text(button(r, '再按一次'))).toContain('目前 47900');
    m.prices = { TXFR1: 47850 };
    act(() => { r.update(createElement(PendingTriggers)); });
    expect(text(button(r, '再按一次'))).toContain('目前 47850'); // still armed
    await click(button(r, '再按一次'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'send');
});

it('cancel needs two clicks; keep is a single click', async () => {
    const r = render();
    await click(button(r, '取消'));
    expect(m.resolve).not.toHaveBeenCalled();
    await click(button(r, '再按一次：取消'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'cancel');
    await click(button(r, '保留'));
    expect(m.resolve).toHaveBeenCalledWith('tg-1', 'keep');
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
    expect(all).toContain('目前 未知');
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
