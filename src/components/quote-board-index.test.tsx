// 指數看板渲染：漲跌家數與量能的欄位、資料缺值時各階梯怎麼留格子、滑過提示、現價固定小數位、收合偏好
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
// 前一交易日金額由 useQuery 抓，測試直接指定它回傳什麼
let previous: number | undefined;
let previousState: { loading: boolean; error: string | null } = { loading: false, error: null };
vi.mock('../hooks/use-display-book', () => ({ useSnapshotBaseline: () => ({ snapshot: display.snapshot }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => display.quote }));
// 記下每次 useQuery 的抓取函式、key、enabled，接線（只有指數才抓、key 帶交易日、回看視窗）才有測試守著
const queryCalls = vi.hoisted(
    () => [] as { fetcher: () => Promise<unknown>; key: string; enabled?: boolean }[],
);
const fetchKbars = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ datetime: [] as string[], Amount: [] as number[] })));
vi.mock('../hooks/use-query', () => ({
    useQuery: (fetcher: () => Promise<unknown>, key: string, enabled?: boolean) => {
        queryCalls.push({ fetcher, key, enabled });
        return { data: previous, ...previousState, updatedAt: null, refresh: async () => {} };
    },
}));
vi.mock('../lib/shioaji', () => ({ fetchKbars }));

import { QuoteBoard } from './quote-board';
import * as styles from './quote-board.css';

const INDEX = { code: 'IX0001', name: '發行量加權股價指數', exchange: 'TSE', security_type: 'IND', target_code: null } as any;

const idx = {
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
};

function render(contract: any = INDEX) {
    let root!: ReturnType<typeof create>;
    act(() => {
        root = create(createElement(QuoteBoard, { contract }));
    });
    return root.root;
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

// lean 階梯收起 lowPriority 與 secondary：沒有這兩個 class 的量能格才會留下來
function leanVolumeLabels(root: ReactTestInstance): string[] {
    const group = root.find(hasClass(styles.indexGroup.volume));
    return group
        .findAll(hasClass(styles.stat))
        .filter((n) => !hasClass(styles.lowPriority)(n) && !hasClass(styles.secondary)(n))
        .map((n) => texts(n)[0]!);
}

afterEach(() => {
    storage.clear();
    previous = undefined;
    previousState = { loading: false, error: null };
    queryCalls.length = 0;
    fetchKbars.mockClear();
});

describe('指數看板', () => {
    it('前一交易日金額的載入、失敗與未收到 quote_idx 各有明確說明', () => {
        display = { quote: { index: idx } };
        previousState = { loading: true, error: null };
        expect(titles(render()).join('\n')).toContain('前一交易日金額取得中，失敗會自動重試');
        previousState = { loading: false, error: 'unavailable' };
        expect(titles(render()).join('\n')).toContain('前一交易日金額取得失敗，本交易日不再重試');
        display = {};
        expect(titles(render())).toContain('本次連線尚未收到 quote_idx');
    });

    it('顯示漲跌家數與量能，現價固定兩位小數，不重複標題列的代號與名稱', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        previous = 1_000_000_000_000;
        const all = texts(render());
        for (const label of ['漲停', '上漲', '平盤', '下跌', '跌停', '成交金額', '預估量', '較昨日', '時間']) {
            expect(all).toContain(label);
        }
        // 指數現價固定兩位小數：尾數 0 不省略（沒有固定時會變成 47,111.9）
        expect(all).toContain('47,111.90');
        expect(all).toContain('量縮7%');
        expect(all).not.toContain('IX0001');
        expect(all).not.toContain('發行量加權股價指數');
    });

    it('lean 階梯在三種資料狀態下都剛好留一格量能：較昨日、成交金額、預估量', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        // 預估量與前一交易日都有：留較昨日
        previous = 1_000_000_000_000;
        expect(leanVolumeLabels(render())).toEqual(['較昨日']);
        // 沒有預估量（盤前、盤後）：留成交金額
        display = { quote: { index: { ...idx, estimate_amount_sum: '' } }, snapshot: undefined, book: undefined };
        expect(leanVolumeLabels(render())).toEqual(['成交金額']);
        // 有預估量、前一交易日還沒抓到（或抓失敗）：留預估量，量能組不會整組空掉
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        previous = undefined;
        expect(leanVolumeLabels(render())).toEqual(['預估量']);
    });

    it('預估量是 0 或空字串視為沒有預估，不顯示「預估量 0」', () => {
        previous = 1_000_000_000_000;
        for (const estimate of ['0', '', undefined]) {
            display = { quote: { index: { ...idx, estimate_amount_sum: estimate } }, snapshot: undefined, book: undefined };
            const root = render();
            const group = root.find(hasClass(styles.indexGroup.volume));
            const stat = (label: string) => group.find((n) => hasClass(styles.stat)(n) && texts(n)[0] === label);
            // 沒有預估量：預估量與較昨日收進提示，成交金額留在看板上
            expect(hasClass(styles.lowPriority)(stat('預估量'))).toBe(true);
            expect(hasClass(styles.lowPriority)(stat('成交金額'))).toBe(false);
            expect(titles(root).join('\n')).not.toContain('預估全日');
        }
    });

    it('提示：有預估量才列「前一交易日」，沒有預估量時不重複列同一個數字', () => {
        previous = 1_000_000_000_000;
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        const withEstimate = titles(render()).join('\n');
        expect(withEstimate).toContain('預估全日 9292.1億');
        expect(withEstimate).toContain('已成交預估的 69%');
        expect(withEstimate).toContain('前一交易日 10000.0億');
        // 沒有 quote_idx 時成交金額退回快照（可能就是前一交易日全日），這時提示不列前一交易日
        display = { quote: { index: { ...idx, estimate_amount_sum: '' } }, snapshot: undefined, book: undefined };
        expect(titles(render()).join('\n')).not.toContain('前一交易日');
    });
});

describe('前一交易日金額的抓取接線', () => {
    // 看板可能不只一個 useQuery，依 key 前綴找前一交易日金額那個
    const prevAmountCall = () => queryCalls.filter((c) => c.key.startsWith('index-prev-amount:')).at(-1)!;

    it('只有指數才抓；key 帶報價所屬交易日，跨日換 key；抓取視窗為往前 21 天到前一天', async () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        render();
        const call = prevAmountCall();
        expect(call.enabled).toBe(true);
        expect(call.key).toBe('index-prev-amount:IX0001:2026-10-16');
        await call.fetcher();
        expect(fetchKbars).toHaveBeenCalledTimes(1);
        expect(fetchKbars.mock.calls[0]!.slice(1)).toEqual(['2026-09-25', '2026-10-15']);

        // App 跨午夜開著：下一個交易日的第一筆 quote_idx 到達後換 key，重新抓
        display = { quote: { index: { ...idx, date: '2026-10-19' } }, snapshot: undefined, book: undefined };
        render();
        expect(prevAmountCall().key).toBe('index-prev-amount:IX0001:2026-10-19');
    });

    it('個股不抓前一交易日金額', () => {
        display = { quote: undefined, snapshot: undefined, book: undefined };
        render({ code: '2330', name: '台積電', exchange: 'TSE', security_type: 'STK', target_code: null } as any);
        expect(prevAmountCall().enabled).toBe(false);
    });

    it('503 依接線等待完整 30 秒才重試，成功後採用前一交易日金額', async () => {
        vi.useFakeTimers();
        try {
            display = { quote: { index: idx } };
            fetchKbars.mockRejectedValueOnce({ status: 503 }).mockResolvedValueOnce({
                datetime: ['2026-10-15 09:00:00', '2026-10-15 09:01:00'], Amount: [400, 600],
            });
            render();
            const pending = prevAmountCall().fetcher();
            await vi.advanceTimersByTimeAsync(29_999);
            expect(fetchKbars).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toBe(1000);
            expect(fetchKbars).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('422 立即失敗，不啟動延遲重試', async () => {
        display = { quote: { index: idx } };
        fetchKbars.mockRejectedValueOnce({ status: 422 });
        render();
        await expect(prevAmountCall().fetcher()).rejects.toMatchObject({ status: 422 });
        expect(fetchKbars).toHaveBeenCalledTimes(1);
    });
});

describe('收合偏好', () => {
    it('按收合寫入 sj-index-board-mode，再按一次回到自動並清掉偏好', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        const root = render();
        const button = () => root.find((n) => n.type === 'button');
        expect(button().props['aria-expanded']).toBe(true);
        act(() => button().props.onClick());
        expect(storage.get('sj-index-board-mode')).toBe('collapsed');
        // 測試環境沒有 ResizeObserver、階梯不會重算，按鈕標示的變化在實機驗證；這裡只看偏好有寫入與清除
        act(() => button().props.onClick());
        expect(storage.has('sj-index-board-mode')).toBe(false);
    });
});
