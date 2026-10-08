// 自選清單漲跌停亮燈 — 成交價到漲停：價格紅底白字＋「漲停」標；跌停綠底
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

function texts(node: any): string {
    return node
        .findAll(() => true)
        .flatMap((n: any) =>
            (n.children ?? []).filter((c: unknown) => typeof c === 'string'),
        )
        .join('|');
}

describe('watchlist 漲跌停亮燈', () => {
    it('漲停：價格套用 limitPrice.up，並顯示「漲停」標', () => {
        tick('2330', 1100, 1000);
        const root = render([{ contract: contract({}) }]);
        const row = rowOf(root, '2330');
        expect(row.props['data-limit']).toBe('up');
        const price = row.find((n: any) => hasClass(n, styles.price));
        const pill = price.find((n: any) => hasClass(n, styles.limitPrice.up));
        expect(texts(pill)).toBe('1,100');
        expect(texts(price)).toContain('漲停');
        expect(texts(row)).not.toContain('跌停');
    });

    it('跌停：價格套用 limitPrice.down，並顯示「跌停」標', () => {
        tick('2330', 900, 1000);
        const root = render([{ contract: contract({}) }]);
        const row = rowOf(root, '2330');
        expect(row.props['data-limit']).toBe('down');
        const price = row.find((n: any) => hasClass(n, styles.price));
        const pill = price.find((n: any) => hasClass(n, styles.limitPrice.down));
        expect(texts(pill)).toBe('900');
        expect(texts(price)).toContain('跌停');
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

    it('選取列也維持亮燈（不被選取底色蓋掉）', () => {
        tick('2330', 1100, 1000);
        const root = render([{ contract: contract({}) }], '2330');
        const row = rowOf(root, '2330');
        expect(
            row.findAll((n: any) => hasClass(n, styles.limitPrice.up)).length,
        ).toBe(1);
    });

    it('國際配色：亮燈色取自主題的漲跌 token（intl 自動反轉為綠漲紅跌）', () => {
        expect(styles.limitTone.up).toBe(vars.color.up);
        expect(styles.limitTone.down).toBe(vars.color.down);
    });
});
