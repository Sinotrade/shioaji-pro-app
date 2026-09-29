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
        expect(m[0]!.text).toBe('強勢上車');
        expect(m[0]!.group).toBe('entry');
    });

    it('分 K：標在當日首次收盤越過 level 那根', () => {
        const bars = [bar(d3 + 60, 101), bar(d3 + 120, 105.5), bar(d3 + 180, 106)];
        expect(entrySignalsToMarkers(sig, bars, 1)[0]!.time).toBe(d3 + 120);
    });

    it('分 K：當日沒越過就標最後一根', () => {
        const bars = [bar(d3 + 60, 100), bar(d3 + 120, 102)];
        expect(entrySignalsToMarkers(sig, bars, 1)[0]!.time).toBe(d3 + 120);
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
        expect(m[0]!.text).toBe('弱勢放空');
        expect(m[0]!.group).toBe('shortEntry');
    });

    it('分 K：標在當日首次收盤跌破 level 那根', () => {
        const bars = [bar(d3 + 60, 99), bar(d3 + 120, 94.5), bar(d3 + 180, 93)];
        expect(shortSignalsToMarkers(shortSig, bars, 1)[0]!.time).toBe(d3 + 120);
    });

    it('分 K：當日沒跌破就標最後一根', () => {
        const bars = [bar(d3 + 60, 100), bar(d3 + 120, 98)];
        expect(shortSignalsToMarkers(shortSig, bars, 1)[0]!.time).toBe(d3 + 120);
    });

    it('分 K：當日無 K 棒就不標', () => {
        expect(shortSignalsToMarkers(shortSig, [], 1).length).toBe(0);
    });
});
