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
vi.mock('../hooks/use-query', () => ({
    useQuery: (fetcher: () => Promise<unknown>, key: string, enabled?: boolean) => {
        queryCalls.push({ fetcher, key, enabled });
        return { data: undefined, error: null, loading: false, updatedAt: null, refresh: async () => {} };
    },
}));
const fetchSnapshots = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));
vi.mock('../lib/shioaji', () => ({
    fetchKbars: async () => ({ datetime: [], Amount: [] }),
    fetchSnapshots,
}));
// 重抓後以 store 裡的快照判斷是否已翻日
const getMarketSnapshot = vi.hoisted(() => vi.fn((..._args: unknown[]): { datetime: string } | undefined => undefined));
vi.mock('../lib/market-snapshot-store', () => ({ getMarketSnapshot }));

import { BOARD_TIERS, RAIL_TIERS, STOCK_TIERS } from '../lib/board-tier';
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
        display = { quote: { tick: { ...tick, simtrade: false } } };
        expect(render(STOCK).root.findAll(hasClass(styles.statusBadge))).toHaveLength(0);
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
        const button = () => root.find((n) => n.type === 'button');
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
        const expanded = (root: ReactTestInstance) => root.find((n) => n.type === 'button').props['aria-expanded'];
        const click = (root: ReactTestInstance) => act(() => root.find((n) => n.type === 'button').props.onClick());
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
