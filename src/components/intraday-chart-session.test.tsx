// intraday-chart 日盤/夜盤手動切換（issue #73）元件層測試
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created, kbars, T } from './chart-session.test-harness';

vi.mock('lightweight-charts', async () => (await import('./chart-session.test-harness')).lwMock());

let quote: any = undefined;
const listeners = new Set<() => void>();
vi.mock('../hooks/use-stream', async () => {
    const React = await import('react');
    return {
        useQuote: () =>
            React.useSyncExternalStore(
                (l: () => void) => {
                    listeners.add(l);
                    return () => listeners.delete(l);
                },
                () => quote,
            ),
    };
});
const fetchMock = vi.fn();
vi.mock('../lib/chart-history', () => ({
    fetchChartHistory: (...a: unknown[]) => fetchMock(...a),
    nextChartHistoryRevision: () => Math.random(),
}));

import { IntradayChart } from './intraday-chart';
import * as styles from './intraday-chart.css';

const fut = {
    code: 'TXFR1',
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: 'TXFJ6',
    name: '台指期近月',
    currency: 'TWD',
    limit_up: 25000,
    limit_down: 20000,
    reference: 22500,
    day_trade: 'Yes',
    update_date: '',
    category: 'TXF',
    margin_trading_balance: 0,
    short_selling_balance: 0,
} as any;
const stk = { ...fut, code: '2330', security_type: 'STK', exchange: 'TSE', reference: 1000, limit_up: 1100, limit_down: 900 };

function pushTick(date: string, time: string, close: number, extra: any = {}) {
    quote = {
        tick: {
            code: 'TXFR1',
            date,
            time,
            close,
            volume: 1,
            total_volume: 999999,
            price_chg: 0,
            ...extra,
        },
        seq: Math.random(),
        lastDir: 0,
        flashSeq: 0,
    };
    act(() => listeners.forEach((l) => l()));
}

const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => {});
};

const mounted: ReactTestRenderer[] = [];
function mount(props: any) {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(IntradayChart, props), {
            createNodeMock: () => ({ clientWidth: 500, clientHeight: 300, getBoundingClientRect: () => ({ width: 500, height: 300, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {} }),
        });
    });
    mounted.push(r);
    return r;
}
const price = () => {
    const s = created.filter((c) => c.kind === 'Baseline');
    return s[s.length - 1]!;
};
const labelsOf = (d: any[]) => d.map((x) => x.time);
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16);

// Fri 2026-09-25 day, Fri night (running), plus Thu day/night
const DATA = kbars([
    ['2026-09-24T08:45:00', '2026-09-24T13:45:00', () => 22400],
    ['2026-09-24T15:00:00', '2026-09-25T05:00:00', () => 22450],
    ['2026-09-25T08:45:00', '2026-09-25T13:45:00', (t) => 22500 + ((t / 60) % 50)],
    ['2026-09-25T15:00:00', '2026-09-25T20:00:00', () => 22800],
]);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
    });
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    created.length = 0;
    quote = undefined;
    fetchMock.mockReset();
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const setNow = (s: string) => vi.setSystemTime(new Date(`${s}+08:00`));

describe('IntradayChart session toggle', () => {
    it('evening 20:00, auto → night; locked day → today 08:46..13:45; night ticks ignored', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut });
        await flush();
        let d = price().last as any[];
        expect(iso(d[0].time)).toBe('2026-09-25T15:01');
        // chip button present, auto style
        const chip = () =>
            r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        expect(chip().props.className).toBe(styles.sessionChipBtn.auto);
        act(() => chip().props.onClick());
        const items = r.root.findAll((n) => n.type === 'button' && n.props.role === 'menuitemradio');
        expect(items.map((i) => i.children.join(''))).toEqual(['自動', '日盤', '夜盤']);
        const calls = fetchMock.mock.calls.length;
        act(() => items[1]!.props.onClick());
        await flush();
        expect(fetchMock.mock.calls.length).toBe(calls + 1);
        d = price().last as any[];
        expect(iso(d[0].time)).toBe('2026-09-25T08:46');
        expect(iso(d[d.length - 1].time)).toBe('2026-09-25T13:45');
        expect(chip().props.className).toBe(styles.sessionChipBtn.manual);
        expect(chip().children.join('')).toBe('日盤');
        // night tick: no draw, no reload
        const upd = price().update.mock.calls.length;
        const f2 = fetchMock.mock.calls.length;
        pushTick('2026-09-25', '20:01:05', 22810);
        pushTick('2026-09-25', '20:02:05', 22820);
        await flush();
        expect(price().update.mock.calls.length).toBe(upd);
        expect(fetchMock.mock.calls.length).toBe(f2);
    });

    it('locked night during the day session → last night; day ticks ignored', async () => {
        setNow('2026-09-25T10:00:30');
        const data = kbars([
            ['2026-09-24T15:00:00', '2026-09-25T05:00:00', () => 22450],
            ['2026-09-25T08:45:00', '2026-09-25T10:00:00', () => 22500],
        ]);
        fetchMock.mockResolvedValue(data);
        mount({ contract: fut, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        const d = price().last as any[];
        expect(iso(d[0].time)).toBe('2026-09-24T15:01');
        expect(iso(d[d.length - 1].time)).toBe('2026-09-25T05:00');
        const upd = price().update.mock.calls.length;
        const f = fetchMock.mock.calls.length;
        pushTick('2026-09-25', '10:00:40', 22510);
        await flush();
        expect(price().update.mock.calls.length).toBe(upd);
        expect(fetchMock.mock.calls.length).toBe(f);
    });

    it('locked day, 13:45:00 closing print is drawn at 13:45; 15:00 night open ignored', async () => {
        setNow('2026-09-25T13:44:50');
        const data = kbars([['2026-09-25T08:45:00', '2026-09-25T13:44:00', () => 22500]]);
        fetchMock.mockResolvedValue(data);
        mount({ contract: fut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        setNow('2026-09-25T13:45:01');
        pushTick('2026-09-25', '13:45:00', 22555);
        await flush();
        const last = price().update.mock.calls.at(-1)?.[0];
        expect(iso(last.time)).toBe('2026-09-25T13:45');
        expect(last.value).toBe(22555);
        const upd = price().update.mock.calls.length;
        const f = fetchMock.mock.calls.length;
        setNow('2026-09-25T15:00:01');
        pushTick('2026-09-25', '15:00:00', 22600);
        await flush();
        expect(price().update.mock.calls.length).toBe(upd);
        expect(fetchMock.mock.calls.length).toBe(f);
    });

    it('locked day overnight → next-morning 08:30 試撮 switches to the new day session', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        mount({ contract: fut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        const f = fetchMock.mock.calls.length;
        setNow('2026-09-28T08:30:05'); // Monday
        pushTick('2026-09-28', '08:30:00', 22700, { simtrade: true });
        await flush();
        expect(fetchMock.mock.calls.length).toBe(f + 1);
        const d = price().last as any[];
        // new day session frame (empty) – price series should be empty
        expect(d.length).toBe(0);
    });

    it('weekend Saturday 11:00: locked day → Friday day session with date chip', async () => {
        setNow('2026-09-26T11:00:00');
        const data = kbars([
            ['2026-09-25T08:45:00', '2026-09-25T13:45:00', () => 22500],
            ['2026-09-25T15:00:00', '2026-09-26T05:00:00', () => 22800],
        ]);
        fetchMock.mockResolvedValue(data);
        const r = mount({ contract: fut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        const d = price().last as any[];
        expect(iso(d[0].time)).toBe('2026-09-25T08:46');
        const chip = r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        expect(chip.children.join('')).toBe('09/25 日盤');
    });

    it('stocks: no session control', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(kbars([['2026-09-25T09:00:00', '2026-09-25T13:30:00', () => 1000]]));
        const r = mount({ contract: stk, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        expect(r.root.findAll((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu')).toHaveLength(0);
        const d = price().last as any[];
        expect(iso(d[0].time)).toBe('2026-09-25T09:01');
    });

    it('prop cleared (layout loaded without the field) → falls back to default auto', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        let mode: any = undefined;
        const onChange = (m: any) => (mode = m);
        const r = mount({ contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        const chip = () => r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        act(() => chip().props.onClick());
        const items = r.root.findAll((n) => n.type === 'button' && n.props.role === 'menuitemradio');
        act(() => items[1]!.props.onClick());
        act(() => r.update(createElement(IntradayChart, { contract: fut, sessionMode: mode, onSessionModeChange: onChange } as any)));
        await flush();
        expect(chip().children.join('')).toBe('日盤');
        // load another layout whose same-id block has no intradaySession
        act(() => r.update(createElement(IntradayChart, { contract: fut, sessionMode: undefined, onSessionModeChange: onChange } as any)));
        await flush();
        expect(chip().props.className).toBe(styles.sessionChipBtn.auto);
    });

    // 個股期（underlying_kind S）預設停板模式 — 會畫漲跌停線
    const stkFut = { ...fut, code: 'CDFR1', underlying_kind: 'S', limit_up: 22300, limit_down: 20000 };
    const limitLines = () =>
        created.flatMap((c) => c.priceLines).filter((l) => l.price === 22300 || l.price === 20000);
    const lockedChip = (r: ReactTestRenderer) =>
        r.root.findAll((n) => typeof n.type === 'string' && (n.props.className === styles.lockPrice.up || n.props.className === styles.lockPrice.down));

    it('reviewing a past day session: reference from history, no limit lines / lock chip', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stkFut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        const d = price().last as any[];
        expect(iso(d[0].time)).toBe('2026-09-25T08:46');
        // 前一個日盤（09/24）收盤 22400，不是合約快取的 22500
        expect(price().options.baseValue?.price).toBe(22400);
        expect(limitLines()).toHaveLength(0);
        expect(lockedChip(r)).toHaveLength(0);
    });

    it('the live session keeps the contract reference and limit lines', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stkFut, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        expect(price().options.baseValue?.price).toBe(22500);
        expect(limitLines().length).toBeGreaterThan(0);
        expect(lockedChip(r)).toHaveLength(1); // 22800 ≥ 漲停 22300
    });

    it('session chip stays usable while a reload is pending and after a failed load', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(new Promise(() => {})); // 卡住的重載
        let mode: any = 'auto';
        const onChange = (m: any) => (mode = m);
        const r = mount({ contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        const chip = () => r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        act(() => chip().props.onClick());
        const items = r.root.findAll((n) => n.type === 'button' && n.props.role === 'menuitemradio');
        act(() => items[1]!.props.onClick());
        act(() => r.update(createElement(IntradayChart, { contract: fut, sessionMode: mode, onSessionModeChange: onChange } as any)));
        await flush();
        expect(chip().children.join('')).toBe('日盤');
        expect(chip().props.className).toBe(styles.sessionChipBtn.manual);
        // 失敗的載入：仍可切回自動
        fetchMock.mockRejectedValue(new Error('down'));
        const r2 = mount({ contract: fut, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        expect(r2.root.findAll((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu')).toHaveLength(1);
    });

    it('long day-session products (gold, underlying C) keep a plain label', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: { ...fut, code: 'TGFR1', underlying_kind: 'C' }, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        expect(r.root.findAll((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu')).toHaveLength(0);
        // 手動值被忽略 — 照自動畫夜盤
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T15:01');
    });

    it('popout: the inherited session is only an initial value', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut, sessionMode: 'day' });
        await flush();
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T08:46');
        const chip = () => r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        act(() => chip().props.onClick());
        const items = r.root.findAll((n) => n.type === 'button' && n.props.role === 'menuitemradio');
        act(() => items[0]!.props.onClick());
        await flush();
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T15:01');
    });

    const text = (r: ReactTestRenderer) =>
        r.root
            .findAll((n) => typeof n.type === 'string')
            .flatMap((n) => n.children.filter((c) => typeof c === 'string'))
            .join('|');
    const openSettings = (r: ReactTestRenderer) =>
        act(() =>
            r.root
                .find((n) => n.type === 'button' && String(n.props.title ?? '').startsWith('顯示設定'))
                .props.onClick(),
        );

    it('past session: change is marked approximate and band mode explains auto-scale', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stkFut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        expect(text(r)).toContain('≈');
        openSettings(r);
        expect(r.root.findAll((n) => n.props.className === styles.settingsHint)).toHaveLength(1);
    });

    it('live session: no approximate marker, no band hint', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stkFut, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        expect(text(r)).not.toContain('≈');
        openSettings(r);
        expect(r.root.findAll((n) => n.props.className === styles.settingsHint)).toHaveLength(0);
    });

    it('unknown persisted value falls back to 自動', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut, sessionMode: 'foo', onSessionModeChange: () => {} });
        await flush();
        const chip = r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        expect(chip.props.className).toBe(styles.sessionChipBtn.auto);
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T15:01');
    });

    it('manual lock without data on a weekend → latest real session, with its date', async () => {
        // 週六 11:00，範圍內只有夜盤資料 → 鎖日盤退到週五日盤並標日期
        setNow('2026-09-26T11:00:00');
        fetchMock.mockResolvedValue(kbars([['2026-09-25T15:00:00', '2026-09-26T05:00:00', () => 22800]]));
        const r = mount({ contract: fut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        const chip = r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        expect(chip.children.join('')).toBe('09/25 日盤');
    });

    it('manual lock without data today still shows the date', async () => {
        // 週五 10:00 鎖夜盤、範圍內沒有夜盤資料 → 昨晚（週四）夜盤空框架＋日期
        setNow('2026-09-25T10:00:00');
        fetchMock.mockResolvedValue(kbars([['2026-09-25T08:45:00', '2026-09-25T10:00:00', () => 22500]]));
        const r = mount({ contract: fut, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        const chip = r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        expect(chip.children.join('')).toBe('09/24 夜盤');
    });

    it('holiday: locking the same session 自動 shows keeps the official reference', async () => {
        // 週五假日 10:00：資料只到週四夜盤（凌晨 05:00 收）— 自動與鎖夜盤都是那段
        setNow('2026-09-25T10:00:00');
        const data = kbars([
            ['2026-09-24T08:45:00', '2026-09-24T13:45:00', () => 22400],
            ['2026-09-24T15:00:00', '2026-09-25T05:00:00', () => 22450],
        ]);
        fetchMock.mockResolvedValue(data);
        const r = mount({ contract: stkFut, sessionMode: 'night', onSessionModeChange: () => {} });
        await flush();
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-24T15:01');
        expect(price().options.baseValue?.price).toBe(22500); // 合約官方參考價
        expect(text(r)).not.toContain('≈');
        expect(limitLines().length).toBeGreaterThan(0);
    });

    // 回歸：同一張已掛載的圖切時段後歷史失敗/空 → 不可殘留前一段走勢
    const seriesOf = (kind: string) => created.filter((c) => c.kind === kind);
    const dataPoints = () =>
        ['Baseline', 'Bar', 'Histogram'].flatMap((k) =>
            seriesOf(k).flatMap((c) => (c.last as any[]).filter((p) => p.value !== undefined || p.close !== undefined)),
        );
    const switchTo = async (r: ReactTestRenderer, label: string, rerender: (m: any) => void) => {
        const chip = r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
        act(() => chip.props.onClick());
        const item = r.root.find((n) => n.type === 'button' && n.props.role === 'menuitemradio' && n.children.join('') === label);
        act(() => item.props.onClick());
        rerender(label === '日盤' ? 'day' : label === '夜盤' ? 'night' : 'auto');
        await flush();
    };

    for (const [name, second] of [
        ['rejects', () => Promise.reject(new Error('403'))],
        ['returns empty', () => Promise.resolve(kbars([]))],
    ] as const) {
        it(`switching auto(night) → 日盤 when history ${name} leaves no night data`, async () => {
            setNow('2026-09-25T20:00:30');
            fetchMock.mockResolvedValueOnce(DATA);
            fetchMock.mockImplementation(second);
            let mode: any = 'auto';
            const onChange = (m: any) => (mode = m);
            const r = mount({ contract: fut, sessionMode: mode, onSessionModeChange: onChange });
            await flush();
            expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T15:01');
            await switchTo(r, '日盤', (m) =>
                act(() => r.update(createElement(IntradayChart, { contract: fut, sessionMode: m, onSessionModeChange: onChange } as any))),
            );
            expect(fetchMock).toHaveBeenCalledTimes(2);
            const chip = r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu');
            expect(chip.children.join('')).toContain('日盤');
            expect(dataPoints()).toHaveLength(0);
        });
    }

    it('manual 更新歷史 failing (403) clears the stale curve', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockRejectedValue(new Error('HTTP 403'));
        const r = mount({ contract: fut, sessionMode: 'auto', onSessionModeChange: () => {} });
        await flush();
        expect(dataPoints().length).toBeGreaterThan(0);
        const refresh = r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '更新歷史');
        act(() => refresh.props.onClick());
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(dataPoints()).toHaveLength(0);
    });

    it('same-session settings reload keeps the curve (no flash)', async () => {
        setNow('2026-09-25T20:00:30');
        let resolve!: (v: unknown) => void;
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(new Promise((res) => (resolve = res)));
        const r = mount({ contract: fut, sessionMode: 'auto', onSessionModeChange: () => {} });
        await flush();
        const refresh = r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '更新歷史');
        act(() => refresh.props.onClick());
        await flush();
        // 重載進行中：同時段資料仍在
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T15:01');
        resolve(DATA);
        await flush();
        expect(iso((price().last as any[])[0].time)).toBe('2026-09-25T15:01');
    });
});
