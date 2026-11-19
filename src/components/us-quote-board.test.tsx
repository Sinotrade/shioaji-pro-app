import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const m = vi.hoisted(() => ({ quote: undefined as unknown, halt: null as unknown, snap: null as unknown }));
vi.mock('../hooks/use-us-snapshot', async importOriginal => ({ ...(await importOriginal<object>()), useUsSnapshot: () => m.snap }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => m.quote }));
vi.mock('../lib/us/us-halts', () => ({ useUsHalt: () => m.halt, usHaltLabel: () => '停牌' }));

import { snapshotMatchesTradeDate, UsQuoteBoard } from './us-quote-board';
import { usIntradayPath } from './us-intraday';

const aapl = { region: 'US', exchange: 'NASDAQ', code: 'AAPL', name: 'Apple', security_type: 'STK', target_code: null, currency: 'USD', reference: 230, us_reference: '230.10', reference_date: '2026-11-17', limit_up: 0, limit_down: 0 } as unknown as ContractInfo;
let view: ReactTestRenderer | undefined;
const text = () => JSON.stringify(view!.toJSON());

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); m.quote = undefined; m.halt = null; });
afterEach(() => { act(() => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

describe('UsQuoteBoard', () => {
    it('shows the reference price before the first tick', () => {
        act(() => { view = create(createElement(UsQuoteBoard, { contract: aapl })); });
        expect(text()).toContain('230.10');
        expect(text()).toContain('尚無即時報價');
        expect(text()).toContain('2026-11-17');
    });
    it('shows live fields and halt state once quotes arrive', () => {
        m.quote = { tick: { close: '231.45', price_chg: '1.35', pct_chg: '0.59', open: '230', high: '232', low: '229.5', total_volume: 12000 }, bidask: { bid_price: ['231.44'], ask_price: ['231.46'] } };
        m.halt = { scope: 'Symbol' };
        act(() => { view = create(createElement(UsQuoteBoard, { contract: aapl })); });
        expect(text()).toContain('231.45');
        expect(text()).toContain('231.44');
        expect(text()).toContain('231.46');
        expect(text()).toContain('停牌');
        expect(text()).not.toContain('尚無即時報價');
    });
});

describe('UsQuoteBoard extended hours', () => {
    it('shows — for open/high/low before the regular open and the change base as 參考', () => {
        // 盤前 tick 的 price_chg 是 SDK 的一般盤值（0）；漲跌改用成交價 − 當天快照 reference
        m.snap = { tradeDate: '2026-11-19', reference: 352.45, open: 0, high: 0, low: 0, close: 352.46, changePrice: 0.01, changeRate: 0, totalVolume: 1, session: 'PreMarket', lastPrice: null };
        m.quote = { tick: { date: '2026-11-19', close: '354.1244', price_chg: '0', pct_chg: '0', open: '', high: '', low: '', total_volume: 255203 }, bidask: undefined };
        act(() => { view = create(createElement(UsQuoteBoard, { contract: aapl })); });
        const t = text();
        m.snap = null;
        expect(t).toContain('354.1244');
        expect(t).toContain('+1.6744');
        expect(t).toContain('352.45'); // 參考＝快照 reference，與漲跌同一個基準
        expect(t).not.toContain('352.46'); // 不拿最後一筆成交當基準
        expect(t).not.toContain('230.10'); // 不再顯示合約上較舊的參考價
        expect((t.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });
});

describe('snapshotMatchesTradeDate', () => {
    it('uses snapshot open/high/low only for the same US trade date as the tick', () => {
        expect(snapshotMatchesTradeDate({ tradeDate: '2026-11-19' }, '2026-11-19')).toBe(true);
        expect(snapshotMatchesTradeDate({ tradeDate: '2026-11-18' }, '2026-11-19')).toBe(false);
        expect(snapshotMatchesTradeDate({ tradeDate: '' }, '2026-11-19')).toBe(false);
        expect(snapshotMatchesTradeDate({ tradeDate: '2026-11-19' }, undefined)).toBe(false);
    });
});

describe('usIntradayPath', () => {
    it('spans ticks and includes the reference line', () => {
        const t = (ts: number, price: string) => ({ key: 'US:AAPL', price, session: 'Regular' as const, freshness: null, ts, volume: 1 });
        const p = usIntradayPath([t(0, '10'), t(1000, '11')], 10.5)!;
        expect(p.points.split(' ')).toHaveLength(2);
        expect(p.lo).toBe(10);
        expect(p.hi).toBe(11);
        expect(p.refY).not.toBeNull();
        expect(usIntradayPath([], 1)).toBeNull();
    });
});
