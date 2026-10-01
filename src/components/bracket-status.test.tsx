// src/components/bracket-status.test.tsx — #201 round 23: the across-epoch
// entry confirmation needs both the fill quantity and "no remainder".

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('../lib/bracket', () => ({}));
vi.mock('../lib/bracket-core', () => ({}));
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
