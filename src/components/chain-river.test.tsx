// chain-river engine: an inactive river repaints once (no stale bands after a
// session reset) and a layoutKey change measures the track again.
import { createElement, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRiver, type RiverLane } from './chain-river';

interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}
const rect = (b: Box) => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top });

let trackBox: Box;
const ctx = {
    calls: [] as string[],
    setTransform() {},
    clearRect() {
        ctx.calls.push('clear');
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    beginPath() {},
    roundRect() {},
    fill() {
        ctx.calls.push('fill');
    },
    arc() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    shadowColor: '',
    shadowBlur: 0,
    lineCap: 'butt',
};
const canvas = { width: 0, height: 0, getContext: () => ctx };
const stage = { getBoundingClientRect: () => rect({ left: 0, top: 0, width: 800, height: 400 }) };
const track = { getBoundingClientRect: () => rect(trackBox) };
const area = {
    scrollTop: 0,
    getBoundingClientRect: () => rect({ left: 0, top: 0, width: 800, height: 400 }),
    addEventListener() {},
    removeEventListener() {},
};
const rows = { getBoundingClientRect: () => rect({ left: 0, top: 0, width: 800, height: 200 }), querySelector: () => track };
const rowEl = { style: { transform: '' } };

function Harness({ lanes, active, layoutKey }: { lanes: RiverLane[]; active: boolean; layoutKey?: string }) {
    const stageRef = useRef(stage as unknown as HTMLElement);
    const areaRef = useRef(area as unknown as HTMLElement);
    const rowsRef = useRef(rows as unknown as HTMLElement);
    const canvasRef = useRef(canvas as unknown as HTMLCanvasElement);
    const rowEls = useRef(new Map<string, HTMLElement>(lanes.map((l) => [l.id, rowEl as unknown as HTMLElement])));
    useRiver({ lanes, stageRef, areaRef, rowsRef, canvasRef, rowEls, reducedMotion: false, active, layoutKey });
    return null;
}

const lane = (m: number): RiverLane => ({ id: 'a', y: 0, m, thick: 8, focus: 1 });

describe('useRiver', () => {
    let renderer: ReactTestRenderer | null = null;
    beforeEach(() => {
        trackBox = { left: 100, top: 0, width: 400, height: 22 };
        ctx.calls = [];
        vi.stubGlobal('getComputedStyle', () => ({ colorScheme: 'dark', getPropertyValue: () => '#ff0000' }));
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        vi.stubGlobal('window', { devicePixelRatio: 1 });
        vi.stubGlobal('document', { visibilityState: 'visible', documentElement: {}, addEventListener() {}, removeEventListener() {} });
    });
    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = null;
        vi.unstubAllGlobals();
    });

    it('repaints once when it goes inactive, so old bands do not linger', () => {
        act(() => {
            renderer = create(createElement(Harness, { lanes: [lane(1)], active: false }));
        });
        // inactive from the start: one static frame with the band
        expect(ctx.calls).toContain('fill');
        ctx.calls = [];
        // the data resets (no flow yet): the band target is 0 → a cleared frame, nothing filled
        act(() => renderer!.update(createElement(Harness, { lanes: [lane(0)], active: false })));
        expect(ctx.calls).toContain('clear');
        expect(ctx.calls).not.toContain('fill');
    });

    it('measures the track again when layoutKey changes', () => {
        const spy = vi.spyOn(track, 'getBoundingClientRect');
        act(() => {
            renderer = create(createElement(Harness, { lanes: [lane(1)], active: false, layoutKey: 'wide' }));
        });
        const before = spy.mock.calls.length;
        trackBox = { left: 60, top: 0, width: 300, height: 22 };
        act(() => renderer!.update(createElement(Harness, { lanes: [lane(1)], active: false, layoutKey: 'narrow' })));
        expect(spy.mock.calls.length).toBeGreaterThan(before);
    });
});
