import { createElement, useRef, type CSSProperties, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useHeaderPopoverFit } from './use-header-popover-fit';

let view: ReactTestRenderer | undefined;
let latest: CSSProperties | undefined;
/** The header button's place and the window width; tests move them and fire resize. */
const geometry = { left: 0, right: 0, viewport: 0 };
const listeners = new Set<() => void>();

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    listeners.clear();
    vi.unstubAllGlobals();
});

function Probe({ open }: { open: boolean }) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    latest = useHeaderPopoverFit(open, wrapRef, popRef);
    return createElement('div', { ref: wrapRef, id: 'wrap' }, open ? createElement('div', { ref: popRef, id: 'pop' }) : null);
}

const win = {
    get innerWidth() { return geometry.viewport; },
    innerHeight: 900,
    getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }),
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
};

/** A 276px menu under a header button at [left, right] in a window `viewport` px wide. */
async function render(open: boolean, left: number, right: number, viewport: number) {
    Object.assign(geometry, { left, right, viewport });
    const createNodeMock = (element: ReactElement) => {
        const { id } = element.props as { id?: string };
        if (id === 'wrap') {
            return { getBoundingClientRect: () => ({ left: geometry.left, right: geometry.right, top: 43, bottom: 70 }), ownerDocument: { defaultView: win }, parentElement: null };
        }
        if (id === 'pop') return { offsetWidth: 276 };
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

it('re-places an open menu when the window resizes or the header re-wraps', async () => {
    await render(true, 734, 795, 1000);
    expect(latest).toBeUndefined();
    // The button wraps to the second row's left edge while the menu is open.
    Object.assign(geometry, { left: 18, right: 79, viewport: 1150 });
    await act(async () => { for (const listener of listeners) listener(); });
    expect(latest).toEqual({ left: 6 - 18, right: 'auto' });
    Object.assign(geometry, { left: 734, right: 795, viewport: 1000 });
    await act(async () => { for (const listener of listeners) listener(); });
    expect(latest).toBeUndefined();
});

it('narrows a menu wider than the window and clears the fit and listeners on close', async () => {
    await render(true, 10, 60, 250);
    expect(latest).toEqual({ left: 6 - 10, right: 'auto', width: 238 });
    await render(false, 10, 60, 250);
    expect(latest).toBeUndefined();
    expect(listeners.size).toBe(0);
});
