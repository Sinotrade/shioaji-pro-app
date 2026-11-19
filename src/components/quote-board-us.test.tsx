// 美股走台股同一個 QuoteBoard：價格位數固定（1 美元以上 2 位）、漲跌基準是
// 美股參考價、盤前開高低不拿前一天的值、IPO 沒成交時不顯示 0.00、延長時段與
// 停牌放在狀態徽章（同一套階梯版面，欄位不會換行跳動）
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
afterEach(() => { act(() => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

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

    it('pre-market: change vs the snapshot reference, empty open/high/low, 盤前 badge', () => {
        // 盤前 tick 的 price_chg 是 SDK 的一般盤值（0）；漲跌改用成交價 − 當天快照 reference
        m.usSnap = usSnap({ tradeDate: '2026-11-19', reference: 352.45, open: 0, high: 0, low: 0, close: 352.46, session: 'PreMarket' });
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '07:00:00', close: '354.1244', price_chg: '0', open: '', high: '', low: '', total_volume: 255203, volume: 5 } };
        m.meta = { session: 'PreMarket' };
        mount();
        const t = text();
        expect(t).toContain('354.12');
        expect(t).toContain('+1.67');
        expect(t).toContain('盤前');
        expect(t).not.toContain('352.46'); // 不拿最後一筆成交當基準
        expect((t.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3); // 開、高、低
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

    it('halt replaces the session badge', () => {
        m.usSnap = usSnap();
        m.halt = { scope: 'Symbol' };
        m.quote = { tick: { code: 'US:AAPL', date: '2026-11-19', time: '13:00:01', close: '98.1', open: '84', high: '99', low: '82', total_volume: 1, volume: 1 } };
        m.meta = { session: 'AfterHours' };
        mount();
        const t = text();
        expect(t).toContain('停牌');
        expect(t).not.toContain('盤後');
    });
});
