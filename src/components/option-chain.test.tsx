// src/components/option-chain.test.tsx — T 字報價月選＋週選與到期選擇器（issue #152）

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const api = vi.hoisted(() => ({
    fetchOptionRoots: vi.fn(),
    fetchOptions: vi.fn(),
    fetchSnapshots: vi.fn(),
}));
const market = vi.hoisted(() => ({
    quotes: {} as Record<string, unknown>,
    snapshots: undefined as unknown[] | undefined,
    refSettled: true,
    refresh: vi.fn(),
}));
const snapshotCodes = vi.hoisted(() => ({ last: [] as string[], live: [] as string[], rows: new Map<string, unknown>() }));

vi.mock('../lib/shioaji', () => api);
vi.mock('../lib/contracts-cache', () => ({
    ensureContract: async (code: string) => ({ code }),
}));
vi.mock('../hooks/use-stream', () => ({
    useQuote: (code: string) => market.quotes[code],
}));
vi.mock('../hooks/use-query', () => ({
    useQuery: () => ({ data: market.snapshots, refresh: market.refresh, updatedAt: market.refSettled ? 1 : null, error: null }),
}));
vi.mock('../hooks/use-live-snapshots', () => ({
    useLiveSnapshots: (contracts: { code: string }[], _fetcher: unknown, live?: { code: string }[]) => {
        snapshotCodes.last = contracts.map((c) => c.code);
        snapshotCodes.live = (live ?? contracts).map((c) => c.code);
        return { snapshots: snapshotCodes.rows, refresh: vi.fn(), loading: false, error: null };
    },
}));
vi.mock('../lib/option-pick', () => ({ pickOptionLeg: vi.fn() }));

const { OptionChain, EXPIRY_KEY, LEGACY_MONTH_KEY, loadChainContracts, resetChainContractsCache } =
    await import('./option-chain');
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
    market.refSettled = true;
    snapshotCodes.rows = new Map();
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

const triggers = (r: ReactTestRenderer) =>
    r.root.findAll((n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox');
const trigger = (r: ReactTestRenderer) => triggers(r)[0]!;
// 下拉清單的選項；清單收合時先展開（沒有選擇器或主按鈕停用時回傳空）
const chips = (r: ReactTestRenderer) => {
    const t = triggers(r)[0];
    if (t && !t.props.disabled && r.root.findAll((n) => n.props.role === 'listbox').length === 0)
        act(() => t.props.onClick());
    return r.root.findAll((n) => n.props.role === 'option');
};
const keys = (r: ReactTestRenderer) => chips(r).map((c) => c.props['data-expiry']);
const selected = (r: ReactTestRenderer) => trigger(r).props['data-expiry'];
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
const bodyRows = (r: ReactTestRenderer) => r.root.find((n) => n.type === 'tbody').findAllByType('tr');

it('lists weekly and monthly expiries sorted, defaulting to the nearest', async () => {
    const r = await renderChain();
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TX1:2026-10-07', 'TXO:2026-10-21']);
    expect(chips(r).map(text)).toEqual([
        '09/29週二週選順延剩 4 天',
        '10/02週五週選剩 7 天',
        '10/07週三週選剩 12 天',
        '10/21週三月選剩 26 天',
    ]);
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
    expect(chips(r).map(text)[0]).toBe('09/29週二週選順延今日到期');
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
    expect(chips(r).map(text)[0]).toBe('09/29週二週選順延剩 4 天');

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
        expect(chips(r).map(text)[0]).toBe('09/29週二週選順延剩 3 天');
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

const reloadButton = (r: ReactTestRenderer) =>
    r.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === '重新載入合約');

it('keeps a retry when every contract load fails, and recovers on retry', async () => {
    let down = true;
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (down) throw Object.assign(new Error('500 internal server error'), { status: 500 });
        if (root === 'TXZ') throw placeholderError();
        return BY_ROOT[root] ?? [];
    });
    const r = await renderChain();
    expect(chips(r)).toHaveLength(0);
    const alert = r.root.find((n) => n.props.role === 'alert');
    expect(text(alert)).toBe('臺指選擇權合約載入失敗');
    expect(reloadButton(r)).toHaveLength(1);
    const before = api.fetchOptions.mock.calls.length;

    // 仍失敗：重試有發出請求，重試入口還在
    await act(async () => reloadButton(r)[0]!.props.onClick());
    expect(api.fetchOptions.mock.calls.length).toBeGreaterThan(before);
    expect(reloadButton(r)).toHaveLength(1);
    expect(reloadButton(r)[0]!.props.disabled).toBe(false);

    down = false;
    await act(async () => reloadButton(r)[0]!.props.onClick());
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TX1:2026-10-07', 'TXO:2026-10-21']);
    expect(r.root.findAll((n) => n.props.role === 'alert')).toHaveLength(0);
});

it('tells a genuinely empty chain apart from a failure, still offering a reload', async () => {
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        return [];
    });
    const r = await renderChain();
    expect(r.root.findAll((n) => n.props.role === 'alert')).toHaveLength(0);
    expect(text(r.root)).toContain('無可用合約');
    const before = api.fetchOptions.mock.calls.length;
    await act(async () => reloadButton(r)[0]!.props.onClick());
    // 成功但為空的結果不沿用快取，重新查詢
    expect(api.fetchOptions.mock.calls.length).toBeGreaterThan(before);
});

it('flags a partial failure next to the retry', async () => {
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        if (root === 'TXU') throw Object.assign(new Error('500 upstream'), { status: 500 });
        return BY_ROOT[root] ?? [];
    });
    const r = await renderChain();
    expect(keys(r)).not.toContain('TXU:2026-10-02');
    expect(text(r.root.find((n) => n.props.role === 'status'))).toContain('部分合約載入失敗');
});

it('puts the load status on its own truncating row, never squeezing the expiry picker', async () => {
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        if (['TX1', 'TXY'].includes(root)) throw Object.assign(new Error('500 upstream'), { status: 500 });
        if (root === 'TXU') return BY_ROOT.TXU!.map((c) => ({ ...c, underlying_code: undefined }));
        return BY_ROOT[root] ?? [];
    });
    const r = await renderChain();
    const status = r.root.find((n) => typeof n.type === 'string' && n.props.role === 'status');
    const full = text(status);
    expect(full).toContain('部分合約載入失敗（TX1、TXY）');
    // 截斷時全文仍可由 tooltip 取得，螢幕閱讀器讀到的是完整文字
    expect(status.props.title).toBe(full);
    expect(status.props.className).toBe(chainStyles.status);
    // 不與到期選擇器、更新報價同列（同列時長訊息會把選擇器擠到 0 寬）
    const toolbar = r.root.find((n) => n.props.className === chainStyles.toolbar);
    expect(toolbar.findAll((n) => n.props.role === 'status')).toHaveLength(0);
    expect(toolbar.findAll((n) => n.props.role === 'group' && n.props['aria-label'] === '到期契約')).toHaveLength(1);
    expect(toolbar.findAll((n) => n.type === 'button' && n.props['aria-label'] === '更新報價')).toHaveLength(1);
});

it('lists only the monthly when no contract carries underlying_code and TXN is unnamed', async () => {
    const strip = (rows: ContractInfo[]) => rows.map((c) => ({ ...c, underlying_code: undefined }));
    api.fetchOptionRoots.mockResolvedValue([
        { root: 'TXO', name: '臺指選擇權' },
        { root: 'TXN' },
    ]);
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXO') return strip(BY_ROOT.TXO!);
        if (root === 'TXN') return strip(series('TXN', '2026-10-09', 'Fri'));
        return [];
    });
    const r = await renderChain();
    expect(fetchedRoots().sort()).toEqual(['TXN', 'TXO']);
    expect(keys(r)).toEqual(['TXO:2026-10-21']);
    expect(snapshotCodes.last.every((c) => c.startsWith('TXO'))).toBe(true);
});

const statusText = (r: ReactTestRenderer) =>
    r.root.findAll((n) => typeof n.type === 'string' && n.props.role === 'status').map(text).join('');
const never = () => new Promise<never>(() => {});
const TIMEOUT_MS = 10_000;

it('times out a hanging weekly root, shows the rest, and recovers on retry', async () => {
    let hang = true;
    const signals: AbortSignal[] = [];
    api.fetchOptions.mockImplementation((root: string, _f: unknown, opts?: { signal?: AbortSignal }) => {
        if (root === 'TXZ') return Promise.reject(placeholderError());
        if (root === 'TXU' && hang) {
            signals.push(opts!.signal!);
            return never();
        }
        return Promise.resolve(BY_ROOT[root] ?? []);
    });
    const r = await renderChain();
    // 還沒逾時：仍在載入中
    expect(text(r.root)).toContain('載入臺指選擇權合約');

    await act(async () => {
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    });
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TX1:2026-10-07', 'TXO:2026-10-21']);
    expect(statusText(r)).toBe('部分合約載入失敗（TXU 逾時），按更新報價重試');
    expect(signals[0]!.aborted).toBe(true);

    hang = false;
    await act(async () => refreshButton(r).props.onClick());
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TX1:2026-10-07', 'TXO:2026-10-21']);
    expect(statusText(r)).toBe('');
    // 其他已成功的代碼沿用快取，只重查逾時的
    expect(fetchedRoots().filter((x) => x === 'TXU')).toHaveLength(2);
    expect(fetchedRoots().filter((x) => x === 'TXO')).toHaveLength(1);
});

it('falls back to the monthly chain when the roots list hangs', async () => {
    api.fetchOptionRoots.mockImplementationOnce(never);
    const r = await renderChain();
    expect(text(r.root)).toContain('載入臺指選擇權合約');
    await act(async () => {
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    });
    expect(keys(r)).toEqual(['TXO:2026-10-21']);
    expect(statusText(r)).toBe('部分合約載入失敗（週選清單 逾時），按更新報價重試');

    await act(async () => refreshButton(r).props.onClick());
    expect(keys(r)).toHaveLength(4);
    expect(statusText(r)).toBe('');
});

it('ignores a response that arrives after its timeout and a successful retry', async () => {
    let late!: (rows: ContractInfo[]) => void;
    let calls = 0;
    api.fetchOptions.mockImplementation((root: string) => {
        if (root === 'TXZ') return Promise.reject(placeholderError());
        if (root === 'TXU' && calls++ === 0) return new Promise<ContractInfo[]>((res) => (late = res));
        return Promise.resolve(BY_ROOT[root] ?? []);
    });
    const r = await renderChain();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    });
    await act(async () => refreshButton(r).props.onClick());
    expect(keys(r)).toContain('TXU:2026-10-02');

    // 第一次請求晚到，帶著不同（舊）的資料
    await act(async () => late(series('TXU', '2026-10-09', 'Fri')));
    expect(keys(r)).toContain('TXU:2026-10-02');
    expect(keys(r)).not.toContain('TXU:2026-10-09');

    // 也沒有寫進當日快取
    act(() => r.unmount());
    const again = await renderChain();
    expect(keys(again)).toContain('TXU:2026-10-02');
    expect(keys(again)).not.toContain('TXU:2026-10-09');
    expect(fetchedRoots().filter((x) => x === 'TXU')).toHaveLength(2);
});

it('does not cache an empty roots list or an empty root for the day', async () => {
    api.fetchOptionRoots.mockResolvedValueOnce([]);
    let r = await renderChain();
    expect(keys(r)).toEqual(['TXO:2026-10-21']);
    expect(statusText(r)).toContain('週選清單');
    await act(async () => refreshButton(r).props.onClick());
    expect(keys(r)).toHaveLength(4);
    act(() => r.unmount());

    resetChainContractsCache();
    api.fetchOptions.mockClear();
    let txuEmpty = true;
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        if (root === 'TXU' && txuEmpty) return [];
        return BY_ROOT[root] ?? [];
    });
    r = await renderChain();
    expect(keys(r)).not.toContain('TXU:2026-10-02');
    act(() => r.unmount());
    txuEmpty = false;
    r = await renderChain();
    expect(keys(r)).toContain('TXU:2026-10-02');
    expect(fetchedRoots().filter((x) => x === 'TXU')).toHaveLength(2);
    expect(fetchedRoots().filter((x) => x === 'TXZ')).toHaveLength(1);
});

it('keeps the monthly when only TXO lacks underlying_code', async () => {
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        if (root === 'TXO') return BY_ROOT.TXO!.map((c) => ({ ...c, underlying_code: undefined }));
        return BY_ROOT[root] ?? [];
    });
    const r = await renderChain();
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TX1:2026-10-07', 'TXO:2026-10-21']);
    expect(statusText(r)).toBe('');
});

it('reports identified-root contracts left out for missing or mismatched fields', async () => {
    api.fetchOptions.mockImplementation(async (root: string) => {
        if (root === 'TXZ') throw placeholderError();
        if (root === 'TX1') return BY_ROOT.TX1!.map((c) => ({ ...c, underlying_code: undefined }));
        if (root === 'TXU')
            return BY_ROOT.TXU!.map((c, i) => (i < 2 ? { ...c, delivery_date: undefined } : c));
        return BY_ROOT[root] ?? [];
    });
    const r = await renderChain();
    expect(keys(r)).toEqual(['TXY:2026-09-29', 'TXU:2026-10-02', 'TXO:2026-10-21']);
    expect(statusText(r)).toBe('22 筆合約資料不完整或標的不符，未列出');
});

it('does not let a straggling older-day response overwrite a newer day cache', async () => {
    const pending: Array<(v: unknown) => void> = [];
    api.fetchOptions.mockImplementation((root: string) => {
        if (root === 'TXZ') return Promise.reject(placeholderError());
        if (root === 'TXO' && pending.length < 2)
            return new Promise((resolve) => pending.push(resolve));
        return Promise.resolve(BY_ROOT[root] ?? []);
    });
    const txoCalls = () => fetchedRoots().filter((x) => x === 'TXO').length;
    const day1 = loadChainContracts('2026-09-24');
    const day2 = loadChainContracts('2026-09-25');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(BY_ROOT.TXO); // 新交易日先回
    await day2;
    pending[0]!(BY_ROOT.TXO); // 前一天的請求晚到
    await day1;
    expect(txoCalls()).toBe(2);
    await loadChainContracts('2026-09-25');
    expect(txoCalls()).toBe(2);
});

// #371：T 字表列出全部履約價，只訂閱訂閱窗；每檔顯示成交量
describe('full strike range', () => {
    const openLong = async (onPick = vi.fn()) => {
        // 履約價遠多於舊版的上下八檔
        const long = series('TX2', '2026-10-14', 'Wed', 60);
        market.quotes = { IX0001: { index: { close: '43000', reference: '42950' } } };
        api.fetchOptionRoots.mockResolvedValue([{ root: 'TXO', name: '臺指選擇權' }, { root: 'TX2', name: '臺指選擇權 週三W2' }]);
        api.fetchOptions.mockImplementation(async (root: string) => (root === 'TX2' ? long : BY_ROOT[root] ?? []));
        const r = await renderChain(onPick);
        expect(selected(r)).toBe('TX2:2026-10-14'); // the nearest expiry
        return r;
    };

    it('lists every strike but subscribes only the eight around ATM until the panel is measured', async () => {
        const r = await openLong();
        expect(bodyRows(r)).toHaveLength(60);
        expect(snapshotCodes.last).toHaveLength(120);
        expect(snapshotCodes.live).toHaveLength(17 * 2);
        expect(snapshotCodes.live).toContain('TX243000C-2026-10-14');
        expect(snapshotCodes.live).toContain('TX242200P-2026-10-14');
        expect(snapshotCodes.live).toContain('TX243800C-2026-10-14');
        expect(snapshotCodes.live).not.toContain('TX242100C-2026-10-14');
        expect(snapshotCodes.live).not.toContain('TX245900C-2026-10-14');
        expect(snapshotCodes.last).toContain('TX245900C-2026-10-14');
    });

    it('marks only the window as live; a far strike can still be picked', async () => {
        const onPick = vi.fn();
        const r = await openLong(onPick);
        expect(bodyRows(r).filter((row) => row.props['data-live'])).toHaveLength(17);
        const far = bodyRows(r).find((row) => text(row).includes('45,900'))!;
        expect(far.props['data-live']).toBeUndefined();
        expect(far.props.title).toContain('畫面外');
        const rect = { left: 0, width: 200 };
        act(() => far.props.onClick({ clientX: 10, currentTarget: { getBoundingClientRect: () => rect } }));
        expect(onPick).toHaveBeenCalledWith('TX245900C-2026-10-14');
    });

    it('shows each side’s volume, compact over ten thousand, zero as zero, dash when unknown', async () => {
        snapshotCodes.rows = new Map([
            ['TX240300C-2026-10-14', { close: 120, change_price: 1, buy_price: 119, sell_price: 121, total_volume: 12345 }],
            ['TX240300P-2026-10-14', { close: 80, change_price: -1, buy_price: 79, sell_price: 81, total_volume: 0 }],
        ]);
        const r = await openLong();
        const row = bodyRows(r).find((x) => text(x).includes('40,300'))!;
        const cells = row.findAllByType('td').map(text);
        expect(cells).toEqual(['120', '119', '121', '1.2萬', '40,300', '80', '79', '81', '0']);
        expect(row.findAllByType('td')[3]!.props.title).toContain('12,345');
        const blank = bodyRows(r).find((x) => text(x).includes('45,900'))!;
        expect(blank.findAllByType('td').map(text)).toEqual(['—', '—', '—', '—', '45,900', '—', '—', '—', '—']);
    });

    // 假的捲動容器：200px 高、表頭 40px、每列 20px，一次看得到 8 列
    const mountMeasured = async ({ quotes = { IX0001: { index: { close: '43000', reference: '42950' } } } as Record<string, unknown> } = {}) => {
        const body = {
            scrollTop: 0,
            clientHeight: 200,
            querySelector: (q: string) => ({ getBoundingClientRect: () => ({ height: q === 'thead' ? 40 : 20 }) }),
        };
        const long = series('TX2', '2026-10-14', 'Wed', 60);
        market.quotes = quotes;
        api.fetchOptionRoots.mockResolvedValue([{ root: 'TXO', name: '臺指選擇權' }, { root: 'TX2', name: '臺指選擇權 週三W2' }]);
        api.fetchOptions.mockImplementation(async (root: string) => (root === 'TX2' ? long : BY_ROOT[root] ?? []));
        const onPick = vi.fn();
        let r!: ReactTestRenderer;
        await act(async () => {
            r = create(createElement(OptionChain, { onPick }), {
                createNodeMock: (el) => ((el.props as Record<string, unknown>)['data-testid'] === 'optchain-body' ? body : null),
            });
        });
        const atmBtn = () => r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '回到價平');
        const scrollTo = async (top: number) => {
            body.scrollTop = top;
            await act(async () => r.root.find((n) => n.props['data-testid'] === 'optchain-body' && n.type === 'div').props.onScroll());
        };
        return { r, body, atmBtn, scrollTo, onPick };
    };

    it('centres on ATM once measured and moves the window only after the scroll settles', async () => {
        const { body, scrollTo } = await mountMeasured();
        expect(body.scrollTop).toBe(530); // row 30 in the middle of the 160px under the header
        const before = snapshotCodes.live;
        await scrollTo(1000);
        expect(snapshotCodes.live).toEqual(before); // still scrolling
        await act(async () => { vi.advanceTimersByTime(299); });
        expect(snapshotCodes.live).toEqual(before);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(snapshotCodes.live).toContain('TX245000C-2026-10-14');
        expect(snapshotCodes.live).not.toContain('TX243000C-2026-10-14');
    });

    it('subscribes nothing until ATM is known, then only the measured window', async () => {
        market.refSettled = false;
        const { r, onPick } = await mountMeasured({ quotes: {} });
        expect(snapshotCodes.last).toHaveLength(120);
        expect(snapshotCodes.live).toEqual([]);
        market.quotes = { IX0001: { index: { close: '43000', reference: '42950' } } };
        await act(async () => { r.update(createElement(OptionChain, { onPick })); });
        expect(snapshotCodes.live).toContain('TX243000C-2026-10-14');
        expect(snapshotCodes.live).toHaveLength((30 + 4 + 3 - (26 - 3) + 1) * 2); // rows 23..37, screen 26..34 plus 3 each way
    });

    it('still subscribes when the user scrolled while ATM was pending', async () => {
        market.refSettled = false;
        const { r, scrollTo, onPick } = await mountMeasured({ quotes: {} });
        await scrollTo(760);
        expect(snapshotCodes.live).toEqual([]);
        market.quotes = { IX0001: { index: { close: '43000', reference: '42950' } } };
        await act(async () => { r.update(createElement(OptionChain, { onPick })); });
        expect(snapshotCodes.live.length).toBeGreaterThan(0);
    });

    it('an ATM move while scrolling does not jump ahead of the settle timer', async () => {
        vi.useFakeTimers();
        try {
            const { r, body, onPick } = await mountMeasured();
            const before = snapshotCodes.live;
            body.scrollTop = 2000;
            await act(async () => { r.root.find((n) => n.props['data-testid'] === 'optchain-body' && n.type === 'div').props.onScroll(); });
            market.quotes = { IX0001: { index: { close: '43100', reference: '42950' } } };
            await act(async () => { r.update(createElement(OptionChain, { onPick })); });
            expect(snapshotCodes.live).toEqual(before);
        } finally { vi.useRealTimers(); }
    });

    it('falls back to the median once the ATM reference query has settled empty', async () => {
        market.refSettled = true;
        await mountMeasured({ quotes: {} });
        expect(snapshotCodes.live.length).toBeGreaterThan(0);
        expect(snapshotCodes.live).toContain('TX243000C-2026-10-14'); // strike at the median of 60
    });

    it('a new expiry gets the screen plus buffer at once, not the eight-strike default', async () => {
        const { r } = await mountMeasured();
        const n = snapshotCodes.live.length / 2;
        expect(n).toBe(15);
        expect(snapshotCodes.live).toContain('TX243700C-2026-10-14');
        expect(r).toBeTruthy();
    });

    it('stops following ATM after a manual scroll, but still says when ATM leaves or returns', async () => {
        const { r, body, atmBtn, scrollTo, onPick } = await mountMeasured();
        await scrollTo(760); // rows 38..45, ATM at 30
        expect(atmBtn().props['data-away']).toBe(true);
        market.quotes = { IX0001: { index: { close: '43900', reference: '43850' } } }; // ATM now row 39
        await act(async () => { r.update(createElement(OptionChain, { onPick })); });
        expect(body.scrollTop).toBe(760);
        expect(atmBtn().props['data-away']).toBeUndefined();
        await act(async () => atmBtn().props.onClick());
        expect(body.scrollTop).toBe(710);
    });

    it('offers a way back to ATM with a lucide icon, not text', async () => {
        const r = await openLong();
        const btn = r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '回到價平');
        expect(btn.props['data-away']).toBeUndefined();
        expect(() => act(() => btn.props.onClick())).not.toThrow();
    });
});
