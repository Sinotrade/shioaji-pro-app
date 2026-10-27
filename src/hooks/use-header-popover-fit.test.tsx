import { createElement, useRef, type CSSProperties, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useHeaderPopoverFit } from './use-header-popover-fit';

let view: ReactTestRenderer | undefined;
let latest: CSSProperties | undefined;

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

function Probe({ open }: { open: boolean }) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    latest = useHeaderPopoverFit(open, wrapRef, popRef);
    return createElement('div', { ref: wrapRef, id: 'wrap' }, open ? createElement('div', { ref: popRef, id: 'pop' }) : null);
}

/** A header button at [left, right] in a window `viewport` px wide, with a 276px menu. */
async function render(open: boolean, left: number, right: number, viewport: number) {
    const win = { innerWidth: viewport, innerHeight: 900, getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }) };
    const createNodeMock = (element: ReactElement) => {
        const { id } = element.props as { id?: string };
        if (id === 'wrap') return { getBoundingClientRect: () => ({ left, right, top: 43, bottom: 70 }), ownerDocument: { defaultView: win }, parentElement: null };
        if (id === 'pop') return { offsetWidth: 276, scrollHeight: 200 };
        return null;
    };
    if (view) await act(async () => view!.update(createElement(Probe, { open })));
    else await act(async () => { view = create(createElement(Probe, { open }), { createNodeMock }); });
}

it('keeps the desktop right-aligned menu untouched when it fits', async () => {
    await render(true, 732, 793, 1000);
    expect(latest).toBeUndefined();
});

it('pulls a menu under a wrapped left-side button back inside the window', async () => {
    await render(true, 88, 149, 700);
    // Right-aligned would start at -127; the menu starts at the 6px margin instead.
    expect(latest).toEqual({ left: 6 - 88, right: 'auto' });
});

it('narrows a menu wider than the window and clears the fit on close', async () => {
    await render(true, 10, 60, 250);
    expect(latest).toEqual({ left: 6 - 10, right: 'auto', width: 238, boxSizing: 'border-box' });
    await render(false, 10, 60, 250);
    expect(latest).toBeUndefined();
});
