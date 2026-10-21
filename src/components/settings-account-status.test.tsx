import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { getAccountState } from '../lib/account-store';
import type { Account } from '../lib/types/portfolio';
import { setPrivacyMode } from '../lib/privacy';
import {
    MARKETS, PROD_SWITCH_HINT, VERIFY_RULES, VERIFY_SEND_RULE, VERIFY_WAIT,
    type Market, type VerificationStatus,
} from './settings-account-verification';
import { ProdAccountStatusSection } from './settings-account-status';
import * as t from './settings-test-order.css';
import * as v from './settings-account-verification.css';

type FixtureState = Omit<ReturnType<typeof getAccountState>, 'loaded'> & { loaded?: boolean };
const fixture = vi.hoisted(() => ({ state: {} as FixtureState }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => fixture.state }));

const stock: Account = { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: '', username: '甲' };
const futures: Account = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: false, person_id: '', username: '乙' };
const accountFor = (market: Market) => market === 'S' ? stock : futures;
const selectionFor = (market: Market, selected: Account | null) => market === 'S'
    ? { selectedStock: selected }
    : { selectedFutures: selected };

function setStatuses(stockStatus: VerificationStatus, futuresStatus: VerificationStatus) {
    const s = { ...stock, signed: stockStatus === 'ok' };
    const f = { ...futures, signed: futuresStatus === 'ok' };
    fixture.state = {
        accounts: [...(stockStatus === 'none' ? [] : [s]), ...(futuresStatus === 'none' ? [] : [f])],
        selectedStock: stockStatus === 'ok' ? s : null,
        selectedFutures: futuresStatus === 'ok' ? f : null,
        loaded: true,
        loadError: false,
    };
}

let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setPrivacyMode(false);
    fixture.state = { accounts: [stock, futures], selectedStock: stock, selectedFutures: null, loaded: true, loadError: false };
});
afterEach(async () => {
    await act(async () => { view?.unmount(); });
    view = undefined;
    setPrivacyMode(false);
    vi.unstubAllGlobals();
});

const render = async () => { await act(async () => { view = create(createElement(ProdAccountStatusSection)); }); };
const textOf = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');
const compactText = (node: ReactTestInstance) => textOf(node).replace(/\s+/g, '');
const rows = () => view!.root.findAll(node => node.type === 'li' && node.props['data-status'] !== undefined);
const rowFor = (market: Market) => rows()[market === 'S' ? 0 : 1]!;
const rules = () => view!.root.findAll(node => node.type === 'section' && node.props.role === 'region');

it.each([
    { market: 'S', status: 'ok', text: '證券已通過，可正式下單帳號9A95-1234567', main: '已通過', sub: '，可正式下單', icon: 'lucide-circle-check', color: t.okIcon },
    { market: 'S', status: 'fail', text: '證券未通過：尚未完成API簽署或模擬測試，無法正式下單帳號9A95-1234567', main: '未通過', sub: '：尚未完成 API 簽署或模擬測試，無法正式下單', icon: 'lucide-circle-x', color: v.failIcon },
    { market: 'S', status: 'none', text: '證券無證券帳戶', main: '無證券帳戶', sub: undefined, icon: 'lucide-circle-x', color: v.failIcon },
    { market: 'F', status: 'ok', text: '期貨已通過，可正式下單帳號F002000-7654321', main: '已通過', sub: '，可正式下單', icon: 'lucide-circle-check', color: t.okIcon },
    { market: 'F', status: 'fail', text: '期貨未通過：尚未完成API簽署或模擬測試，無法正式下單帳號F002000-7654321', main: '未通過', sub: '：尚未完成 API 簽署或模擬測試，無法正式下單', icon: 'lucide-circle-x', color: v.failIcon },
    { market: 'F', status: 'none', text: '期貨無期貨帳戶', main: '無期貨帳戶', sub: undefined, icon: 'lucide-circle-x', color: v.failIcon },
] as const)('renders the frozen $market/$status row with its accessible text and icon', async ({ market, status, text, main, sub, icon, color }) => {
    setStatuses(market === 'S' ? status : 'ok', market === 'F' ? status : 'ok');
    await render();
    expect(rows()).toHaveLength(2);
    expect(rows().map(row => textOf(row.findByProps({ className: v.statusMarket })))).toEqual(['證券', '期貨']);
    const row = rowFor(market);
    expect(row.props['data-status']).toBe(status);
    expect(compactText(row)).toBe(text);
    expect(row.props.title).toBeUndefined();
    expect(row.props['aria-label']).toBeUndefined();
    expect(textOf(row.findByProps({ className: v.statusMain }))).toBe(main);
    expect(row.findAllByProps({ className: v.statusSub }).map(textOf)).toEqual(sub === undefined ? [] : [sub]);
    expect(row.children.map(child => typeof child === 'string' ? child : child.props.className)).toEqual(
        status === 'none' ? [v.statusMarket, v.statusText] : [v.statusMarket, v.statusText, v.accountId],
    );
    const svg = row.findByType('svg');
    expect(svg.props.className).toContain(icon);
    expect(svg.props.className).toContain(color);
    expect(svg.props['aria-hidden']).toBe(true);
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
    expect(row.findAllByProps({ className: t.srOnly }).map(textOf)).toEqual(status === 'none' ? [] : ['帳號 ']);
});

it('shows the mixed signed/unsigned fixture without exposing account holder names', async () => {
    await render();
    expect(rows().map(row => row.props['data-status'])).toEqual(['ok', 'fail']);
    expect(textOf(view!.root)).not.toMatch(/甲|乙/);
});

it.each(MARKETS)('uses the first listed %s account when no account is selected', async market => {
    const first = { ...accountFor(market), signed: false };
    const second = { ...first, account_id: '2222222' };
    fixture.state = { ...fixture.state, accounts: [first, second, ...fixture.state.accounts.filter(a => a.account_type !== market)], ...selectionFor(market, null) };
    await render();
    expect(rowFor(market).props['data-status']).toBe('fail');
    expect(textOf(rowFor(market).findByProps({ className: v.accountId }))).toBe(`帳號 ${first.broker_id}-${first.account_id}`);
    expect(textOf(rowFor(market))).not.toContain('2222222');
});

it.each(MARKETS)('shows the selected %s account even when it is not first in the list', async market => {
    const selected = { ...accountFor(market), signed: true, account_id: '2222222' };
    fixture.state = { ...fixture.state, accounts: [...fixture.state.accounts, selected], ...selectionFor(market, selected) };
    await render();
    expect(rowFor(market).props['data-status']).toBe('ok');
    expect(textOf(rowFor(market).findByProps({ className: v.accountId }))).toBe(`帳號 ${selected.broker_id}-2222222`);
    expect(textOf(rowFor(market))).not.toContain(accountFor(market).account_id);
});

it.each(MARKETS)('does not mark a selected unsigned %s account as passed', async market => {
    const selected = { ...accountFor(market), signed: false };
    fixture.state = { ...fixture.state, ...selectionFor(market, selected) };
    await render();
    expect(rowFor(market).props['data-status']).toBe('fail');
});

it.each(MARKETS)('does not mark a selected %s account with unknown signing as passed', async market => {
    const selected = { ...accountFor(market), signed: undefined } as unknown as Account;
    fixture.state = { ...fixture.state, ...selectionFor(market, selected) };
    await render();
    expect(rowFor(market).props['data-status']).toBe('fail');
});

it.each(MARKETS)('does not infer that %s passed from an unselected signed account', async market => {
    setStatuses('ok', 'ok');
    fixture.state = { ...fixture.state, ...selectionFor(market, null) };
    await render();
    expect(rowFor(market).props['data-status']).toBe('fail');
    expect(textOf(rowFor(market))).toContain(accountFor(market).account_id);
});

it.each(MARKETS)('ignores a selected account of the wrong market for %s', async market => {
    const other = { ...accountFor(market === 'S' ? 'F' : 'S'), signed: true };
    fixture.state = { ...fixture.state, ...selectionFor(market, other) };
    await render();
    expect(rowFor(market).props['data-status']).toBe('fail');
    expect(textOf(rowFor(market).findByProps({ className: v.accountId }))).toBe(`帳號 ${accountFor(market).broker_id}-${accountFor(market).account_id}`);
});

it.each([
    { name: 'not loaded with no accounts', loaded: false, empty: true, loadError: false },
    { name: 'not loaded with retained accounts', loaded: false, empty: false, loadError: false },
    { name: 'loaded with no accounts', loaded: true, empty: true, loadError: false },
    { name: 'load error with no accounts', loaded: true, empty: true, loadError: true },
])('renders only a neutral explanation when accounts are unknown: $name', async ({ loaded, empty, loadError }) => {
    fixture.state = { ...fixture.state, loaded, loadError, ...(empty ? { accounts: [], selectedStock: null, selectedFutures: null } : {}) };
    await render();
    const explanation = view!.root.findByType('p');
    expect(textOf(explanation)).toBe('取得帳號後顯示驗證狀態。');
    expect(explanation.props.className).toBe(t.description);
    expect(view!.root.findAllByType('li')).toHaveLength(0);
    expect(view!.root.findAllByType('ul')).toHaveLength(0);
    expect(view!.root.findAllByType('svg')).toHaveLength(0);
    expect(rules()).toHaveLength(0);
    expect(textOf(view!.root)).not.toMatch(/無證券帳戶|無期貨帳戶/);
});

it('keeps retained account statuses visible after a load error', async () => {
    fixture.state.loadError = true;
    await render();
    expect(rows().map(row => row.props['data-status'])).toEqual(['ok', 'fail']);
    expect(textOf(view!.root)).not.toContain('取得帳號後顯示驗證狀態。');
});

it('accepts a nonempty account mock without the loaded field', async () => {
    delete fixture.state.loaded;
    await render();
    expect(rows().map(row => row.props['data-status'])).toEqual(['ok', 'fail']);
});

it('masks both selected and fallback account ids when privacy mode is on', async () => {
    setPrivacyMode(true);
    await render();
    expect(rows().map(row => textOf(row.findByProps({ className: v.accountId })))).toEqual(['帳號 9A95-•••••67', '帳號 F002000-•••••21']);
    expect(JSON.stringify(view!.toJSON())).not.toMatch(/1234567|7654321|甲|乙/);
});

it('updates masked account ids when privacy mode changes after mounting', async () => {
    await render();
    await act(async () => { setPrivacyMode(true); });
    expect(JSON.stringify(view!.toJSON())).not.toMatch(/1234567|7654321/);
    expect(rows().map(row => textOf(row.findByProps({ className: v.accountId })))).toEqual(['帳號 9A95-•••••67', '帳號 F002000-•••••21']);
    await act(async () => { setPrivacyMode(false); });
    expect(rows().map(row => textOf(row.findByProps({ className: v.accountId })))).toEqual(['帳號 9A95-1234567', '帳號 F002000-7654321']);
});

it.each([
    ['ok', 'ok', false],
    ['ok', 'fail', true],
    ['fail', 'ok', true],
    ['fail', 'fail', true],
    ['ok', 'none', true],
    ['none', 'ok', true],
    ['fail', 'none', true],
    ['none', 'fail', true],
] as const)('shows production rules for S=%s and F=%s only when needed', async (stockStatus, futuresStatus, showRules) => {
    setStatuses(stockStatus, futuresStatus);
    await render();
    expect(rules()).toHaveLength(showRules ? 1 : 0);
    if (!showRules) {
        expect(textOf(view!.root)).not.toContain('如何通過驗證');
        expect(textOf(view!.root)).not.toContain(PROD_SWITCH_HINT);
        return;
    }
    const region = rules()[0]!;
    expect(textOf(region.findByProps({ id: region.props['aria-labelledby'] }))).toBe('如何通過驗證');
    expect(region.findByType('ul').props.role).toBe('list');
    const items = region.findAllByType('li').map(textOf);
    expect(items).toHaveLength(6);
    items.forEach((text, i) => { expect(text).toBe(i === 3 ? VERIFY_SEND_RULE + PROD_SWITCH_HINT : VERIFY_RULES[i]); });
    expect(textOf(region).split(VERIFY_WAIT)).toHaveLength(2);
    expect(textOf(region)).not.toMatch(/5 分鐘|數小時內會開通/);
});

it('labels the shared glass card and preserves list semantics in production', async () => {
    await render();
    const card = view!.root.findByProps({ className: t.card });
    expect(card.type).toBe('section');
    expect(textOf(card.findByProps({ id: card.props['aria-labelledby'] }))).toBe('帳戶狀態');
    expect(textOf(card.findByProps({ className: t.environment }))).toBe('正式環境');
    expect(card.findByProps({ className: v.statusList }).props.role).toBe('list');
    expect(card.findAll(node => typeof node.type === 'string' && (node.props['aria-live'] !== undefined || node.props.role === 'status' || node.props.role === 'alert'))).toHaveLength(0);
});

it('has no buttons, links, focusable controls or click handlers', async () => {
    await render();
    expect(view!.root.findAllByType('button')).toHaveLength(0);
    expect(view!.root.findAll(node => typeof node.type === 'string' && (
        ['a', 'input', 'select', 'textarea', 'summary'].includes(node.type) || node.props.tabIndex !== undefined || node.props.onClick !== undefined
    ))).toHaveLength(0);
});

it('renders new account statuses and removes rows when the account state becomes unknown', async () => {
    setStatuses('ok', 'ok');
    await render();
    setStatuses('ok', 'fail');
    await act(async () => { view!.update(createElement(ProdAccountStatusSection)); });
    expect(rows().map(row => row.props['data-status'])).toEqual(['ok', 'fail']);
    expect(rules()).toHaveLength(1);
    fixture.state.loaded = false;
    await act(async () => { view!.update(createElement(ProdAccountStatusSection)); });
    expect(rows()).toHaveLength(0);
    expect(rules()).toHaveLength(0);
    expect(textOf(view!.root)).toContain('取得帳號後顯示驗證狀態。');
});

it('keeps production imports within the frozen passive display boundary', () => {
    const source = readFileSync(resolve(__dirname, 'settings-account-status.tsx'), 'utf8');
    expect(source).not.toMatch(/placeQuickOrder|lib\/trade|use-stream|useQuote|useServerInfo|refreshAccounts|<button|from ['"]\.\/settings-test-order['"]|\bfetch\s*\(|EventSource|\buseEffect\b|\bonClick\b/);
    // 含 side-effect import（import '…'）與動態 import，否則白名單有漏洞
    const imports = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(imports.every(path => [
        'react', '../lib/account-store', '../lib/privacy', './settings-account-verification', './settings-test-order.css', './settings-account-verification.css',
    ].includes(path!))).toBe(true);
    expect(readFileSync(resolve(__dirname, 'settings-account-verification.css.ts'), 'utf8')).not.toContain('light-dark(');
});
