// src/components/bracket-status.test.tsx — #201 round 23: the across-epoch
// entry confirmation needs both the fill quantity and "no remainder".

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const r33 = vi.hoisted(() => ({ plans: [] as unknown[], cancel: vi.fn(), ack: vi.fn() }));
vi.mock('../lib/bracket', () => ({ useBrackets: () => r33.plans, isNativeBracket: (p: object) => 'native' in p, bracketSnapshotStale: () => false, cancelRemainingEntry: r33.cancel, acknowledgePendingRegistration:r33.ack }));
vi.mock('../lib/bracket-core', async () => await vi.importActual('../lib/bracket-core'));
vi.mock('../lib/execution/native', () => ({ useNativeHealth: () => null }));
vi.mock('../lib/privacy', () => ({ maskAccountId: (s: string) => s, usePrivacyMode: () => false }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => null, protectionEnvLabel: () => '' }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null }));
vi.mock('../lib/trigger-engine', () => ({ useTriggerFeed: () => ({ feedMissing: [], executing: true }) }));

it('confirms only with a valid quantity AND no remainder; nothing is inferred', async () => {
    const { EntryAcrossDayConfirm } = await import('./bracket-status');
    const onConfirm = vi.fn();
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(EntryAcrossDayConfirm, { code: 'TXFJ6', action: 'Buy', seqno: '00155E', placedAt: Date.UTC(2026, 8, 30, 4), known: 1, quantity: 3, busy: false, onConfirm })); });
    const button = () => r.root.find(n => n.type === 'button' && n.props['aria-label'] === '確認成交');
    const qty = () => r.root.findAll(n => n.type === 'input' && n.props.type === 'number')[0]!;
    const box = () => r.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox')[0]!;
    const text = () => JSON.stringify(r.toJSON());
    expect(button().props.disabled).toBe(true);
    expect(text()).toContain('請先到委託查詢刪除');
    act(() => qty().props.onChange({ target: { value: '2' } }));
    expect(button().props.disabled).toBe(true); // no remainder not confirmed yet
    act(() => box().props.onChange({ target: { checked: true } }));
    expect(button().props.disabled).toBe(false);
    expect(text()).not.toContain('請先到委託查詢刪除');
    act(() => qty().props.onChange({ target: { value: '0' } })); // below what is known
    expect(button().props.disabled).toBe(true);
    act(() => qty().props.onChange({ target: { value: '4' } })); // above the order
    expect(button().props.disabled).toBe(true);
    act(() => qty().props.onChange({ target: { value: '3' } }));
    act(() => button().props.onClick());
    expect(onConfirm).toHaveBeenCalledWith(3, true);
    expect(text()).toContain('TXFJ6');
    expect(text()).toContain('00155E');
});

it('the stepper stays within known..quantity', async () => {
    const { EntryAcrossDayConfirm } = await import('./bracket-status');
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(EntryAcrossDayConfirm, { code: 'TXFJ6', action: 'Sell', seqno: '1', placedAt: 0, known: 1, quantity: 3, busy: false, onConfirm: vi.fn() })); });
    const qty = () => r.root.findAll(n => n.type === 'input' && n.props.type === 'number')[0]!;
    const btn = (label: string) => r.root.find(n => n.type === 'button' && n.props['aria-label'] === label);
    act(() => btn('增加').props.onClick());
    expect(qty().props.value).toBe('1');
    for (let i = 0; i < 5; i++) act(() => btn('增加').props.onClick());
    expect(qty().props.value).toBe('3');
    for (let i = 0; i < 5; i++) act(() => btn('減少').props.onClick());
    expect(qty().props.value).toBe('1');
});

async function r33NativePlan() {
    const { programForNewBracket, bracketPlansFromPrograms } = await import('../lib/execution/native-view');
    const p = programForNewBracket({ env: 'local|simulation', account: { account_type: 'F', broker_id: 'fixture-broker', account_id: 'fixture-account' }, orderId: 'entry', seqno: 'stable-entry', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 2, stopPrice: 95, takePrice: 110 }, 'r33-ui', 1)!;
    const lv = p.levels[0]!;
    lv.entryFilled = 1; lv.position = 1; lv.phase = 'exiting'; lv.orders[0]!.filled = 1;
    lv.orders.push({ submitVersion: 1, key: 'queued-cover', role: 'exit', leg: 'stop', cycle: 0, qty: 1, status: 'pendingSubmit', orderId: null, filled: 0, fills: {}, fillTs: {}, detail: null, acknowledged: false, cancel: null });
    return { p, lv, map: () => bracketPlansFromPrograms([p])[0]! };
}
it('partial 1/2 queued Cover retains the actual cancel-remainder UI action', async () => {
    const { BracketStatusList } = await import('./bracket-status');
    const fixture = await r33NativePlan();
    const plan = fixture.map();r33.plans = [plan];r33.cancel.mockReset().mockResolvedValue(undefined);
    let view!: ReactTestRenderer;
    act(() => { view = create(createElement(BracketStatusList, { code: 'TXFR1' })); });
    const button = () => view.root.find(n => n.type === 'button' && n.children.join('') === '刪除剩餘進場單');
    await act(async () => { await button().props.onClick(); });
    const confirm = view.root.find(n => n.type === 'button' && n.children.join('').includes('再按一次：刪除剩餘進場單'));
    await act(async () => { await confirm.props.onClick(); });
    expect(r33.cancel).toHaveBeenCalledWith(plan);
    expect(view.root.findAllByType('span').map(n => n.children.join('')).join('|')).toContain('成交 1/2');
    act(() => view.unmount());
});
it('a legacy stopped snapshot with a failed Cover and known position stays visible', async () => {
    const { BracketStatusList } = await import('./bracket-status');
    const fixture = await r33NativePlan();
    fixture.p.status = 'stopped';fixture.lv.phase = 'disabled';fixture.lv.unprotected = 1;
    fixture.lv.orders[1]!.status = 'notSent';r33.plans = [fixture.map()];
    let view!: ReactTestRenderer;
    act(() => { view = create(createElement(BracketStatusList, { code: 'TXFR1' })); });
    const output = JSON.stringify(view.toJSON());
    expect(output).toContain('出場未送出');expect(view.root.findAllByType('div').map(n => n.children.filter(c => typeof c === 'string').join('')).join('|')).toContain('可能未保護 1');
    act(() => view.unmount());
});
it('a persisted failed registration displays its entry identity and no financial action', async () => {
    r33.cancel.mockClear();
    const { BracketStatusList } = await import('./bracket-status');
    const fixture = await r33NativePlan();
    r33.plans = [{ ...fixture.map(), registrationPending: { owner: 'native', detail: '進場單已送出，勿重送進場或另掛重複出場單' } }];
    let view!: ReactTestRenderer;
    act(() => { view = create(createElement(BracketStatusList, { code: 'TXFR1' })); });
    const output = JSON.stringify(view.toJSON());expect(output).toContain('保護登記待確認');expect(output).toContain('stable-entry');
    expect(view.root.findAllByType('button')).toHaveLength(1);
    expect(JSON.stringify(view.toJSON())).toContain('已人工核對');
    expect(r33.cancel).not.toHaveBeenCalled();
    act(() => view.unmount());
});
