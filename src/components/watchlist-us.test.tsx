// 自選列的美股：美股標記、無即時價顯示參考價、有即時價顯示 tick 漲跌；
// 列身分用連動 key（美股 T 與台股 T 不撞名），點列照常 onSelect
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
});
const quotes: Record<string, any> = {};
const asked: string[] = [];
vi.mock('../hooks/use-stream', () => ({
    useQuote: (code: string) => { asked.push(code); return quotes[code]; },
}));
vi.mock('../lib/stream', () => ({ getQuote: (code: string) => quotes[code] }));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));
vi.mock('../lib/limit-style-prefs', () => ({ useLimitStyle: () => 'block' }));
vi.mock('../hooks/use-product-search', () => ({
    useProductSearch: () => ({
        suggestions: [], searching: false, searchError: false, activeIdentity: null, setActiveIdentity: () => undefined,
        renderedVersion: 0, currentVersion: () => 0, isCurrent: () => true, isComposing: () => false, isStale: () => false,
        cancel: () => undefined, clear: () => undefined, change: () => undefined, retry: () => undefined,
        startComposition: () => undefined, endComposition: () => undefined,
    }),
}));

import { Watchlist } from './watchlist';
import { toUsContractInfo } from '../lib/us/us-contracts';

const twT = {
    exchange: 'TSE', code: 'T', security_type: 'STK', target_code: null, name: '台測', currency: 'TWD',
    limit_up: 110, limit_down: 90, reference: 100, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as any;
const usT = toUsContractInfo('T', { code: 'T', exchange: 'NYSE', shortName: 'AT&T', reference: '24.1', referenceDate: '2026-11-17', fetchedOn: '2026-11-18' });

let r: ReactTestRenderer | null = null;
afterEach(() => {
    act(() => r?.unmount());
    r = null;
    for (const k of Object.keys(quotes)) delete quotes[k];
    asked.length = 0;
});

function render(props: Record<string, unknown> = {}) {
    const handlers = { onSelect: vi.fn(), onRemove: vi.fn(), onReorder: vi.fn() };
    act(() => {
        r = create(createElement(Watchlist, {
            items: [{ contract: twT }, { contract: usT }],
            selectedCode: null,
            onAdd: async () => {},
            serverLists: [{ id: 'w', name: 'W', contracts: [] } as any],
            activeListId: 'w',
            onSelectList: () => {},
            onCreateList: async () => {},
            onRenameList: async () => true,
            onDeleteList: async () => {},
            loading: false,
            structureBusy: false,
            loadError: false,
            onRetryLoad: () => {},
            ...handlers,
            ...props,
        }));
    });
    return handlers;
}

const rowByKey = (key: string) => r!.root.find((n) => n.type === 'div' && n.props['data-key'] === key);
const text = (node: any): string => node.findAll(() => true)
    .flatMap((n: any) => (n.children ?? []).filter((c: unknown) => typeof c === 'string')).join('|');

it('renders the US T and TW T as separate rows keyed by link key', () => {
    const { onSelect, onRemove } = render();
    const us = rowByKey('US:T');
    const tw = rowByKey('T');
    expect(us.props['data-region']).toBe('US');
    expect(tw.props['data-region']).toBeUndefined();
    // 美股訂閱 US:T，不以裸代碼 T 查行情
    expect(asked).toEqual(expect.arrayContaining(['T', 'US:T']));
    act(() => { us.props.onClick(); });
    expect(onSelect).toHaveBeenCalledWith(usT);
    const remove = us.find((n) => n.type === 'button' && n.props.title === '從清單移除');
    act(() => { remove.props.onClick({ stopPropagation: () => undefined }); });
    expect(onRemove).toHaveBeenCalledWith('US:T');
});

it('shows the 美股 marker and the reference price until the first tick', () => {
    render();
    const us = text(rowByKey('US:T'));
    expect(us).toContain('美股');
    expect(us).toContain('參考 24.10');
    expect(us).toContain('USD');
    expect(us).toContain('AT&T');
});

it('shows the live last price and tick change once quotes arrive', () => {
    quotes['US:T'] = { tick: { code: 'US:T', close: '25.3', price_chg: '1.2', pct_chg: '4.98' }, lastDir: 1, flashSeq: 0 };
    render();
    const us = text(rowByKey('US:T'));
    expect(us).toContain('25.30');
    expect(us).toContain('4.98');
    expect(us).not.toContain('參考');
});

it('selects the US row only when the selected key is US:T', () => {
    render({ selectedCode: 'US:T' });
    const sel = (key: string) => String(rowByKey(key).props.className);
    expect(sel('US:T')).not.toEqual(sel('T'));
});
