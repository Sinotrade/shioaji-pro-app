// 自選清單漲跌停亮燈 — 四種樣式（設定可選）：block 數字區實心色塊（預設）、
// tint 整列淡底＋右側色條、solid 整列實心、none 不標示
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
});

const quotes: Record<string, any> = {};
vi.mock('../hooks/use-stream', () => ({
    useQuote: (code: string) => quotes[code],
}));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));
let limitStyle = 'block';
vi.mock('../lib/limit-style-prefs', () => ({
    useLimitStyle: () => limitStyle,
}));

import { vars } from '../theme.css';
import { Watchlist } from './watchlist';
import * as styles from './watchlist.css';

function contract(over: Record<string, unknown>) {
    return {
        exchange: 'TSE',
        code: '2330',
        security_type: 'STK',
        target_code: null,
        name: '台積電',
        currency: 'TWD',
        limit_up: 1100,
        limit_down: 900,
        reference: 1000,
        day_trade: 'Yes',
        update_date: '',
        category: '',
        margin_trading_balance: 0,
        short_selling_balance: 0,
        ...over,
    } as any;
}

function tick(code: string, close: number, ref: number) {
    quotes[code] = {
        tick: { code, close, price_chg: close - ref, total_volume: 1 },
        lastDir: 0,
        flashSeq: 0,
    };
}

let r: ReactTestRenderer | null = null;
afterEach(() => {
    act(() => r?.unmount());
    r = null;
    for (const k of Object.keys(quotes)) delete quotes[k];
    limitStyle = 'block';
});

function render(items: any[], selectedCode: string | null = null) {
    act(() => {
        r = create(
            createElement(Watchlist, {
                items,
                selectedCode,
                onSelect: () => {},
                onAdd: async () => {},
                onRemove: () => {},
                onReorder: () => {},
                serverLists: [{ id: 'w', name: 'W', contracts: [] } as any],
                activeListId: 'w',
                onSelectList: () => {},
                onCreateList: async () => {},
                onRenameList: async () => true,
                onDeleteList: async () => {},
                loading: false,
                structureBusy: false,
                loadError: false,
                onRetryLoad: () => {},
            }),
        );
    });
    return r!;
}

function rowOf(root: ReactTestRenderer, code: string) {
    return root.root.find(
        (n) => n.props['data-code'] === code && n.type === 'div',
    );
}

function hasClass(node: any, cls: string) {
    const have = String(node.props.className ?? '').split(/\s+/);
    return cls.split(/\s+/).every((c) => have.includes(c));
}

// 畫面上可見的文字（略過只給螢幕閱讀器的 srOnly）
function texts(node: any): string {
    return node
        .findAll((n: any) => !hasAncestorSr(n, node))
        .flatMap((n: any) =>
            (n.children ?? []).filter((c: unknown) => typeof c === 'string'),
        )
        .join('|');
}

function hasAncestorSr(n: any, stop: any): boolean {
    for (let p = n; p && p !== stop.parent; p = p.parent) {
        if (typeof p.type === 'string' && hasClass(p, styles.srOnly)) return true;
    }
    return false;
}

function srText(node: any): string {
    return node
        .findAll((n: any) => typeof n.type === 'string' && hasClass(n, styles.srOnly))
        .map((n: any) => n.children.join(''))
        .join('|');
}

describe('watchlist 漲跌停亮燈', () => {
    it('A 預設：漲停時價格與漲跌兩行一起包在數字區實心色塊內', () => {
        tick('2330', 1100, 1000);
        const root = render([{ contract: contract({}) }]);
        const row = rowOf(root, '2330');
        expect(row.props['data-limit']).toBe('up');
        const block = row.find((n: any) => hasClass(n, styles.numCell));
        expect(hasClass(block, styles.limitBlock.up)).toBe(true);
        // 價格與漲跌（含漲跌幅）都在色塊內 — 不是只包價格
        expect(block.find((n: any) => hasClass(n, styles.price))).toBeTruthy();
        expect(block.find((n: any) => hasClass(n, styles.change))).toBeTruthy();
        expect(texts(block)).toBe('1,100|+100.00| |+10.00%');
        // 代碼／名稱不在色塊內
        expect(texts(block)).not.toMatch(/2330|台積電/);
        // 不顯示小標文字，只給螢幕閱讀器
        expect(texts(row)).not.toMatch(/漲停|跌停/);
        expect(srText(row).trim()).toBe('漲停');
    });

    it('A 預設：跌停用 limitBlock.down', () => {
        tick('2330', 900, 1000);
        const root = render([{ contract: contract({}) }]);
        const block = rowOf(root, '2330').find((n: any) => hasClass(n, styles.numCell));
        expect(hasClass(block, styles.limitBlock.down)).toBe(true);
        expect(srText(rowOf(root, '2330')).trim()).toBe('跌停');
    });

    it('B：整列淡底＋右側色條（列套 limitTint），沒有數字區色塊', () => {
        limitStyle = 'tint';
        tick('2330', 1100, 1000);
        const row = rowOf(render([{ contract: contract({}) }]), '2330');
        expect(hasClass(row, styles.limitTint.up)).toBe(true);
        const block = row.find((n: any) => hasClass(n, styles.numCell));
        expect(hasClass(block, styles.limitBlock.up)).toBe(false);
    });

    it('D：整列實心（列套 limitSolid）', () => {
        limitStyle = 'solid';
        tick('2330', 900, 1000);
        const row = rowOf(render([{ contract: contract({}) }]), '2330');
        expect(hasClass(row, styles.limitSolid.down)).toBe(true);
    });

    it('不標示：到停板也不加任何亮燈樣式', () => {
        limitStyle = 'none';
        tick('2330', 1100, 1000);
        const row = rowOf(render([{ contract: contract({}) }]), '2330');
        const block = row.find((n: any) => hasClass(n, styles.numCell));
        expect(hasClass(block, styles.limitBlock.up)).toBe(false);
        expect(hasClass(row, styles.limitTint.up)).toBe(false);
        expect(hasClass(row, styles.limitSolid.up)).toBe(false);
        expect(srText(row)).toBe('');
    });

    it('未到漲跌停：不亮燈', () => {
        tick('2330', 1095, 1000);
        const root = render([{ contract: contract({}) }]);
        const row = rowOf(root, '2330');
        expect(row.props['data-limit']).toBeUndefined();
        expect(texts(row)).not.toMatch(/漲停|跌停/);
    });

    it('指數不亮燈', () => {
        quotes['001'] = {
            index: { close: 25000, reference: 22000, open: 0, high: 0, low: 0 },
            lastDir: 0,
            flashSeq: 0,
        };
        const root = render([
            {
                contract: contract({
                    code: '001',
                    security_type: 'IND',
                    limit_up: 24200,
                    limit_down: 19800,
                }),
            },
        ]);
        expect(rowOf(root, '001').props['data-limit']).toBeUndefined();
    });

    it('浮點邊界：0.1 級距累加的漲停價仍亮燈', () => {
        tick('2002', 0.1 * 333, 30.3);
        const root = render([
            { contract: contract({ code: '2002', limit_up: 33.3, limit_down: 27.3, reference: 30.3 }) },
        ]);
        expect(rowOf(root, '2002').props['data-limit']).toBe('up');
    });

    it('無即時 tick 時用快照收盤價判斷', () => {
        const root = render([
            {
                contract: contract({}),
                snapshot: { close: 900, change_price: -100, change_rate: -10 } as any,
            },
        ]);
        expect(rowOf(root, '2330').props['data-limit']).toBe('down');
    });

    it('昨日快照（隱含參考價和今天不同）不亮燈', () => {
        // 昨日 1000 → 1100 漲停；今天參考價 1100、漲停 1210，尚未成交
        const root = render([
            {
                contract: contract({ reference: 1100, limit_up: 1210, limit_down: 990 }),
                snapshot: { close: 1100, change_price: 100, change_rate: 10 } as any,
            },
        ]);
        expect(rowOf(root, '2330').props['data-limit']).toBeUndefined();
        // 用今天的漲停價也一樣：快照屬於昨天就不亮
        const root2 = render([
            {
                contract: contract({ code: '2317', reference: 1000, limit_up: 1100 }),
                snapshot: { close: 1100, change_price: 110, change_rate: 11 } as any,
            },
        ]);
        expect(rowOf(root2, '2317').props['data-limit']).toBeUndefined();
    });

    it('選取列在每種樣式都保留 selected（藍色左條）且仍亮燈', () => {
        for (const st of ['block', 'tint', 'solid'] as const) {
            limitStyle = st;
            tick('2330', 1100, 1000);
            const row = rowOf(render([{ contract: contract({}) }], '2330'), '2330');
            expect(hasClass(row, styles.row.selected)).toBe(true);
            expect(row.props['data-limit']).toBe('up');
            act(() => r?.unmount());
            r = null;
        }
    });

    it('A：不同位數的停板價共用同一份固定寬度色塊 class', () => {
        tick('2424', 9.79, 8.9);
        tick('2059', 10615, 11790);
        const root = render([
            { contract: contract({ code: '2424', limit_up: 9.79, limit_down: 8.01, reference: 8.9 }) },
            { contract: contract({ code: '2059', limit_up: 12965, limit_down: 10615, reference: 11790 }) },
        ]);
        const block = (code: string) =>
            rowOf(root, code).find((n: any) => hasClass(n, styles.numCell));
        expect(hasClass(block('2424'), styles.limitBlock.up)).toBe(true);
        expect(hasClass(block('2059'), styles.limitBlock.down)).toBe(true);
        // 寬度、內距、圓角在共用的 base class；漲／跌只差底色
        const up = styles.limitBlock.up.split(' ');
        const shared = styles.limitBlock.down.split(' ').filter((c) => up.includes(c));
        expect(shared.length).toBe(1);
        expect(block('2424').props.style).toBeUndefined();
        expect(block('2059').props.style).toBeUndefined();
    });

    it('小線圖模式＋色塊：停板列收起小線圖，數字區跨到小線圖欄', () => {
        store.set('sj-pro-watchlist-spark', '1');
        tick('2330', 1100, 1000);
        tick('2317', 105, 100);
        const root = render([
            { contract: contract({}) },
            { contract: contract({ code: '2317', limit_up: 110, limit_down: 90, reference: 100 }) },
        ]);
        const lit = rowOf(root, '2330');
        expect(lit.findAll((n: any) => typeof n.type === 'string' && hasClass(n, styles.sparkCell)).length).toBe(0);
        expect(hasClass(lit.find((n: any) => hasClass(n, styles.numCell)), styles.numCellWide)).toBe(true);
        // 未停板列照常顯示小線圖
        const normal = rowOf(root, '2317');
        expect(normal.findAll((n: any) => typeof n.type === 'string' && hasClass(n, styles.sparkCell)).length).toBe(1);
        store.delete('sj-pro-watchlist-spark');
    });

    it('國際配色：亮燈色取自主題的漲跌 token（intl 自動反轉為綠漲紅跌）', () => {
        expect(styles.limitTone.up).toBe(vars.color.up);
        expect(styles.limitTone.down).toBe(vars.color.down);
    });
});
