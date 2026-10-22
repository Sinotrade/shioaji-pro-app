// #330 — 下鑽「其他成員」：無法取得排行當下有效的群組漲跌時顯示「—」，
// 取得時顯示反推的 ≈值
import { createElement } from 'react';
import {
    act,
    create,
    type ReactTestInstance,
    type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IcProjection, IcProjectionState } from '../lib/types/market';

const ROWS_AT = '2026-10-20T13:33:00+08:00';
const m = vi.hoisted(() => ({
    wperfAt: undefined as number | undefined,
    wperfAtCalls: [] as (string | undefined)[],
}));

function state(
    kind: 'ranking' | 'group_metric',
    extra: Partial<IcProjectionState>,
): IcProjectionState {
    return {
        kind,
        date: '2026-10-20',
        calculatedAt: '2026-10-20T13:50:00+08:00',
        marketPhase: 'continuous_trading',
        simtrade: false,
        ...extra,
    };
}
const group = (value: number) => [
    { category: '24', name: '半導體業', item_count: 96, value },
];
const TOP: [string, number, number][] = [
    ['2330', -0.62, 410345],
    ['2454', -1.31, 44129],
    ['2408', -3.21, 8834],
    ['2303', -3.42, 10808],
    ['3189', -3.77, 3383],
    ['3443', -1.09, 6861],
    ['3711', -1.49, 19585],
    ['2344', -1.93, 4575],
    ['6770', -1.84, 2011],
    ['3661', -2.02, 2094],
];

vi.mock('../hooks/use-index-components', () => ({
    useIndexComponents: (_index: unknown, projections: IcProjection[]) => ({
        states: projections.map((p) => {
            if (p.kind === 'ranking') {
                return state('ranking', {
                    calculatedAt: ROWS_AT,
                    entries: TOP.map(([code, pct, ppm], i) => ({
                        code,
                        category: '24',
                        value: 400 - i * 30,
                        price: 100,
                        reference: 100,
                        price_chg: 0,
                        pct_chg: pct,
                        weight_pct: ppm / 10_000,
                        price_source: 'regular',
                        trading_status: 'active',
                        data_status: 'live',
                    })),
                });
            }
            // 群組即時值已走到 13:50 的 -0.24%（與排行不同刻）
            if (p.metric === 'weighted_performance') {
                return state('group_metric', { groups: group(-0.24) });
            }
            if (p.metric === 'amount') {
                return state('group_metric', { groups: group(5000) });
            }
            return state('group_metric', { groups: group(-240) });
        }),
        subErrors: projections.map(() => undefined),
        bootstrap: { status: 'ready' },
    }),
}));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../lib/index-components', () => ({
    getIcBootstrapGroupWeights: () => new Map([['24', 54.7111]]),
    getIcGroupWperfAt: (_code: string, _cat: string, at: string | undefined) => {
        m.wperfAtCalls.push(at);
        return m.wperfAt;
    },
}));
vi.mock('../lib/sector-sync', () => ({
    useFocusedSector: () => ({ category: '24', seq: 1 }),
}));
vi.mock('../lib/trade', () => ({ notify: () => undefined }));
vi.mock('../lib/theme-store', () => ({
    useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: 1 }),
}));
vi.mock('../lib/stock-index', () => ({
    loadStockDetails: () => Promise.resolve([]),
    SECTOR_INDICES: [],
}));

const { SectorHeatmap, initialSizeMetric } = await import('./sector-heatmap');

const text = (n: ReactTestInstance): string =>
    n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;

function otherPctCell() {
    const label = view.root.find(
        (n) => typeof n.type === 'string' && /^其他成員（86 檔）$/.test(text(n)),
    );
    const row = label.parent!;
    const spans = row.children.filter(
        (c): c is ReactTestInstance => typeof c !== 'string',
    );
    return spans[spans.indexOf(label) + 1]!;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    m.wperfAtCalls = [];
});
afterEach(async () => {
    await act(async () => view?.unmount());
    vi.unstubAllGlobals();
});

it('無法取得排行當下有效的群組漲跌 → 其他成員顯示「—」，不再出現 ≈+10%', async () => {
    m.wperfAt = undefined;
    await act(async () => {
        view = create(createElement(SectorHeatmap, {}));
    });
    // 以排行的 calculated_at 查群組漲跌，而不是拿群組的即時值
    expect(m.wperfAtCalls).toContain(ROWS_AT);
    const cell = otherPctCell();
    expect(text(cell)).toBe('—');
    expect(cell.props.title).toMatch(/無法可靠估算/);
    expect(text(view.root)).not.toMatch(/≈\+10\.00%/);
});

it('取得排行當下有效的群組漲跌 → 顯示反推的 ≈值', async () => {
    m.wperfAt = -0.940698;
    await act(async () => {
        view = create(createElement(SectorHeatmap, {}));
    });
    expect(text(otherPctCell())).toBe('≈-2.06%');
});

it('預設面積為貢獻，已存的選擇照舊', () => {
    expect(initialSizeMetric(null)).toBe('contribution');
    expect(initialSizeMetric('bogus')).toBe('contribution');
    expect(initialSizeMetric('weight')).toBe('weight');
    expect(initialSizeMetric('amount')).toBe('amount');
    expect(initialSizeMetric('contribution')).toBe('contribution');
});
