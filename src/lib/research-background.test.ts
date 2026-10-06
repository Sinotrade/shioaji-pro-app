import { describe, expect, it } from 'vitest';
import { createResearchBackgroundStore, researchBackgroundKey } from './research-background';
import { v9Resonance } from './utils/research-chart';
import type { Candle } from './types/market';

const stock = { security_type: 'STK', exchange: 'TSE', code: '2330', target_code: null } as const;
const t = (value: string) => Date.parse(`${value}Z`) / 1000;
const bar = (time: number, close = 100, volume = 1): Candle => ({ time, open: close, high: close, low: close, close, volume });

describe('view-independent research background', () => {
    it('keeps the wider minute set when a short chart range arrives and deduplicates volume', () => {
        const store = createResearchBackgroundStore();
        const key = researchBackgroundKey(stock, 'test');
        const full = Array.from({ length: 800 }, (_, i) => bar(t('2026-10-01T09:01:00') + i * 60));
        store.mergeMinutes(key, full);
        const before = v9Resonance(store.get(key).minutes, 'STK');
        store.mergeMinutes(key, full.slice(-100));
        expect(store.get(key).minutes).toHaveLength(800);
        expect(store.get(key).minutes.reduce((sum, candle) => sum + candle.volume, 0)).toBe(800);
        expect(v9Resonance(store.get(key).minutes, 'STK')).toEqual(before);
    });
    it('isolates symbols, security classes, actual months and API sources', () => {
        const keys = [stock, { ...stock, code: '2409' }, { ...stock, security_type: 'FUT' as const },
            { ...stock, target_code: 'TXFJ6' }, { ...stock, target_code: 'TXFK6' }].map(c => researchBackgroundKey(c, 'A'));
        keys.push(researchBackgroundKey(stock, 'B'));
        expect(new Set(keys).size).toBe(keys.length);
        const store = createResearchBackgroundStore();
        store.mergeMinutes(keys[0]!, [bar(60)]);
        for (const key of keys.slice(1)) expect(store.get(key).minutes).toEqual([]);
    });
    it('rejects a late old history response without dropping its older non-overlap rows', () => {
        const store = createResearchBackgroundStore();
        const oldRequest = store.nextRevision();
        const newerRequest = store.nextRevision();
        store.mergeMinutes('A', [bar(120, 102, 8)], newerRequest);
        store.mergeMinutes('A', [bar(60, 100, 1), bar(120, 101, 3)], oldRequest);
        expect(store.get('A').minutes).toEqual([bar(60, 100, 1), bar(120, 102, 8)]);
    });
    it('makes owned copies and emits only changed snapshots', () => {
        const store = createResearchBackgroundStore();
        let events = 0;
        const stop = store.subscribe('A', () => events++);
        const incoming = [bar(60)];
        store.mergeMinutes('A', incoming);
        const snapshot = store.get('A');
        incoming[0]!.close = 999;
        expect(store.get('A').minutes[0]!.close).toBe(100);
        store.mergeMinutes('A', [bar(60)]);
        expect(store.get('A')).toBe(snapshot);
        expect(events).toBe(1);
        stop(); store.mergeMinutes('A', [bar(120)]); expect(events).toBe(1);
    });
    it('does not let low-priority daily hydration erase newer confirmed daily data', () => {
        const store = createResearchBackgroundStore();
        store.replaceDaily('A', [bar(86400)], 2);
        store.replaceDaily('A', [], 0);
        expect(store.get('A').daily).toEqual([bar(86400)]);
    });
    it('uses only confirmed daily cache and cuts it at replay time without future leakage', () => {
        const store = createResearchBackgroundStore();
        const dates = Array.from({ length: 120 }, (_, i) => bar(t('2026-05-01T00:00:00') + i * 86400));
        store.replaceDaily('A', dates);
        const now = dates[117]!.time + 12 * 3600; // this day's 13:30 confirmation is still future
        const frames = v9Resonance([], 'STK', now, store.get('A').daily).frames;
        expect(frames.at(-1)).toMatchObject({ bars: 117, side: 'neutral' });
        const changedFuture = dates.map(c => c.time >= dates[117]!.time ? bar(c.time, 9999) : c);
        expect(v9Resonance([], 'STK', now, changedFuture).frames).toEqual(frames);
        expect(v9Resonance(dates, 'STK', Infinity, []).frames.at(-1)).toMatchObject({ bars: 0, side: 'insufficient' });
    });
    it('bounds memory, sorts history and rejects invalid OHLCV without fabricating gaps', () => {
        const store = createResearchBackgroundStore(3, 2);
        store.mergeMinutes('A', [bar(300), bar(60), bar(180), bar(120), { ...bar(240), volume: -1 }]);
        expect(store.get('A').minutes.map(c => c.time)).toEqual([120, 180, 300]);
        store.mergeMinutes('B', [bar(60)]); store.mergeMinutes('C', [bar(60)]);
        expect(store.get('A').minutes).toEqual([]);
    });
});
