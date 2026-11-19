// 美股走台股元件的轉接規則：價格位數、跳動、時段框架、kbars 形狀、快照形狀
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchUsKbars = vi.hoisted(() => vi.fn());
const fetchKbars = vi.hoisted(() => vi.fn());
vi.mock('./us-history', async (orig) => ({ ...(await orig<object>()), fetchUsKbars }));
vi.mock('../shioaji', () => ({ fetchKbars }));

import { fmtUsAvgPrice, fmtUsChange, fmtUsPrice, usPriceDecimals } from './decimal';
import { tickDecimals, tickSizeFor } from '../utils/ticksize';
import {
    isDaySessionLabel,
    isUsChartSession,
    nyWallClockNow,
    pickIntradayWindow,
    sessionKindOf,
    sessionMinutes,
    sessionWindowFor,
    tickBucket,
} from '../intraday-session';
import { fetchChartHistory, usCandlesToKbars } from '../chart-history';
import { aggregate, kbarsToCandles, wallClockToUtc } from '../utils/kbars';
import { usSnapshotToTw } from './us-adapter';
import { displayBook } from '../display-book';
import { drawingSymbolKey } from '../chart-drawings';
import type { ContractBase } from '../types/contract';

const US = { region: 'US', security_type: 'STK', exchange: 'NASDAQ', code: 'AAPL' } as unknown as ContractBase;
const TW = { region: 'TW', security_type: 'STK', exchange: 'TSE', code: '2330' } as unknown as ContractBase;

afterEach(() => { fetchUsKbars.mockReset(); fetchKbars.mockReset(); });

describe('US price display', () => {
    it('2 decimals at $1 and above, 4 below — sub-penny prints are rounded, not lengthened', () => {
        expect(usPriceDecimals('98.083')).toBe(2);
        expect(usPriceDecimals(0.5123)).toBe(4);
        expect(usPriceDecimals(1)).toBe(2);
        expect(fmtUsPrice('98.083')).toBe('98.08');
        expect(fmtUsPrice('98')).toBe('98.00');
        expect(fmtUsPrice(1234.5)).toBe('1,234.50');
        expect(fmtUsPrice('0.51234')).toBe('0.5123');
        expect(fmtUsPrice('0.5')).toBe('0.5000');
        expect(fmtUsPrice(undefined)).toBe('—');
        expect(fmtUsPrice('abc')).toBe('—');
    });
    it('change follows the price it belongs to', () => {
        expect(fmtUsChange('15.083', '98.083')).toBe('15.08');
        expect(fmtUsChange('0.5', '98.08')).toBe('0.50');
        expect(fmtUsChange('-0.0123', '0.51')).toBe('-0.0123');
    });
    it('average/cost keeps up to 4 decimals', () => {
        expect(fmtUsAvgPrice('98.0834')).toBe('98.0834');
        expect(fmtUsAvgPrice('98.1')).toBe('98.10');
    });
    it('US tick size: 0.01 at $1+, 0.0001 below; TW untouched', () => {
        expect(tickSizeFor(US, 98.08)).toBe(0.01);
        expect(tickSizeFor(US, 0.51)).toBe(0.0001);
        expect(tickDecimals(tickSizeFor(US, 600))).toBe(2); // 不像台股 500 以上變 1 元
        expect(tickDecimals(tickSizeFor(US, 0.2))).toBe(4);
        expect(tickSizeFor(TW, 600)).toBe(1);
    });
});

describe('US session kind', () => {
    const at = (s: string) => wallClockToUtc(s);
    it('maps region US to the New York regular session 09:30–16:00', () => {
        expect(sessionKindOf(US)).toBe('US');
        expect(sessionKindOf(TW)).toBe('STK');
        const w = sessionWindowFor('US', at('2026-11-19T07:00:00'));
        expect(w).toEqual({ start: at('2026-11-19T09:30:00'), end: at('2026-11-19T16:00:00'), night: false });
        expect(sessionMinutes(w)).toHaveLength(390);
        // 盤後時間仍屬當天的框架（不會被當成換時段而重載）
        expect(sessionWindowFor('US', at('2026-11-19T18:30:00')).start).toBe(w.start);
    });
    it('labels: first bar 09:31, last 16:00, closing auction prints fold into 16:00', () => {
        expect(isDaySessionLabel('US', at('2026-11-19T09:31:00'))).toBe(true);
        expect(isDaySessionLabel('US', at('2026-11-19T09:30:00'))).toBe(false);
        expect(isDaySessionLabel('US', at('2026-11-19T16:00:00'))).toBe(true);
        const w = sessionWindowFor('US', at('2026-11-19T12:00:00'));
        expect(tickBucket(w, at('2026-11-19T16:00:02'))).toBe(w.end);
    });
    it('picks the last session that has data (pre-market keeps showing yesterday)', () => {
        const times = [at('2026-11-18T15:59:00'), at('2026-11-18T16:00:00')];
        const w = pickIntradayWindow('US', times, 'auto', at('2026-11-19T07:00:00'));
        expect(w.start).toBe(at('2026-11-18T09:30:00'));
    });
    it('only regular and closing prints enter the intraday chart', () => {
        expect(isUsChartSession('Regular')).toBe(true);
        expect(isUsChartSession('AfterHours')).toBe(true);
        expect(isUsChartSession('PreMarket')).toBe(false);
        expect(isUsChartSession(undefined)).toBe(false);
    });
    it('New York wall clock handles EST and EDT', () => {
        expect(nyWallClockNow(Date.UTC(2026, 10, 19, 18, 0, 0))).toBe(at('2026-11-19T13:00:00')); // EST −5
        expect(nyWallClockNow(Date.UTC(2026, 6, 1, 18, 0, 0))).toBe(at('2026-07-01T14:00:00')); // EDT −4
    });
});

describe('chart history adapter', () => {
    it('US 1-min candles round-trip through the TW kbars shape', () => {
        const bars = [
            { time: wallClockToUtc('2026-11-19T09:31:00'), open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
            { time: wallClockToUtc('2026-11-19T09:32:00'), open: 10.5, high: 12, low: 10, close: 11, volume: 50 },
        ];
        const k = usCandlesToKbars(bars);
        expect(k.datetime).toEqual(['2026-11-19T09:31:00', '2026-11-19T09:32:00']);
        expect(kbarsToCandles(k)).toEqual(bars);
        expect(k.Amount[0]).toBeCloseTo(((11 + 9 + 10.5) / 3) * 100);
        // 5 分 K 聚合沿用 close-label-right：09:31、09:32 都在 09:35 那根
        expect(aggregate(kbarsToCandles(k), 5)[0]!.time).toBe(wallClockToUtc('2026-11-19T09:35:00'));
    });
    it('routes US contracts to the US kbars API and TW to the TW one', async () => {
        fetchUsKbars.mockResolvedValue([{ time: wallClockToUtc('2026-11-19T09:31:00'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
        fetchKbars.mockResolvedValue({ datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] });
        const us = await fetchChartHistory(US, '2026-07-01', '2026-11-19', { revision: 9001 });
        expect(fetchUsKbars).toHaveBeenCalledWith(US, '2026-07-01', '2026-11-19', expect.anything());
        expect(us.datetime).toEqual(['2026-11-19T09:31:00']);
        await fetchChartHistory(TW, '2026-11-18', '2026-11-19', { revision: 9001 });
        expect(fetchKbars).toHaveBeenCalledTimes(1);
        expect(fetchUsKbars).toHaveBeenCalledTimes(1);
    });
});

describe('US snapshot adapter', () => {
    const snap = {
        code: 'AAPL', exchange: 'NASDAQ', ts: Date.UTC(2026, 10, 19, 18, 0, 0), tradeDate: '2026-11-19',
        open: 1, high: 2, low: 0.5, close: 1.5, reference: 1.2, changePrice: 0.3, changeRate: 25,
        totalVolume: 900, buyPrice: 1.49, sellPrice: 1.51, buyVolume: 10, sellVolume: 20, session: 'Regular' as const, lastPrice: 1.5,
    };
    it('keys the snapshot by US:CODE with a New York wall-clock time', () => {
        const s = usSnapshotToTw(snap);
        expect(s.code).toBe('US:AAPL');
        expect(s.datetime).toBe('2026-11-19T13:00:00');
        expect([s.buy_price, s.sell_price, s.total_volume, s.change_price]).toEqual([1.49, 1.51, 900, 0.3]);
    });
    it('feeds the depth ladder one level; a newer live bidask wins', () => {
        const s = usSnapshotToTw(snap);
        const seeded = displayBook('US:AAPL', s, undefined)!;
        expect(seeded.source).toBe('snapshot');
        expect(seeded.bids).toEqual([{ price: 1.49, vol: 10 }]);
        const live = displayBook('US:AAPL', s, {
            code: 'US:AAPL', date: '2026-11-19', time: '13:00:05', bid_price: ['1.5'], bid_volume: [3], ask_price: ['1.52'], ask_volume: [4], intraday_odd: false, simtrade: false,
        } as never)!;
        expect(live.source).toBe('stream');
        expect(live.asks).toEqual([{ price: 1.52, vol: 4 }]);
    });
});

describe('drawings', () => {
    it('stores US drawings apart from TW codes', () => {
        expect(drawingSymbolKey({ code: 'aapl', security_type: 'STK', region: 'US' }, true)).toBe('US:AAPL');
        expect(drawingSymbolKey({ code: '2330', security_type: 'STK' }, true)).toBe('2330');
    });
});
