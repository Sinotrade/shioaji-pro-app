import { createElement, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePointerParallax } from './use-pointer-parallax';

let frames: Map<number, FrameRequestCallback>;
let seq: number;
let reduced: boolean;
let focused: { matches: (s: string) => boolean } | null;
const win = Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ get matches() { return reduced; } }) });
const doc = Object.defineProperty(Object.assign(new EventTarget(), { hidden: false }), 'activeElement', { get: () => focused });
const vars = new Map<string, string>();
const node = { style: { setProperty: (k: string, v: string) => { vars.set(k, v); } } };

const flush = (max = 500) => {
    for (let i = 0; i < max && frames.size; i++) {
        const [id, cb] = frames.entries().next().value!;
        frames.delete(id);
        cb(0);
    }
};
const move = (clientX: number, clientY: number) => win.dispatchEvent(Object.assign(new Event('pointermove'), { clientX, clientY }));
const px = () => Number(vars.get('--login-px') ?? 0);
const py = () => Number(vars.get('--login-py') ?? 0);

function Probe({ enabled = true }: { enabled?: boolean }) {
    const ref = useRef<HTMLElement | null>(null);
    usePointerParallax(ref, enabled);
    return createElement('div', { ref });
}

const mount = async (enabled = true) => {
    let view!: ReactTestRenderer;
    await act(async () => { view = create(createElement(Probe, { enabled }), { createNodeMock: () => node }); });
    return view;
};

beforeEach(() => {
    frames = new Map();
    seq = 0;
    reduced = false;
    focused = null;
    doc.hidden = false;
    win.innerWidth = 1200;
    vars.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++seq, cb); return seq; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('usePointerParallax', () => {
    it('eases toward the pointer and stops the frame loop once settled', async () => {
        const view = await mount();
        move(1200, 0);
        expect(frames.size).toBe(1);
        flush(1);
        expect(px()).toBeGreaterThan(0);
        expect(px()).toBeLessThan(1);
        flush();
        expect(frames.size).toBe(0);
        expect(px()).toBe(1);
        expect(py()).toBe(-1);
        await act(async () => view.unmount());
    });

    it('stays still under reduced motion or a coarse pointer', async () => {
        reduced = true;
        const view = await mount();
        move(1200, 800);
        flush(1);
        expect(px()).toBe(0);
        expect(frames.size).toBe(0);
        await act(async () => view.unmount());
    });

    it.each([
        ['an input is focused', () => { focused = { matches: (s) => s.includes('input') }; }],
        ['the window is narrow', () => { win.innerWidth = 600; }],
        ['the page is hidden', () => { doc.hidden = true; }],
    ])('eases back to rest while %s', async (_, pause) => {
        const view = await mount();
        move(1200, 800);
        flush();
        expect(px()).toBe(1);
        pause();
        doc.dispatchEvent(new Event('focusin'));
        flush();
        expect(px()).toBe(0);
        expect(py()).toBe(0);
        await act(async () => view.unmount());
    });

    it('does nothing when disabled', async () => {
        const view = await mount(false);
        move(1200, 800);
        expect(frames.size).toBe(0);
        await act(async () => view.unmount());
    });

    it('removes listeners and cancels the pending frame on unmount', async () => {
        const view = await mount();
        move(600, 400);
        expect(frames.size).toBe(1);
        await act(async () => view.unmount());
        expect(frames.size).toBe(0);
        move(1200, 800);
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(frames.size).toBe(0);
    });
});
