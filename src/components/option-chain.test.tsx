// src/components/option-chain.test.tsx — T 字報價月選＋週選與到期選擇器（issue #152）

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const api = vi.hoisted(() => ({
    fetchOptionRoots: vi.fn(),
    fetchOptions: vi.fn(),
}));
const snapshotCodes = vi.hoisted(() => ({ last: [] as string[] }));

vi.mock('../lib/shioaji', () => api);
vi.mock('../hooks/use-stream', () => ({
    useQuote: () => ({ tick: { close: '40300', price_chg: '12' } }),
}));
vi.mock('../hooks/use-live-snapshots', () => ({
    useLiveSnapshots: (contracts: { code: string }[]) => {
        snapshotCodes.last = contracts.map((c) => c.code);
        return { snapshots: new Map(), refresh: vi.fn(), loading: false, error: null };
    },
}));
vi.mock('../lib/option-pick', () => ({ pickOptionLeg: vi.fn() }));

const { OptionChain, EXPIRY_KEY } = await import('./option-chain');
const { OptionExpiryPicker } = await import('./option-expiry-picker');
const { buildExpiries } = await import('../lib/option-expiry');

function series(root: string, date: string, weekday: string, strikes = 10): ContractInfo[] {
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
                ...({ expiry_weekday: weekday } as object),
            });
        }
    }
    return rows;
}

const BY_ROOT: Record<string, ContractInfo[]> = {
    TXO: series('TXO', '2026-10-21', 'Wed'),
    TX1: series('TX1', '2026-10-07', 'Wed'),
    TXU: series('TXU', '2026-10-02', 'Fri'),
    TXY: series('TXY', '2026-09-29', 'Fri'),
};

let store: Map<string, string>;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T02:00:00Z'));
    store = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
    });
    api.fetchOptionRoots.mockResolvedValue([
        { root: 'TEO', name: '電子選擇權' },
        { root: 'TX1', name: '臺指選擇權 週三W1' },
        { root: 'TXO', name: '臺指選擇權' },
        { root: 'TXU', name: '臺指選擇權 週五W1' },
        { root: 'TXY', name: '臺指選擇權 週五W4' },
        { root: 'TXZ', name: '臺指選擇權 週五W3' },
    ]);
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw new Error('meta has no info_hash for this shard');
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
const selected = (r: ReactTestRenderer) =>
    chips(r).find((c) => c.props['aria-checked'])!.props['data-expiry'];
const text = (n: ReactTestInstance): string =>
    n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');

it('lists weekly and monthly expiries sorted, defaulting to the nearest', async () => {
    const r = await renderChain();
    expect(chips(r).map((c) => c.props['data-expiry'])).toEqual([
        'TXY:2026-09-29',
        'TXU:2026-10-02',
        'TX1:2026-10-07',
        'TXO:2026-10-21',
    ]);
    expect(chips(r).map(text)).toEqual([
        '09/29週五4天',
        '10/02週五7天',
        '10/07週三12天',
        '10/21月26天',
    ]);
    expect(selected(r)).toBe('TXY:2026-09-29');
    // a failing placeholder root does not break the chain; other indices are not loaded
    expect(api.fetchOptions.mock.calls.map((c) => c[0]).sort()).toEqual(['TX1', 'TXO', 'TXU', 'TXY', 'TXZ']);
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
    const atmRow = rows.find((row) => text(row).includes('40,300') || text(row).includes('40300'))!;
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

it('falls back to the monthly root when roots cannot be listed', async () => {
    vi.setSystemTime(new Date('2026-09-26T02:00:00Z')); // new day → reload cache
    api.fetchOptionRoots.mockRejectedValue(new Error('offline'));
    const r = await renderChain();
    expect(api.fetchOptions.mock.calls.map((c) => c[0])).toEqual(['TXO']);
    expect(chips(r).map((c) => c.props['data-expiry'])).toEqual(['TXO:2026-10-21']);
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
    expect(radios[2]!.props.title).toBe('2026/10/07 到期 · 週三週選（TX1）· 剩 12 天');
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
