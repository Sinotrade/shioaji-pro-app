// QuoteBoard 自訂欄位：關掉的格子不畫、依設定排序、軌道與價格旁的量跟著開關，設定經 onFieldsChange 存回面板
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
import { compactQuoteBoardFields, moveField, moveSection, normalizeQuoteBoardFields, toggleField, type QuoteBoardFieldsConfig } from '../lib/quote-board-fields';
import { QuoteBoardSettings } from './quote-board-settings';
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
function render(contract: any, width?: number, fields?: QuoteBoardFieldsConfig, onFieldsChange?: (f: QuoteBoardFieldsConfig | undefined) => void) {
    let root!: ReturnType<typeof create>;
    act(() => {
        root = create(
            createElement(QuoteBoard, { contract, fields, onFieldsChange }),
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
});

const cfg = (...ops: ((f: ReturnType<typeof normalizeQuoteBoardFields>) => ReturnType<typeof normalizeQuoteBoardFields>)[]) =>
    compactQuoteBoardFields(ops.reduce((f, op) => op(f), normalizeQuoteBoardFields(undefined)));

const INDEX = { ...STOCK, code: 'IX0001', name: '加權指數', security_type: 'IND' };
const idx = {
    close: '23000', reference: '22900', open: '22950', high: '23050', low: '22880',
    raise_count: 500, flat_count: 80, fall_count: 400, limit_up_count: 3, limit_down_count: 1,
    amount_sum: '400000000000', estimate_amount_sum: '', date: '2026/10/21', time: '10:00:00.000',
};

describe('個股自訂欄位', () => {
    it('關掉開與漲跌停：數字欄不畫，單格欄重排成上排量、下排量比', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const root = render(STOCK, undefined, cfg((f) => toggleField(f, 'stock', 'open'), (f) => toggleField(f, 'stock', 'limits'))).root;
        expect(root.findAll(hasClass(styles.pairGroup)).map(texts)).toEqual([['高', '2,445', '低', '2,415']]);
        const run = root.find(hasClass(styles.volGroup));
        expect(texts(run)).toEqual(['量', '33,257', '量比', '0.69']);
        expect(run.props.style).toEqual({ [styles.VOL_COLS_VAR]: '2' });
        expect(root.findAll(hasClass(styles.stockLimit))).toHaveLength(0);
    });

    it('依設定排序：漲跌停排到最前面、量移到開前面', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const fields = cfg(
            (f) => moveField(f, 'stock', 'limits', -1),
            (f) => moveField(f, 'stock', 'limits', -1),
            (f) => moveField(f, 'stock', 'limits', -1),
            (f) => moveField(f, 'stock', 'limits', -1),
            (f) => moveField(f, 'stock', 'volume', -1),
        );
        const stats = render(STOCK, undefined, fields).root.find(hasClass(styles.stockStats));
        expect(texts(stats)).toEqual(['漲停', '2,680', '跌停', '2,200', '高', '2,445', '低', '2,415', '量', '33,257', '開', '2,430', '量比', '0.69']);
        // 第一格在上排，其餘在下排
        const run = stats.find(hasClass(styles.volGroup));
        expect(run.findAll(hasClass(styles.rowTop)).map(texts).flat()).toEqual(['量', '33,257']);
    });

    it('關掉區間軌改用數字欄；關掉軌道下方的開、漲跌停時軌道數字列也不顯示', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        expect(render(STOCK, 300).root.findAll(hasClass(styles.railSlot))).toHaveLength(1);
        tierCalls.length = 0;
        const off = render(STOCK, 300, cfg((f) => toggleField(f, 'stock', 'rail'))).root;
        expect(off.findAll(hasClass(styles.railSlot))).toHaveLength(0);
        expect(tierCalls.at(-1)?.[2]).toBe(STOCK_TIERS);
        const rail = render(STOCK, 300, cfg((f) => toggleField(f, 'stock', 'open'), (f) => toggleField(f, 'stock', 'limits'))).root.find(hasClass(styles.railCells));
        expect(texts(rail)).toEqual(['低', '2,415', '高', '2,445']);
    });

    it('價格旁的量（compact）跟著量、量比的開關', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const noRatio = render(STOCK, undefined, cfg((f) => toggleField(f, 'stock', 'ratio'))).root;
        expect(allText(noRatio.find(hasClass(styles.stockVolTag)))).toBe('量 33,257');
        const none = render(STOCK, undefined, cfg((f) => toggleField(f, 'stock', 'ratio'), (f) => toggleField(f, 'stock', 'volume'))).root;
        expect(none.findAll(hasClass(styles.stockVolTag))).toHaveLength(0);
    });

    it('數字欄整區移到區間軌前面', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const board = render(STOCK, 300, cfg((f) => moveSection(f, 'stock', 'stats', -1))).root.find(hasClass(styles.board));
        const kids = board.children.filter((c): c is ReactTestInstance => typeof c !== 'string');
        const statsAt = kids.findIndex(hasClass(styles.stockStats));
        const railAt = kids.findIndex((k) => k.findAll(hasClass(styles.railSlot)).length > 0 || hasClass(styles.railSlot)(k));
        expect(statsAt).toBeGreaterThan(-1);
        expect(statsAt).toBeLessThan(railAt);
    });
});

describe('指數自訂欄位', () => {
    it('關掉平盤、時間與比例條，量能組排到家數組前面', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        const fields = cfg(
            (f) => toggleField(f, 'index', 'flat'),
            (f) => toggleField(f, 'index', 'time'),
            (f) => toggleField(f, 'index', 'breadthBar'),
            (f) => moveSection(f, 'index', 'volume', -1),
        );
        const root = render(INDEX, undefined, fields).root;
        const groups = root.find(hasClass(styles.indexStats)).children as ReactTestInstance[];
        expect(hasClass(styles.indexGroup.volume)(groups[0]!)).toBe(true);
        expect(texts(root.find(hasClass(styles.indexGroup.breadth)))).toEqual(['漲停', '3', '上漲', '500', '下跌', '400', '跌停', '1']);
        expect(texts(root.find(hasClass(styles.indexGroup.volume)))).not.toContain('時間');
        expect(root.findAll(hasClass(styles.breadthBar))).toHaveLength(0);
        expect(root.findAll(hasClass(styles.breadthMini))).toHaveLength(0);
    });

    it('整組關掉時不畫那一組；全部關掉時不畫統計區', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        const vol = cfg(...(['amount', 'estimate', 'change', 'time'] as const).map((k) => (f: any) => toggleField(f, 'index', k)));
        const root = render(INDEX, undefined, vol).root;
        expect(root.findAll(hasClass(styles.indexGroup.volume))).toHaveLength(0);
        const all = cfg(...(['amount', 'estimate', 'change', 'time', 'limitUp', 'raise', 'flat', 'fall', 'limitDown'] as const).map((k) => (f: any) => toggleField(f, 'index', k)));
        expect(render(INDEX, undefined, all).root.findAll(hasClass(styles.indexStats))).toHaveLength(0);
    });

    it('預估量、較昨日都關掉時，成交金額不再收進提示（mid 也看得到）', () => {
        display = { quote: { index: { ...idx, estimate_amount_sum: '600000000000' } }, snapshot: undefined, book: undefined };
        const amountCell = (root: ReactTestInstance) => root.find((n) => hasClass(styles.stat)(n) && texts(n)[0] === '成交金額');
        expect(hasClass(styles.lowPriority)(amountCell(render(INDEX).root))).toBe(true);
        const root = render(INDEX, undefined, cfg((f) => toggleField(f, 'index', 'estimate'), (f) => toggleField(f, 'index', 'change'))).root;
        expect(hasClass(styles.lowPriority)(amountCell(root))).toBe(false);
    });

    it('收盤後只留實際量、不畫成交金額；關掉實際量那格時成交金額照常顯示', () => {
        const closed = { ...idx, time: '13:33:00', amount_sum: '825100000000', estimate_amount_sum: '' };
        display = { quote: { index: closed }, snapshot: undefined, book: undefined };
        const labels = (root: ReactTestInstance) => texts(root.find(hasClass(styles.indexGroup.volume)));
        const def = labels(render(INDEX).root);
        expect(def).toContain('實際量');
        expect(def).not.toContain('成交金額');
        const noEstimate = labels(render(INDEX, undefined, cfg((f) => toggleField(f, 'index', 'estimate'))).root);
        expect(noEstimate).toContain('成交金額');
        expect(noEstimate).not.toContain('實際量');
    });
});

describe('設定面板', () => {
    it('齒輪打開設定，勾選與排序經 onFieldsChange 存回；回到預設時存 undefined', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const saved: (QuoteBoardFieldsConfig | undefined)[] = [];
        const root = render(STOCK, undefined, undefined, (f) => saved.push(f)).root;
        const gear = root.find((n) => n.type === 'button' && n.props['aria-label'] === '自訂報價欄位');
        // 測試環境沒有 DOM：錨點給一個假的元素
        const el = { ownerDocument: { body: null, addEventListener() {}, removeEventListener() {}, defaultView: null }, getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }), focus() {} };
        act(() => gear.props.onClick({ currentTarget: el }));
        const settings = root.findByType(QuoteBoardSettings);
        expect(settings.props.currentKind).toBe('stock');
        act(() => settings.props.onChange(toggleField(settings.props.fields, 'stock', 'open')));
        expect(saved.at(-1)).toEqual({ stock: expect.objectContaining({ hidden: ['open'] }) });
        act(() => settings.props.onChange(normalizeQuoteBoardFields(undefined)));
        expect(saved.at(-1)).toBeUndefined();
    });

    it('沒有 onFieldsChange（彈出視窗）時只在本視窗生效', () => {
        display = { quote: { tick }, snapshot: { yesterday_volume: 48000 }, book };
        const root = render(STOCK).root;
        const gear = root.find((n) => n.type === 'button' && n.props['aria-label'] === '自訂報價欄位');
        const el = { ownerDocument: { body: null, addEventListener() {}, removeEventListener() {}, defaultView: null }, getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }), focus() {} };
        act(() => gear.props.onClick({ currentTarget: el }));
        const settings = root.findByType(QuoteBoardSettings);
        act(() => settings.props.onChange(toggleField(settings.props.fields, 'stock', 'limits')));
        expect(root.findAll(hasClass(styles.stockLimit))).toHaveLength(0);
    });
});
