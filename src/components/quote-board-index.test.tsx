// 指數看板渲染：漲跌家數與量能的欄位、資料缺值時各階梯怎麼留格子、滑過提示、現價固定小數位、收合偏好
import { createElement } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => display }));
// 記下每次 useQuery 的抓取函式、key、enabled，接線（只有指數才抓、key 帶交易日、回看視窗）才有測試守著
const queryCalls = vi.hoisted(
    () => [] as { fetcher: () => Promise<unknown>; key: string; enabled?: boolean }[],
);
const fetchKbars = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ datetime: [], Amount: [] })));
vi.mock('../hooks/use-query', () => ({
    useQuery: (fetcher: () => Promise<unknown>, key: string, enabled?: boolean) => {
        queryCalls.push({ fetcher, key, enabled });
        return { data: previous, error: null, loading: false, updatedAt: null, refresh: async () => {} };
    },
}));
vi.mock('../lib/shioaji', () => ({ fetchKbars }));

import { todayStr } from '../lib/utils/date';
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

// 某一格（標籤）的數值文字
function statValue(root: ReactTestInstance, label: string): string | undefined {
    const cell = root.find((n) => hasClass(styles.stat)(n) && texts(n)[0] === label);
    return texts(cell).slice(1).join('');
}

// 元件用電腦時鐘決定基準日的退路，測試固定在 2026-10-19 14:00（台灣），跨過午夜跑也不會變
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T06:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
    storage.clear();
    previous = undefined;
    queryCalls.length = 0;
    fetchKbars.mockClear();
});

describe('指數看板', () => {
    it('顯示漲跌家數與量能，現價固定兩位小數，不重複標題列的代號與名稱', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        previous = 1_000_000_000_000;
        const all = texts(render());
        for (const label of ['漲停', '上漲', '平盤', '下跌', '跌停', '成交金額', '預估量', '較昨日', '時間']) {
            expect(all).toContain(label);
        }
        // 指數現價固定兩位小數：尾數 0 不省略（沒有固定時會變成 47,111.9）
        expect(all).toContain('47,111.90');
        // 較昨日直接用 +/-；compact 的量能標籤沒有標籤可依靠，加「量」字和價格漲跌幅區分
        expect(all).toContain('-7%');
        expect(all).toContain('量-7%');
        expect(all).not.toContain('IX0001');
        expect(all).not.toContain('發行量加權股價指數');
    });

    it('lean 階梯在三種資料狀態下都剛好留一格量能：較昨日、成交金額、預估量', () => {
        display = { quote: { index: idx }, snapshot: undefined, book: undefined };
        // 預估量與前一交易日都有：留較昨日
        previous = 1_000_000_000_000;
        expect(leanVolumeLabels(render())).toEqual(['較昨日']);
        // 沒有預估量（盤前、盤中，這筆是 11:36）：留成交金額
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

describe('收盤後改用實際量', () => {
    const statLabels = (root: ReactTestInstance) => texts(root.find(hasClass(styles.indexGroup.volume)));

    it('13:33 收盤報價沒有預估量：標「實際量」顯示全日金額，較昨日用它算，提示標全日實際、不列進度', () => {
        previous = 1_000_000_000_000;
        display = {
            quote: { index: { ...idx, time: '13:33:00', amount_sum: '825100000000', estimate_amount_sum: '' } },
            snapshot: undefined,
            book: undefined,
        };
        const root = render();
        const all = statLabels(root);
        expect(all).toContain('實際量');
        expect(all).not.toContain('預估量');
        expect(all).toContain('-17%');
        // 收盤後成交金額與實際量是同一個數字，兩格照樣並列（使用者決定）；提示不重複列
        expect(all).toContain('成交金額');
        const tip = titles(root).join('\n');
        expect(tip).toContain('全日實際 8251.0億');
        expect(tip).not.toContain('成交金額');
        expect(tip).toContain('前一交易日 10000.0億');
        expect(tip).not.toContain('已成交預估');
        // lean 階梯仍只留一格量能：較昨日
        expect(leanVolumeLabels(root)).toEqual(['較昨日']);
    });

    it('盤中沒有預估量照舊：標「預估量」、不算較昨日', () => {
        previous = 1_000_000_000_000;
        display = { quote: { index: { ...idx, estimate_amount_sum: '' } }, snapshot: undefined, book: undefined };
        const root = render();
        const all = statLabels(root);
        expect(all).toContain('預估量');
        expect(all).not.toContain('實際量');
        expect(statValue(root, '較昨日')).toBe('—');
    });

    it('收盤那筆沒帶成交金額：不拿開頁當下的舊快照金額當實際量', () => {
        previous = 1_000_000_000_000;
        display = {
            quote: { index: { ...idx, time: '13:33:00', amount_sum: '', estimate_amount_sum: '' } },
            snapshot: { close: 46728.34, total_amount: 300000000000, datetime: `${todayStr()}T10:00:00` },
            book: undefined,
        };
        const root = render();
        expect(statLabels(root)).toContain('預估量');
        expect(statLabels(root)).not.toContain('實際量');
        expect(statValue(root, '較昨日')).toBe('—');
    });

    it('只有收盤快照（沒收到 quote_idx）也改用實際量；基準日跟著快照日期，半夜、週末重開也一樣', () => {
        previous = 1_000_000_000_000;
        const snapshot = (datetime: string) => ({ close: 46728.34, total_amount: 825100000000, datetime });
        const prevKey = () => queryCalls.filter((c) => c.key.startsWith('index-prev-amount:')).at(-1)!.key;
        display = { quote: undefined, snapshot: snapshot(`${todayStr()}T13:33:00`), book: undefined };
        expect(statLabels(render())).toContain('實際量');
        display = { quote: undefined, snapshot: snapshot('2020-01-03T13:33:00'), book: undefined };
        const old = render();
        expect(statLabels(old)).toContain('實際量');
        expect(statValue(old, '較昨日')).toBe('-17%');
        // 比的是快照那天的前一交易日，不是電腦日期的前一天
        expect(prevKey()).toBe('index-prev-amount:IX0001:2020-01-03');
    });

    it('13:30 到 13:33 之間的快照還不算收盤（收盤集合競價的成交 13:33 才進金額）', () => {
        previous = 1_000_000_000_000;
        display = { quote: undefined, snapshot: { close: 46728.34, total_amount: 711346622130, datetime: `${todayStr()}T13:30:00` }, book: undefined };
        const root = render();
        expect(statLabels(root)).toContain('預估量');
        expect(statValue(root, '較昨日')).toBe('—');
    });

    it('今天盤中的快照（11:00）不算收盤：標「預估量」、不算較昨日', () => {
        previous = 1_000_000_000_000;
        display = { quote: undefined, snapshot: { close: 46728.34, total_amount: 644150000000, datetime: `${todayStr()}T11:00:00` }, book: undefined };
        const root = render();
        expect(statLabels(root)).toContain('預估量');
        expect(statLabels(root)).not.toContain('實際量');
        expect(statValue(root, '較昨日')).toBe('—');
    });
});

describe('收盤後重開：家數讀回本機存的收盤那筆', () => {
    // 與 beforeEach 固定的系統時間同一天（describe 收集時 beforeEach 還沒跑，不能呼叫 todayStr()）
    const today = '2026-10-19';
    const note = `收盤時存下的家數（${today} 13:33:00）`;
    const closeQuote = { ...idx, date: today.replace(/-/g, '/'), time: '13:33:00', limit_up_count: 7, raise_count: 160, flat_count: 72, fall_count: 862, limit_down_count: 2 };
    const snapshot = (datetime: string) => ({ close: 46822.08, total_amount: 825100000000, datetime });

    it('沒有即時報價、快照同一天：顯示存下的家數與時間，量能是實際量與較昨日（收盤後重開的完整畫面）', () => {
        previous = 1_000_000_000_000;
        storage.set('sj-index-close:IX0001', JSON.stringify(closeQuote));
        display = { quote: undefined, snapshot: snapshot(`${today}T13:33:00`), book: undefined };
        const root = render();
        const breadthCells = texts(root.find(hasClass(styles.indexGroup.breadth)));
        expect(breadthCells).toEqual(['漲停', '7', '上漲', '160', '平盤', '72', '下跌', '862', '跌停', '2']);
        expect(statValue(root, '時間')).toBe('13:33:00');
        // 金額由 Compact 拆成數字與單位兩個節點，數值從提示驗
        expect(statValue(root, '較昨日')).toBe('-17%');
        const tip = titles(root).join('\n');
        expect(tip).toContain('全日實際 8251.0億');
        // 讀回時這個時間只屬於家數
        expect(tip).toContain('家數更新 13:33:00');
        // 家數組與窄階梯的比例條都註明是哪天收盤時存下的
        expect(String(root.find(hasClass(styles.indexGroup.breadth)).props.title)).toContain(note);
        expect(String(root.find(hasClass(styles.breadthMini)).props.title)).toContain(note);
        // 價格仍看快照，不拿讀回那筆的收盤價
        expect(texts(root)).toContain('46,822.08');
        expect(texts(root)).not.toContain('47,111.90');
    });

    it('半夜重開（電腦已是隔天）：基準日跟著快照日期，照樣顯示實際量與較昨日', () => {
        vi.setSystemTime(new Date('2026-10-19T17:40:00Z'));
        previous = 1_000_000_000_000;
        storage.set('sj-index-close:IX0001', JSON.stringify(closeQuote));
        display = { quote: undefined, snapshot: snapshot(`${today}T13:33:00`), book: undefined };
        const root = render();
        expect(texts(root.find(hasClass(styles.indexGroup.volume)))).toContain('實際量');
        expect(statValue(root, '較昨日')).toBe('-17%');
        expect(statValue(root, '時間')).toBe('13:33:00');
        expect(queryCalls.filter((c) => c.key.startsWith('index-prev-amount:')).at(-1)!.key).toBe('index-prev-amount:IX0001:2026-10-19');
    });

    it('快照是別天：不拿存下的家數，維持空值', () => {
        storage.set('sj-index-close:IX0001', JSON.stringify(closeQuote));
        display = { quote: undefined, snapshot: snapshot('2020-01-02T08:45:00'), book: undefined };
        const all = texts(render());
        expect(all).not.toContain('862');
        expect(all).not.toContain('13:33:00');
    });

    it('有即時報價時以即時為準，不讀本機（存檔與快照同一天，只有「即時優先」擋得住）', () => {
        storage.set('sj-index-close:IX0001', JSON.stringify(closeQuote));
        display = { quote: { index: { ...idx, date: closeQuote.date, time: '13:20:00' } }, snapshot: snapshot(`${today}T13:33:00`), book: undefined };
        const root = render();
        const all = texts(root);
        expect(all).toContain('625');
        expect(all).not.toContain('862');
        expect(String(root.find(hasClass(styles.indexGroup.breadth)).props.title)).not.toContain('收盤時存下');
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

    it('報價與快照都還沒到時不抓，免得先用電腦日期抓一次、快照到了換基準日又抓一次', () => {
        display = { quote: undefined, snapshot: undefined, book: undefined };
        render();
        expect(prevAmountCall().enabled).toBe(false);
    });

    it('個股不抓前一交易日金額', () => {
        display = { quote: undefined, snapshot: undefined, book: undefined };
        render({ code: '2330', name: '台積電', exchange: 'TSE', security_type: 'STK', target_code: null } as any);
        expect(prevAmountCall().enabled).toBe(false);
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
