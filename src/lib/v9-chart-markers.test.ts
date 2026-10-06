// src/lib/v9-chart-markers.test.ts — 選股進場 marker builder 單測（多方＋空方）
import { describe, expect, it } from 'vitest';
import {
    entrySignalsToMarkers,
    shortSignalsToMarkers,
} from './utils/v9-chart-markers';
import type { Candle } from './types/market';

const baseDay = Date.UTC(2026, 0, 1) / 1000;
const d3 = baseDay + 3 * 86400;
const sig = [{ time: d3, level: 105 }];
const shortSig = [{ time: d3, level: 95 }];

function bar(sec: number, c: number): Candle {
    return { time: sec, open: c, high: c, low: c, close: c, volume: 1 };
}

describe('entrySignalsToMarkers（多方）', () => {
    it('日 K：標在信號日、金色向上、在 K 棒下方', () => {
        const m = entrySignalsToMarkers(sig, [], 1440);
        expect(m.length).toBe(1);
        expect(m[0]!.time).toBe(d3);
        expect(m[0]!.position).toBe('belowBar');
        expect(m[0]!.shape).toBe('arrowUp');
        expect(m[0]!.color).toBe('#f5c451');
        expect(m[0]!.text).toBe('日K多確認');
        expect(m[0]!.group).toBe('entry');
    });

    it('分 K：盤中越過 level 不會被事後日 K 信號回投，標記留在日盤確認棒', () => {
        const close = d3 + 13.5 * 3600;
        const bars = [bar(d3 + 9 * 3600 + 60, 105.5), bar(close, 106)];
        expect(entrySignalsToMarkers(sig, bars, 1, 'STK', close)[0]!.time).toBe(close);
    });

    it('分 K：沒有確認時間的已收棒，不會退而標在更早一根', () => {
        const bars = [bar(d3 + 9 * 3600 + 60, 100), bar(d3 + 12 * 3600, 106)];
        expect(entrySignalsToMarkers(sig, bars, 1)).toEqual([]);
    });

    it('即時與回放：日盤未收盤不能顯示日 K 確認，即使未來資料已載入', () => {
        const close = d3 + 13.5 * 3600;
        const bars = [bar(close, 106), bar(d3 + 86400 + 9 * 3600, 107)];
        expect(entrySignalsToMarkers(sig, bars, 1, 'STK', close - 1)).toEqual([]);
        expect(entrySignalsToMarkers(sig, [], 1440, 'STK', close - 1)).toEqual([]);
        expect(entrySignalsToMarkers(sig, [], 1440, 'STK', close)).toHaveLength(1);
    });

    it('期貨日 K：在交易日期當日13:45確認，不等到次日05:00', () => {
        const close = d3 + 13.75 * 3600;
        const bars = [bar(d3 + 5 * 3600, 106), bar(close, 107)];
        expect(entrySignalsToMarkers(sig, bars, 5, 'FUT', close - 1)).toEqual([]);
        expect(entrySignalsToMarkers(sig, bars, 5, 'FUT', close)[0]!.time).toBe(close);
    });

    it('分 K：不把很久以前的日 K 結果貼到新視窗第一根無關棒', () => {
        expect(entrySignalsToMarkers(sig, [bar(d3 + 7 * 86400 + 9 * 3600, 106)], 1)).toEqual([]);
    });

    it('分 K：當日無 K 棒就不標', () => {
        expect(entrySignalsToMarkers(sig, [], 1).length).toBe(0);
    });
});

describe('shortSignalsToMarkers（空方）', () => {
    it('日 K：標在信號日、金色向下、在 K 棒上方', () => {
        const m = shortSignalsToMarkers(shortSig, [], 1440);
        expect(m.length).toBe(1);
        expect(m[0]!.time).toBe(d3);
        expect(m[0]!.position).toBe('aboveBar');
        expect(m[0]!.shape).toBe('arrowDown');
        expect(m[0]!.color).toBe('#f5c451');
        expect(m[0]!.text).toBe('日K空確認');
        expect(m[0]!.group).toBe('shortEntry');
    });

    it('分 K：不回投首次跌破棒，只標日盤確認時點', () => {
        const close = d3 + 13.5 * 3600;
        const bars = [bar(d3 + 9 * 3600 + 60, 94.5), bar(close, 93)];
        expect(shortSignalsToMarkers(shortSig, bars, 1, 'STK', close)[0]!.time).toBe(close);
    });

    it('分 K：確認棒缺失就不標，不fallback到盤中最後棒', () => {
        const bars = [bar(d3 + 9 * 3600 + 60, 100), bar(d3 + 12 * 3600, 94)];
        expect(shortSignalsToMarkers(shortSig, bars, 1)).toEqual([]);
    });

    it('回放時日 K 空訊號在收盤前不可见', () => {
        const close = d3 + 13.5 * 3600;
        expect(shortSignalsToMarkers(shortSig, [bar(close, 94)], 1, 'STK', close - 1)).toEqual([]);
        expect(shortSignalsToMarkers(shortSig, [], 1440, 'STK', close - 1)).toEqual([]);
    });

    it('分 K：當日無 K 棒就不標', () => {
        expect(shortSignalsToMarkers(shortSig, [], 1).length).toBe(0);
    });
});
