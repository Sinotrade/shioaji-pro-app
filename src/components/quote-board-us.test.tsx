// 美股走台股同一個 QuoteBoard：價格位數固定（1 美元以上 2 位）、漲跌基準是
// 美股參考價、盤前開高低不拿前一天的值、IPO 沒成交時不顯示 0.00、大字是一般盤價、
// 盤前／盤後價在副區塊（一律保留位置），停牌放在狀態徽章（同一套階梯版面，欄位不會換行跳動）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
    };
});

const m = vi.hoisted(() => ({ quote: undefined as unknown, snapshot: undefined as unknown, usSnap: null as unknown, halt: null as unknown, meta: undefined as unknown, keys: [] as string[] }));
vi.mock('../hooks/use-display-book', () => ({ useSnapshotBaseline: (code: string) => { m.keys.push(code); return { snapshot: m.snapshot }; } }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (key: string) => { m.keys.push(key); return m.quote; } }));
vi.mock('../hooks/use-us-snapshot', async (orig) => ({ ...(await orig<object>()), useUsSnapshot: () => m.usSnap }));
vi.mock('../lib/us/us-halts', () => ({ useUsHalt: () => m.halt, usHaltLabel: () => '停牌' }));
vi.mock('../lib/us/us-quotes', async (orig) => ({ ...(await orig<object>()), getUsTickMeta: () => m.meta }));
const fetchSnapshots = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../lib/shioaji', () => ({ fetchKbars: vi.fn(), fetchSnapshots }));

import { QuoteBoard } from './quote-board';
import { resetUsMarketClockForTest } from '../hooks/use-us-market-clock';
import { usSnapshotToTw } from '../lib/us/us-adapter';
import type { UsSnapshot } from '../lib/us/us-history';

const aapl = {
    region: 'US', exchange: 'NASDAQ', code: 'AAPL', name: 'Apple', security_type: 'STK', target_code: null, currency: 'USD',
    reference: 83.0, us_reference: '83.00', reference_date: '2026-11-18', limit_up: 0, limit_down: 0,
} as unknown as ContractInfo;

const usSnap = (over: Partial<UsSnapshot> = {}): UsSnapshot => ({
    code: 'AAPL', exchange: 'NASDAQ', ts: Date.UTC(2026, 10, 19, 18, 0, 0), tradeDate: '2026-11-19',
    open: 84, high: 99, low: 82, close: 98.083, reference: 83, changePrice: 15.083, changeRate: 18.17,
    totalVolume: 1_234_567, buyPrice: 98.07, sellPrice: 98.09, buyVolume: 100, sellVolume: 200, session: 'Regular', lastPrice: 98.083,
    yesterdayVolume: 2_000_000, ...over,
});

let view: ReactTestRenderer | undefined;
const text = () => JSON.stringify(view!.toJSON());
const mount = () => act(() => { view = create(createElement(QuoteBoard, { contract: aapl })); });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.quote = undefined; m.snapshot = undefined; m.usSnap = null; m.halt = null; m.meta = undefined; m.keys = [];
});
afterEach(() => { act(() => view?.unmount()); view = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); resetUsMarketClockForTest(); });
/** 把時鐘定在美東 2026-11-19（四）的某個時間（EST，UTC−5） */
const atEt = (h: number, m = 0, day = 19) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, day, h + 5, m));
    resetUsMarketClockForTest(Date.now());
};
const extBlock = () => view!.root.find(n => n.props['data-testid'] === 'us-board-ext');
const extIcon = () => extBlock().find(n => n.props.role === 'img').props['aria-label'];
const extText = () => extBlock().findAll(() => true).flatMap(n => n.children.filter((c): c is string => typeof c === 'string')).join(' ');

describe('QuoteBoard (US through the TW board)', () => {
    it('reads quotes and snapshot by the US:CODE link key and never calls the TW snapshot API', () => {
        m.usSnap = usSnap();
        m.snapshot = usSnapshotToTw(usSnap());
        mount();
        expect(m.keys.every(k => k === 'US:AAPL')).toBe(true);
        expect(fetchSnapshots).not.toHaveBeenCalled();
    });

    it('rounds a sub-penny print to 2 decimals and measures the change from the reference', () => {
        m.usSnap = usSnap();
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '13:00:01', close: '98.083', price_chg: '15.083', open: '84', high: '99', low: '82', total_volume: 1_234_567, volume: 10 } };
        m.meta = { session: 'Regular' };
        mount();
        const t = text();
        expect(t).toContain('98.08');
        expect(t).not.toContain('98.083');
        expect(t).toContain('+15.08');
        expect(t).not.toContain('15.083');
        expect(t).toContain('+18.17%');
        expect(t).not.toContain('us-board-status'); // 一般盤沒有狀態徽章
    });

    it('uses 4 decimals under $1', () => {
        m.usSnap = usSnap({ reference: 0.5, tradeDate: '2026-11-19' });
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '13:00:01', close: '0.51234', open: '0.5', high: '0.52', low: '0.49', total_volume: 10, volume: 1 } };
        mount();
        const t = text();
        expect(t).toContain('0.5123');
        expect(t).toContain('+0.0123');
    });

    it('pre-market: big price is the previous close, 盤前 ext price vs the reference, empty open/high/low', () => {
        atEt(7);
        m.usSnap = usSnap({ tradeDate: '2026-11-19', reference: 352.45, open: 0, high: 0, low: 0, close: 352.45, changePrice: 0, changeRate: 0, session: 'PreMarket' });
        m.quote = { tick: {
            code: 'US:AAPL', date: '2026-11-19', time: '07:00:00', close: '354.1244', price_chg: '0', open: '', high: '', low: '', total_volume: 255203, volume: 5,
            us: { session: 'PreMarket', regular: '', regularChg: '', regularPct: '', extClose: '354.12', extHigh: '355', extLow: '353' },
        } };
        m.meta = { session: 'PreMarket' };
        mount();
        const big = view!.root.find(n => typeof n.props.className === 'string' && n.props.className.includes('bigPrice'));
        expect(big.children).toEqual(['352.45']);
        // 漲跌 0 沒有意義：標昨收，不顯示 0.00 0.00%
        expect(view!.root.find(n => n.props['data-testid'] === 'us-board-prev-close').children).toEqual(['昨收']);
        expect(text()).not.toContain('"0.00"');
        expect(extBlock().props['data-us-ext']).toBe('PreMarket');
        expect(extIcon()).toBe('盤前'); // 日出圖示，讀屏名稱是盤前
        expect(extText()).toContain('354.12');
        expect(extText()).toContain('+1.67');
        expect(extBlock().props.title).toContain('盤前高 355.00');
        expect(text()).not.toContain('us-board-status'); // 時段不再佔狀態徽章
        expect((text().match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3); // 開、高、低
    });

    it('regular session: big price ignores odd-lot prints, the ext block keeps its place but is hidden', () => {
        atEt(12);
        m.usSnap = usSnap({ reference: 145.98 });
        m.quote = { tick: {
            code: 'US:AAPL', date: '2026-11-19', time: '12:00:00', close: '135.63', open: '143.57', high: '143.725', low: '135.06', total_volume: 10, volume: 2,
            us: { session: 'Regular', regular: '135.62', regularChg: '-10.36', regularPct: '-7.1', extClose: '', extHigh: '', extLow: '', updatesLast: false },
        } };
        mount();
        const big = view!.root.find(n => typeof n.props.className === 'string' && n.props.className.includes('bigPrice'));
        expect(big.children).toEqual(['135.62']);
        expect(text()).toContain('-10.36');
        expect(extBlock().props['data-us-ext']).toBe('none');
        expect(extBlock().props['aria-hidden']).toBe(true);
        expect(String(extBlock().props.className)).toContain('usExtEmpty');
    });

    it('post-market: ext vs today\'s close; after 20:00 it stays greyed', () => {
        const us = { session: 'AfterHours', regular: '353.10', regularChg: '', regularPct: '', extClose: '354.00', extHigh: '', extLow: '' };
        m.usSnap = usSnap({ reference: 349 });
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '17:00:00', close: '354.00', open: '350', high: '355', low: '345', total_volume: 10, volume: 1, us } };
        atEt(17);
        mount();
        expect(extBlock().props['data-us-ext']).toBe('AfterHours');
        expect(extText()).toContain('+0.90');
        expect(String(extBlock().props.className)).not.toContain('usExtClosed');
        act(() => view!.unmount());
        atEt(21);
        mount();
        expect(extBlock().props['data-us-ext']).toBe('closed');
        expect(String(extBlock().props.className)).toContain('usExtClosed');
        act(() => view!.unmount());
        atEt(4, 1, 20); // 隔天 04:00 換日：清掉
        mount();
        expect(extBlock().props['data-us-ext']).toBe('none');
    });

    it('next-day pre-market does not show the previous day\'s open/high/low', () => {
        m.usSnap = usSnap({ tradeDate: '2026-11-18', open: 84, high: 99, low: 82 });
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '07:00:00', close: '98.5', open: '', high: '', low: '', total_volume: 10, volume: 1 } };
        mount();
        const t = text();
        expect(t).not.toContain('84.00');
        expect(t).not.toContain('99.00');
    });

    it('IPO snapshot with no trade: no 0.00 price, shows 快照', () => {
        const ipo = usSnap({ code: 'ANT', close: 0, open: 0, high: 0, low: 0, reference: 0, changePrice: 0, changeRate: 0, totalVolume: 0, buyPrice: 100, sellPrice: 100, session: 'Unknown', lastPrice: 0 });
        m.usSnap = ipo;
        m.snapshot = usSnapshotToTw(ipo);
        mount();
        const t = text();
        expect(t).toContain('快照');
        // 價格與漲跌都是空值符號，不是 0.00／0.00%
        const block = view!.root.findAll(n => typeof n.props.className === 'string' && n.props.className.includes('changeBlock'))[0]!;
        const spans = block.findAllByType('span').map(s => s.children.filter(c => typeof c === 'string').join(''));
        expect(spans.slice(0, 2)).toEqual(['—', '—']);
        expect(t).not.toContain('"0.00%"');
    });

    it('overnight at 21:00 ET: moon icon (夜盤) vs the new day reference replaces the greyed post-market; ext block width is reserved', () => {
        m.usSnap = usSnap({ reference: 349, close: 353.1, session: 'AfterHours', extClose: 354, ts: Date.UTC(2026, 10, 20, 0, 59) });
        atEt(21);
        mount();
        expect(extBlock().props['data-us-ext']).toBe('closed'); // 還沒有夜盤成交：盤後轉灰
        expect(extIcon()).toBe('盤後');
        act(() => view!.unmount());
        m.quote = { tick: {
            code: 'US:AAPL', date: '2026-11-19', time: '21:00:05', close: '354.50', open: '', high: '', low: '', total_volume: 10, volume: 100,
            us: { session: 'Overnight', tradeDate: '2026-11-20', ts: Date.UTC(2026, 10, 20, 2, 0, 5), regular: '353.10', regularChg: '', regularPct: '', extClose: '354.50', extHigh: '', extLow: '' },
        } };
        mount();
        expect(extBlock().props['data-us-ext']).toBe('Overnight');
        expect(extIcon()).toBe('夜盤');
        expect(extText()).toContain('354.50');
        expect(extBlock().props.title).toContain('美東 21:00:05');
    });

    it('halt replaces the session badge', () => {
        m.usSnap = usSnap();
        m.halt = { scope: 'Symbol' };
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '13:00:01', close: '98.1', open: '84', high: '99', low: '82', total_volume: 1, volume: 1 } };
        m.meta = { session: 'AfterHours' };
        mount();
        const t = text();
        expect(t).toContain('停牌');
        expect(extBlock().props['data-us-ext']).toBe('none');
    });

    it('shows the delayed / stale feed badge on live US quotes', () => {
        m.usSnap = usSnap();
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '13:00:01', close: '98.08', open: '84', high: '99', low: '82', total_volume: 10, volume: 1 } };
        m.meta = { session: 'Regular', freshness: 'Delayed' };
        mount();
        expect(text()).toContain('us-board-freshness');
        expect(text()).toContain('延遲');
        act(() => view!.unmount());
        m.meta = { session: 'Regular', freshness: 'Stale' };
        mount();
        expect(text()).toContain('過時');
        act(() => view!.unmount());
        m.meta = { session: 'Regular', freshness: 'Realtime' };
        mount();
        expect(text()).not.toContain('us-board-freshness');
    });

    it('without a live tick, an extended-session snapshot shows the regular close big and its ext price in the ext block', () => {
        atEt(8);
        const s = usSnap({ reference: 98, close: 100, changePrice: 2, changeRate: 2.04, session: 'PreMarket', lastPrice: 105, extClose: 105 });
        m.usSnap = s;
        m.snapshot = usSnapshotToTw(s);
        mount();
        const big = view!.root.find(n => typeof n.props.className === 'string' && n.props.className.includes('bigPrice'));
        expect(big.children).toEqual(['100.00']);
        expect(extText()).toContain('105.00');
        expect(extIcon()).toBe('盤前');
        expect(extText()).toContain('+7.00'); // 105 − 參考 98
    });

    it('without a reference, the pre-market ext change is measured from the previous close', () => {
        atEt(8);
        const s = usSnap({ reference: 0, close: 100, open: 0, changePrice: 0, changeRate: 0, session: 'PreMarket', lastPrice: 110, extClose: 110 });
        m.usSnap = s;
        m.snapshot = usSnapshotToTw(s);
        const noRef = { ...aapl, reference: 0, us_reference: null, reference_date: null } as unknown as ContractInfo;
        act(() => { view = create(createElement(QuoteBoard, { contract: noRef })); });
        expect(extText()).toContain('110.00');
        expect(extText()).toContain('+10.00'); // 110 − 前一日收盤 100
        expect(extText()).toContain('+10.00%');
    });

    it('a snapshot with no extended-session price keeps the regular close and no session badge', () => {
        const s = usSnap({ reference: 98, close: 100, changePrice: 2, changeRate: 2.04, session: 'PreMarket', lastPrice: null });
        m.usSnap = s;
        m.snapshot = usSnapshotToTw(s);
        mount();
        const t = text();
        expect(t).toContain('100.00');
        expect(t).not.toContain('us-board-status');
    });
});
