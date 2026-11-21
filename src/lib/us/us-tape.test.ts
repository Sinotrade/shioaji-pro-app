// 成交明細的美股資料轉接（lib/us/us-tape）：歷史／即時列、去重、跨日分隔
import { describe, expect, it } from 'vitest';
import { parseUsTicks } from './us-history';
import { mergeUsTape, usTapeDayBreaks, usTapeRowFromMeta, usTapeRowsFromHistory } from './us-tape';

const MAX = 120;

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
        expect(rows.map(r => r.close)).toEqual(['103', '102']);
        expect(rows[0]!.time).toBe('09:30:03.000000');
    });
});

describe('mergeUsTape', () => {
    const t0 = Date.UTC(2026, 10, 18, 20, 59, 59);
    const hist = usTapeRowsFromHistory([0, 1, 2].map(i => ({ ts: t0 + i, tsUs: (t0 + i) * 1000, time: `15:59:59.00${i}000`, price: 352 + i / 100, volume: 10 + i, bid: null, ask: null, tickType: 0, session: 'Regular' as const, oddLot: false })), MAX);
    it('drops live rows already in history and keeps newer ones on top', () => {
        const dup = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000, volume: 12, tickType: 1 });
        const newer = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.5', session: 'AfterHours', freshness: null, ts: t0 + 5000, tsUs: (t0 + 5000) * 1000 + 7, volume: 3, tickType: 1 });
        const rows = mergeUsTape([newer, dup], hist, MAX);
        expect(rows.map(r => r.close)).toEqual(['352.5', '352.02', '352.01', '352']);
        expect(rows[0]!.time).toBe('16:00:04.000007');
    });
    it('keeps a same-price same-volume trade in a different microsecond of the same ms', () => {
        const near = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000 + 800, volume: 12 });
        expect(mergeUsTape([near], hist, MAX)).toHaveLength(4);
    });
    it('matches a live trade to history parsed from an imprecise ns JSON number (±1 µs)', () => {
        // 1795012200000016 µs 的 ns 值超過 2^53，JSON.parse 後變成 ...015.9xx µs
        const ns = 1795012200000016000;
        const parsed = parseUsTicks({ ts: [ns], close: [352.05], volume: [8] })!;
        expect(Math.abs(parsed[0]!.tsUs - 1795012200000016)).toBeLessThanOrEqual(1);
        const h = usTapeRowsFromHistory(parsed, MAX);
        const live = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.05', session: 'Regular', freshness: null, ts: 1795012200000, tsUs: 1795012200000016, volume: 8 });
        expect(mergeUsTape([live], h, MAX)).toHaveLength(1);
        // 差 2 µs 以上是不同成交
        const other = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.05', session: 'Regular', freshness: null, ts: 1795012200000, tsUs: 1795012200000019, volume: 8 });
        expect(mergeUsTape([other], h, MAX)).toHaveLength(2);
    });
    it('prefers exact microsecond matches over ±1 µs when live ticks arrive out of order', () => {
        const t = 1795012200000016;
        const mk = (us: number) => ({ ts: Math.floor(us / 1000), tsUs: us, time: '', price: 352.05, volume: 8, bid: null, ask: null, tickType: 0, session: 'Regular' as const, oddLot: false });
        const h = usTapeRowsFromHistory([mk(t), mk(t + 2)], MAX); // 歷史 [t+2, t]
        const live = [t + 1, t + 2].map(us => usTapeRowFromMeta({ key: 'US:AAPL', price: '352.05', session: 'Regular', freshness: null, ts: Math.floor(us / 1000), tsUs: us, volume: 8 }));
        expect(mergeUsTape(live, h, MAX)).toHaveLength(2);
    });
    it('shows history time from the same rounded microsecond used for dedupe', () => {
        const parsed = parseUsTicks({ ts: [1795012200000016000], close: [1], volume: [1] })!;
        expect(parsed[0]!.time.endsWith(`.${String(parsed[0]!.tsUs % 1_000_000).padStart(6, '0')}`)).toBe(true);
        expect(parsed[0]!.time).toBe('09:30:00.000016');
    });
    it('keeps a live row that only shares the timestamp', () => {
        const other = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000, volume: 99 });
        expect(mergeUsTape([other], hist, MAX)).toHaveLength(4);
    });
});
