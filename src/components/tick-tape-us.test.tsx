// 美股成交明細：歷史與即時訂閱用同一個成交種類（漏斗鈕）；切換時只重抓歷史、不重新訂閱
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../lib/types/contract';

vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
    };
});

const m = vi.hoisted(() => ({ load: vi.fn(), retain: vi.fn(), release: vi.fn(), subscribe: vi.fn() }));
vi.mock('../lib/quote-ownership', () => ({ retainQuote: (...a: unknown[]) => { m.retain(...a); return m.release; } }));
vi.mock('../lib/shioaji', () => ({ fetchLastTicks: vi.fn() }));
vi.mock('../lib/stream', () => ({ onAnyTick: () => () => {} }));
vi.mock('../lib/us/us-quotes', async (orig) => ({ ...(await orig<object>()), subscribeUsSessionTicks: (...a: unknown[]) => { m.subscribe(...a); return () => {}; } }));
vi.mock('../lib/us/us-tape', async (orig) => ({ ...(await orig<object>()), loadUsTapeHistory: m.load }));

import { TickTape } from './tick-tape';
import { setUsTickDetail } from '../lib/us/us-tick-prefs';

const aapl = { region: 'US', exchange: 'NASDAQ', code: 'AAPL', security_type: 'STK', target_code: null } as unknown as ContractBase;

let r: ReactTestRenderer | null = null;
afterEach(() => { act(() => r?.unmount()); r = null; setUsTickDetail('Tick'); vi.clearAllMocks(); });

describe('TickTape (US) history follows the tick-detail setting', () => {
    it('refetches history with the new detail on toggle without re-subscribing live', async () => {
        setUsTickDetail('Tick');
        m.load.mockResolvedValue([]);
        await act(async () => { r = create(createElement(TickTape, { contract: aapl })); });
        expect(m.load).toHaveBeenCalledTimes(1);
        expect(m.load.mock.calls[0]![2]).toBe('Tick');
        expect(m.retain).toHaveBeenCalledTimes(1);
        expect(m.subscribe).toHaveBeenCalledTimes(1);

        await act(async () => { setUsTickDetail('TickFull'); });
        expect(m.load).toHaveBeenCalledTimes(2);
        expect(m.load.mock.calls[1]![2]).toBe('TickFull');
        // 即時訂閱由 stream.ts 改訂；明細不放掉、不重新 retain
        expect(m.retain).toHaveBeenCalledTimes(1);
        expect(m.release).not.toHaveBeenCalled();
        expect(m.subscribe).toHaveBeenCalledTimes(1);
    });
    it('ignores the setting for Taiwan contracts', async () => {
        const tw = { region: 'TW', exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null } as unknown as ContractBase;
        const { fetchLastTicks } = await import('../lib/shioaji');
        vi.mocked(fetchLastTicks).mockResolvedValue({ datetime: [], close: [], volume: [], tick_type: [] } as never);
        await act(async () => { r = create(createElement(TickTape, { contract: tw })); });
        const calls = vi.mocked(fetchLastTicks).mock.calls.length;
        await act(async () => { setUsTickDetail('TickFull'); });
        expect(vi.mocked(fetchLastTicks).mock.calls.length).toBe(calls);
        expect(m.load).not.toHaveBeenCalled();
    });
});
