// chain-heat 清單：欄位排序（缺值墊底、同值依今日成交值）、點標題換排序、點列選取、
// 收盤或欄位被收起時改依漲跌%、窄時依序收欄
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// pane width the list measures (0 = unmeasured: every column)
const box = vi.hoisted(() => ({ width: 0 }));
vi.mock('./chain-ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./chain-ui')>()),
    useBoxSize: () => ({ ref: () => undefined, element: null, size: { width: box.width, height: 0 } }),
}));
import type { HeatCell } from '../lib/chain-motion';
import { fitColumns, fmtYi, GROUP_COLUMNS, GROUP_STEPS, GROUP_STEPS_IDLE, HeatList, MEMBER_COLUMNS, MEMBER_STEPS, rowStep, sortTiles, type Tile } from './chain-heat';

const cell = (net: number, turnover: number): HeatCell => ({ net, turnover, ratio: turnover > 0 ? net / turnover : null, minutes: [], amounts: [] });
const tile = (id: string, net: number, pct: number | null, order: number, turnover = 1e6): Tile => ({
    id,
    name: id,
    sub: '',
    cell: cell(net, turnover),
    pct,
    order,
});

// c has no bar in the window: its net is missing, not zero
const TILES = [tile('a', 5, 1, 300), tile('b', -2, 3, 100), tile('c', 0, null, 200, 0), tile('d', 9, -1, 50)];
const ids = (tiles: Tile[]) => tiles.map((t) => t.id);

describe('sortTiles', () => {
    it('orders by net with missing values last', () => {
        expect(ids(sortTiles(TILES, { key: 'net', desc: true }, 10))).toEqual(['d', 'a', 'b', 'c']);
        expect(ids(sortTiles(TILES, { key: 'net', desc: false }, 10))).toEqual(['b', 'a', 'd', 'c']);
    });

    it('falls back to turnover before the first bar', () => {
        expect(ids(sortTiles(TILES, { key: 'net', desc: true }, null))).toEqual(['a', 'c', 'b', 'd']);
    });

    it('orders by change with missing values last', () => {
        expect(ids(sortTiles(TILES, { key: 'pct', desc: true }, 10))).toEqual(['b', 'a', 'd', 'c']);
    });
});

describe('fitColumns', () => {
    const shown = (width: number, cols = MEMBER_COLUMNS, steps = MEMBER_STEPS) => {
        const fit = fitColumns(width, cols, steps);
        return { cols: cols.filter((c) => fit.shown.has(c)), slim: fit.slim };
    };

    it('shows everything when the name keeps its room', () => {
        expect(shown(32)).toEqual({ cols: ['code', 'price', 'pct', 'vol', 'net', 'turnover'], slim: false });
    });

    it('gives way in order: code, slimmer figures, 成交值, 量比, 淨流入, price', () => {
        expect(shown(28)).toEqual({ cols: ['price', 'pct', 'vol', 'net', 'turnover'], slim: false });
        expect(shown(21)).toEqual({ cols: ['price', 'pct', 'vol', 'net'], slim: true });
        expect(shown(17)).toEqual({ cols: ['price', 'pct', 'net'], slim: true });
        expect(shown(13)).toEqual({ cols: ['price', 'pct'], slim: true });
        expect(shown(8)).toEqual({ cols: ['pct'], slim: true });
    });

    it('keeps 漲跌% on the group table at any width, and drops the empty 淨流入 first before the first bar', () => {
        expect(shown(12, GROUP_COLUMNS, GROUP_STEPS)).toEqual({ cols: ['pct'], slim: true });
        expect(shown(15, GROUP_COLUMNS, GROUP_STEPS)).toEqual({ cols: ['pct', 'net'], slim: true });
        expect(shown(15, GROUP_COLUMNS, GROUP_STEPS_IDLE)).toEqual({ cols: ['pct', 'vol'], slim: true });
    });
});

describe('rowStep', () => {
    it('moves within the rows and ignores other keys', () => {
        expect(rowStep('ArrowDown', 0, 5)).toBe(1);
        expect(rowStep('ArrowUp', 0, 5)).toBe(0);
        expect(rowStep('PageDown', 0, 5)).toBe(4);
        expect(rowStep('Home', 3, 5)).toBe(0);
        expect(rowStep('End', 2, 5)).toBe(4);
        expect(rowStep('Enter', 2, 5)).toBeNull();
        expect(rowStep('ArrowDown', 0, 0)).toBeNull();
    });
});

describe('HeatList', () => {
    let renderer: ReactTestRenderer | null = null;
    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = null;
    });

    const rows = () => renderer!.root.findByType('tbody').findAllByType('tr');
    // the name text (not the ▶ marker or the kind dot)
    const rowNames = () =>
        rows().map((tr) => tr.findAllByType('span').map((sp) => sp.props.children).find((c) => typeof c === 'string' && c !== '▶') as string);
    const header = (label: string) =>
        renderer!.root.find((n: ReactTestInstance) => n.type === 'button' && ([] as unknown[]).concat(n.props.children).includes(label));
    const groups = (now: number | null, selectedId: string | null, onClick = vi.fn()) =>
        createElement(HeatList, {
            tiles: TILES,
            now,
            netTitle: '近 10 分鐘淨流入',
            nameLabel: '族群',
            columns: GROUP_COLUMNS,
            steps: GROUP_STEPS,
            selectedId,
            label: '族群清單',
            onClick,
        });

    it('sorts by net first, re-sorts on a header click and picks a row', () => {
        const onClick = vi.fn();
        act(() => {
            renderer = create(groups(10, 'a', onClick));
        });
        expect(rowNames()).toEqual(['d', 'a', 'b', 'c']);
        expect(rows()[1]!.findByType('button').props['aria-pressed']).toBe(true);

        act(() => header('漲跌%').props.onClick());
        expect(rowNames()).toEqual(['b', 'a', 'd', 'c']);
        expect(header('漲跌%').parent!.props['aria-sort']).toBe('descending');

        act(() => header('漲跌%').props.onClick());
        expect(rowNames()).toEqual(['d', 'a', 'b', 'c']);

        act(() => rows()[2]!.props.onClick());
        expect(onClick).toHaveBeenCalledWith('b');
    });

    it('marks change as the sort before the first bar, and a click on it flips it', () => {
        act(() => {
            renderer = create(groups(null, null));
        });
        expect(rowNames()).toEqual(['b', 'a', 'd', 'c']);
        expect(header('漲跌%').parent!.props['aria-sort']).toBe('descending');
        expect(header('淨流入').parent!.props['aria-sort']).toBeUndefined();

        act(() => header('漲跌%').props.onClick());
        expect(rowNames()).toEqual(['d', 'a', 'b', 'c']);
        expect(header('漲跌%').parent!.props['aria-sort']).toBe('ascending');
    });

    it('renders only the columns it is given (the 金流 detail card)', () => {
        act(() => {
            renderer = create(
                createElement(HeatList, {
                    tiles: TILES,
                    now: 10,
                    netTitle: '近 5 分淨流入',
                    nameLabel: '個股',
                    columns: ['pct', 'net'],
                    steps: ['slim'],
                    selectedId: null,
                    label: '成分股',
                    onClick: vi.fn(),
                }),
            );
        });
        expect(renderer!.root.findAllByType('th').map((th) => th.findAll((n) => n.type === 'button').length)).toEqual([0, 1, 1]);
        expect(rowNames()).toEqual(['d', 'a', 'b', 'c']);
    });

    it('sorts by 漲跌% when the sorted column gave way to a narrow pane', () => {
        vi.stubGlobal('document', { documentElement: {} });
        vi.stubGlobal('getComputedStyle', () => ({ fontSize: '16px' }));
        box.width = 200; // 12.5rem: only 漲跌% beside the name
        try {
            act(() => {
                renderer = create(groups(10, null));
            });
            expect(renderer!.root.findAllByType('th').map((th) => th.props.title ?? th.findAllByType('button')[0]?.props.children[0])).toEqual(['族群', '漲跌%']);
            expect(rowNames()).toEqual(['b', 'a', 'd', 'c']);
            expect(header('漲跌%').parent!.props['aria-sort']).toBe('descending');
        } finally {
            box.width = 0;
            vi.unstubAllGlobals();
        }
    });
});

describe('fmtYi', () => {
    it('drops the unit and keeps one decimal', () => {
        expect(fmtYi(643_800_000_000)).toBe('6,438.0');
        expect(fmtYi(31_400_000_000)).toBe('314.0');
        expect(fmtYi(9_680_000_000)).toBe('96.8');
        expect(fmtYi(52_000_000)).toBe('0.5');
    });
});
