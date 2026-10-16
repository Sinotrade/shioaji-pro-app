import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, Fragment, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { getAccountState } from '../lib/account-store';
import type { Account } from '../lib/types/portfolio';
import {
    MARKETS, MARKET_LABEL, PROD_SWITCH_HINT, VERIFY_LEGEND, VERIFY_RULES, VERIFY_SEND_RULE, VERIFY_WAIT,
    VerificationIcon, VerificationLegend, VerificationRules, needsVerificationRules, verificationStatus,
    type Market, type VerificationStatus,
} from './settings-account-verification';
import * as t from './settings-test-order.css';
import * as v from './settings-account-verification.css';

const stock: Account = { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: '', username: '甲' };
const futures: Account = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: true, person_id: '', username: '乙' };
const accountFor = (market: Market) => market === 'S' ? stock : futures;
const selectionFor = (market: Market, selected: Account | null) => market === 'S'
    ? { selectedStock: selected, selectedFutures: futures }
    : { selectedStock: stock, selectedFutures: selected };
const state = (extra: Partial<ReturnType<typeof getAccountState>> = {}) => ({
    accounts: [stock, futures], selectedStock: stock, selectedFutures: futures, loaded: true, loadError: false, ...extra,
});

it('shows the rules only when some market is ✕ (fail or none), never while accounts are unknown', () => {
    expect(needsVerificationRules(state())).toBe(false);
    expect(needsVerificationRules(state(selectionFor('F', { ...futures, signed: false })))).toBe(true);
    expect(needsVerificationRules(state({ accounts: [stock], selectedFutures: null }))).toBe(true);
    expect(needsVerificationRules(state({ loaded: false }))).toBe(false);
    expect(needsVerificationRules(state({ accounts: [], selectedStock: null, selectedFutures: null }))).toBe(false);
});

it.each(MARKETS)('returns ok only for the signed selected %s account', market => {
    expect(verificationStatus(market, state())).toBe('ok');
});

it.each(MARKETS)('returns fail for the selected unsigned %s account', market => {
    expect(verificationStatus(market, state(selectionFor(market, { ...accountFor(market), signed: false })))).toBe('fail');
});

it.each(MARKETS)('returns fail when %s is listed but no account is selected', market => {
    expect(verificationStatus(market, state(selectionFor(market, null)))).toBe('fail');
});

it.each(MARKETS)('returns none when %s is absent while the other market is selected', market => {
    const other = market === 'S' ? futures : stock;
    expect(verificationStatus(market, state({ accounts: [other], ...selectionFor(market, null) }))).toBe('none');
});

it.each(MARKETS)('ignores a selected account of the wrong market for %s', market => {
    const other = market === 'S' ? futures : stock;
    expect(verificationStatus(market, state(selectionFor(market, other)))).toBe('fail');
    expect(verificationStatus(market, state({ accounts: [other], ...selectionFor(market, other) }))).toBe('none');
});

it.each(MARKETS)('does not consider an undefined signed value verified for %s', market => {
    const selected = { ...accountFor(market), signed: undefined } as unknown as Account;
    expect(verificationStatus(market, state(selectionFor(market, selected)))).toBe('fail');
});

it.each(MARKETS)('keeps %s unknown while loading, even with retained accounts', market => {
    expect(verificationStatus(market, state({ loaded: false }))).toBeUndefined();
});

it.each([false, true])('keeps an empty loaded account list unknown with loadError=%s', loadError => {
    for (const market of MARKETS) {
        expect(verificationStatus(market, state({ accounts: [], selectedStock: null, selectedFutures: null, loadError }))).toBeUndefined();
    }
});

it('uses retained accounts after a load error and accepts mocks without loaded', () => {
    const retained = state({ loadError: true, selectedFutures: null });
    expect(verificationStatus('S', retained)).toBe('ok');
    expect(verificationStatus('F', retained)).toBe('fail');
    const { loaded: _loaded, ...mock } = retained;
    expect(verificationStatus('S', mock)).toBe('ok');
    expect(verificationStatus('F', mock)).toBe('fail');
});

let view: ReactTestRenderer | undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });
const render = async (element: ReactElement) => { await act(async () => { view = create(element); }); };
const textOf = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(textOf).join('');

it.each([
    ['ok', 'lucide-circle-check', t.okIcon],
    ['fail', 'lucide-circle-x', v.failIcon],
    ['none', 'lucide-circle-x', v.failIcon],
] as const)('renders %s with the correct shape and semantic color', async (status: VerificationStatus, iconClass, colorClass) => {
    await render(createElement(VerificationIcon, { status }));
    const svg = view!.root.findByType('svg');
    expect(svg.props.className).toContain(iconClass);
    expect(svg.props.className).toContain(colorClass);
    expect(svg.props.className).not.toMatch(/lucide-shield|lucide-circle(\s|$)/);
    expect(svg.props['aria-hidden']).toBe(true);
    expect(svg.props.width).toBe(12);
    expect(svg.props.height).toBe(12);
});

it('supports the larger production verification icon', async () => {
    await render(createElement(VerificationIcon, { status: 'fail', size: 14 }));
    const svg = view!.root.findByType('svg');
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
});

it('renders the shared legend verbatim with hidden check and cross icons', async () => {
    await render(createElement(VerificationLegend));
    const legend = view!.root.findByType('p');
    expect(textOf(legend)).toBe(VERIFY_LEGEND);
    expect(legend.props.className).toBe(v.legend);
    const icons = legend.findAllByType('svg');
    expect(icons).toHaveLength(2);
    expect(icons[0]!.props.className).toContain('lucide-circle-check');
    expect(icons[1]!.props.className).toContain('lucide-circle-x');
    expect(icons.every(n => n.props['aria-hidden'] === true)).toBe(true);
    expect(legend.findAllByProps({ className: t.srOnly }).map(textOf)).toEqual(['✓', '✕']);
});

it('renders six official rules in a labelled region with one wait phrase', async () => {
    await render(createElement(VerificationRules));
    const region = view!.root.findByType('section');
    expect(region.props.role).toBe('region');
    expect(textOf(region.findByProps({ id: region.props['aria-labelledby'] }))).toBe('如何通過驗證');
    expect(region.findByType('ul').props.role).toBe('list');
    expect(region.findAllByType('li').map(textOf)).toEqual(VERIFY_RULES);
    expect(textOf(region).split(VERIFY_WAIT)).toHaveLength(2);
    expect(textOf(region)).not.toMatch(/5 分鐘|數小時內會開通/);
    expect(textOf(region)).not.toContain(PROD_SWITCH_HINT);
    expect(region.findAll(n => typeof n.type === 'string' && (n.props['aria-live'] || n.props.role === 'status' || n.props.role === 'alert'))).toHaveLength(0);
    expect(region.findAll(n => typeof n.type === 'string' && (['button', 'a', 'input'].includes(n.type) || n.props.tabIndex !== undefined))).toHaveLength(0);
});

it('appends the production switch hint only to the fourth rule', async () => {
    await render(createElement(VerificationRules, { production: true }));
    const items = view!.root.findAllByType('li').map(textOf);
    expect(items).toHaveLength(6);
    items.forEach((text, i) => { expect(text).toBe(i === 3 ? VERIFY_SEND_RULE + PROD_SWITCH_HINT : VERIFY_RULES[i]); });
});

it('gives simultaneous rule regions distinct accessible heading ids', async () => {
    await render(createElement(Fragment, null, createElement(VerificationRules), createElement(VerificationRules, { production: true })));
    const regions = view!.root.findAllByType('section');
    expect(new Set(regions.map(n => n.props['aria-labelledby'])).size).toBe(2);
    for (const region of regions) expect(textOf(region.findByProps({ id: region.props['aria-labelledby'] }))).toBe('如何通過驗證');
});

it('keeps the frozen market names and verification copy verbatim', () => {
    expect(MARKETS).toEqual(['S', 'F']);
    expect(MARKET_LABEL).toEqual({ S: '證券', F: '期貨' });
    expect(VERIFY_WAIT).toBe('約需 1 分鐘至數小時不等');
    expect(VERIFY_LEGEND).toBe('✓ 表示帳戶已通過簽署與模擬測試；✕ 表示尚未通過。');
    expect(VERIFY_SEND_RULE).toBe('在模擬環境登入，各送一筆測試單：證券用 2890 永豐金、期貨用台指近月（即測試單預設商品）。');
    expect(PROD_SWITCH_HINT).toBe('請切換到模擬環境，用設定 > 帳號的「測試單」送出。');
    expect(VERIFY_RULES).toEqual([
        '可測試時間：開盤日（週一至週五）08:00–20:00（台北時間）；18:00–20:00 僅限台灣 IP。',
        '證券、期貨須各別簽署、各別測試（只測已簽署的商品）。',
        '簽署時間須早於測試時間，否則審核不會通過。',
        VERIFY_SEND_RULE,
        '連續送測試單需間隔 1 秒以上，系統才會記錄。',
        `測試成功與否${VERIFY_WAIT}；若是先登入才完成簽署或測試，請登出後重新登入才會生效。`,
    ]);
});

it('keeps the shared import graph free of orders, quotes and mode ownership', () => {
    const source = readFileSync(resolve(__dirname, 'settings-account-verification.tsx'), 'utf8');
    expect(source).not.toMatch(/placeQuickOrder|lib\/trade|use-stream|useQuote|useServerInfo|server-info-store|from '\.\/settings-test-order'/);
    // 白名單（spec §1.2）：含 side-effect import 與動態 import；黑名單抓不到間接 import 送單模組的檔案
    const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter(path => ![
        'react', 'lucide-react', '../lib/account-store', './settings-test-order.css', './settings-account-verification.css',
    ].includes(path!))).toEqual([]);
    expect(source).not.toMatch(/\brequire\s*\(/);
    // account-store 只能是 type import：一般 import 會經 server-info-store 把模式與 shioaji 拉進來
    const storeImports = [...source.matchAll(/^import\b[^;]*?['"]\.\.\/lib\/account-store['"]/gm)].map(match => match[0]);
    expect(storeImports.length).toBeGreaterThan(0);
    expect(storeImports.every(line => /^import type\s/.test(line))).toBe(true);
    for (const file of ['settings-test-order.css.ts', 'settings-account-verification.css.ts']) {
        expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('light-dark(');
    }
});

it('keeps the badge color-mix behind @supports with a muted Safari 13 fallback', () => {
    const css = readFileSync(resolve(__dirname, 'settings-test-order.css.ts'), 'utf8');
    const start = css.indexOf('export const verification = style({');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('\n});', start));
    const supports = block.indexOf("'@supports'");
    expect(supports).toBeGreaterThan(-1);
    expect(block.slice(0, supports)).toContain('background: vars.color.muted');
    expect(block.slice(0, supports)).not.toContain('color-mix(');
    expect(block.slice(supports)).toContain('color-mix(in srgb, ${vars.color.success} 10%');
    expect(block.slice(supports)).toContain('color-mix(in srgb, ${vars.color.danger} 10%');
    // 新 class 不用 color-mix（spec §1.6）
    expect(readFileSync(resolve(__dirname, 'settings-account-verification.css.ts'), 'utf8')).not.toContain('color-mix(');
});
