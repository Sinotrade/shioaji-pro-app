// band() 在自訂指標 runtime 的行為：常數展開、`_lo` 下緣、名稱/參數驗證
import { describe, expect, it } from 'vitest';
import { runCustom, type BarsInput } from './custom-runtime';

function bars(n: number): BarsInput {
    const time: number[] = [];
    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const volume: number[] = [];
    for (let i = 0; i < n; i++) {
        const c = 100 + i;
        time.push(1_700_000_000 + i * 60);
        open.push(c - 0.5);
        high.push(c + 1);
        low.push(c - 1);
        close.push(c);
        volume.push(10);
    }
    return { time, open, high, low, close, volume };
}

describe('band()', () => {
    it('expands constants into full-length series and stores the lower edge in <name>_lo', () => {
        const res = runCustom(
            `band('牆', p.wall + 25, p.wall - 25, { color: '#c0392b' })`,
            bars(5),
            { wall: 1000 },
        );
        expect(res.error).toBeUndefined();
        expect(res.order).toEqual(['牆']); // 下緣不進 order
        expect(res.outputs['牆']).toEqual([1025, 1025, 1025, 1025, 1025]);
        expect(res.outputs['牆_lo']).toEqual([975, 975, 975, 975, 975]);
        expect(res.hints['牆']).toEqual({ kind: 'band', color: '#c0392b' });
    });

    it('accepts series for both edges and propagates null warm-up gaps', () => {
        const res = runCustom(
            `const mid = ta.sma(close, 3)
band('通道', ta.add(mid, 2), ta.sub(mid, 2))`,
            bars(5),
            {},
        );
        expect(res.error).toBeUndefined();
        const up = res.outputs['通道']!;
        const lo = res.outputs['通道_lo']!;
        expect(up.length).toBe(5);
        expect(up.slice(0, 2)).toEqual([null, null]); // sma 暖身期
        expect(lo.slice(0, 2)).toEqual([null, null]);
        // close = 100..104 → sma(3) at i=2 is 101 → 103 / 99
        expect(up[2]).toBe(103);
        expect(lo[2]).toBe(99);
    });

    it('whitelists border and width, dropping anything else', () => {
        const ok = runCustom(
            `band('a', 10, 5, { border: 'dashed', width: 2 })`,
            bars(2),
            {},
        );
        expect(ok.hints['a']).toEqual({ kind: 'band', border: 'dashed', width: 2 });
        const bad = runCustom(
            `band('b', 10, 5, { border: 'dotted', width: 7 })`,
            bars(2),
            {},
        );
        expect(bad.error).toBeUndefined();
        expect(bad.hints['b']).toEqual({ kind: 'band' });
    });

    it('rejects names ending in _lo', () => {
        const res = runCustom(`band('x_lo', 10, 5)`, bars(2), {});
        expect(res.error).toMatch(/_lo/);
    });

    it('rejects a band whose lower-edge key would clobber an existing plot()', () => {
        const res = runCustom(
            `plot('x_lo', close)
band('x', 10, 5)`,
            bars(2),
            {},
        );
        expect(res.error).toMatch(/x_lo/);
    });

    it('reports a clear error for non-series, non-number edges', () => {
        const res = runCustom(`band('x', 'oops', 5)`, bars(2), {});
        expect(res.error).toMatch(/上緣/);
    });

    it('rejects a later plot() whose _lo name would overwrite an existing band lower edge', () => {
        const res = runCustom(
            `band('x', 10, 5)
plot('x_lo', close)`,
            bars(2),
            {},
        );
        expect(res.error).toMatch(/x_lo/);
        // 反向：_lo 名稱沒有對應 band 時仍是合法的一般輸出
        const ok = runCustom(`plot('vol_lo', close)`, bars(2), {});
        expect(ok.error).toBeUndefined();
        expect(ok.order).toEqual(['vol_lo']);
    });
});
