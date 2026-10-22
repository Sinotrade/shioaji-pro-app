// QuoteBoard 渲染內容：個股成對兩行（高低、開量、停板）與指數看板，代號名稱交給標題列、
// 參考價與時間收進滑過提示；價格固定小數位；指數與個股各自記收合偏好
import { createElement } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
    };
    return store;
});

let display: any = {};
vi.mock('../hooks/use-display-book', () => ({ useSnapshotBaseline: () => ({ snapshot: display.snapshot }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => display.quote }));
// 包住真的 useBoardTier，記下看板傳進去的階梯（有軌道時應該是 RAIL_TIERS）
const tierCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../hooks/use-board-tier', async (importOriginal) => {
    const real = await importOriginal<typeof import('../hooks/use-board-tier')>();
    return {
        ...real,
        useBoardTier: (...args: Parameters<typeof real.useBoardTier>) => {
            tierCalls.push(args);
            return real.useBoardTier(...args);
        },
    };
});
// 記下每次 useQuery 的 fetcher、key 與 enabled，驗證什麼情況下才會重抓快照、重抓什麼
const queryCalls = vi.hoisted(
    () => [] as { fetcher: () => Promise<unknown>; key: string; enabled: boolean | undefined }[],
);
// 依 key 給回傳資料（預設都沒有資料、還沒抓完）；有設定的 key 視為已抓完（值可以是 undefined：抓完但沒資料）
const queryData = vi.hoisted(() => new Map<string, unknown>());
const queryErrors = vi.hoisted(() => new Map<string, string>());
vi.mock('../hooks/use-query', () => ({
    useQuery: (fetcher: () => Promise<unknown>, key: string, enabled?: boolean) => {
        queryCalls.push({ fetcher, key, enabled });
        const done = enabled && queryData.has(key);
        const error = (enabled && queryErrors.get(key)) || null;
        return { data: done ? queryData.get(key) : undefined, error, loading: false, updatedAt: done ? 1 : null, refresh: async () => {} };
    },
}));
const fetchSnapshots = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));
const fetchKbars = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ datetime: [], Amount: [] })));
vi.mock('../lib/shioaji', () => ({ fetchKbars, fetchSnapshots }));
// 重抓後以 store 裡的快照判斷是否已翻日
// 產業標籤點了呼叫 focusSector（產業全景監聽它下鑽）
const focusSector = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
vi.mock('../lib/sector-sync', () => ({ focusSector }));
const getMarketSnapshot = vi.hoisted(() => vi.fn((..._args: unknown[]): { datetime: string } | undefined => undefined));
vi.mock('../lib/market-snapshot-store', () => ({ getMarketSnapshot }));

import { BOARD_TIERS, RAIL_TIERS, STOCK_TIERS } from '../lib/board-tier';
import { wallClockToUtc } from '../lib/utils/kbars';
import * as panel from './panel.css';
import { QuoteBoard } from './quote-board';
import * as styles from './quote-board.css';

const STOCK = {
    code: '2330',
    name: '台積電',
    exchange: 'TSE',
    security_type: 'STK',
    target_code: null,
    reference: 2440,
    limit_up: 2680,
    limit_down: 2200,
} as any;

// 數值刻意都不同，對調任何兩格都會被抓到
const tick = {
    close: '2420',
    price_chg: '-20',
    open: '2430',
    high: '2445',
    low: '2415',
    total_volume: 33257,
    volume: 12,
    time: '13:29:15.123',
};
const book = { source: 'stream', time: '13:29:15', bids: [{ price: 2420, vol: 508 }], asks: [{ price: 2425, vol: 698 }] };

// width：給軌道一個量得到的寬度，讓 SVG 真的畫出來（預設不給，跟隱藏時一樣只留數字）
function render(contract: any, width?: number) {
    let root!: ReturnType<typeof create>;
    act(() => {
        root = create(
            createElement(QuoteBoard, { contract }),
            width === undefined ? undefined : { createNodeMock: () => ({ clientWidth: width }) },
        );
    });
    return root;
}

// 元素底下所有文字串起來（子節點有字串也有元素時用，texts 只收子節點全是字串的葉節點）
function allText(node: ReactTestInstance): string {
    return node.children.map((c) => (typeof c === 'string' ? c : allText(c))).join('');
}

// 依 DOM 順序收集葉節點文字
function texts(node: ReactTestInstance): string[] {
    return node
        .findAll((n) => typeof n.type === 'string' && n.children.length > 0 && n.children.every((c) => typeof c === 'string'))
        .map((n) => (n.children as string[]).join(''));
}

function titles(node: ReactTestInstance): string[] {
    return node.findAll((n) => typeof n.props.title === 'string').map((n) => n.props.title as string);
}

// vanilla-extract 組合樣式的 class 是多個名稱，全部都要在元素上才算
const hasClass = (cls: string) => (n: ReactTestInstance) => {
    if (typeof n.type !== 'string') return false;
    const own = String(n.props.className ?? '').split(' ');
    return cls.split(' ').every((c) => own.includes(c));
};

afterEach(() => {
    storage.clear();
    fetchSnapshots.mockClear();
    getMarketSnapshot.mockReset();
});

describe('個股看板（成對兩行）', () => {
    it('試撮與純快照有狀態標籤及提示，真成交後不留舊狀態', () => {
        display = { quote: { tick: { ...tick, simtrade: true } } };
        const simulated = render(STOCK).root;
        expect(allText(simulated.find(hasClass(styles.statusBadge)))).toBe('試撮');
        expect(titles(simulated)).toContain('試撮揭示價，非成交價\n更新 13:29:15');
        display = { snapshot: { code: '2330', close: 2420, datetime: '2026-10-16 13:30:00' } };
        const snapshot = render(STOCK).root;
        expect(allText(snapshot.find(hasClass(styles.statusBadge)))).toBe('快照');
        expect(titles(snapshot)).toContain('快照 2026-10-16 13:30:00，尚未收到即時成交');
        expect(hasClass(styles.tipCell)(snapshot.find(hasClass(styles.board)).children[0] as ReactTestInstance)).toBe(true);
        // 伺服器可能回 ISO 格式（帶 T 與小數秒），提示只留到秒
        display = { snapshot: { code: '2330', close: 2420, datetime: '2026-10-16T14:30:00.123456' } };
        expect(titles(render(STOCK).root)).toContain('快照 2026-10-16 14:30:00，尚未收到即時成交');
        display = { quote: { tick: { ...tick, simtrade: false } } };
        expect(render(STOCK).root.findAll(hasClass(styles.statusBadge))).toHaveLength(0);
    });

    it('盤前試撮還沒有開高低（0）時顯示空值符號，不顯示 0.00', () => {
        display = { quote: { tick: { ...tick, simtrade: true, open: '0', high: '0', low: '0', total_volume: 0 } } };
        const shown = texts(render(STOCK).root);
        expect(shown).not.toContain('0.00');
        expect(shown.filter((t) => t === '—').length).toBeGreaterThanOrEqual(3);
    });

    it('試撮價剛好在漲停：窄階梯留「試撮」、收起停板徽章，區間軌照常畫現價針', () => {
        // 13:25 收盤試撮：已經有開高低，試撮價在漲停
        const atUp = { ...tick, close: '2680', price_chg: '240', high: '2680' };
        display = { quote: { tick: { ...atUp, simtrade: true } } };
        const root = render(STOCK).root;
        expect(root.find(hasClass(styles.statusBadge)).props.className).toContain(styles.statusKeep);
        expect(root.find(hasClass(styles.limitBadge.up)).props.className).toContain(styles.limitWide);
        expect(root.findByProps({ locked: null })).toBeTruthy();
        // 真成交鎖漲停時照舊
        display = { quote: { tick: { ...atUp, simtrade: false } } };
        const locked = render(STOCK).root;
        expect(locked.findAll(hasClass(styles.statusBadge))).toHaveLength(0);
        expect(locked.find(hasClass(styles.limitBadge.up)).props.className).not.toContain(styles.limitWide);
        expect(locked.findByProps({ locked: 'up' })).toBeTruthy();
    });

    it('盤前快照還是前一天：參考價跟著快照推，合約已換成今天的參考價與漲跌停時不判停板、不畫軌', () => {
        // 前一天從 100 漲停到 110；合約已換成今天：參考 110、漲跌停 121／99
        display = { snapshot: { code: 'X', close: 110, change_price: 10, change_rate: 10, open: 100, high: 110, low: 100, datetime: '2026-10-20T13:30:00' } };
        const root = render({ ...STOCK, reference: 110, limit_up: 121, limit_down: 99 }).root;
        expect(texts(root)).toContain('+10.00%');
        expect(titles(root)).toContain('參考 100.00');
        expect(root.findAll(hasClass(styles.railSlot))).toHaveLength(0);
        expect(root.findAll(hasClass(styles.limitBadge.up))).toHaveLength(0);
        // 同一天（推出的參考價等於合約）照常畫軌
        display = { snapshot: { code: 'X', close: 115, change_price: 5, change_rate: 4.55, open: 112, high: 116, low: 111, datetime: '2026-10-21T10:00:00' } };
        expect(render({ ...STOCK, reference: 110, limit_up: 121, limit_down: 99 }).root.findAll(hasClass(styles.railSlot))).toHaveLength(1);
    });

    describe('有夜盤的期貨：K 線全盤時開高低含前一天 15:00 起的夜盤', () => {
        const TXF = { ...STOCK, code: 'TXFR1', security_type: 'FUT', underlying_kind: 'I', reference: 46341, limit_up: 50975, limit_down: 41707 };
        // 2026-10-21 實際數字：夜盤 15:00 開 46,490；日盤 08:45 開 47,240
        const dayTick = { ...tick, date: '2026/10/21', time: '09:10:00.000', simtrade: false, close: '47150', price_chg: '809', open: '47240', high: '47288', low: '47131' };
        const renderTxf = (sessionMode?: 'all' | 'day', contract: any = TXF) => {
            let root!: ReturnType<typeof create>;
            act(() => { root = create(createElement(QuoteBoard, { contract, sessionMode })); });
            return root;
        };
        // 10/21 交易日的夜盤從 10/20 15:00 起；開盤前（試撮）和開盤後各抓一次
        const nightStart = wallClockToUtc('2026-10-20T15:00:00');
        const openKey = `night-ohl:TXFR1:${nightStart}:open`;
        const preKey = `night-ohl:TXFR1:${nightStart}:pre`;
        const nightOhl = { open: 46490, high: 47000, low: 46400 };
        afterEach(() => queryData.clear());

        it('全盤（缺省）：開盤用夜盤的，最高最低取兩段極值，提示註明含夜盤', () => {
            queryData.set(openKey, nightOhl);
            display = { quote: { tick: dayTick } };
            queryCalls.length = 0;
            const root = renderTxf().root;
            expect(texts(root)).toEqual(expect.arrayContaining(['46,490', '47,288', '46,400']));
            expect(queryCalls.find((c) => c.key === openKey)?.enabled).toBe(true);
            expect(titles(root)).toContain('開盤為前一交易日 15:00 夜盤開盤，高低與量含夜盤');
            expect(root.findByProps({ role: 'img' }).props.title).toContain('開盤為前一交易日 15:00 夜盤開盤');
        });

        it('全盤：量 = 日盤累計量 + 夜盤量，量的提示和開盤同一句註記；僅日盤時照日盤量、不加提示', () => {
            queryData.set(openKey, { ...nightOhl, volume: 27540 });
            display = { quote: { tick: { ...dayTick, total_volume: 11453 } } };
            const root = renderTxf().root;
            expect(texts(root)).toContain('38,993');
            expect(texts(root)).not.toContain('11,453');
            const volCell = root.find((n) => typeof n.type === 'string' && n.children.length === 1 && n.children[0] === '38,993');
            expect(volCell.props.title).toBe('開盤為前一交易日 15:00 夜盤開盤，高低與量含夜盤');
            const day = renderTxf('day').root;
            expect(texts(day)).toContain('11,453');
            expect(texts(day)).not.toContain('38,993');
            const dayCell = day.find((n) => typeof n.type === 'string' && n.children.length === 1 && n.children[0] === '11,453');
            expect(dayCell.props.title).toBeUndefined();
        });

        it('App 隔夜開著：最後一筆夜盤成交的累計量就是夜盤量，日盤開盤後加上日盤量', () => {
            display = { quote: { tick: { ...dayTick, time: '04:59:58.000', open: '46490', high: '47000', low: '46400', close: '46900', total_volume: 27540 } } };
            const root = renderTxf();
            display = { quote: { tick: { ...dayTick, time: '09:10:00.000', total_volume: 11453 } } };
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(texts(root.root)).toContain('38,993');
        });

        it('隔夜開著但停在 04:56（斷線）：開盤後仍抓一次夜盤 K，最後幾分鐘的量與高低補回來', () => {
            display = { quote: { tick: { ...dayTick, time: '04:56:00.000', open: '46490', high: '47000', low: '46400', close: '46900', total_volume: 20000 } } };
            const root = renderTxf();
            // 08:40 試撮：直接用最後一筆，不抓
            display = { quote: { tick: { ...dayTick, time: '08:40:00.000', simtrade: true, open: '0', high: '0', low: '0', total_volume: 0 } } };
            queryCalls.length = 0;
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(queryCalls.some((c) => c.key.startsWith('night-ohl:') && c.enabled)).toBe(false);
            expect(texts(root.root)).toContain('20,000');
            // 09:10 開盤後抓到完整夜盤：22,000 口、高 47,050
            queryData.set(openKey, { open: 46490, high: 47050, low: 46400, volume: 22000, partial: false });
            display = { quote: { tick: { ...dayTick, time: '09:10:00.000', total_volume: 11453 } } };
            queryCalls.length = 0;
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(queryCalls.find((c) => c.key === openKey)?.enabled).toBe(true);
            expect(texts(root.root)).toEqual(expect.arrayContaining(['33,453', '47,288']));
            expect(titles(root.root)).toContain('開盤為前一交易日 15:00 夜盤開盤，高低與量含夜盤');
        });

        it('夜盤 K 抓前一個平日到交易日當天，只取夜盤時段', async () => {
            display = { quote: { tick: dayTick } };
            queryCalls.length = 0;
            renderTxf();
            fetchKbars.mockClear();
            fetchKbars.mockResolvedValueOnce({
                datetime: ['2026-10-20T13:45:00', '2026-10-20T15:01:00', '2026-10-21T05:00:00', '2026-10-21T08:46:00'],
                Open: [46300, 46490, 46900, 47240], High: [46310, 46600, 47000, 47288], Low: [46290, 46480, 46400, 47200],
            });
            await expect(queryCalls.find((c) => c.key === openKey)!.fetcher()).resolves.toMatchObject({ open: 46490, high: 47000, low: 46400 });
            expect(fetchKbars.mock.calls[0]?.slice(1)).toEqual(['2026-10-20', '2026-10-21']);
        });

        it('夜盤 K 缺凌晨尾段（上游晚發布）：照收並標不完整，不在背景重抓；補齊時不標', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-21T01:00:00Z')); // 台灣 09:00
            try {
                display = { quote: { tick: dayTick } };
                queryCalls.length = 0;
                renderTxf();
                // 每分鐘一根：上游先只發布到 23:59，補齊後才有 00:00 到 05:00（凌晨 03:00 衝到 47,000）；
                // 前一天日盤收盤定盤那根（13:46）不算進夜盤的判斷
                const minutes = (from: string, n: number) => Array.from({ length: n }, (_, i) => wallClockToUtc(from) + i * 60);
                const toKbars = (ts: number[]) => ({
                    datetime: ts.map((t) => new Date(t * 1000).toISOString().slice(0, 19)),
                    Open: ts.map(() => 46500),
                    High: ts.map((t) => (t === wallClockToUtc('2026-10-21T03:00:00') ? 47000 : 46600)),
                    Low: ts.map(() => 46400),
                });
                const evening = [wallClockToUtc('2026-10-20T13:46:00'), ...minutes('2026-10-20T15:01:00', 539)];
                const fetcher = queryCalls.find((c) => c.key === openKey)!.fetcher;
                fetchKbars.mockClear();
                fetchKbars.mockResolvedValueOnce(toKbars(evening));
                await expect(fetcher()).resolves.toEqual({ open: 46500, high: 46600, low: 46400, partial: true });
                expect(fetchKbars).toHaveBeenCalledTimes(1);
                fetchKbars.mockResolvedValueOnce(toKbars([...evening, ...minutes('2026-10-21T00:00:00', 301)]));
                await expect(fetcher()).resolves.toEqual({ open: 46500, high: 47000, low: 46400, partial: false });
                // 收盤後（14:00）才查、夜盤有 05:01 到 05:04 收盤定盤那幾根：完整的夜盤不能被誤標不完整
                vi.setSystemTime(new Date('2026-10-21T06:00:00Z'));
                fetchKbars.mockResolvedValueOnce(toKbars([...evening, ...minutes('2026-10-21T00:00:00', 305)]));
                await expect(fetcher()).resolves.toMatchObject({ partial: false });
            } finally {
                vi.useRealTimers();
            }
        });

        it('提示：夜盤不完整時說可能不含凌晨；抓取失敗時說開高低為日盤', () => {
            display = { quote: { tick: dayTick } };
            queryData.set(openKey, { ...nightOhl, partial: true });
            expect(titles(renderTxf().root)).toContain('開盤為前一交易日 15:00 夜盤開盤；夜盤資料尚未齊全，高低與量可能不完整');
            queryData.clear();
            queryErrors.set(openKey, '503 Service Unavailable');
            try {
                expect(titles(renderTxf().root)).toContain('夜盤資料取得失敗，開高低與量為日盤');
            } finally {
                queryErrors.clear();
            }
        });

        it('週一的夜盤在上週五 15:00 到週六 05:00：查上週五到週一', async () => {
            display = { quote: { tick: { ...dayTick, date: '2026/10/19' } } };
            queryCalls.length = 0;
            renderTxf();
            fetchKbars.mockClear();
            await queryCalls.find((c) => c.key === `night-ohl:TXFR1:${wallClockToUtc('2026-10-16T15:00:00')}:open`)!.fetcher();
            expect(fetchKbars.mock.calls[0]?.slice(1)).toEqual(['2026-10-16', '2026-10-19']);
        });

        it('App 隔夜開著：08:30 試撮進來時直接用最後一筆夜盤成交的開高低，不等夜盤 K', () => {
            display = { quote: { tick: { ...dayTick, time: '04:59:58.000', open: '46490', high: '47000', low: '46400', close: '46900' } } };
            const root = renderTxf();
            display = { quote: { tick: { ...dayTick, time: '08:40:00.000', simtrade: true, open: '0', high: '0', low: '0' } } };
            queryCalls.length = 0;
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(texts(root.root)).toEqual(expect.arrayContaining(['46,490', '47,000', '46,400']));
            expect(queryCalls.some((c) => c.key.startsWith('night-ohl:') && c.enabled)).toBe(false);
        });

        it('日盤到 16:15 的匯率期貨照日盤，不補夜盤', () => {
            display = { quote: { tick: { ...dayTick, close: '31.55', price_chg: '0.05', open: '31.5', high: '31.6', low: '31.45' } } };
            queryCalls.length = 0;
            renderTxf(undefined, { ...TXF, code: 'RHFR1', underlying_kind: 'E', reference: 31.5, limit_up: 34.65, limit_down: 28.35 });
            expect(queryCalls.some((c) => c.key.startsWith('night-ohl:') && c.enabled)).toBe(false);
        });

        it('K 線切到僅日盤時照日盤，不抓夜盤', () => {
            queryData.set(openKey, nightOhl);
            display = { quote: { tick: dayTick } };
            queryCalls.length = 0;
            const shown = texts(renderTxf('day').root);
            expect(shown).toEqual(expect.arrayContaining(['47,240', '47,288', '47,131']));
            expect(shown).not.toContain('46,490');
            expect(queryCalls.some((c) => c.key.startsWith('night-ohl:') && c.enabled)).toBe(false);
        });

        it('夜盤時段的即時成交本來就從 15:00 算起，不再補', () => {
            display = { quote: { tick: { ...dayTick, date: '2026/10/21', time: '15:30:00.000', open: '46900' } } };
            queryCalls.length = 0;
            renderTxf();
            expect(queryCalls.some((c) => c.key.startsWith('night-ohl:') && c.enabled)).toBe(false);
        });

        it('08:30 試撮還沒有日盤開高低：開高低直接用夜盤的（開盤前抓的那份，開盤後再抓一次補凌晨）', () => {
            queryData.set(preKey, nightOhl);
            display = { quote: { tick: { ...dayTick, time: '08:40:00.000', simtrade: true, open: '0', high: '0', low: '0' } } };
            const shown = texts(renderTxf().root);
            expect(shown).toEqual(expect.arrayContaining(['46,490', '47,000', '46,400']));
        });

        it('夜盤 K 還在抓時不寫提示、開高低先照日盤；抓完沒有夜盤成交時說明', () => {
            display = { quote: { tick: dayTick } };
            const loading = renderTxf().root;
            expect(titles(loading).some((t) => t.includes('開高低為日盤'))).toBe(false);
            expect(texts(loading)).toContain('47,240');
            queryData.set(openKey, undefined);
            expect(titles(renderTxf().root)).toContain('夜盤時段沒有成交，開高低與量為日盤');
        });

        it('08:45 開盤後換成開盤後的查詢、還沒回來時，先沿用開盤前抓到的同一段夜盤', () => {
            queryData.set(preKey, nightOhl);
            display = { quote: { tick: { ...dayTick, time: '08:40:00.000', simtrade: true, open: '0', high: '0', low: '0' } } };
            const root = renderTxf();
            display = { quote: { tick: { ...dayTick, time: '08:45:01.000' } } };
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(texts(root.root)).toContain('46,490');
        });

        it('隔夜開著但最後一筆夜盤成交停在半夜（電腦睡眠、斷線）：不當成整段夜盤，照常去抓 K', () => {
            display = { quote: { tick: { ...dayTick, date: '2026/10/20', time: '23:00:00.000', open: '46490', high: '46800', low: '46480', close: '46700' } } };
            const root = renderTxf();
            display = { quote: { tick: { ...dayTick, time: '08:40:00.000', simtrade: true, open: '0', high: '0', low: '0' } } };
            queryCalls.length = 0;
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(queryCalls.find((c) => c.key === preKey)?.enabled).toBe(true);
            // K 抓回來前先拿半夜那筆墊著（區間軌不會先換成數字欄），提示說不完整
            expect(texts(root.root)).toEqual(expect.arrayContaining(['46,490', '46,800', '46,480']));
            expect(titles(root.root)).toContain('開盤為前一交易日 15:00 夜盤開盤；夜盤資料尚未齊全，高低與量可能不完整');
        });

        it('睡眠前那筆比抓回的 K（缺凌晨尾段）更完整時取聯集，高低不會往回縮', () => {
            // 00:30 衝到 47,000，01:00 睡眠；開盤前抓到的 K 只到 23:59（最高 46,600）
            display = { quote: { tick: { ...dayTick, time: '01:00:00.000', open: '46490', high: '47000', low: '46480', close: '46900' } } };
            const root = renderTxf();
            queryData.set(preKey, { open: 46490, high: 46600, low: 46400, partial: true });
            display = { quote: { tick: { ...dayTick, time: '08:40:00.000', simtrade: true, open: '0', high: '0', low: '0' } } };
            act(() => root.update(createElement(QuoteBoard, { contract: TXF })));
            expect(texts(root.root)).toEqual(expect.arrayContaining(['46,490', '47,000', '46,400']));
        });
    });

    it('即時成交是前一天的（推出的參考價和合約對不上）：不判停板、不畫軌；停板組註明是今日的', () => {
        // 昨天鎖漲停 2680（參考 2440）的最後一筆，合約已換成今天：參考 2680、漲跌停 2948／2412
        display = { quote: { tick: { ...tick, close: '2680', price_chg: '240', high: '2680' } } };
        const root = render({ ...STOCK, reference: 2680, limit_up: 2948, limit_down: 2412 }).root;
        expect(root.findAll(hasClass(styles.railSlot))).toHaveLength(0);
        expect(root.findAll(hasClass(styles.limitBadge.up))).toHaveLength(0);
        expect(titles(root)).toContain('參考 2,440');
        expect(titles(root)).toContain('漲跌停取自合約（參考 2,680），和現價不是同一個交易日');
        expect(allText(root.find(hasClass(styles.srOnly)))).toContain('漲跌停取自合約');
        // 合約已換日、報價還是前一天：同樣沒有區間軌，wide 也只允許單行，08:30 試撮進來時才不會從兩列縮成一列
        expect(root.find(hasClass(styles.board)).props.className).toContain(styles.boardRailPending);
    });

    it('會畫軌的個股盤前還沒有開高低：看板帶 boardRailPending（wide 不換行）；選擇權不帶', () => {
        display = { quote: { tick: { ...tick, simtrade: true, open: '0', high: '0', low: '0', close: '2445', price_chg: '5' } } };
        expect(render(STOCK).root.find(hasClass(styles.board)).props.className).toContain(styles.boardRailPending);
        expect(render({ ...STOCK, security_type: 'OPT' }).root.find(hasClass(styles.board)).props.className).not.toContain(styles.boardRailPending);
    });

    it('沒有停板組的商品（指數）報價和合約不是同一天時，讀屏不念漲跌停提示', () => {
        // 10/21 盤前櫃買指數：快照還是前一天（現價 387.88、漲跌 -6.17），合約參考價已換成 387.88
        display = { snapshot: { code: 'IX0043', close: 387.88, change_price: -6.17, change_rate: -1.57, datetime: '2026-10-20T13:33:00' } };
        const root = render({ ...STOCK, code: 'IX0043', security_type: 'IND', reference: 387.88, limit_up: 0, limit_down: 0 }).root;
        expect(allText(root.find(hasClass(styles.srOnly)))).not.toContain('漲跌停');
        expect(titles(root)).toContain('參考 394.05');
    });

    it('快照 0／0（沒成交）推不出參考價時照用合約參考價', () => {
        display = { snapshot: { code: '2330', close: 0, change_price: 0, change_rate: 0, datetime: '2026-10-21T10:00:00' } };
        expect(titles(render(STOCK).root)).toContain('參考 2,440');
    });

    it('組合商品（價差）真成交的 0 是合法價格，照常顯示', () => {
        display = { quote: { tick: { ...tick, simtrade: false, close: '-3', price_chg: '-3', open: '-5', high: '0', low: '-12' } } };
        const spread = { ...STOCK, code: 'TXFI6/J6', security_type: 'FUT', limit_up: 0, limit_down: 0, reference: 0 };
        expect(texts(render(spread).root)).toContain('0.00');
    });

    it('小跳動匯率期貨保留價格與漲跌的四位小數', () => {
        display = { quote: { tick: { ...tick, close: '1.0856', price_chg: '0.0035', open: '1.0821', high: '1.09', low: '1.08' } } };
        const root = render({ ...STOCK, code: 'XEFR1', security_type: 'FUT', tick: 0.0001, reference: 1.0821 }).root;
        expect(texts(root)).toContain('1.0856');
        expect(texts(root)).toContain('+0.0035');
    });

    it('隱藏事實放在漲跌區內，不干擾直屬節點量測與現價字寬', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const root = render(STOCK).root;
        const board = root.find(hasClass(styles.board));
        expect(board.children.some(c => typeof c !== 'string' && hasClass(styles.srOnly)(c))).toBe(false);
        expect(allText(board.children[0] as ReactTestInstance)).toBe('2,420');
        // useBoardTier 靠這個屬性把讀屏補充排除在量測簽章外，兩邊各寫一次字串，這裡守住元件這一側
        expect(root.find(hasClass(styles.srOnly)).props['data-board-details']).toBeTruthy();
        const detail = allText(root.find(hasClass(styles.srOnly)));
        expect(detail).toContain('更新 13:29:15');
        expect(detail).toContain('參考 2,440');
        expect(detail).toContain('量比 = 今日累計成交量 ÷ 前一交易日全日成交量');
        expect(detail).not.toContain('粗段');
        expect(detail).not.toContain('粗：');
    });

    // 元件的實際文字會自動成為 hook 的逐子節點簽章；重測行為另由 hook 測試守住。
    it('價格位數、停板徽章與產業分類都納入重新量測簽章', () => {
        const key = (contract = STOCK) => render(contract).root.find(hasClass(styles.board)).children
            .map(child => typeof child === 'string' ? child.length : allText(child).length).join(',');
        display = { quote: { tick }, snapshot: undefined, book };
        const original = key();
        expect(key({ ...STOCK, category: '24' })).not.toBe(original);
        display = { quote: { tick: { ...tick, close: '2680' } }, snapshot: undefined, book };
        expect(key()).not.toBe(original);
        display = { quote: { tick: { ...tick, close: '999' } }, snapshot: undefined, book };
        expect(key()).not.toBe(original);
    });

    it('指數家數跨位數時更新重新量測簽章', () => {
        const contract = { ...STOCK, code: 'IX0001', security_type: 'IND' };
        display = { quote: { index: { raise_count: 99 } } };
        render(contract);
        const before = allText(render(contract).root.find(hasClass(styles.indexStats)));
        display = { quote: { index: { raise_count: 100 } } };
        render(contract);
        expect(allText(render(contract).root.find(hasClass(styles.indexStats)))).not.toBe(before);
    });
    it('三組依序為高／低、開／量（含量比）、漲停／跌停，上排是上方的值、下排是下方的值', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const root = render(STOCK).root;
        expect(root.findAll(hasClass(styles.pairGroup)).map(texts)).toEqual([
            ['高', '2,445', '低', '2,415'],
            ['漲停', '2,680', '跌停', '2,200'],
        ]);
        // 開在上排，量與量比在下排（33,257 ÷ 48,000 = 0.69）
        expect(texts(root.find(hasClass(styles.volGroup)))).toEqual(['開', '2,430', '量', '33,257', '量比', '0.69']);
    });

    it('量比的滑過提示寫出算法與代入數字；昨日量拿不到時顯示空值並說明', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        expect(titles(render(STOCK).root)).toContain('量比 = 今日累計成交量 ÷ 前一交易日全日成交量\n33,257 ÷ 48,000 = 0.69\n1.00 代表已達前一交易日全日量');
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render(STOCK).root;
        expect(texts(root.find(hasClass(styles.volGroup)))).toContain('—');
        expect(titles(root)).toContain('量比 = 今日累計成交量 ÷ 前一交易日全日成交量\n前一交易日成交量尚未取得');
    });

    it('不顯示委買委賣、代號名稱、參考與時間的格子', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const all = texts(render(STOCK).root);
        for (const gone of ['賣', '買', '委買', '委賣', '參考', '時間', '台積電', '2,425', '698', '508']) {
            expect(all).not.toContain(gone);
        }
    });

    it('參考價放在漲跌的滑過提示、更新時間放在現價的滑過提示', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const t = titles(render(STOCK).root);
        expect(t).toContain('參考 2,440');
        expect(t).toContain('更新 13:29:15');
    });

    it('興櫃不顯示停板組', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render({ ...STOCK, exchange: 'OES', limit_up: undefined, limit_down: undefined }).root;
        expect(root.findAll(hasClass(styles.stockLimit))).toHaveLength(0);
        expect(texts(root)).not.toContain('漲停');
    });

    it('權證、組合商品的漲跌停是 0／0 時不顯示停板組，也不會畫出孤立的 0', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render({ ...STOCK, security_type: 'WRT', limit_up: 0, limit_down: 0 }).root;
        expect(root.findAll(hasClass(styles.stockLimit))).toHaveLength(0);
        const stats = root.find(hasClass(styles.stockStats));
        expect(stats.children.every((c) => typeof c !== 'string' && typeof c !== 'number')).toBe(true);
    });

    it('小數跳動的期貨價格固定小數位，尾數 0 不省略（寬度不會跳動）', () => {
        display = {
            quote: { tick: { ...tick, close: '2345.1', open: '2340', high: '2350.05', low: '2338.2' } },
            snapshot: undefined,
            book,
        };
        const root = render({
            code: 'ZEFR1',
            name: '電子期近月',
            exchange: 'TAIFEX',
            security_type: 'FUT',
            target_code: null,
            reference: 2340,
            limit_up: 2574,
            limit_down: 2106,
            tick: 0.05,
        }).root;
        const all = texts(root);
        expect(all).toContain('2,345.10');
        expect(all).toContain('2,340.00');
        expect(all).toContain('2,338.20');
        // 期貨不顯示量比（夜盤開始後今日量只算夜盤，比昨日全日量會失真）
        expect(all).not.toContain('量比');
    });
});

describe('日內區間軌（有漲跌停且開高低收到齊的商品）', () => {
    const rails = (node: ReactTestInstance) =>
        node.findAll((n) => typeof n.type === 'string' && n.props.role === 'img');

    it('個股有軌道：數字一行由小到大，圖的提示只寫看板上沒有的資訊', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render(STOCK).root;
        const [rail, ...rest] = rails(root);
        expect(rest).toHaveLength(0);
        // 最低 2,415 是 -1.02%，超過 ±1% 尺的 92%，換成 ±2%
        expect(rail!.props.title).toBe(
            '開 2,430｜高 2,445（+0.20%）｜低 2,415（-1.02%）｜平盤 2,440（幅度對平盤）\n' +
                '較開盤 -0.41%（陰線）｜距漲停 +10.74%｜距跌停 -9.09%｜刻度 ±2%，每格 1%\n' +
                '粗：開到現價｜細：最低到最高',
        );
        expect(texts(root.find(hasClass(styles.railNumbers)))).toEqual([
            '跌停', '2,200', '低', '2,415', '開', '2,430', '高', '2,445', '漲停', '2,680',
        ]);
    });

    it('軌道只是多一塊：右側的高低、開量、停板數字照樣在（窄面板的階梯要用）', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render(STOCK).root;
        expect(root.findAll(hasClass(styles.pairGroup))).toHaveLength(2);
        expect(root.findAll(hasClass(styles.volGroup))).toHaveLength(1);
    });

    it('興櫃、權證 0／0、指數，以及還沒有成交資料時不畫軌道', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        expect(rails(render({ ...STOCK, exchange: 'OES', limit_up: undefined, limit_down: undefined }).root)).toHaveLength(0);
        expect(rails(render({ ...STOCK, security_type: 'WRT', limit_up: 0, limit_down: 0 }).root)).toHaveLength(0);
        display = { quote: undefined, snapshot: undefined, book };
        expect(rails(render(STOCK).root)).toHaveLength(0);
        display = { quote: { index: { code: 'IX0001', close: '47111.9', open: '1', high: '1', low: '1' } }, snapshot: undefined, book: undefined };
        expect(rails(render({ code: 'IX0001', name: '加權', exchange: 'TSE', security_type: 'IND', target_code: null }).root)).toHaveLength(0);
    });

    it('產業分類：個股依類別顯示（一位數代碼補零），「其他」與期貨不顯示', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        expect(texts(render({ ...STOCK, category: '24' }).root)).toContain('半導體');
        expect(texts(render({ ...STOCK, category: '1' }).root)).toContain('水泥');
        expect(texts(render({ ...STOCK, category: '20' }).root)).not.toContain('其他');
        const futures = texts(render({ ...STOCK, code: 'TXFR1', security_type: 'FUT', category: '24' }).root);
        expect(futures).not.toContain('半導體');
    });

    it('產業標籤可點：和排行榜一樣讓產業全景下鑽到這檔的產業', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const tag = render({ ...STOCK, category: '24' }).root.find(hasClass(styles.sectorTag));
        expect(tag.type).toBe('button');
        expect(tag.props.title).toBe('跳到此類股熱力圖');
        focusSector.mockClear();
        act(() => tag.props.onClick());
        expect(focusSector).toHaveBeenCalledWith('24');
    });

    it('指數期（台指期）：數字列兩端換成距低、距高點數；個股期照個股寫漲跌停', () => {
        const fut = { ...STOCK, code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', reference: 2440, tick: 1 };
        display = { quote: { tick }, snapshot: undefined, book };
        const idx = texts(render({ ...fut, underlying_kind: 'I' }).root.find(hasClass(styles.railNumbers)));
        expect(idx).toEqual(['距低', '5', '低', '2,415', '開', '2,430', '高', '2,445', '距高', '25']);
        const stk = texts(render({ ...fut, code: 'CDFR1', underlying_kind: 'S' }).root.find(hasClass(styles.railNumbers)));
        expect(stk[0]).toBe('跌停');
    });

    it('數字欄的高、低也跟開盤價比上色：最高等於開盤時不上紅', () => {
        display = { quote: { tick: { ...tick, high: '2430' } }, snapshot: undefined, book };
        const group = render(STOCK).root.findAll(hasClass(styles.pairGroup))[0]!;
        const high = group.find((n) => typeof n.type === 'string' && n.children[0] === '2,430');
        expect(String(high.props.className).split(' ')).not.toContain(panel.dirText.up);
        const low = group.find((n) => typeof n.type === 'string' && n.children[0] === '2,415');
        expect(String(low.props.className).split(' ')).toContain(panel.dirText.down);
    });

    it('選擇權不畫軌道（漲跌停兩側差數十倍，比例會誤導），維持原本的數字欄', () => {
        display = { quote: { tick: { ...tick, close: '150', open: '100', high: '160', low: '95' } }, snapshot: undefined, book };
        const opt = { ...STOCK, code: 'TXO47000K6', security_type: 'OPT', reference: 100, limit_up: 4828, limit_down: 0.1 };
        expect(rails(render(opt).root)).toHaveLength(0);
    });

    it('有軌道時用 RAIL_TIERS，沒有軌道的個股用 STOCK_TIERS，指數維持原本的 BOARD_TIERS', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        tierCalls.length = 0;
        render(STOCK);
        expect(tierCalls.at(-1)![2]).toBe(RAIL_TIERS);
        render({ ...STOCK, exchange: 'OES', limit_up: undefined, limit_down: undefined });
        expect(tierCalls.at(-1)![2]).toBe(STOCK_TIERS);
        display = { quote: { index: { code: 'IX0001', close: '47111.9' } }, snapshot: undefined, book: undefined };
        render({ code: 'IX0001', name: '加權', exchange: 'TSE', security_type: 'IND', target_code: null });
        expect(tierCalls.at(-1)![2]).toBe(BOARD_TIERS);
    });

    it('價格旁的量標籤（compact 顯示）是「量 33,257」加獨立的量比 span（tight 的 CSS 靠它收起量比、只留量）', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const tag = render(STOCK).root.find(hasClass(styles.stockVolTag));
        expect(allText(tag)).toBe('量 33,257量比 0.69');
        expect(texts(tag.find(hasClass(styles.stockVolTagRatio)))).toEqual(['量比 0.69']);
    });

    describe('量比的分母（快照的昨日成交量）過期時不算', () => {
        // 快照在週五抓的（昨日量是週四的），週一的即時成交拿它除會除到錯的那一天
        const snapshotFriday = { yesterday_volume: 48000, datetime: '2026-10-16T14:30:00' };
        const monday = { ...tick, date: '2026/10/19', simtrade: false };
        const ratioTitles = (root: ReactTestInstance) => titles(root).filter((t) => t.startsWith('量比 ='));

        it('日期對不上：量比顯示空值、提示寫待更新；數字欄與軌道照常', () => {
            display = { quote: { tick: monday }, snapshot: snapshotFriday, book };
            const root = render(STOCK).root;
            expect(texts(root.find(hasClass(styles.volGroup)))).toEqual(['開', '2,430', '量', '33,257', '量比', '—']);
            expect(new Set(ratioTitles(root))).toEqual(new Set(['量比 = 今日累計成交量 ÷ 前一交易日全日成交量\n前一交易日成交量待更新']));
            expect(allText(root.find(hasClass(styles.stockVolTag)))).toBe('量 33,257量比 —');
        });

        it('日期相同或沒有即時成交日期：照常計算', () => {
            display = { quote: { tick: { ...monday, date: '2026/10/16' } }, snapshot: snapshotFriday, book };
            expect(texts(render(STOCK).root.find(hasClass(styles.volGroup)))).toContain('0.69');
            display = { quote: { tick }, snapshot: snapshotFriday, book };
            expect(texts(render(STOCK).root.find(hasClass(styles.volGroup)))).toContain('0.69');
        });

        it('當天第一筆真成交之後才重抓一次快照；試撮、日期相同、期貨都不抓', () => {
            display = { quote: { tick: monday }, snapshot: snapshotFriday, book };
            queryCalls.length = 0;
            render(STOCK);
            expect(
                queryCalls.filter((c) => c.key.startsWith('ratio-snapshot:')).map(({ key, enabled }) => ({ key, enabled })),
            ).toEqual([{ key: 'ratio-snapshot:2330:2026-10-19', enabled: true }]);
            const enabledFor = (quote: object, snapshot: object, contract: object = STOCK) => {
                display = { quote, snapshot, book };
                queryCalls.length = 0;
                render(contract);
                return queryCalls.find((c) => c.key.startsWith('ratio-snapshot:'))?.enabled;
            };
            expect(enabledFor({ tick: { ...monday, simtrade: true } }, snapshotFriday)).toBe(false);
            // 非試撮但量為 0 不算真成交（stream 的定義是 !simtrade 且 volume > 0）
            expect(enabledFor({ tick: { ...monday, volume: 0 } }, snapshotFriday)).toBe(false);
            expect(enabledFor({ tick: { ...monday, date: '2026/10/16' } }, snapshotFriday)).toBe(false);
            expect(enabledFor({ tick: monday }, snapshotFriday, { ...STOCK, code: 'TXFR1', security_type: 'FUT' })).toBe(false);
        });
    });

    describe('重抓快照的抓取函式', () => {
        const snapshotFriday = { yesterday_volume: 48000, datetime: '2026-10-16T14:30:00' };
        const monday = { ...tick, date: '2026/10/19', simtrade: false };
        const ratioFetcher = () => {
            display = { quote: { tick: monday }, snapshot: snapshotFriday, book };
            queryCalls.length = 0;
            render(STOCK);
            return queryCalls.find((c) => c.key.startsWith('ratio-snapshot:'))!.fetcher;
        };

        it('抓這個合約的快照；store 裡已是當天的快照就結束，只抓一次', async () => {
            const fetcher = ratioFetcher();
            getMarketSnapshot.mockReturnValue({ datetime: '2026-10-19T09:00:05' });
            await fetcher();
            expect(fetchSnapshots).toHaveBeenCalledTimes(1);
            expect(fetchSnapshots).toHaveBeenCalledWith([STOCK]);
        });

        it('回來的快照還是上一個交易日就等一下再抓，抓到當天的快照才算完成', async () => {
            vi.useFakeTimers();
            try {
                const fetcher = ratioFetcher();
                getMarketSnapshot
                    .mockReturnValueOnce({ datetime: '2026-10-16T14:30:00' })
                    .mockReturnValue({ datetime: '2026-10-19T09:00:05' });
                const done = fetcher();
                await vi.advanceTimersByTimeAsync(3_000);
                await expect(done).resolves.toBeUndefined();
                expect(fetchSnapshots).toHaveBeenCalledTimes(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it('一直沒翻日：重試有上限（每天最多 5 次），最後丟出錯誤，不無限重抓', async () => {
            vi.useFakeTimers();
            try {
                const fetcher = ratioFetcher();
                getMarketSnapshot.mockReturnValue({ datetime: '2026-10-16T14:30:00' });
                const done = fetcher();
                const settled = expect(done).rejects.toThrow('snapshot not rolled');
                await vi.advanceTimersByTimeAsync(3_000 + 10_000 + 30_000 + 60_000);
                await settled;
                expect(fetchSnapshots).toHaveBeenCalledTimes(5);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it('今天碰過漲停（最高等於漲停）又打開：漲停端畫成實心，現價直針照畫', () => {
        display = { quote: { tick: { ...tick, high: '2680' } }, snapshot: undefined, book };
        const root = render(STOCK, 480).root;
        const cap = root.findAll(
            (n) => n.type === 'rect' && hasClass(styles.railBody.up)(n) && n.props.width === 4 && n.props.height === 12,
        );
        expect(cap).toHaveLength(1);
        expect(root.findAll((n) => n.type === 'rect' && hasClass(styles.railNeedle)(n))).toHaveLength(1);
    });
});

describe('指數看板', () => {
    const INDEX = { code: 'IX0001', name: '發行量加權股價指數', exchange: 'TSE', security_type: 'IND', target_code: null };

    it('顯示漲跌家數與量能，不顯示個股的成對欄位', () => {
        display = {
            quote: {
                index: {
                    code: 'IX0001',
                    date: '2026-10-16',
                    time: '11:36:10',
                    reference: '46969.87',
                    close: '47111.90',
                    open: '46995.03',
                    high: '47520.6',
                    low: '46995.03',
                    amount_sum: '644150000000',
                    estimate_amount_sum: '929210000000',
                    raise_count: 625,
                    flat_count: 123,
                    fall_count: 324,
                    limit_up_count: 17,
                    limit_down_count: 1,
                },
            },
            snapshot: undefined,
            book: undefined,
        };
        const root = render(INDEX).root;
        const all = texts(root);
        for (const label of ['漲停', '上漲', '平盤', '下跌', '跌停', '成交金額', '預估量', '較昨日', '時間']) {
            expect(all).toContain(label);
        }
        // 指數現價固定兩位小數：尾數 0 不省略（沒有固定時會變成 47,111.9）
        expect(all).toContain('47,111.90');
        expect(root.findAll(hasClass(styles.pairGroup))).toHaveLength(0);
        expect(all).not.toContain('發行量加權股價指數');
    });
});

describe('收合偏好：指數與個股各自一份', () => {
    it('在個股看板按收合只寫個股的 key，不影響指數；再按回自動', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render(STOCK).root;
        const button = () => root.find((n) => n.type === 'button' && n.props['aria-label'] === '報價統計');
        expect(button().props['aria-label']).toBe('報價統計');
        expect(button().props['aria-expanded']).toBe(true);
        act(() => button().props.onClick());
        expect(storage.get('sj-stock-board-mode')).toBe('collapsed');
        expect(storage.get('sj-index-board-mode')).toBeUndefined();
        expect(button().props['aria-expanded']).toBe(false);
        expect(button().props['aria-label']).toBe('報價統計');
        act(() => button().props.onClick());
        expect(storage.has('sj-stock-board-mode')).toBe(false);
    });

    it('兩種看板同時開著：按個股的收合，指數看板不跟著收；按指數的，個股也不受影響', () => {
        display = { quote: { tick }, snapshot: undefined, book };
        const INDEX = { code: 'IX0001', name: '發行量加權股價指數', exchange: 'TSE', security_type: 'IND', target_code: null };
        const stock = render(STOCK).root;
        const index = render(INDEX).root;
        const expanded = (root: ReactTestInstance) => root.find((n) => n.type === 'button' && n.props['aria-label'] === '報價統計').props['aria-expanded'];
        const click = (root: ReactTestInstance) => act(() => root.find((n) => n.type === 'button' && n.props['aria-label'] === '報價統計').props.onClick());
        click(stock);
        expect([expanded(stock), expanded(index)]).toEqual([false, true]);
        click(index);
        expect([expanded(stock), expanded(index)]).toEqual([false, false]);
        click(stock);
        expect([expanded(stock), expanded(index)]).toEqual([true, false]);
        // 還原，免得模組層的偏好留到後面的測試
        click(index);
        expect([expanded(stock), expanded(index)]).toEqual([true, true]);
        expect(storage.has('sj-stock-board-mode') || storage.has('sj-index-board-mode')).toBe(false);
    });
});
