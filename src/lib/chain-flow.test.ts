import { describe, expect, it } from 'vitest';
import {
    codePct,
    FlowBook,
    groupFlow,
    leaders,
    marketSeconds,
    memberFlows,
    barSlot,
    minuteSlot,
    normDate,
    parseKbarEvent,
    SESSION_SLOTS,
    sessionTurnover,
    shareShift,
    slotLabel,
    type KBarEvent,
} from './chain-flow';

const DATE = '2026-10-21';
const bar = (code: string, slot: number, close: number, amount: number): KBarEvent => ({
    code,
    date: DATE,
    slot,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    amount,
});

describe('minute slots', () => {
    it('maps the bar start time onto 09:00–13:30', () => {
        expect(minuteSlot('09:00:00.000000')).toBe(0);
        expect(minuteSlot('10:42:00')).toBe(102);
        expect(minuteSlot('13:30')).toBe(SESSION_SLOTS - 1);
        expect(minuteSlot('08:59:00')).toBeNull();
        expect(minuteSlot('13:31:00')).toBeNull();
        expect(minuteSlot('')).toBeNull();
        expect(slotLabel(102)).toBe('10:42');
    });

    it('maps the stream bar label (minute end) onto the minute it closes', () => {
        // the 09:00–09:01 bar is stamped 09:01:00
        expect(barSlot('09:01:00.000000')).toBe(0);
        expect(barSlot('10:43:00')).toBe(102);
        expect(barSlot('13:30:00')).toBe(SESSION_SLOTS - 2);
        // the closing auction may be stamped after 13:30: it folds into the 13:30 slot
        expect(barSlot('13:31:00')).toBe(SESSION_SLOTS - 1);
        expect(barSlot('13:34:00')).toBe(SESSION_SLOTS - 1);
        expect(barSlot('13:35:00')).toBeNull();
        expect(barSlot('09:00:00')).toBeNull();
        expect(barSlot('')).toBeNull();
        expect(normDate('2026/10/21')).toBe(DATE);
    });
});

describe('parseKbarEvent', () => {
    it('reads the documented 1-minute bar (string numbers too)', () => {
        const rows = parseKbarEvent(
            JSON.stringify({
                code: '2330',
                date: '2026/10/21',
                time: '09:31:00.000000',
                open: '1000',
                high: 1005,
                low: 999,
                close: '1004',
                volume: 120,
                amount: '120480000',
                tick_count: 33,
            }),
        );
        expect(rows).toEqual([
            { code: '2330', date: DATE, slot: 30, open: 1000, high: 1005, low: 999, close: 1004, volume: 120, amount: 120480000 },
        ]);
    });

    it('accepts arrays and wrapped batches, drops rows it cannot place', () => {
        const rows = parseKbarEvent({
            date: '2026/10/21',
            rows: [
                { code: '2330', time: '09:01:00', close: 1000, amount: 1 },
                { code: '2317', datetime: '2026-10-21 09:02:00', close: 200, amount: 2 },
                { code: '2454', time: '14:00:00', close: 1, amount: 1 },
                { code: '1101', time: '09:03:00', close: 0, amount: 1 },
                { time: '09:03:00', close: 1, amount: 1 },
            ],
        });
        expect(rows.map((r) => [r.code, r.slot, r.date])).toEqual([
            ['2330', 0, DATE],
            ['2317', 1, DATE],
        ]);
        expect(parseKbarEvent('not json')).toEqual([]);
        expect(parseKbarEvent([{ code: '2330', time: '09:05:00', close: 1, amount: 5 }])[0]?.slot).toBe(4);
    });
});

describe('FlowBook', () => {
    it('signs each bar by its close versus the previous close (first bar versus the reference)', () => {
        const book = new FlowBook();
        book.seed('A', { ref: 100, close: 100, totalAmount: 0, shares: null, slot: 0 });
        book.addBar(bar('A', 0, 101, 10));
        book.addBar(bar('A', 1, 100, 20));
        book.addBar(bar('A', 2, 100, 30));
        const flow = book.codes.get('A')!;
        expect([flow.net[0], flow.net[1], flow.net[2]]).toEqual([10, -20, 0]);
        expect(flow.last).toBe(100);
    });

    it('recomputes neighbours when a bar arrives out of order or the baseline comes late', () => {
        const book = new FlowBook();
        book.addBar(bar('A', 5, 102, 10));
        expect(book.codes.get('A')!.net[5]).toBe(0); // no baseline yet
        book.seed('A', { ref: 100, close: 101, totalAmount: 0, shares: null, slot: 5 });
        expect(book.codes.get('A')!.net[5]).toBe(10); // above the snapshot price
        book.addBar(bar('A', 3, 103, 7)); // earlier bar: slot 5 now compares with 103
        const flow = book.codes.get('A')!;
        expect(flow.net[3]).toBe(0); // before the snapshot, mid-session: direction unknown
        expect(flow.net[5]).toBe(-10);
        expect(flow.last).toBe(102); // an older bar never moves the price back
        expect([book.firstSlot, book.lastSlot]).toEqual([3, 5]);
    });

    it("takes the first bar's direction from the snapshot price, not from yesterday's close", () => {
        const book = new FlowBook();
        // opened mid-session: up 5 % on the day but the minute itself fell
        book.seed('A', { ref: 100, close: 105.5, totalAmount: 0, shares: null, slot: 41 });
        book.addBar(bar('A', 41, 105, 20));
        expect(book.codes.get('A')!.net[41]).toBe(-20);
        // only the 09:00 bar compares with the reference
        book.addBar(bar('B', 0, 101, 5));
        book.seed('B', { ref: 100, close: null, totalAmount: 0, shares: null, slot: 0 });
        expect(book.codes.get('B')!.net[0]).toBe(5);
        // no baseline at all mid-session: unknown, not guessed from the reference
        book.addBar(bar('C', 60, 101, 5));
        book.seed('C', { ref: 100, close: null, totalAmount: 0, shares: null, slot: 0 });
        expect(book.codes.get('C')!.net[60]).toBe(0);
    });

    it('rolls to a new trading day and ignores ticks for unknown codes', () => {
        const book = new FlowBook();
        book.addBar(bar('A', 1, 10, 1));
        book.addBar({ ...bar('B', 1, 10, 1), date: '2026-10-22' });
        expect(book.date).toBe('2026-10-22');
        expect([...book.codes.keys()]).toEqual(['B']);
        book.tick('Z', 10, 1);
        expect(book.codes.has('Z')).toBe(false);
        book.tick('B', 11, 500);
        expect(book.codes.get('B')!.last).toBe(11);
        expect(book.codes.get('B')!.tickAmount).toBe(500);
    });

    it('a delayed bar never replaces a newer tick price; a newer bar does', () => {
        const book = new FlowBook();
        book.addBar(bar('A', 40, 100, 1));
        book.tick('A', 103, null, marketSeconds('09:42:30'));
        book.addBar(bar('A', 41, 102, 1)); // closes 09:42:00, older than the tick
        expect(book.codes.get('A')!.last).toBe(103);
        book.addBar(bar('A', 42, 104, 1)); // closes 09:43:00
        expect(book.codes.get('A')!.last).toBe(104);
        // a tick without a time is taken as newest
        book.tick('A', 105, null);
        expect(book.codes.get('A')!.last).toBe(105);
    });

    it('never overcounts the snapshot minute: it counts as covered by the seed', () => {
        const book = new FlowBook();
        // snapshot taken during minute 30 (slot: 31 covers it); all of minute
        // 30 may have traded before the snapshot, so its bar adds nothing
        book.seed('A', { ref: 10, close: 10, totalAmount: 1000, shares: null, slot: 31 });
        book.addBar(bar('A', 30, 10, 400));
        book.addBar(bar('A', 31, 10, 50));
        expect(sessionTurnover(book.codes.get('A')!)).toBe(1050);
    });

    it('session turnover = seed (before the panel opened) + bars after it, never below a tick total', () => {
        const book = new FlowBook();
        book.seed('A', { ref: 10, close: 10, totalAmount: 1000, shares: null, slot: 30 });
        book.addBar(bar('A', 30, 10, 50));
        book.addBar(bar('A', 31, 10, 50));
        expect(sessionTurnover(book.codes.get('A')!)).toBe(1100);
        book.tick('A', 10, 5000);
        expect(sessionTurnover(book.codes.get('A')!)).toBe(5000);
        expect(codePct(book.codes.get('A'))).toBe(0);
    });
});

describe('groupFlow', () => {
    function book20() {
        const book = new FlowBook();
        for (const code of ['A', 'B']) book.seed(code, { ref: 100, close: 100, totalAmount: 0, shares: null, slot: 0 });
        book.setShares('A', 3);
        book.setShares('B', 1);
        // 20 quiet minutes, then A surges with inflow for 5 minutes
        for (let s = 0; s < 20; s += 1) {
            book.addBar(bar('A', s, s % 2 ? 100 : 100.5, 10));
            book.addBar(bar('B', s, s % 2 ? 100 : 99.5, 10));
        }
        for (let s = 20; s < 25; s += 1) {
            book.addBar(bar('A', s, 101 + s, 100));
            book.addBar(bar('B', s, 99, 10));
        }
        return book;
    }

    it('sums turnover and net per minute and over the last five minutes', () => {
        const book = book20();
        const g = groupFlow(book, ['A', 'B']);
        expect(g.count).toBe(2);
        expect(g.turnover[24]).toBe(110);
        expect(g.flow5).toBe(490); // A +100 × 5, B −10 once (100 → 99), then flat
        expect(g.turnover5).toBe(550);
        expect(g.cumNet[24]).toBe(g.net.reduce((a, b) => a + b, 0));
        expect(g.total).toBe(20 * 20 + 550);
    });

    it('量能倍數 compares the last five minutes with the session average', () => {
        const g = groupFlow(book20(), ['A', 'B']);
        // total 950 over 25 minutes = 38 / min; last five = 550 → 550 / 190
        expect(g.accel).toBeCloseTo(550 / 190, 6);
        const early = new FlowBook();
        early.addBar(bar('A', 3, 10, 10));
        expect(groupFlow(early, ['A']).accel).toBeNull();
    });

    it('weights the change by previous-close market cap and counts breadth', () => {
        const g = groupFlow(book20(), ['A', 'B', 'missing']);
        const pa = ((125 - 100) / 100) * 100;
        const pb = -1;
        expect(g.pct).toBeCloseTo((3 * pa + pb) / 4, 6);
        expect(g.breadth).toEqual({ up: 1, flat: 0, down: 1 });
        expect(g.count).toBe(3);
    });

    it('leaders rank by absolute 5-minute flow', () => {
        const book = book20();
        book.seed('C', { ref: 50, close: 50, totalAmount: 0, shares: null, slot: 0 });
        for (let s = 20; s < 25; s += 1) book.addBar(bar('C', s, 49 - s / 10, 300));
        const top = leaders(book, ['A', 'B', 'C'], 2);
        expect(top.map((l) => [l.code, l.flow5])).toEqual([
            ['C', -1500],
            ['A', 500],
        ]);
    });

    it('member flows sum each code over the window and skip idle codes', () => {
        const book = book20();
        book.seed('C', { ref: 50, close: 50, totalAmount: 0, shares: null, slot: 0 });
        for (let s = 20; s < 25; s += 1) book.addBar(bar('C', s, 49 - s / 10, 300));
        book.seed('D', { ref: 10, close: 10, totalAmount: 0, shares: null, slot: 0 });
        const now = book.lastSlot!;
        const recent = memberFlows(book, ['A', 'C', 'D', 'missing'], 5);
        expect(recent.map((m) => m.code)).toEqual(['A', 'C']);
        expect(recent.find((m) => m.code === 'C')).toMatchObject({ net: -1500, turnover: 1500 });
        const all = memberFlows(book, ['A'], null);
        const a = book.codes.get('A')!;
        let turnover = 0;
        for (let s = 0; s <= now; s += 1) turnover += a.amount[s]!;
        expect(all[0]!.turnover).toBe(turnover);
        expect(memberFlows(new FlowBook(), ['A'], 5)).toEqual([]);
    });

    it('stays fast for the whole universe (800 codes × 271 minutes)', () => {
        const book = new FlowBook();
        const codes = Array.from({ length: 800 }, (_, i) => String(1000 + i));
        for (const code of codes) {
            book.seed(code, { ref: 100, close: 100, totalAmount: 1e6, shares: 1e6, slot: 0 });
            for (let s = 0; s < SESSION_SLOTS; s += 1) book.addBar(bar(code, s, 100 + Math.sin(s + Number(code)), 1e4));
        }
        const start = performance.now();
        for (let i = 0; i < 37; i += 1) groupFlow(book, codes.slice(i * 20, i * 20 + 60));
        groupFlow(book, codes);
        expect(performance.now() - start).toBeLessThan(250);
    });
});

describe('shareShift', () => {
    it('reports percentage-point moves of recent turnover share between stages', () => {
        const book = new FlowBook();
        for (let s = 0; s < 30; s += 1) {
            book.addBar(bar('UP', s, 10, s < 15 ? 30 : 10));
            book.addBar(bar('DN', s, 10, s < 15 ? 10 : 30));
        }
        const shifts = shareShift([groupFlow(book, ['UP']), groupFlow(book, ['DN'])], 29, 15);
        expect(shifts[0]).toBeCloseTo(-25, 6);
        expect(shifts[1]).toBeCloseTo(25, 6);
        expect(shareShift([groupFlow(book, ['UP'])], null)).toEqual([0]);
    });
});
