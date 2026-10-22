// chain-rank 窄面板明細抽屜：開啟時聚焦抽屜、關閉時焦點回到觸發鈕、aria-expanded／aria-controls
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./chain-ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./chain-ui')>()),
    // narrower than the dock width: the detail card is a drawer
    useBoxSize: () => ({ ref: () => undefined, element: null, size: { width: 420, height: 400 } }),
}));

import { FlowBook, groupFlow } from '../lib/chain-flow';
import type { Theme } from '../lib/company-data/types';
import { FlowRank } from './chain-rank';
import type { FlowRow } from './chain-ui';

const NOW = 20;

function rows(): FlowRow[] {
    const book = new FlowBook();
    return [0, 1, 2].map((g) => {
        const code = String(2000 + g);
        for (let slot = 0; slot <= NOW; slot += 1) {
            const close = 100 + (g === 1 ? -slot : slot) / 10;
            book.addBar({ code, date: '2026-10-21', slot, open: close, high: close, low: close, close, volume: 1, amount: 1e6 });
        }
        const theme = { id: `t${g}`, kind: 'chain', name: `族群${g}`, aliases: [], related: [], stages: [], members: [], as_of: null } as Theme;
        return { theme, codes: [code], flow: groupFlow(book, [code], NOW) };
    });
}

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
});

const focused: string[] = [];
function render() {
    focused.length = 0;
    const element: ReactElement = createElement(FlowRank, {
        rows: rows(),
        metric: '5',
        now: NOW,
        from: 0,
        selectedId: 't0',
        reducedMotion: true,
        paused: false,
        onSelect: () => undefined,
        nameOf: (code: string) => code,
        onPick: () => undefined,
    });
    act(() => {
        renderer = create(element, {
            createNodeMock: (el) => ({
                focus: () => focused.push(el.type === 'aside' ? 'drawer' : String((el.props as { title?: string }).title ?? el.type)),
                getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
                getContext: () => null,
                style: {},
            }),
        });
    });
}

const toggle = () => renderer!.root.find((n: ReactTestInstance) => n.type === 'button' && n.props.title === '顯示選取族群的明細');
const drawer = () => renderer!.root.findAll((n: ReactTestInstance) => n.type === 'aside');

describe('FlowRank drawer', () => {
    it('exposes its state on the trigger, focuses the drawer on open and returns focus on close', () => {
        render();
        expect(toggle().props['aria-expanded']).toBe(false);
        expect(toggle().props['aria-pressed']).toBeUndefined();
        expect(drawer()).toHaveLength(0);

        act(() => toggle().props.onClick());
        const [aside] = drawer();
        expect(aside).toBeDefined();
        expect(toggle().props['aria-expanded']).toBe(true);
        expect(toggle().props['aria-controls']).toBe(aside!.props.id);
        expect(aside!.props.tabIndex).toBe(-1);
        expect(focused).toEqual(['drawer']);

        const close = aside!.find((n: ReactTestInstance) => n.type === 'button' && n.props['aria-label'] === '關閉明細');
        act(() => close.props.onClick());
        expect(drawer()).toHaveLength(0);
        expect(toggle().props['aria-expanded']).toBe(false);
        expect(focused).toEqual(['drawer', '顯示選取族群的明細']);
    });

    it('closes on Escape and returns focus to the trigger', () => {
        render();
        act(() => toggle().props.onClick());
        act(() => drawer()[0]!.props.onKeyDown({ key: 'Escape', stopPropagation: () => undefined }));
        expect(drawer()).toHaveLength(0);
        expect(focused.at(-1)).toBe('顯示選取族群的明細');
    });
});
