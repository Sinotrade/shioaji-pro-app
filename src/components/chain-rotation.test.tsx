// chain-rotation 輪動圖：hover 重用版面計算（不重跑碰撞鬆弛）、SVG 無障礙結構
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const relax = vi.hoisted(() => ({ calls: 0 }));

vi.mock('./chain-ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./chain-ui')>()),
    useBoxSize: () => ({ ref: () => undefined, element: null, size: { width: 640, height: 420 } }),
}));
vi.mock('../lib/chain-motion', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/chain-motion')>();
    return {
        ...actual,
        relaxCircles: (...args: Parameters<typeof actual.relaxCircles>) => {
            relax.calls += 1;
            return actual.relaxCircles(...args);
        },
    };
});
vi.mock('motion/react', () => {
    const strip = ({ initial: _i, animate: _a, transition: _t, ...rest }: Record<string, unknown>) => rest;
    return {
        LazyMotion: ({ children }: { children: ReactNode }) => children,
        domAnimation: {},
        m: { g: (props: Record<string, unknown>) => createElement('g', strip(props)) },
    };
});

import { FlowBook, groupFlow, type KBarEvent } from '../lib/chain-flow';
import type { Theme } from '../lib/company-data/types';
import { MOMENTUM_WARMUP } from '../lib/chain-motion';
import { FlowRotation } from './chain-rotation';
import type { FlowRow } from './chain-ui';

const NOW = 30;

function rows(): FlowRow[] {
    const book = new FlowBook();
    const out: FlowRow[] = [];
    for (let g = 0; g < 6; g += 1) {
        const code = String(2000 + g);
        for (let slot = 0; slot <= NOW; slot += 1) {
            const close = 100 + ((slot * (g + 1)) % 7) - (g % 2 ? slot / 10 : 0);
            const bar: KBarEvent = { code, date: '2026-10-21', slot, open: close, high: close, low: close, close, volume: 1, amount: 1e6 * (g + 1) };
            book.addBar(bar);
        }
        const theme = { id: `t${g}`, kind: 'chain', name: `族群${g}`, aliases: [], related: [], stages: [], members: [], as_of: null } as Theme;
        out.push({ theme, codes: [code], flow: groupFlow(book, [code], NOW) });
    }
    return out;
}

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
});

function render(selectedId = 't0', data = rows(), from = 0) {
    const props = { rows: data, now: NOW, from, session: '2026-10-21', reducedMotion: true, paused: false, onSelect: () => undefined };
    act(() => {
        renderer = create(createElement(FlowRotation, { ...props, selectedId }));
    });
    return {
        rerender: (id: string) => act(() => renderer!.update(createElement(FlowRotation, { ...props, selectedId: id }))),
    };
}

const bubbles = () => renderer!.root.findAll((n: ReactTestInstance) => n.type === 'g' && n.props.role === 'button');

describe('FlowRotation', () => {
    it('reuses the collision layout on hover and on a selection change', () => {
        relax.calls = 0;
        const view = render();
        const afterMount = relax.calls;
        expect(afterMount).toBeGreaterThan(0);
        const first = bubbles()[0]!;
        act(() => first.props.onMouseEnter());
        act(() => first.props.onMouseLeave());
        act(() => first.props.onFocus());
        expect(relax.calls).toBe(afterMount);
        // the selection only re-places labels, not the bubbles
        view.rerender('t3');
        expect(relax.calls).toBe(afterMount);
    });

    it('is a labelled group of buttons, not an image, with decorative layers hidden', () => {
        render('t2');
        const svg = renderer!.root.find((n: ReactTestInstance) => n.type === 'svg' && n.props.role === 'group');
        expect(svg.props.role).toBe('group');
        expect(svg.props['aria-label']).toBe('族群資金輪動圖');
        const list = bubbles();
        expect(list.length).toBe(6);
        for (const b of list) {
            expect(b.props.tabIndex).toBe(0);
            expect(b.props['aria-label']).toMatch(/^族群\d /);
        }
        expect(list.filter((b) => b.props['aria-pressed']).map((b) => b.props['aria-label'])).toEqual([expect.stringMatching(/^族群2 /)]);
        // every non-button child of the svg is hidden from assistive tech
        const direct = svg.children.filter((c): c is ReactTestInstance => typeof c !== 'string');
        for (const child of direct) {
            if (child.type === 'g' && child.props['aria-hidden'] === 'true') continue;
            // LazyMotion passes through: its children are buttons and aria-hidden labels
            const hasOnlyControls = child.findAll((n: ReactTestInstance) => n.type === 'g' && n.parent === child).every((g) => g.props.role === 'button' || g.props['aria-hidden'] === 'true');
            expect(hasOnlyControls).toBe(true);
        }
    });

    it('warm-up: no quadrant, counters blank, grey bubbles on the centre line, a badge with the minutes left', () => {
        // 5 minutes received (slots 26..30): momentum is still identically 0
        render('t0', rows(), NOW - 4);
        const text = (n: ReactTestInstance): string => n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
        const counts = renderer!.root.findAll((n: ReactTestInstance) => n.type === 'button').map((b) => text(b));
        expect(counts).toEqual(['領先—', '轉弱—', '改善—', '落後—']);
        const badge = renderer!.root.find((n: ReactTestInstance) => n.props.role === 'status');
        expect(text(badge)).toContain(`資金動能累積中・還需 ${MOMENTUM_WARMUP - 5} 分鐘`);
        for (const b of bubbles()) expect(b.props['aria-label']).toMatch(/動能累積中/);
        // no corner quadrant names and no momentum axis caption
        const svgText = text(renderer!.root.find((n: ReactTestInstance) => n.type === 'svg' && n.props.role === 'group'));
        expect(svgText).not.toMatch(/資金動能（百分點）/);
        expect(svgText).not.toMatch(/領先|轉弱|改善|落後/);
    });

    it('after warm-up: classified, no badge', () => {
        render('t0', rows(), 0);
        expect(renderer!.root.findAll((n: ReactTestInstance) => n.props.role === 'status')).toHaveLength(0);
        for (const b of bubbles()) expect(b.props['aria-label']).toMatch(/領先|轉弱|改善|落後/);
    });
});
