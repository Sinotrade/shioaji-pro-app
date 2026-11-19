import { describe, expect, it } from 'vitest';
import { usBestLevel, usDepthLevel } from './us-depth';
import { parseUsTicks } from '../lib/us/us-history';
import { mergeUsTape, usTapeDayBreaks, usTapeRowFromMeta, usTapeRowsFromHistory } from './us-tick-tape';

describe('usBestLevel', () => {
    it('reads the single best level and the decimal spread', () => {
        const r = usBestLevel({ bid_price: ['352.39'], bid_volume: [100], ask_price: ['352.41'], ask_volume: [200] });
        expect(r.bid).toEqual({ price: '352.39', vol: 100 });
        expect(r.ask).toEqual({ price: '352.41', vol: 200 });
        expect(Number(r.spread)).toBeCloseTo(0.02);
    });
    it('hides empty sides', () => {
        const r = usBestLevel({ bid_price: ['0'], bid_volume: [0], ask_price: [], ask_volume: [] });
        expect(r).toEqual({ bid: null, ask: null, spread: null });
        expect(usBestLevel(undefined).bid).toBeNull();
    });
});

describe('usDepthLevel', () => {
    const snap = { buyPrice: 354.06, buyVolume: 120, sellPrice: 354.26, sellVolume: 100 };
    it('seeds from the snapshot before any live bidask', () => {
        const r = usDepthLevel(undefined, snap);
        expect(r.source).toBe('snapshot');
        expect(r.bid).toEqual({ price: '354.06', vol: 120 });
        expect(r.ask).toEqual({ price: '354.26', vol: 100 });
        expect(Number(r.spread)).toBeCloseTo(0.2);
        expect(usDepthLevel({ bid_price: [], ask_price: [] }, snap).source).toBe('snapshot');
    });
    it('uses live data as soon as one side is valid, ignoring the snapshot', () => {
        const r = usDepthLevel({ bid_price: ['354.17'], bid_volume: [3], ask_price: [], ask_volume: [] }, snap);
        expect(r.source).toBe('live');
        expect(r.bid).toEqual({ price: '354.17', vol: 3 });
        expect(r.ask).toBeNull();
    });
    it('never falls back to the snapshot once live data was seen for the contract', () => {
        const empty = { bid_price: ['0'], bid_volume: [0], ask_price: ['0'], ask_volume: [0] };
        expect(usDepthLevel(empty, snap, true)).toMatchObject({ bid: null, ask: null, spread: null, source: 'live' });
        expect(usDepthLevel(undefined, snap, true).source).toBe('live');
        expect(usDepthLevel(empty, snap, false).source).toBe('snapshot');
    });
    it('shows empty without live or usable snapshot', () => {
        expect(usDepthLevel(undefined, null)).toMatchObject({ bid: null, ask: null, source: 'live' });
        expect(usDepthLevel(undefined, { buyPrice: 0, buyVolume: 0, sellPrice: null, sellVolume: null })).toMatchObject({ bid: null, ask: null, source: 'live' });
    });
});

describe('ANT IPO snapshot (21391, 2026-11-19)', () => {
    it('seeds a locked 100/100 best level with no spread', () => {
        const r = usDepthLevel(undefined, { buyPrice: 100, buyVolume: 100, sellPrice: 100, sellVolume: 100 });
        expect(r).toMatchObject({ bid: { price: '100', vol: 100 }, ask: { price: '100', vol: 100 }, spread: null, source: 'snapshot' });
    });
});

describe('usTapeDayBreaks', () => {
    it('labels the day where today\'s pre-market rows meet the previous session', () => {
        const rows = [{ date: '2026-11-19' }, { date: '2026-11-19' }, { date: '2026-11-18' }, { date: '2026-11-18' }];
        expect([...usTapeDayBreaks(rows, '2026-11-19')]).toEqual([[2, '2026-11-18']]);
    });
    it('labels the top when nothing is from today', () => {
        expect([...usTapeDayBreaks([{ date: '2026-11-18' }], '2026-11-19')]).toEqual([[0, '2026-11-18']]);
        expect(usTapeDayBreaks([], '2026-11-19').size).toBe(0);
    });
});

describe('usTapeRowsFromHistory', () => {
    it('puts the newest first and caps the rows', () => {
        const ticks = [1, 2, 3].map(i => ({ ts: i, tsUs: i * 1000, time: `09:30:0${i}.000000`, price: 100 + i, volume: i, bid: null, ask: null, tickType: 1, session: 'Regular' as const, oddLot: false }));
        const rows = usTapeRowsFromHistory(ticks, 2);
        expect(rows.map(r => r.price)).toEqual(['103', '102']);
        expect(rows[0]!.time).toBe('09:30:03.000000');
    });
});

describe('mergeUsTape', () => {
    const t0 = Date.UTC(2026, 10, 18, 20, 59, 59);
    const hist = usTapeRowsFromHistory([0, 1, 2].map(i => ({ ts: t0 + i, tsUs: (t0 + i) * 1000, time: `15:59:59.00${i}000`, price: 352 + i / 100, volume: 10 + i, bid: null, ask: null, tickType: 0, session: 'Regular' as const, oddLot: false })));
    it('drops live rows already in history and keeps newer ones on top', () => {
        const dup = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000, volume: 12, tickType: 1 });
        const newer = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.5', session: 'AfterHours', freshness: null, ts: t0 + 5000, tsUs: (t0 + 5000) * 1000 + 7, volume: 3, tickType: 1 });
        const rows = mergeUsTape([newer, dup], hist);
        expect(rows.map(r => r.price)).toEqual(['352.5', '352.02', '352.01', '352']);
        expect(rows[0]!.time).toBe('16:00:04.000007');
    });
    it('keeps a same-price same-volume trade in a different microsecond of the same ms', () => {
        const near = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000 + 800, volume: 12 });
        expect(mergeUsTape([near], hist)).toHaveLength(4);
    });
    it('matches a live trade to history parsed from an imprecise ns JSON number (±1 µs)', () => {
        // 1795012200000016 µs 的 ns 值超過 2^53，JSON.parse 後變成 ...015.9xx µs
        const ns = 1795012200000016000;
        const parsed = parseUsTicks({ ts: [ns], close: [352.05], volume: [8] })!;
        expect(Math.abs(parsed[0]!.tsUs - 1795012200000016)).toBeLessThanOrEqual(1);
        const h = usTapeRowsFromHistory(parsed);
        const live = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.05', session: 'Regular', freshness: null, ts: 1795012200000, tsUs: 1795012200000016, volume: 8 });
        expect(mergeUsTape([live], h)).toHaveLength(1);
        // 差 2 µs 以上是不同成交
        const other = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.05', session: 'Regular', freshness: null, ts: 1795012200000, tsUs: 1795012200000019, volume: 8 });
        expect(mergeUsTape([other], h)).toHaveLength(2);
    });
    it('prefers exact microsecond matches over ±1 µs when live ticks arrive out of order', () => {
        const t = 1795012200000016;
        const mk = (us: number) => ({ ts: Math.floor(us / 1000), tsUs: us, time: '', price: 352.05, volume: 8, bid: null, ask: null, tickType: 0, session: 'Regular' as const, oddLot: false });
        const h = usTapeRowsFromHistory([mk(t), mk(t + 2)]); // 歷史 [t+2, t]
        const live = [t + 1, t + 2].map(us => usTapeRowFromMeta({ key: 'US:AAPL', price: '352.05', session: 'Regular', freshness: null, ts: Math.floor(us / 1000), tsUs: us, volume: 8 }));
        expect(mergeUsTape(live, h)).toHaveLength(2);
    });
    it('shows history time from the same rounded microsecond used for dedupe', () => {
        const parsed = parseUsTicks({ ts: [1795012200000016000], close: [1], volume: [1] })!;
        expect(parsed[0]!.time.endsWith(`.${String(parsed[0]!.tsUs % 1_000_000).padStart(6, '0')}`)).toBe(true);
        expect(parsed[0]!.time).toBe('09:30:00.000016');
    });
    it('keeps a live row that only shares the timestamp', () => {
        const other = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000, volume: 99 });
        expect(mergeUsTape([other], hist)).toHaveLength(4);
    });
});
