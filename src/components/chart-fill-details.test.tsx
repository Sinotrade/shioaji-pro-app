// ChartFillDetails：買賣文字與顏色、帳號遮罩、時間精度、狀態文案，以及 tooltip 不吃滑鼠事件的 CSS 保證
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer, type TestRendererOptions } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartFill } from '../lib/chart-fills';
import { ChartFillDetails } from './chart-fill-details';
import * as styles from './chart-fill-details.css';

const UP = '#f00';
const DOWN = '#0f0';
const ts = (date: string) => Date.parse(`${date}+08:00`) / 1000;
const ACCOUNT = { account_type: 'F', person_id: '', broker_id: 'F002000', account_id: '7654321', signed: true, username: '甲' };
const fill = (n: number, overrides: Partial<ChartFill> = {}): ChartFill => ({
    id: `fill-${n}`, time: 0, ts: ts('2026-10-13T21:38:23') + n, price: 48680 + n, quantity: n + 1, unit: '口', action: 'Buy', code: 'TXFJ6', account: ACCOUNT, ...overrides,
});
const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
const mounted: ReactTestRenderer[] = [];
const element = (props: Partial<Parameters<typeof ChartFillDetails>[0]> = {}) =>
    createElement(ChartFillDetails, { fills: [fill(0)], accountId: '7654321', privacy: false, up: UP, down: DOWN, ...props });
function render(props: Partial<Parameters<typeof ChartFillDetails>[0]> = {}, options?: TestRendererOptions) {
    let r!: ReactTestRenderer;
    act(() => { r = create(element(props), options); });
    mounted.push(r);
    return r;
}
const rows = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'tr' && n.props['data-fill-id']);
const root = (r: ReactTestRenderer) => r.root.findAll(n => n.props['data-fill-details'])[0]!;

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
    for (const r of mounted.splice(0)) act(() => r.unmount());
    vi.unstubAllGlobals();
});

describe('ChartFillDetails', () => {
    it('買進是「▲ 買」用上漲色、賣出是「▼ 賣」用下跌色；價格與數量帶單位', () => {
        const r = render({ fills: [fill(0), fill(1, { action: 'Sell', unit: '張', price: 12.5 })] });
        const cells = rows(r).map(row => row.findAll(n => n.type === 'td'));
        expect(cells[0]!.map(text)).toEqual(['10-13 21:38:23', '▲ 買', '48,680', '1 口']);
        expect(cells[0]![1]!.props.style.color).toBe(UP);
        expect(cells[1]!.map(text).slice(1)).toEqual(['▼ 賣', '12.5', '2 張']);
        expect(cells[1]![1]!.props.style.color).toBe(DOWN);
    });

    it('帳號只在隱私模式下遮罩（清單與 tooltip 都是）', () => {
        for (const tooltip of [false, true]) {
            expect(text(root(render({ tooltip, privacy: false })))).toContain('帳戶 7654321');
            const masked = text(root(render({ tooltip, privacy: true })));
            expect(masked).not.toContain('7654321');
            expect(masked).toContain('帳戶 •••••21');
        }
    });

    it('時間帶小數秒才顯示到毫秒；dateless 只在 tooltip 省略月日', () => {
        const whole = fill(0, { ts: ts('2026-10-13T21:38:23') });
        const fraction = fill(1, { ts: ts('2026-10-13T21:38:24') + 0.123 });
        expect(rows(render({ fills: [whole, fraction] })).map(row => text(row.findAll(n => n.type === 'td')[0]!)))
            .toEqual(['10-13 21:38:23', '10-13 21:38:24.123']);
        const tip = render({ fills: [whole, fraction], tooltip: true, dateless: true });
        expect(rows(tip).map(row => text(row.findAll(n => n.type === 'td')[0]!))).toEqual(['21:38:23', '21:38:24.123']);
        // 清單永遠是完整時間，dateless 對它沒有作用；tooltip 沒有 dateless 時也保留日期
        expect(text(rows(render({ fills: [whole], dateless: true }))[0]!)).toContain('10-13 21:38:23');
        expect(text(rows(render({ fills: [whole], tooltip: true }))[0]!)).toContain('10-13 21:38:23');
    });

    it('窄提示框只顯示到秒（數量欄才不會被擠出框外）、時間格可換行；寬提示框與清單仍到毫秒', () => {
        const fraction = fill(1, { ts: ts('2026-10-13T21:38:24') + 0.123 });
        const timeCell = (r: ReactTestRenderer) => rows(r)[0]!.findAll(n => n.type === 'td')[0]!;
        const narrow = render({ fills: [fraction], tooltip: true, compact: true });
        expect(text(timeCell(narrow))).toBe('10-13 21:38:24');
        expect(timeCell(narrow).props.className).toBe(styles.tooltipTime);
        expect(text(timeCell(render({ fills: [fraction], tooltip: true, compact: true, dateless: true })))).toBe('21:38:24');
        const wide = render({ fills: [fraction], tooltip: true });
        expect(text(timeCell(wide))).toBe('10-13 21:38:24.123');
        expect(timeCell(wide).props.className).toBe(styles.cell);
        const list = render({ fills: [fraction], compact: true });
        expect(text(timeCell(list))).toBe('10-13 21:38:24.123');
        expect(timeCell(list).props.className).toBe(styles.cell);
    });

    it('tooltip 最多 4 筆：剛好 4 筆沒有「另有」，第 5 筆起提示請開明細', () => {
        const four = render({ fills: [0, 1, 2, 3].map(n => fill(n)), tooltip: true });
        expect(rows(four)).toHaveLength(4);
        expect(text(root(four))).not.toContain('另有');
        const six = render({ fills: [0, 1, 2, 3, 4, 5].map(n => fill(n)), tooltip: true });
        expect(rows(six)).toHaveLength(4);
        expect(text(root(six))).toContain('另有 2 筆');
        expect(root(six).props.role).toBe('tooltip');
        // 清單不截斷，也沒有「另有」
        const list = render({ fills: [0, 1, 2, 3, 4, 5].map(n => fill(n)) });
        expect(rows(list)).toHaveLength(6);
        expect(text(root(list))).not.toContain('另有');
    });

    it('狀態文案：沒有帳戶先請選帳戶；待確認用原因；K 線載入中不說沒有成交；其餘才說沒有可顯示成交', () => {
        const empty = (props: Partial<Parameters<typeof ChartFillDetails>[0]>) => text(root(render({ fills: [], ...props })));
        // 沒有帳戶時沒有東西被藏起來：即使來源待確認，也先請使用者選帳戶
        expect(empty({ accountId: undefined, pending: true, note: '成交待對帳' })).toContain('請先選擇圖表帳戶以查看成交。');
        expect(empty({ accountId: undefined, pending: true, note: '成交待對帳' })).not.toContain('成交待對帳');
        expect(empty({ pending: true })).toContain('成交資料待確認');
        expect(empty({ pending: true })).toContain('確認前不顯示成交');
        expect(empty({ pending: true, note: '成交待對帳：串流中斷' })).toContain('成交待對帳：串流中斷');
        const loading = empty({ barsLoading: true });
        expect(loading).toContain('載入 K 線中…');
        expect(loading).toContain('已載入成交 · … 筆');
        expect(loading).not.toContain('沒有可顯示');
        expect(empty({})).toContain('目前帳戶在已載入 K 線範圍內沒有可顯示的逐筆成交。');
    });

    it('待確認的空清單寫出處置說明：有 hint 用 hint，沒給沿用委託分頁的更新', () => {
        const empty = (props: Partial<Parameters<typeof ChartFillDetails>[0]>) => text(root(render({ fills: [], pending: true, ...props })));
        expect(empty({ hint: '主視窗的資料同步後會自動確認' })).toContain('確認前不顯示成交；主視窗的資料同步後會自動確認。');
        expect(empty({ hint: '主視窗的資料同步後會自動確認' })).not.toContain('委託分頁');
        expect(empty({})).toContain('確認前不顯示成交；可使用委託分頁的更新。');
    });

    it('無對應 K 棒的成交列在清單最後並標示；表頭分開計數，沒有時維持原樣；tooltip 不列', () => {
        const late = fill(9, { id: 'late' });
        const list = render({ fills: [fill(0), fill(1)], unplaced: [late] });
        expect(rows(list).map(row => row.props['data-fill-id'])).toEqual(['fill-0', 'fill-1', 'late']);
        expect(text(root(list))).toContain('已載入成交 · 2 筆（圖上）＋1 筆無對應 K 棒');
        const tbodies = list.root.findAll(n => n.type === 'tbody');
        expect(tbodies).toHaveLength(2);
        expect(text(tbodies[1]!.findAll(n => n.type === 'th')[0]!)).toBe('圖上無對應 K 棒（例如盤後）');
        expect(text(root(render({ fills: [fill(0)] })))).toContain('已載入成交 · 1 筆');
        expect(text(root(render({ fills: [fill(0)] })))).not.toContain('無對應');
        // 只有無對應 K 棒的成交：照樣列出，不說沒有成交
        const only = text(root(render({ fills: [], unplaced: [late] })));
        expect(only).toContain('0 筆（圖上）＋1 筆無對應 K 棒');
        expect(only).not.toContain('沒有可顯示');
        const tip = render({ fills: [fill(0)], unplaced: [late], tooltip: true });
        expect(rows(tip).map(row => row.props['data-fill-id'])).toEqual(['fill-0']);
        expect(text(root(tip))).not.toContain('無對應');
    });

    it('全部帳戶：清單多一欄帳戶、tooltip（寬窄都是）每筆第二列寫帳戶（套隱私遮罩），表頭寫全部帳戶而不是單一帳戶', () => {
        const other = { ...ACCOUNT, account_id: '1111121' };
        const fills = [fill(0), fill(1, { account: other })];
        // 提示框每筆第二列那格（第一列之後的那一列）
        const meta = (r: ReactTestRenderer) => r.root.findByType('tbody').findAllByType('tr').filter((_, i) => i % 2).map(row => row.findByType('td'));
        for (const [tooltip, compact] of [[false, false], [true, false], [true, true]] as const) {
            const plain = render({ fills, allAccounts: true, accountId: undefined, tooltip, compact });
            const masked = render({ fills, allAccounts: true, accountId: undefined, privacy: true, tooltip, compact });
            if (!tooltip) {
                expect(rows(plain).map(row => row.findAllByType('td').length)).toEqual([5, 5]);
                expect(rows(plain).map(row => text(row.findAll(n => n.type === 'td').at(-1)!))).toEqual(['7654321', '1111121']);
                expect(rows(masked).map(row => text(row.findAll(n => n.type === 'td').at(-1)!))).toEqual(['•••••21', '•••••21']);
            } else {
                // 寬框（380～450px）也放第二列：第一列四格、不含帳戶
                expect(rows(plain).map(row => row.findAllByType('td').length)).toEqual([4, 4]);
                expect(rows(plain).map(text).join()).not.toMatch(/帳戶|7654321|1111121/);
                expect(meta(plain).map(td => td.props.colSpan)).toEqual([4, 4]);
                expect(meta(plain).map(text)).toEqual(['帳戶 7654321', '帳戶 1111121']);
                expect(meta(masked).map(text)).toEqual(['帳戶 •••••21', '帳戶 •••••21']);
            }
            const header = text(root(plain).findByType('strong').parent!);
            expect(header).toContain('全部帳戶');
            expect(header).not.toContain('帳戶 '); // 不是「帳戶 7654321」
            expect(text(root(masked))).not.toMatch(/7654321|1111121/);
        }
        const list = render({ fills, allAccounts: true });
        expect(list.root.findAll(n => n.type === 'th').map(text)).toEqual(['成交時間', '買賣', '成交價', '數量', '帳戶']);
        // 沒有單一帳戶也不請使用者選帳戶；待確認照樣說原因
        const empty = (props: Partial<Parameters<typeof ChartFillDetails>[0]>) => text(root(render({ fills: [], allAccounts: true, accountId: undefined, ...props })));
        expect(empty({})).toContain('全部帳戶在已載入 K 線範圍內沒有可顯示的逐筆成交。');
        expect(empty({ pending: true, note: '成交待對帳' })).toContain('成交待對帳');
        expect(empty({ pending: true })).not.toContain('請先選擇圖表帳戶');
    });

    it('tooltip 標頭寫筆數與合計數量（含第 5 筆以後），張、股分開不相加', () => {
        const tip = (fills: ChartFill[]) => text(root(render({ fills, tooltip: true })).findAll(n => n.type === 'strong')[0]!);
        expect(tip([0, 1, 2, 3, 4].map(n => fill(n)))).toBe('此 K 棒成交 · 5 筆／15 口');
        expect(tip([fill(0, { unit: '張' }), fill(1, { unit: '股', quantity: 1000 }), fill(2, { unit: '張' })])).toBe('此 K 棒成交 · 3 筆／4 張＋1,000 股');
    });

    it('清單是可聚焦的 region（tabIndex 0、名稱、欄位 scope）；tooltip 不可聚焦', () => {
        const list = render({ id: 'fills-list' });
        expect(root(list).props).toMatchObject({ id: 'fills-list', tabIndex: 0, role: 'region', 'aria-label': '已載入成交明細' });
        expect(list.root.findAll(n => n.type === 'th').map(n => n.props.scope)).toEqual(['col', 'col', 'col', 'col']);
        const tip = render({ tooltip: true });
        expect(root(tip).props.tabIndex).toBeUndefined();
        expect(root(tip).props['aria-label']).toBe('此 K 棒成交');
        expect(tip.root.findAll(n => n.type === 'th')).toHaveLength(0);
    });
});

describe('ChartFillDetails 均價摘要與清單上限', () => {
    const summary = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'div' && n.props['data-fill-summary']).map(text);
    it('tooltip：同商品同方向同單位有 2 個以上價位才多一行均價摘要（買先於賣），位數＝圖表位數、均價最多多 1 位', () => {
        const fills = [
            fill(0, { price: 46458, quantity: 1 }), fill(1, { price: 46474, quantity: 2 }), // 買 2 個價位：均 (46458＋46474×2)÷3＝46468.67
            fill(2, { action: 'Sell', price: 46470 }), fill(3, { action: 'Sell', price: 46470 }), // 賣只有 1 個價位：不出摘要
            fill(4, { price: 31.5, unit: '張', quantity: 1 }), fill(5, { price: 31.55, unit: '張', quantity: 1 }), // 另一個單位
        ];
        const r = render({ fills, tooltip: true, decimalsFor: (price) => (price < 100 ? 2 : 0) });
        expect(summary(r)).toEqual(['▲ 買 3 口 · 均 46,468.7 · 46,458～46,474', '▲ 買 2 張 · 均 31.525 · 31.50～31.55']);
        const lines = r.root.findAll(n => n.type === 'div' && n.props['data-fill-summary']);
        expect(lines[0]!.props.style.color).toBe(UP);
        // 沒傳位數：均價不截小數、不補 0
        const plain = render({ fills: fills.slice(0, 2), tooltip: true });
        expect(summary(plain)).toEqual(['▲ 買 3 口 · 均 46,468.66666667 · 46,458～46,474']);
    });
    it('同一根有兩個月份（換月日）時行首加商品；賣的摘要用下跌色；清單不顯示摘要', () => {
        const fills = [fill(0, { action: 'Sell', price: 10 }), fill(1, { action: 'Sell', price: 12 }), fill(2, { code: 'TXFK6', price: 20 }), fill(3, { code: 'TXFK6', price: 22 })];
        const r = render({ fills, tooltip: true });
        expect(summary(r)).toEqual(['TXFK6 ▲ 買 7 口 · 均 21.14285714 · 20～22', 'TXFJ6 ▼ 賣 3 口 · 均 11.33333333 · 10～12']);
        expect(r.root.findAll(n => n.type === 'div' && n.props['data-fill-summary'])[1]!.props.style.color).toBe(DOWN);
        expect(summary(render({ fills }))).toEqual([]);
        expect(summary(render({ fills: [fill(0), fill(1, { price: 48680 })], tooltip: true }))).toEqual([]); // 同一價位
    });
    it(`清單兩段合計只列最新 500 筆（無對應 K 棒至少保留 50 個名額）並寫出未列的筆數；表頭照實際總數`, () => {
        const many = Array.from({ length: 1200 }, (_, i) => fill(i));
        const r = render({ fills: many, unplaced: [fill(5000, { id: 'late' })] });
        expect(rows(r)).toHaveLength(500);
        expect(rows(r)[0]!.props['data-fill-id']).toBe('fill-701');
        expect(rows(r)[498]!.props['data-fill-id']).toBe('fill-1199');
        expect(rows(r)[499]!.props['data-fill-id']).toBe('late'); // 盤後最新的那筆仍看得到
        expect(text(root(r))).toContain('1200 筆（圖上）＋1 筆無對應 K 棒');
        expect(text(root(r))).toContain('清單只列最新 500 筆，另有 701 筆未列出。');
        // 圖上很多、無對應也很多：無對應保留 50 列（最新的）
        const late = Array.from({ length: 400 }, (_, i) => fill(2000 + i));
        const both = render({ fills: many, unplaced: late });
        expect(rows(both)).toHaveLength(500);
        expect(rows(both)[450]!.props['data-fill-id']).toBe('fill-2350');
        // 圖上 300 筆：剩下 200 個名額給無對應 K 棒的最新 200 筆
        const mixed = render({ fills: many.slice(0, 300), unplaced: late });
        expect(rows(mixed)).toHaveLength(500);
        expect(rows(mixed)[300]!.props['data-fill-id']).toBe('fill-2200');
        expect(text(root(mixed))).toContain('300 筆（圖上）＋400 筆無對應 K 棒');
        expect(text(root(mixed))).toContain('另有 200 筆未列出。');
        expect(text(render({ fills: many.slice(0, 500) }).root)).not.toContain('只列最新');
    });
});

describe('ChartFillDetails 換月合約與窄提示框', () => {
    it('跨合約各只有一個價位也在提示框逐筆第二列標出合約（寬提示框也是），判斷範圍包含整根 K 棒', () => {
        const fills = [fill(0, { price: 10 }), fill(1, { code: 'TXFK6', price: 20 })];
        for (const allAccounts of [false, true]) {
            const r = render({ fills, tooltip: true, allAccounts });
            expect(r.root.findAll(n => n.props['data-fill-summary'])).toHaveLength(0);
            const bodyRows = r.root.findByType('tbody').findAllByType('tr');
            expect(rows(r).map(row => row.findAllByType('td').length)).toEqual([4, 4]);
            expect([bodyRows[1]!, bodyRows[3]!].map(row => text(row))).toEqual(
                allAccounts ? ['合約 TXFJ6 · 帳戶 7654321', '合約 TXFK6 · 帳戶 7654321'] : ['合約 TXFJ6', '合約 TXFK6']);
        }
        const partial = render({ fills: fills.slice(0, 1), bar: fills, tooltip: true });
        expect(text(partial.root.findByType('tbody'))).toContain('合約 TXFJ6');
    });

    it.each([false, true])('清單跨圖上與無對應成交判斷合約欄，群組標題涵蓋所有欄位（全部帳戶=%s）', (allAccounts) => {
        const r = render({ fills: [fill(0)], unplaced: [fill(1, { code: 'TXFK6' })], allAccounts });
        const headers = r.root.findAll(n => n.type === 'th' && n.props.scope === 'col').map(text);
        expect(headers).toEqual(['成交時間', '買賣', '合約', '成交價', '數量', ...(allAccounts ? ['帳戶'] : [])]);
        expect(rows(r).map(row => text(row.findAllByType('td')[2]!))).toEqual(['TXFJ6', 'TXFK6']);
        expect(r.root.findByProps({ scope: 'rowgroup' }).props.colSpan).toBe(allAccounts ? 6 : 5);
    });

    it.each([false, true])('提示框全部帳戶每筆第一列四格、第二列顯示遮罩帳戶，跨合約時也顯示合約（窄框=%s；寬框也是）', (compact) => {
        for (const multiCode of [false, true]) {
            const fills = [fill(0), fill(1, { code: multiCode ? 'TXFK6' : 'TXFJ6', account: { ...ACCOUNT, account_id: '1111121' } })];
            const r = render({ fills, tooltip: true, compact, allAccounts: true, privacy: true });
            const bodyRows = r.root.findByType('tbody').findAllByType('tr');
            expect(bodyRows).toHaveLength(4);
            rows(r).forEach((row, i) => {
                expect(row.findAllByType('td')).toHaveLength(4);
                expect(text(row)).not.toMatch(/TXF|帳戶|•••••21/);
                const meta = bodyRows[i * 2 + 1]!.findByType('td');
                expect(meta.props.colSpan).toBe(4);
                expect(meta.props.className).toBe(styles.tooltipMeta);
                expect(text(meta)).toBe(`${multiCode ? `合約 ${fills[i]!.code} · ` : ''}帳戶 •••••21`);
            });
            expect(text(root(r))).not.toMatch(/7654321|1111121/);
        }
    });

    it('窄提示框跨合約且目前帳戶時第二列只列合約；單一合約維持單列四格', () => {
        const r = render({ fills: [fill(0), fill(1, { code: 'TXFK6' })], tooltip: true, compact: true });
        const bodyRows = r.root.findByType('tbody').findAllByType('tr');
        expect(bodyRows).toHaveLength(4);
        rows(r).forEach((row, i) => {
            expect(row.findAllByType('td')).toHaveLength(4);
            const meta = bodyRows[i * 2 + 1]!.findByType('td');
            expect(meta.props.colSpan).toBe(4);
            expect(text(meta)).toBe(`合約 ${i === 0 ? 'TXFJ6' : 'TXFK6'}`);
            expect(text(meta)).not.toContain('帳戶');
        });
        const single = render({ tooltip: true, compact: true });
        expect(single.root.findByType('tbody').findAllByType('tr')).toHaveLength(1);
        expect(rows(single)[0]!.findAllByType('td')).toHaveLength(4);
    });
});

describe('chart-fill-details.css.ts', () => {
    // react-test-renderer 不會算 CSS；這是「tooltip 不吃點價下單／畫圖／十字線事件」唯一的保證，所以直接釘住原始碼。
    const source = readFileSync(new URL('./chart-fill-details.css.ts', import.meta.url), 'utf8');
    const block = (name: string) => source.slice(source.indexOf(`export const ${name} = style(`), source.indexOf('});', source.indexOf(`export const ${name} = style(`)));

    it("tooltip 是 pointerEvents: 'none'，窄面板不超出圖表區", () => {
        expect(block('tooltip')).toContain("pointerEvents: 'none'");
        expect(block('tooltip')).toContain("overflow: 'hidden'");
        expect(block('tooltip')).toContain("maxWidth: 'calc(100% - 80px)'");
        expect(block('tooltipCompact')).toContain("maxWidth: 'calc(100% - 16px)'");
        expect(block('tooltipMeta')).toContain("whiteSpace: 'normal'");
        expect(block('tooltipMeta')).toContain('muted');
        expect(block('tooltipTime')).toContain("whiteSpace: 'normal'");
    });

    it('明細清單最高 168px 且不超過圖表元件高度的 38%，可收縮、有下限，並保有鍵盤焦點外框', () => {
        const details = block('details');
        expect(details).toContain("flex: '0 1 auto'");
        expect(details).toContain("maxHeight: 'min(168px, 38%)'");
        expect(details).toContain('minHeight: 40');
        expect(details).toContain(':focus-visible');
    });

    it('「這根 K 棒」摘要行黏在清單頂端（top 抵掉清單上內距 6px、不透明底色）；標亮的列用選取底色', () => {
        expect(block('focusLine')).toContain("position: 'sticky'");
        expect(block('focusLine')).toContain('top: -6');
        expect(block('focusLine')).toContain('background: vars.color.panel');
        expect(block('details')).toContain("padding: '6px 10px'"); // top: -6 綁著這個上內距
        expect(block('focusRow')).toContain('vars.color.accentDim');
    });
});

it('tooltip：筆數、合計與均價摘要看整根 K 棒（bar），逐筆列看 fills 的順序', () => {
    const bar = [fill(0, { price: 100, quantity: 1 }), fill(1, { price: 101, quantity: 2 }), fill(2, { price: 102, quantity: 3 }), fill(3, { price: 103, quantity: 4 }), fill(4, { price: 104, quantity: 5 }), fill(5, { price: 105, quantity: 6 })];
    // fills 只給前幾筆（命中的那組在前）；合計與摘要仍要算整根
    const hovered = [bar[4]!, bar[0]!, bar[1]!, bar[2]!];
    const r = render({ fills: hovered, bar, tooltip: true });
    const all = text(root(r));
    expect(all).toContain('6 筆／21 口');
    expect(all).toContain('另有 2 筆');
    expect(rows(r).map(n => n.props['data-fill-id'])).toEqual(['fill-4', 'fill-0', 'fill-1', 'fill-2']);
    expect(r.root.findAll(n => n.props['data-fill-summary'])).toHaveLength(1);
});

describe('ChartFillDetails 清單的「這根 K 棒」', () => {
    type Focus = { time: number; label: string; fills: readonly ChartFill[] } | null;
    const focusLine = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'div' && n.props['data-fill-focus'])[0];
    // aria-describedby 指到的節點文字（依序，空白分隔）
    const described = (r: ReactTestRenderer) => String(root(r).props['aria-describedby']).split(' ')
        .map(id => text(r.root.find(n => typeof n.type === 'string' && n.props.id === id))).join(' ');
    const current = (r: ReactTestRenderer) => rows(r).filter(row => row.props['aria-current'] === 'true').map(row => row.props['data-fill-id']);
    // 清單容器與摘要行的 DOM 替身：容器記下每次設定的 scrollTop，摘要行高 20px
    const dom = () => {
        let top = 0;
        const scrolls = vi.fn();
        const box = {
            get scrollTop() { return top; },
            set scrollTop(value: number) { top = value; scrolls(value); },
            clientTop: 1,
            getBoundingClientRect: () => ({ top: 100 }),
            querySelector: () => ({ getBoundingClientRect: () => ({ top: 400 }) }),
            focus: vi.fn(),
        };
        const line = { offsetHeight: 20, getBoundingClientRect: () => ({ bottom: 150 }) };
        const options: TestRendererOptions = {
            createNodeMock: (el: ReactElement) => {
                const props = el.props as Record<string, unknown>;
                return props['data-fill-details'] ? box : props['data-fill-focus'] !== undefined ? line : null;
            },
        };
        return { box, scrolls, options };
    };

    it('摘要行：這根每個商品｜方向｜單位一段（多價位帶均價與區間、單一價位帶價格），買賣分色；清單裡這根的列標亮', () => {
        const bar = [fill(0, { price: 46458, quantity: 1 }), fill(1, { price: 46474, quantity: 2 }), fill(2, { action: 'Sell', price: 46470, quantity: 2 }), fill(3, { action: 'Sell', price: 46470, quantity: 1 })];
        const others = [fill(4, { time: 1 }), fill(5, { time: 1 })];
        const focus: Focus = { time: 0, label: '10:25', fills: bar };
        const r = render({ fills: [...bar, ...others], focus, decimalsFor: (price) => (price < 100 ? 2 : 0) });
        const line = focusLine(r)!;
        expect(text(line)).toContain('10:25 這根：▲ 買 3 口 · 均 46,468.7 · 46,458～46,474；▼ 賣 3 口 · 46,470');
        expect(line.findAll(n => n.type === 'span' && n.props.style).map(n => [text(n), n.props.style.color])).toEqual([
            ['▲ 買 3 口 · 均 46,468.7 · 46,458～46,474', UP], ['▼ 賣 3 口 · 46,470', DOWN]]);
        expect(rows(r).map(row => row.props['aria-current'])).toEqual(['true', 'true', 'true', 'true', undefined, undefined]);
        expect(rows(r).map(row => row.props.className)).toEqual([styles.focusRow, styles.focusRow, styles.focusRow, styles.focusRow, undefined, undefined]);
        expect(text(line)).not.toContain('未列於目前清單');
    });

    it('這根跨合約（換月日）才在每段行首加商品：看這根的成交，不看整張清單', () => {
        const bar = [fill(0, { price: 10 }), fill(1, { code: 'TXFK6', price: 20 })];
        const focus: Focus = { time: 0, label: '10:25', fills: bar };
        expect(text(focusLine(render({ fills: bar, focus }))!)).toContain('10:25 這根：TXFJ6 ▲ 買 1 口 · 10；TXFK6 ▲ 買 2 口 · 20');
        const one = [fill(0, { price: 10 })];
        const single: Focus = { time: 0, label: '10:25', fills: one };
        const r = render({ fills: [...one, fill(1, { time: 1, code: 'TXFK6', price: 20 })], focus: single });
        expect(r.root.findAll(n => n.type === 'th').map(text)).toContain('合約'); // 整張清單是跨合約的
        expect(text(focusLine(r)!)).toContain('10:25 這根：▲ 買 1 口 · 10');
        expect(text(focusLine(r)!)).not.toContain('TXF');
    });

    it('提示框忽略 focus：沒有摘要行、不標亮、不加 aria-describedby', () => {
        const bar = [fill(0), fill(1)];
        const focus: Focus = { time: 0, label: '10:25', fills: bar };
        const r = render({ fills: bar, bar, tooltip: true, focus });
        expect(focusLine(r)).toBeUndefined();
        expect(rows(r).filter(row => row.props['aria-current'] !== undefined)).toHaveLength(0);
        expect(root(r).props['aria-describedby']).toBeUndefined();
    });

    it('這根的成交不在清單的 500 列內：照樣顯示摘要並寫明未列、不突破上限；部分在內時寫另有幾筆', () => {
        const many = (inBar: (i: number) => boolean) => Array.from({ length: 1200 }, (_, i) => fill(i, { time: inBar(i) ? 1 : 0 }));
        // 清單只列第 700～1199 筆
        const early = many(i => i < 10);
        const unlisted: Focus = { time: 1, label: '10:25', fills: early.slice(0, 10) };
        const r = render({ fills: early, focus: unlisted });
        expect(text(focusLine(r)!)).toContain('此棒成交未列於目前清單');
        expect(rows(r)).toHaveLength(500);
        expect(rows(r).filter(row => row.props['aria-current'] !== undefined)).toHaveLength(0);
        const edge = many(i => i >= 695 && i < 705);
        const partial: Focus = { time: 1, label: '10:25', fills: edge.slice(695, 705) };
        const p = render({ fills: edge, focus: partial });
        expect(text(focusLine(p)!)).toContain('此棒另有 5 筆未列於目前清單');
        expect(rows(p)).toHaveLength(500);
        expect(current(p)).toEqual(['fill-700', 'fill-701', 'fill-702', 'fill-703', 'fill-704']);
    });

    it('部分或全部未列時，清單的說明同時指到摘要與未列提示（仍不含「×」）', () => {
        const many = Array.from({ length: 1200 }, (_, i) => fill(i, { time: i >= 695 && i < 705 ? 1 : 0, price: 100, quantity: 1 }));
        const r = render({ fills: many, focus: { time: 1, label: '10:25', fills: many.slice(695, 705) } satisfies Focus });
        expect(String(root(r).props['aria-describedby']).split(' ')).toHaveLength(2);
        expect(described(r)).toBe('10:25 這根：▲ 買 10 口 · 100 此棒另有 5 筆未列於目前清單');
        expect(described(r)).not.toContain('取消標示');
        const early = Array.from({ length: 1200 }, (_, i) => fill(i, { time: i < 10 ? 1 : 0, price: 100, quantity: 1 }));
        const none = render({ fills: early, focus: { time: 1, label: '10:25', fills: early.slice(0, 10) } satisfies Focus });
        expect(String(root(none).props['aria-describedby']).split(' ')).toHaveLength(2);
        expect(described(none)).toBe('10:25 這根：▲ 買 10 口 · 100 此棒成交未列於目前清單');
        expect(described(none)).not.toContain('取消標示');
    });

    it('有給 groups 就用每價分組算摘要行（不逐筆重算）：筆數與標亮仍看 fills', () => {
        const bar = [fill(0, { price: 100, quantity: 1 }), fill(1, { price: 100, quantity: 1 })];
        const groups = [{ code: 'TXFJ6', action: 'Buy' as const, unit: '口' as const, price: 100, quantity: 5 }, { code: 'TXFK6', action: 'Sell' as const, unit: '口' as const, price: 90, quantity: 1 }];
        const r = render({ fills: bar, focus: { time: 0, label: '10:25', fills: bar, groups } });
        expect(text(focusLine(r)!)).toContain('10:25 這根：TXFJ6 ▲ 買 5 口 · 100；TXFK6 ▼ 賣 1 口 · 90');
        expect(current(r)).toEqual(['fill-0', 'fill-1']);
        expect(text(focusLine(r)!)).not.toContain('未列於目前清單');
    });

    it('「圖上無對應 K 棒」那段即使 time 相同也不標亮', () => {
        const bar = [fill(0), fill(1)];
        const focus: Focus = { time: 0, label: '10:25', fills: bar };
        const r = render({ fills: bar, unplaced: [fill(9, { id: 'late' })], focus });
        expect(rows(r).map(row => row.props['data-fill-id'])).toEqual(['fill-0', 'fill-1', 'late']);
        expect(current(r)).toEqual(['fill-0', 'fill-1']);
    });

    it('待確認（focus.fills 是空陣列）：沒有摘要行、不標亮、不加 aria-describedby', () => {
        const focus: Focus = { time: 0, label: '10:25', fills: [] };
        const r = render({ fills: [fill(0), fill(1)], focus });
        expect(focusLine(r)).toBeUndefined();
        expect(rows(r).filter(row => row.props['aria-current'] !== undefined)).toHaveLength(0);
        expect(root(r).props['aria-describedby']).toBeUndefined();
    });

    it('打開時捲一次，第一筆標亮的列捲到摘要行下緣；新回報、待確認再確認都不再捲，換一根才再捲', () => {
        const { scrolls, options } = dom();
        const bar = [fill(0), fill(1)];
        const focus: Focus = { time: 0, label: '10:25', fills: bar };
        const r = render({ fills: bar, focus }, options);
        // 列上緣 400 − 容器上緣 100 − 容器上框 1 − 摘要行高 20
        expect(scrolls.mock.calls).toEqual([[279]]);
        // 新回報：同一根多一筆、focus 換成新物件
        const more = [...bar, fill(2)];
        const update = (props: Partial<Parameters<typeof ChartFillDetails>[0]>) => act(() => r.update(element(props)));
        update({ fills: more, focus: { time: 0, label: '10:25', fills: more } satisfies Focus });
        expect(scrolls).toHaveBeenCalledTimes(1);
        // 待確認（成交暫時清空）再確認
        update({ fills: [], focus: { time: 0, label: '10:25', fills: [] } satisfies Focus });
        update({ fills: more, focus: { time: 0, label: '10:25', fills: more } satisfies Focus });
        expect(focusLine(r)).toBeDefined();
        expect(scrolls).toHaveBeenCalledTimes(1);
        // 換成另一根
        const next = [...more, fill(3, { time: 1 })];
        update({ fills: next, focus: { time: 1, label: '10:26', fills: next.slice(3) } satisfies Focus });
        expect(scrolls).toHaveBeenCalledTimes(2);
        // 沒有 focus：不捲
        const plain = dom();
        render({ fills: bar }, plain.options);
        expect(plain.scrolls).not.toHaveBeenCalled();
    });

    it('打開時不搬焦點；摘要行是清單的說明；「×」先取消、再把焦點還給清單容器且不捲動', () => {
        const { box, options } = dom();
        const onClearFocus = vi.fn();
        const bar = [fill(0), fill(1)];
        const focus: Focus = { time: 0, label: '10:25', fills: bar };
        const r = render({ fills: bar, focus, onClearFocus }, options);
        expect(box.focus).not.toHaveBeenCalled();
        const line = focusLine(r)!;
        // 說明只指向摘要，不含「×」按鈕的名稱
        const ids = String(root(r).props['aria-describedby']).split(' ');
        expect(ids).toHaveLength(1);
        expect(described(r)).toBe('10:25 這根：▲ 買 3 口 · 均 48,680.66666667 · 48,680～48,681');
        expect(described(r)).not.toContain('取消標示');
        const clear = line.findByType('button');
        expect(clear.props).toMatchObject({ type: 'button', 'aria-label': '取消標示這根 K 棒' });
        act(() => clear.props.onClick());
        expect(onClearFocus).toHaveBeenCalledTimes(1);
        expect(box.focus).toHaveBeenCalledTimes(1);
        expect(box.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(onClearFocus.mock.invocationCallOrder[0]).toBeLessThan(box.focus.mock.invocationCallOrder[0]!);
        expect(root(render({ fills: bar })).props['aria-describedby']).toBeUndefined();
    });
});
