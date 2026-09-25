// src/components/option-chain.test.tsx — T 字報價月選＋週選與到期選擇器（issue #152）

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const api = vi.hoisted(() => ({
    fetchOptionRoots: vi.fn(),
    fetchOptions: vi.fn(),
    fetchSnapshots: vi.fn(),
}));
const market = vi.hoisted(() => ({
    quotes: {} as Record<string, unknown>,
    snapshots: undefined as unknown[] | undefined,
    refresh: vi.fn(),
}));
const snapshotCodes = vi.hoisted(() => ({ last: [] as string[] }));

vi.mock('../lib/shioaji', () => api);
vi.mock('../lib/contracts-cache', () => ({
    ensureContract: async (code: string) => ({ code }),
}));
vi.mock('../hooks/use-stream', () => ({
    useQuote: (code: string) => market.quotes[code],
}));
vi.mock('../hooks/use-query', () => ({
    useQuery: () => ({ data: market.snapshots, refresh: market.refresh }),
}));
vi.mock('../hooks/use-live-snapshots', () => ({
    useLiveSnapshots: (contracts: { code: string }[]) => {
        snapshotCodes.last = contracts.map((c) => c.code);
        return { snapshots: new Map(), refresh: vi.fn(), loading: false, error: null };
    },
}));
vi.mock('../lib/option-pick', () => ({ pickOptionLeg: vi.fn() }));

const { OptionChain, EXPIRY_KEY, LEGACY_MONTH_KEY, resetChainContractsCache } = await import('./option-chain');
const { OptionExpiryPicker } = await import('./option-expiry-picker');
const { buildExpiries } = await import('../lib/option-expiry');
const chainStyles = await import('./option-chain.css');

function series(root: string, date: string, weekday: string | undefined, strikes = 10): ContractInfo[] {
    const rows: ContractInfo[] = [];
    for (let i = 0; i < strikes; i++) {
        for (const right of ['C', 'P']) {
            const strike = 40000 + i * 100;
            rows.push({
                security_type: 'OPT',
                exchange: 'TAIFEX',
                code: `${root}${strike}${right}-${date}`,
                target_code: null,
                name: `${root} ${strike}${right}`,
                currency: 'TWD',
                limit_up: 0,
                limit_down: 0,
                reference: 0,
                day_trade: '',
                update_date: '2026-09-24',
                category: '',
                margin_trading_balance: 0,
                short_selling_balance: 0,
                root,
                delivery_month: date.slice(0, 7).replace('-', ''),
                delivery_date: date,
                strike_price: strike,
                option_right: right,
                underlying_code: 'IX0001',
                expiry_weekday: weekday,
            });
        }
    }
    return rows;
}

const BY_ROOT: Record<string, ContractInfo[]> = {
    TXO: series('TXO', '2026-10-21', 'Wed'),
    TX1: series('TX1', '2026-10-07', 'Wed'),
    TXU: series('TXU', '2026-10-02', 'Fri'),
    // 模擬環境真實情況：週五 W4 遇假日調整到 09/29（週二）
    TXY: series('TXY', '2026-09-29', 'Fri'),
};

const placeholderError = () =>
    Object.assign(new Error('500 contracts: decode failed: meta has no info_hash for this shard'), { status: 500 });

let store: Map<string, string>;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-09-25T02:00:00Z')); // 10:00 Taipei
    resetChainContractsCache();
    store = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    market.quotes = { IX0001: { index: { close: '40300', reference: '40250' } } };
    market.snapshots = undefined;
    api.fetchOptionRoots.mockResolvedValue([
        { root: 'TEO', name: '電子選擇權' },
        { root: 'TX1', name: '臺指選擇權 週三W1' },
        { root: 'TXO', name: '臺指選擇權' },
        { root: 'TXU', name: '臺指選擇權 週五W1' },
        { root: 'TXY', name: '臺指選擇權 週五W4' },
        { root: 'TXZ', name: '臺指選擇權 週五W3' },
    ]);
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        return BY_ROOT[root] ?? [];
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function renderChain(onPick = vi.fn()) {
    let r!: ReactTestRenderer;
    await act(async () => {
        r = create(createElement(OptionChain, { onPick }));
    });
    return r;
}

const chips = (r: ReactTestRenderer) =>
    r.root.findAll((n) => n.type === 'button' && n.props['data-expiry'] !== undefined);
const keys = (r: ReactTestRenderer) => chips(r).map((c) => c.props['data-expiry']);
const selected = (r: ReactTestRenderer) =>
    chips(r).find((c) => c.props['aria-checked'])!.props['data-expiry'];
const text = (n: ReactTestInstance): string =>
    n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const fetchedRoots = () => api.fetchOptions.mock.calls.map((c) => c[0] as string);
const atmLabel = (r: ReactTestRenderer) =>
    text(r.root.find((n) => n.type === 'span' && typeof n.props.title === 'string' && n.props.title.includes('為中心')));
const atmStrike = (r: ReactTestRenderer) =>
    r.root
        .findAll((n) => n.type === 'td' && String(n.props.className).includes(chainStyles.atmStrike))
        .map(text);
const refreshButton = (r: ReactTestRenderer) =>
    r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '更新報價');

it('lists weekly and monthly expiries sorted, defaulting to the nearest', async () => {
    const r = await renderChain();
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TX1:2026-10-07', 'TXO:2026-10-21']);
    expect(chips(r).map(text)).toEqual(['09/29週五4天', '10/02週五7天', '10/07週三12天', '10/21月26天']);
    expect(selected(r)).toBe('TXY:2026-09-29');
    // the holiday-shifted weekly is flagged; other indices are not loaded
    expect(chips(r)[0]!.props.title).toContain('原定週五，遇假日調整為週二');
    expect(fetchedRoots().sort()).toEqual(['TX1', 'TXO', 'TXU', 'TXY', 'TXZ']);
});

it('switching to a weekly expiry shows its strikes, quotes and picks its codes', async () => {
    const onPick = vi.fn();
    const r = await renderChain(onPick);
    const tx1 = chips(r).find((c) => c.props['data-expiry'] === 'TX1:2026-10-07')!;
    await act(async () => tx1.props.onClick());
    expect(selected(r)).toBe('TX1:2026-10-07');
    expect(store.get(EXPIRY_KEY)).toBe('TX1:2026-10-07');
    expect(snapshotCodes.last.length).toBeGreaterThan(0);
    expect(snapshotCodes.last.every((c) => c.startsWith('TX1'))).toBe(true);

    const rows = r.root.findAll((n) => n.type === 'tr' && typeof n.props.onClick === 'function');
    const rect = { left: 0, width: 200 };
    const atmRow = rows.find((row) => text(row).includes('40,300'))!;
    act(() => atmRow.props.onClick({ clientX: 10, currentTarget: { getBoundingClientRect: () => rect } }));
    act(() => atmRow.props.onClick({ clientX: 190, currentTarget: { getBoundingClientRect: () => rect } }));
    expect(onPick.mock.calls.map((c) => c[0])).toEqual(['TX140300C-2026-10-07', 'TX140300P-2026-10-07']);
});

it('restores a remembered expiry, or falls back to the nearest once it expired', async () => {
    store.set(EXPIRY_KEY, 'TXO:2026-10-21');
    let r = await renderChain();
    expect(selected(r)).toBe('TXO:2026-10-21');
    act(() => r.unmount());

    store.set(EXPIRY_KEY, 'TX5:2026-09-23');
    r = await renderChain();
    expect(selected(r)).toBe('TXY:2026-09-29');
});

it('drops an expiry after the 13:45 close on its delivery day', async () => {
    vi.setSystemTime(new Date('2026-09-29T05:44:00Z')); // 13:44 Taipei
    store.set(EXPIRY_KEY, 'TXY:2026-09-29');
    const r = await renderChain();
    expect(keys(r)[0]).toBe('TXY:2026-09-29');
    expect(chips(r).map(text)[0]).toBe('09/29週五今日');
    expect(selected(r)).toBe('TXY:2026-09-29');

    // the panel stays mounted across the close → list and selection update
    await act(async () => {
        vi.advanceTimersByTime(2 * 60_000);
    });
    expect(keys(r)).not.toContain('TXY:2026-09-29');
    expect(selected(r)).toBe('TXU:2026-10-02');
});

it('reloads contracts when the Taipei date changes while mounted', async () => {
    vi.setSystemTime(new Date('2026-09-25T15:59:00Z')); // 23:59 Taipei
    const r = await renderChain();
    expect(fetchedRoots().filter((x) => x === 'TXO')).toHaveLength(1);
    expect(chips(r).map(text)[0]).toBe('09/29週五4天');

    BY_ROOT.TX2 = series('TX2', '2026-10-14', 'Wed');
    api.fetchOptionRoots.mockResolvedValue([
        { root: 'TXO', name: '臺指選擇權' },
        { root: 'TX2', name: '臺指選擇權 週三W2' },
        { root: 'TXY', name: '臺指選擇權 週五W4' },
    ]);
    try {
        await act(async () => {
            vi.advanceTimersByTime(2 * 60_000);
        });
        expect(api.fetchOptionRoots).toHaveBeenCalledTimes(2);
        expect(fetchedRoots().filter((x) => x === 'TXO')).toHaveLength(2);
        expect(keys(r)).toEqual(['TXY:2026-09-29', 'TX2:2026-10-14', 'TXO:2026-10-21']);
        expect(chips(r).map(text)[0]).toBe('09/29週五3天');
    } finally {
        delete BY_ROOT.TX2;
    }
});

it('does not cache a one-off failure; retries it but not known placeholders', async () => {
    let txoFails = true;
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        if (root === 'TXO' && txoFails) throw Object.assign(new Error('500 upstream timeout'), { status: 500 });
        return BY_ROOT[root] ?? [];
    });
    const r = await renderChain();
    // weeklies still show (underlying taken from them) while TXO is missing
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TX1:2026-10-07']);

    txoFails = false;
    await act(async () => refreshButton(r).props.onClick());
    expect(keys(r)).toContain('TXO:2026-10-21');
    expect(fetchedRoots().filter((x) => x === 'TXO')).toHaveLength(2);
    expect(fetchedRoots().filter((x) => x === 'TXZ')).toHaveLength(1);
    expect(fetchedRoots().filter((x) => x === 'TX1')).toHaveLength(1);
});

it('falls back to the monthly root when roots cannot be listed, and retries roots', async () => {
    api.fetchOptionRoots.mockRejectedValueOnce(new Error('offline'));
    const r = await renderChain();
    expect(fetchedRoots()).toEqual(['TXO']);
    expect(keys(r)).toEqual(['TXO:2026-10-21']);

    await act(async () => refreshButton(r).props.onClick());
    expect(keys(r)).toHaveLength(4);
});

it('centres on the underlying index, then TXF, then the median, and says which', async () => {
    let r = await renderChain();
    expect(atmLabel(r)).toBe('加權 40,300 +50');
    expect(atmStrike(r)).toEqual(['40,300']);
    act(() => r.unmount());

    market.quotes = { TXFR1: { tick: { close: '40500', price_chg: '-20' } } };
    r = await renderChain();
    expect(atmLabel(r)).toBe('TXF 40,500 -20');
    expect(atmStrike(r)).toEqual(['40,500']);
    act(() => r.unmount());

    market.quotes = {};
    market.snapshots = [{ code: 'IX0001', close: 40200, change_price: 10 }];
    r = await renderChain();
    expect(atmLabel(r)).toBe('加權 40,200 +10');
    act(() => r.unmount());

    market.snapshots = undefined;
    r = await renderChain();
    expect(atmLabel(r)).toBe('中位數置中');
    expect(atmStrike(r)).toEqual([]);
});

it('migrates the old month-only memory to that month’s monthly expiry', async () => {
    store.set(LEGACY_MONTH_KEY, '202610');
    const r = await renderChain();
    expect(selected(r)).toBe('TXO:2026-10-21');
    expect(store.get(EXPIRY_KEY)).toBe('TXO:2026-10-21');
    expect(store.has(LEGACY_MONTH_KEY)).toBe(false);
});

it('prefers the new memory over the old month and still removes the old key', async () => {
    store.set(LEGACY_MONTH_KEY, '202610');
    store.set(EXPIRY_KEY, 'TX1:2026-10-07');
    const r = await renderChain();
    expect(selected(r)).toBe('TX1:2026-10-07');
    expect(store.has(LEGACY_MONTH_KEY)).toBe(false);
});

it('groups chips by month and marks the selection for assistive tech', () => {
    const contracts = Object.values(BY_ROOT).flat() as Parameters<typeof buildExpiries>[0];
    const expiries = buildExpiries(contracts, '2026-09-25');
    const onChange = vi.fn();
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(OptionExpiryPicker, { expiries, value: 'TXU:2026-10-02', onChange }));
    });
    const groups = r.root.findAll((n) => n.props.role === 'group');
    expect(groups.map((g) => g.props['aria-label'])).toEqual(['2026年9月', '2026年10月']);
    expect(groups.map((g) => g.findAll((n) => n.type === 'button').length)).toEqual([1, 3]);
    const radios = r.root.findAll((n) => n.type === 'button' && n.props.role === 'radio');
    expect(radios.filter((b) => b.props['aria-checked']).map((b) => b.props['data-expiry'])).toEqual(['TXU:2026-10-02']);
    expect(radios[2]!.props.title).toBe('2026/10/07（三）到期 · 週三週選（TX1） · 剩 12 天');
    // holiday-shifted date is visibly marked
    expect(radios[0]!.findAll((n) => n.type === 'span' && n.props['data-shifted'] === true)).toHaveLength(1);
    expect(radios[1]!.findAll((n) => n.type === 'span' && n.props['data-shifted'] === true)).toHaveLength(0);
    act(() => radios[3]!.props.onClick());
    expect(onChange).toHaveBeenCalledWith('TXO:2026-10-21');
});

it('prefixes the year on month groups that fall in the next year', () => {
    const contracts = [
        ...BY_ROOT.TXO!,
        ...series('TXO', '2027-03-17', 'Wed'),
    ] as Parameters<typeof buildExpiries>[0];
    const expiries = buildExpiries(contracts, '2026-09-25');
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(OptionExpiryPicker, { expiries, value: expiries[0]!.key, onChange: vi.fn() }));
    });
    const labels = r.root
        .findAll((n) => n.props.role === 'group')
        .map((g) => text(g.findAllByType('span')[0]!));
    expect(labels).toEqual(['10月', '27年3月']);
});
