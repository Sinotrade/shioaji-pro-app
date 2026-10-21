// PriceBandPrimitive renderer：用假的 chart / series / canvas context 驗證
// draw() 真的會依逐根座標產生填色多邊形與上下緣線（不需要真正的 canvas）
import { describe, expect, it } from 'vitest';
import { outputLineStyle } from './indicator-defs';
import {
    BAND_BORDER_OPACITY,
    BAND_FILL_OPACITY,
    bandColors,
    bandRangeIn,
    PriceBandPrimitive,
    type PriceBandPoint,
} from './price-band';

const T0 = 1_791_400_000;
const pts = (n: number, top: number, bottom: number): PriceBandPoint[] =>
    Array.from({ length: n }, (_, i) => ({ time: (T0 + i * 300) as never, top, bottom }));

interface Calls { beginPath: number; fill: number; stroke: number; closePath: number; moveTo: [number, number][]; lineTo: [number, number][]; dash: unknown[]; fillStyle?: unknown; strokeStyle?: unknown; lineWidth?: unknown }

function fakeTarget(w = 800, h = 400, hr = 1, vr = 1) {
    const calls: Calls = { beginPath: 0, fill: 0, stroke: 0, closePath: 0, moveTo: [], lineTo: [], dash: [] };
    const ctx = {
        set fillStyle(v: unknown) { calls.fillStyle = v; },
        set strokeStyle(v: unknown) { calls.strokeStyle = v; },
        set lineWidth(v: unknown) { calls.lineWidth = v; },
        beginPath: () => { calls.beginPath++; },
        closePath: () => { calls.closePath++; },
        fill: () => { calls.fill++; },
        stroke: () => { calls.stroke++; },
        moveTo: (x: number, y: number) => { calls.moveTo.push([x, y]); },
        lineTo: (x: number, y: number) => { calls.lineTo.push([x, y]); },
        setLineDash: (d: unknown) => { calls.dash.push(d); },
    };
    const target = {
        useBitmapCoordinateSpace: (fn: (scope: unknown) => void) =>
            fn({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize: { width: w * hr, height: h * vr }, mediaSize: { width: w, height: h } }),
    };
    return { target, calls };
}

// 線性假座標：x 每根 10px；price 49000 → y=300，每點 1px
function fakeAttach(prim: PriceBandPrimitive, opts: { nullAt?: number[]; priceNull?: boolean } = {}) {
    const nullAt = new Set(opts.nullAt ?? []);
    const chart = { timeScale: () => ({ timeToCoordinate: (t: number) => { const i = (t - T0) / 300; return nullAt.has(i) ? null : i * 10; } }) };
    const series = { priceToCoordinate: (p: number) => (opts.priceNull ? null : 300 - (p - 49000)) };
    prim.attached({ chart, series, requestUpdate: () => {} } as never);
    return { chart, series };
}

const draw = (prim: PriceBandPrimitive, t: ReturnType<typeof fakeTarget>) =>
    prim.paneViews()[0]!.renderer()!.draw(t.target as never);

describe('PriceBandPrimitive renderer', () => {
    it('fills one polygon + strokes two edges for a constant band with all coords valid', () => {
        const prim = new PriceBandPrimitive({ points: pts(5, 49150, 49100), fillColor: 'rgba(1,2,3,0.2)', borderColor: '#c0392b', borderStyle: 'solid', borderWidth: 2 });
        fakeAttach(prim);
        const t = fakeTarget();
        draw(prim, t);
        expect(t.calls.fill).toBe(1);
        expect(t.calls.stroke).toBe(2);
        expect(t.calls.fillStyle).toBe('rgba(1,2,3,0.2)');
        expect(t.calls.strokeStyle).toBe('#c0392b');
        expect(t.calls.lineWidth).toBe(2);
        // 多邊形：上緣 5 點（1 moveTo + 4 lineTo）→ 下緣 5 點（5 lineTo）
        expect(t.calls.moveTo[0]).toEqual([0, 150]); // x=0, y=300-(49150-49000)=150
        expect(t.calls.lineTo.length).toBeGreaterThanOrEqual(9);
        // 下緣 y 應為 200（49100）
        expect(t.calls.lineTo.some(([, y]) => y === 200)).toBe(true);
        expect(t.calls.dash[0]).toEqual([]); // solid
    });

    it('breaks into separate segments when a middle point has no coordinate', () => {
        const prim = new PriceBandPrimitive({ points: pts(5, 49150, 49100), fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        fakeAttach(prim, { nullAt: [2] });
        const t = fakeTarget();
        draw(prim, t);
        expect(t.calls.fill).toBe(2);
        expect(t.calls.stroke).toBe(4);
    });

    it('still paints a visible sliver for a single-point segment', () => {
        const prim = new PriceBandPrimitive({ points: pts(1, 49150, 49100), fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        fakeAttach(prim);
        const t = fakeTarget();
        draw(prim, t);
        expect(t.calls.fill).toBe(1);
        expect(t.calls.stroke).toBe(2);
        // 單點區段被撐成有寬度的矩形
        const xs = t.calls.lineTo.map(([x]) => x).concat(t.calls.moveTo.map(([x]) => x));
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0);
    });

    it('uses a dashed pattern scaled by the pixel ratio', () => {
        const prim = new PriceBandPrimitive({ points: pts(3, 49150, 49100), fillColor: 'f', borderColor: 'b', borderStyle: 'dashed', borderWidth: 1 });
        fakeAttach(prim);
        const t = fakeTarget(800, 400, 2, 2);
        draw(prim, t);
        expect(t.calls.dash[0]).toEqual([8, 8]);
        expect(t.calls.lineWidth).toBe(2); // 1 * hr
    });

    it('draws nothing when every price coordinate is null or there are no points', () => {
        const a = new PriceBandPrimitive({ points: pts(4, 49150, 49100), fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        fakeAttach(a, { priceNull: true });
        const ta = fakeTarget(); draw(a, ta);
        expect(ta.calls.fill).toBe(0); expect(ta.calls.stroke).toBe(0);
        const b = new PriceBandPrimitive({ points: [], fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        fakeAttach(b);
        const tb = fakeTarget(); draw(b, tb);
        expect(tb.calls.fill).toBe(0);
    });

    it('draws nothing before attached() (no chart/series yet)', () => {
        const prim = new PriceBandPrimitive({ points: pts(4, 49150, 49100), fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        const t = fakeTarget(); draw(prim, t);
        expect(t.calls.fill).toBe(0);
    });
});

describe('PriceBandPrimitive layering and edges', () => {
    it('draws in the bottom layer so candles and volume paint on top of the band', () => {
        const prim = new PriceBandPrimitive({ points: pts(2, 49150, 49100), fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        expect(prim.paneViews()[0]!.zOrder!()).toBe('bottom');
    });

    it('snaps a 1px edge to the pixel centre so it stays one crisp pixel', () => {
        const prim = new PriceBandPrimitive({ points: pts(3, 49150.4, 49100.4), fillColor: 'f', borderColor: 'b', borderStyle: 'solid', borderWidth: 1 });
        fakeAttach(prim);
        const t = fakeTarget();
        draw(prim, t);
        expect(t.calls.lineWidth).toBe(1);
        // 邊線的 moveTo 在填色之後：第 2、3 個 moveTo 是上／下緣
        const edgeYs = t.calls.moveTo.slice(1).map(([, y]) => y);
        expect(edgeYs).toEqual([149.5, 199.5]); // 149.6 → 149.5、199.6 → 199.5
    });

    it('keeps a 2px edge on whole pixels', () => {
        const prim = new PriceBandPrimitive({ points: pts(3, 49150.4, 49100.4), fillColor: 'f', borderColor: 'b', borderStyle: 'dashed', borderWidth: 2 });
        fakeAttach(prim);
        const t = fakeTarget();
        draw(prim, t);
        expect(t.calls.lineWidth).toBe(2);
        expect(t.calls.moveTo.slice(1).map(([, y]) => y)).toEqual([150, 200]);
        expect(t.calls.dash[0]).toEqual([4, 4]); // 虛線維持虛線
    });
});

describe('bandColors', () => {
    it('defaults to a light fill and a softened border', () => {
        expect(BAND_FILL_OPACITY).toBeGreaterThanOrEqual(8);
        expect(BAND_FILL_OPACITY).toBeLessThanOrEqual(12);
        const c = bandColors('#ff0000', 100);
        expect(c.fillColor).toBe(`rgba(255, 0, 0, ${(BAND_FILL_OPACITY / 100).toFixed(2)})`);
        expect(c.borderColor).toBe(`rgba(255, 0, 0, ${(BAND_BORDER_OPACITY / 100).toFixed(2)})`);
    });

    it('scales both fill and border by the user opacity override', () => {
        const c = bandColors('#00ff00', 50);
        expect(c.fillColor).toBe(`rgba(0, 255, 0, ${(Math.round(BAND_FILL_OPACITY / 2) / 100).toFixed(2)})`);
        expect(c.borderColor).toBe(`rgba(0, 255, 0, ${(Math.round(BAND_BORDER_OPACITY / 2) / 100).toFixed(2)})`);
    });
});

describe('bandRangeIn', () => {
    const series: PriceBandPoint[] = [
        { time: 100 as never, top: 10, bottom: 5 },
        { time: 200 as never, top: 30, bottom: 20 },
        { time: 300 as never, top: 12, bottom: 18 }, // 上下緣顛倒也要正確
        { time: 400 as never, top: 90, bottom: 80 },
    ];

    it('uses only the points inside the visible time range', () => {
        expect(bandRangeIn(series, 150, 350)).toEqual({ minValue: 12, maxValue: 30 });
        expect(bandRangeIn(series, 0, 1000)).toEqual({ minValue: 5, maxValue: 90 });
        expect(bandRangeIn(series, 400, 400)).toEqual({ minValue: 80, maxValue: 90 });
    });

    it('returns null when nothing is visible', () => {
        expect(bandRangeIn(series, 210, 290)).toBeNull();
        expect(bandRangeIn(series, 500, 600)).toBeNull();
        expect(bandRangeIn([], 0, 1)).toBeNull();
    });
});

describe('outputLineStyle', () => {
    it('previews dashed outputs and dashed band borders as dashed', () => {
        expect(outputLineStyle({ key: 'a', label: 'a', kind: 'dashed', color: '#fff' })).toBe('dashed');
        expect(outputLineStyle({ key: 'b', label: 'b', kind: 'band', color: '#fff', border: 'dashed' })).toBe('dashed');
        expect(outputLineStyle({ key: 'c', label: 'c', kind: 'band', color: '#fff' })).toBe('solid');
        expect(outputLineStyle({ key: 'd', label: 'd', kind: 'line', color: '#fff' })).toBe('solid');
    });
});
