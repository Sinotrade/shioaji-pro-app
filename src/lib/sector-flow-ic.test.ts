import { describe, expect, it } from 'vitest';
import { IcFlowRecorder, icKeyOf, icSlot } from './sector-flow-ic';

const D = '2026-10-22';
const at = (hhmmss: string) => `${D}T${hhmmss}.123456+08:00`;
const row = (category: string, value: number, item_count = 10) => ({ category, item_count, value });

describe('icKeyOf / icSlot', () => {
    it('maps a card to its index_components group', () => {
        expect(icKeyOf('twse', '24')).toBe('IX0001:24');
        expect(icKeyOf('tpex', '03')).toBe('IX0043:3');
        expect(icKeyOf('emerging', '24')).toBeNull();
        expect(icKeyOf('twse', null)).toBeNull();
        expect(icKeyOf('twse', 'x')).toBeNull();
    });

    it('turns calculated_at into the Taipei minute slot', () => {
        expect(icSlot(at('09:00:30'))).toBe(0);
        expect(icSlot('2026-10-22T02:42:05Z')).toBe(102); // 10:42 Taipei
        expect(icSlot(at('13:30:00'))).toBe(270);
        expect(icSlot(at('13:33:10'))).toBe(270); // closing auction stamp
        expect(icSlot(at('13:40:00'))).toBeNull();
        expect(icSlot(at('08:59:59'))).toBeNull();
        expect(icSlot(undefined)).toBeNull();
    });
});

describe('IcFlowRecorder', () => {
    it('rebuilds minute turnover from cumulative amounts and signs it by the weighted change', () => {
        const r = new IcFlowRecorder();
        // panel opens at 10:00 (slot 60): baseline, no turnover for the gap before
        r.sampleAmount('IX0001', D, 60, [row('24', 1000)]);
        r.samplePerf('IX0001', D, 60, [row('24', 1.0)]);
        r.sampleAmount('IX0001', D, 60, [row('24', 1100)]);
        r.samplePerf('IX0001', D, 60, [row('24', 1.2)]);
        // 10:01 falls
        r.sampleAmount('IX0001', D, 61, [row('24', 1300)]);
        r.samplePerf('IX0001', D, 61, [row('24', 0.9)]);
        // 10:02 trades flat (no change sample: carried forward)
        r.sampleAmount('IX0001', D, 62, [row('24', 1350)]);
        const f = r.groupFlow(['IX0001:24'], 62)!;
        expect(f.turnover[60]).toBe(100);
        expect(f.net[60]).toBe(100);
        expect(f.turnover[61]).toBe(200);
        expect(f.net[61]).toBe(-200);
        expect(f.turnover[62]).toBe(50);
        expect(f.net[62]).toBe(0);
        expect(f.cumNet[62]).toBe(-100);
        expect(f.flow5).toBe(-100);
        expect(f.turnover5).toBe(350);
        expect(f.total).toBe(1350);
        expect(f.pct).toBeCloseTo(0.9);
        expect(f.count).toBe(10);
    });

    it('combines TWSE and TPEx groups of one industry, change weighted by turnover', () => {
        const r = new IcFlowRecorder();
        r.sampleAmount('IX0001', D, 10, [row('24', 3000, 80)]);
        r.samplePerf('IX0001', D, 10, [row('24', 2)]);
        r.sampleAmount('IX0043', D, 10, [row('24', 1000, 60)]);
        r.samplePerf('IX0043', D, 10, [row('24', -2)]);
        const f = r.groupFlow(['IX0001:24', 'IX0043:24'], 10)!;
        expect(f.pct).toBeCloseTo(1); // (3000·2 + 1000·−2) / 4000
        expect(f.count).toBe(140);
        expect(f.total).toBe(4000);
        expect(r.groupFlow(['IX0001:99'], 10)).toBeNull();
    });

    it('never pours a recording gap into one minute', () => {
        const r = new IcFlowRecorder();
        r.sampleAmount('IX0001', D, 0, [row('1', 100)]);
        r.samplePerf('IX0001', D, 0, [row('1', 0)]);
        r.sampleAmount('IX0001', D, 1, [row('1', 150)]);
        r.samplePerf('IX0001', D, 1, [row('1', 0.5)]);
        r.rebase(); // panel closed
        r.sampleAmount('IX0001', D, 40, [row('1', 5000)]);
        r.samplePerf('IX0001', D, 40, [row('1', 0.2)]);
        r.sampleAmount('IX0001', D, 41, [row('1', 5100)]);
        r.samplePerf('IX0001', D, 41, [row('1', 0.1)]);
        const f = r.groupFlow(['IX0001:1'], 41)!;
        expect(f.turnover[1]).toBe(50);
        expect(f.net[1]).toBe(50);
        expect(f.turnover[40]).toBe(0);
        expect(f.turnover[41]).toBe(100);
        expect(f.net[41]).toBe(-100);
        expect(f.total).toBe(5100);
    });

    it('starts over on a new trading day', () => {
        const r = new IcFlowRecorder();
        r.sampleAmount('IX0001', D, 5, [row('1', 100)]);
        r.sampleAmount('IX0001', D, 6, [row('1', 200)]);
        r.sampleAmount('IX0001', '2026-10-23', 0, [row('1', 10)]);
        const f = r.groupFlow(['IX0001:1'], 6)!;
        expect(f.total).toBe(10);
        expect(f.turnover[6]).toBe(0);
    });

    it('ignores a state from an older day instead of wiping the newer session', () => {
        const r = new IcFlowRecorder();
        r.sampleAmount('IX0001', D, 5, [row('1', 100)]);
        r.sampleAmount('IX0001', D, 6, [row('1', 200)]);
        r.sampleAmount('IX0043', '2026-10-21', 270, [row('1', 9999)]);
        r.samplePerf('IX0043', '2026-10-21', 270, [row('1', 3)]);
        expect(r.date).toBe(D);
        expect(r.groupFlow(['IX0001:1'], 6)!.turnover[6]).toBe(100);
        expect(r.groupFlow(['IX0043:1'], 6)).toBeNull();
    });

    it('keeps what an earlier span measured when a new span starts in the same minute', () => {
        const r = new IcFlowRecorder();
        r.sampleAmount('IX0001', D, 10, [row('1', 1000)]);
        r.samplePerf('IX0001', D, 10, [row('1', 0)]);
        r.sampleAmount('IX0001', D, 10, [row('1', 1200)]);
        r.samplePerf('IX0001', D, 10, [row('1', 0.4)]);
        r.rebase(); // reconnect inside the minute
        r.sampleAmount('IX0001', D, 10, [row('1', 1500)]);
        r.samplePerf('IX0001', D, 10, [row('1', 0.5)]);
        r.sampleAmount('IX0001', D, 10, [row('1', 1600)]);
        r.samplePerf('IX0001', D, 10, [row('1', 0.3)]);
        const f = r.groupFlow(['IX0001:1'], 10)!;
        expect(f.turnover[10]).toBe(300); // 200 before the gap + 100 after, not the 300 inside it
        expect(f.net[10]).toBe(200 - 100);
    });
});
