import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const m = vi.hoisted(() => ({ quote: undefined as unknown, halt: null as unknown }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => m.quote }));
vi.mock('../lib/us/us-halts', () => ({ useUsHalt: () => m.halt, usHaltLabel: () => '停牌' }));

import { UsQuoteBoard } from './us-quote-board';
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
