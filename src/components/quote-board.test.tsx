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
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => display }));
vi.mock('../hooks/use-query', () => ({
    useQuery: () => ({ data: undefined, error: null, loading: false, updatedAt: null, refresh: async () => {} }),
}));
vi.mock('../lib/shioaji', () => ({ fetchKbars: async () => ({ datetime: [], Amount: [] }) }));

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
    time: '13:29:15.123',
};
const book = { source: 'stream', time: '13:29:15', bids: [{ price: 2420, vol: 508 }], asks: [{ price: 2425, vol: 698 }] };

function render(contract: any) {
    let root!: ReturnType<typeof create>;
    act(() => {
        root = create(createElement(QuoteBoard, { contract }));
    });
    return root;
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

describe('個股看板（成對兩行）', () => {
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
        expect(titles(render(STOCK).root)).toContain('量比 = 今日成交量 ÷ 昨日成交量\n33,257 ÷ 48,000 = 0.69');
        display = { quote: { tick }, snapshot: undefined, book };
        const root = render(STOCK).root;
        expect(texts(root.find(hasClass(styles.volGroup)))).toContain('—');
        expect(titles(root)).toContain('量比 = 今日成交量 ÷ 昨日成交量\n昨日成交量尚未取得');
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
        expect(button().props['aria-expanded']).toBe(true);
        act(() => button().props.onClick());
        expect(storage.get('sj-stock-board-mode')).toBe('collapsed');
        expect(storage.get('sj-index-board-mode')).toBeUndefined();
        expect(button().props['aria-expanded']).toBe(false);
        act(() => button().props.onClick());
        expect(storage.has('sj-stock-board-mode')).toBe(false);
    });
});
