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
import { resetUsMarketClockForTest } from '../hooks/use-us-market-clock';

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

it('main line is the regular price; odd-lot / extended prints do not move it', () => {
    quotes['US:T'] = { tick: {
        code: 'US:T', date: '2026-11-19', close: '25.37', open: '24.2', price_chg: '1.2', pct_chg: '4.98',
        us: { session: 'Regular', regular: '25.30', regularChg: '1.2', regularPct: '4.98', extClose: '', extHigh: '', extLow: '', updatesLast: false },
    }, lastDir: 1, flashSeq: 0 };
    render();
    const us = text(rowByKey('US:T'));
    expect(us).toContain('25.30');
    expect(us).not.toContain('25.37');
});

it('US rows always reserve the extended-hours line (no row-height jump); TW rows have none', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        // 美東 2026-11-19 07:00（盤前）
        vi.setSystemTime(Date.UTC(2026, 10, 19, 12, 0));
        resetUsMarketClockForTest(Date.now());
        quotes['US:T'] = { tick: {
            code: 'US:T', date: '2026-11-19', close: '24.60', open: '', price_chg: '0', pct_chg: '0',
            us: { session: 'PreMarket', regular: '', regularChg: '', regularPct: '', extClose: '24.60', extHigh: '24.7', extLow: '24.5' },
        }, lastDir: 1, flashSeq: 0 };
        render({ items: [{ contract: twT }, { contract: usT, usSnapshot: {
            code: 'T', exchange: 'NYSE', ts: null, tradeDate: '2026-11-19', open: 0, high: 0, low: 0, close: 24.1, reference: 24.1,
            changePrice: 0, changeRate: 0, totalVolume: 0, buyPrice: null, sellPrice: null, buyVolume: null, sellVolume: null, session: 'PreMarket', lastPrice: 24.6,
        } }] });
        const ext = (key: string) => rowByKey(key).findAll((n) => n.props['data-us-ext'] !== undefined);
        expect(ext('T')).toHaveLength(0);
        expect(ext('US:T')).toHaveLength(1);
        expect(ext('US:T')[0]!.props['data-us-ext']).toBe('PreMarket');
        const us = text(rowByKey('US:T'));
        expect(us).toContain('24.10'); // 主行：前一日收盤
        expect(us).toContain('昨收'); // 漲跌 0 沒有意義
        expect(us).not.toContain('0.00%');
        const icon = rowByKey('US:T').find((n) => n.props.role === 'img' && n.props['data-us-session']);
        expect(icon.props['aria-label']).toBe('盤前'); // 日出圖示
        expect(icon.props.title).toContain('盤前');
        expect(us).toContain('24.60');
        expect(us).toContain('+0.50');
        act(() => r?.unmount());
        // 一般盤：副行仍在（空白、aria-hidden），列高不變
        vi.setSystemTime(Date.UTC(2026, 10, 19, 17, 0));
        resetUsMarketClockForTest(Date.now());
        render();
        const blank = ext('US:T');
        expect(blank).toHaveLength(1);
        expect(blank[0]!.props['data-us-ext']).toBe('none');
        expect(blank[0]!.props['aria-hidden']).toBe('true');
    } finally {
        vi.useRealTimers();
        resetUsMarketClockForTest();
    }
});

it('sorting by change% uses the regular-session change, not the extended-hours price', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        // 美東 2026-11-19 17:00（盤後）：A 一般盤 +1%、盤後大漲；B 一般盤 +3%、盤後不動
        vi.setSystemTime(Date.UTC(2026, 10, 19, 22, 0));
        resetUsMarketClockForTest(Date.now());
        const usA = toUsContractInfo('A', { code: 'A', exchange: 'NYSE', shortName: 'A', reference: '100', referenceDate: '2026-11-18', fetchedOn: '2026-11-19' });
        const usB = toUsContractInfo('B', { code: 'B', exchange: 'NYSE', shortName: 'B', reference: '100', referenceDate: '2026-11-18', fetchedOn: '2026-11-19' });
        const t = (code: string, regular: string, ext: string) => ({ tick: {
            code: `US:${code}`, date: '2026-11-19', close: ext || regular, open: '100',
            us: { session: 'AfterHours', regular, regularChg: '', regularPct: '', extClose: ext, extHigh: '', extLow: '' },
        }, lastDir: 1, flashSeq: 0 });
        quotes['US:A'] = t('A', '101', '120');
        quotes['US:B'] = t('B', '103', '');
        render({ items: [{ contract: usA }, { contract: usB }] });
        const sortBtn = r!.root.find((n) => n.type === 'button' && n.props.title === '依漲跌幅排序');
        act(() => sortBtn.props.onClick());
        const keys = r!.root.findAll((n) => n.type === 'div' && typeof n.props['data-key'] === 'string').map((n) => n.props['data-key']);
        expect(keys).toEqual(['US:B', 'US:A']);
    } finally {
        vi.useRealTimers();
        resetUsMarketClockForTest();
    }
});

it('US rows flash only when the main (regular) price changes, not on odd-lot / extended prints', () => {
    const q = (close: string, regular: string, flashSeq: number) => ({ tick: {
        code: 'US:T', date: '2026-11-19', close, open: '24.2', price_chg: '', pct_chg: '',
        us: { session: 'Regular', regular, regularChg: '', regularPct: '', extClose: '', extHigh: '', extLow: '' },
    }, lastDir: 1, flashSeq });
    const overlays = () => rowByKey('US:T').findAll((n) => n.type === 'span' && String(n.props.className ?? '').includes('flashOverlay'));
    quotes['US:T'] = q('25.30', '25.30', 1);
    const props = { items: [{ contract: usT }] };
    render(props);
    expect(overlays()).toHaveLength(0); // 第一次拿到價格不閃
    const rerender = () => act(() => r!.update(createElement(Watchlist, { ...(r!.root.props as any), items: [{ contract: usT }] })));
    quotes['US:T'] = q('25.37', '25.30', 2); // 零股成交：主行不變
    rerender();
    expect(overlays()).toHaveLength(0);
    quotes['US:T'] = q('25.40', '25.40', 3); // 一般盤價上漲
    rerender();
    expect(overlays()).toHaveLength(1);
    expect(String(overlays()[0]!.props.className)).toContain('up');
});
