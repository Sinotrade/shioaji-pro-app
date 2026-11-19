// 美股走台股同一個五檔元件：只畫最佳一檔、價格與價差照美股位數（1 美元以上 2 位）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../lib/types/contract';

const m = vi.hoisted(() => ({ book: null as unknown, key: '' }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: (key: string) => { m.key = key; return { book: m.book }; } }));

import { DepthLadder } from './depth-ladder';

const aapl = { region: 'US', exchange: 'NASDAQ', code: 'AAPL', security_type: 'STK' } as unknown as ContractBase;
let view: ReactTestRenderer | undefined;
const text = () => JSON.stringify(view!.toJSON());

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); m.book = null; m.key = ''; });
afterEach(() => { act(() => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

describe('DepthLadder (US)', () => {
    it('reads the US:CODE book, draws one row, and prints the spread at 2 decimals', () => {
        m.book = { source: 'stream', time: '13:00:00', bids: [{ price: 348.57, vol: 94 }], asks: [{ price: 348.64, vol: 40 }] };
        act(() => { view = create(createElement(DepthLadder, { code: 'AAPL', contract: aapl })); });
        expect(m.key).toBe('US:AAPL');
        expect(view!.root.findByProps({ 'data-levels': 1 })).toBeTruthy();
        const t = text();
        expect(t).toContain('348.57');
        expect(t).toContain('0.07');
        expect(t).not.toContain('0.0700');
    });
    it('keeps 4 decimals under $1', () => {
        m.book = { source: 'stream', time: '13:00:00', bids: [{ price: 0.5123, vol: 1 }], asks: [{ price: 0.5125, vol: 1 }] };
        act(() => { view = create(createElement(DepthLadder, { code: 'AAPL', contract: aapl })); });
        expect(text()).toContain('0.0002');
    });
});
