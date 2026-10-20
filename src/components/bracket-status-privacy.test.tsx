// #268 — the bracket status card's protected／unprotected quantities are the
// position size: hidden under 遮金額 like the positions table.
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BracketPlan } from '../lib/bracket-core';

const m = vi.hoisted(() => ({ privMoney: false, plans: [] as unknown[] }));
vi.mock('../lib/bracket', () => ({
    acknowledgeBracketExit: vi.fn(), bracketSnapshotStale: () => false, cancelRemainingEntry: vi.fn(),
    dismissBracket: vi.fn(), reconcileBracket: vi.fn(), useBrackets: () => m.plans,
}));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [], selectedStock: null, selectedFutures: null, loaded: true, loadError: false }) }));
vi.mock('../lib/trigger-engine', () => ({ useTriggerFeed: () => ({ feedMissing: [], executing: true }) }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'srv|simulation', protectionEnvLabel: () => '模擬' }));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMode: () => false, usePrivacyMoney: () => m.privMoney }));
const { BracketStatusList } = await import('./bracket-status');

const plan = (over: Partial<BracketPlan> = {}): BracketPlan => ({
    id: 'bk-1', env: 'srv|simulation', account: { account_type: 'F', broker_id: 'b', account_id: 'a1' }, market: 'futures', orderId: 'o1', seqno: '1',
    quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 3, stopPrice: 48000, takePrice: 48600,
    group: 'bracket:o1', fills: { a: 3 }, filled: 3, entryClosed: true, exit: null, issues: [], createdAt: 1, updatedAt: 1, ...over,
} as BracketPlan);
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const render = async () => { await act(async () => { view = create(createElement(BracketStatusList, { code: 'TXFR1' })); }); };

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); m.privMoney = false; });
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('shows the unprotected quantity normally and hides it under 遮金額', async () => {
    m.plans = [plan({ exit: { status: 'incomplete', kind: 'stop', quantity: 3, filled: 1, fills: { x: 1 }, at: 1 } })];
    await render();
    expect(text(view.root)).toMatch(/可能未保護 2（待確認）/);
    await act(async () => view.unmount());
    m.privMoney = true;
    await render();
    expect(text(view.root)).toContain('可能未保護 •••••（待確認）');
    expect(text(view.root)).not.toMatch(/可能未保護 2/);
});

it('hides the OCO protected quantity under 遮金額', async () => {
    m.plans = [plan()];
    await render();
    expect(text(view.root)).toContain('OCO 保護 3');
    await act(async () => view.unmount());
    m.privMoney = true;
    await render();
    expect(text(view.root)).toContain('OCO 保護 •••••');
});
