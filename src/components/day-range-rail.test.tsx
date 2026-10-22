// 日內區間軌元件：上面是圖（兩端寫尺幅度、鎖停板時不畫現價直針），下面一行數字由小到大；
// 兩端格子（跌停／漲停或距低／距高）由 CSS 在 railMid、railLow 收起
import { createElement } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INDEX_FUTURE_SCALES, STOCK_SCALES, type DayRange } from '../lib/day-range';
import { DayRangeRail } from './day-range-rail';
import * as panel from './panel.css';
import * as styles from './quote-board.css';

const TXF: DayRange = {
    reference: 47284,
    limitUp: 52012,
    limitDown: 42556,
    open: 47269,
    high: 47380,
    low: 47214,
    close: 47289,
};
const fmt = (v: number) => v.toLocaleString('en-US');

function render(props: Partial<Parameters<typeof DayRangeRail>[0]>, width = 480) {
    let root!: ReturnType<typeof create>;
    act(() => {
        root = create(
            createElement(DayRangeRail, {
                range: TXF,
                fmt,
                fmtPoints: fmt,
                scales: STOCK_SCALES,
                edges: 'limits',
                locked: null,
                touched: { up: false, down: false },
                ...props,
            }),
            { createNodeMock: () => ({ clientWidth: width }) },
        );
    });
    return root.root;
}

function texts(node: ReactTestInstance): string[] {
    return node
        .findAll((n) => typeof n.type === 'string' && n.children.length > 0 && n.children.every((c) => typeof c === 'string'))
        .map((n) => (n.children as string[]).join(''));
}

const hasClass = (cls: string) => (n: ReactTestInstance) =>
    typeof n.type === 'string' && String(n.props.className ?? '').split(' ').includes(cls);
const rects = (root: ReactTestInstance, cls: string) => root.findAll((n) => n.type === 'rect' && hasClass(cls)(n));
const isCap = (r: ReactTestInstance) => r.props.width === 4 && r.props.height === 12;
const svgTexts = (root: ReactTestInstance) => root.findAll((n) => n.type === 'text').map(texts).flat();
afterEach(() => vi.unstubAllGlobals());

describe('DayRangeRail', () => {
    it('dpr 1.5 下軌道與引線的起點、寬度對齊實體像素', () => {
        vi.stubGlobal('window', { devicePixelRatio: 1.5 });
        const root = render({ range: { ...TXF, close: 47289.16, high: 47380.37, low: 47214.28 } }, 483);
        for (const rect of [...rects(root, styles.railTrack), ...rects(root, styles.railWick.up)]) {
            for (const value of [rect.props.x, rect.props.width]) expect(value * 1.5).toBeCloseTo(Math.round(value * 1.5));
        }
    });

    it('根字級放大時兩端幅度字與數字列保留的左側空間同步放大', () => {
        vi.stubGlobal('document', { documentElement: {} });
        let rootPx = 16;
        vi.stubGlobal('getComputedStyle', () => ({ fontSize: `${rootPx}px` }));
        const left = () => render({}).find(hasClass(styles.railNumbers)).props.style.paddingLeft;
        const standard = left();
        rootPx = 18.4;
        expect(left()).toBeGreaterThan(standard);
    });

    it('數字一行由小到大：跌停、低、開、高、漲停（軌道左低右高同方向）', () => {
        const row = render({}).find(hasClass(styles.railNumbers));
        expect(texts(row)).toEqual(['跌停', '42,556', '低', '47,214', '開', '47,269', '高', '47,380', '漲停', '52,012']);
    });

    it('數字列的格子標上低、開、高最長的字數，railMid、railLow 依它決定留幾格', () => {
        expect(render({}).find(hasClass(styles.railCells)).props['data-chars']).toBe(6);
        const chars = (range: DayRange, f: (v: number) => string) =>
            render({ range, fmt: f }).find(hasClass(styles.railCells)).props['data-chars'];
        const two = (v: number) => v.toFixed(2);
        expect(chars({ reference: 9.9, limitUp: 10.85, limitDown: 8.91, open: 9.9, high: 9.95, low: 9.8, close: 9.85 }, two)).toBe(4);
        // 只有最高價最長（跨 100 元）：不能只看現價、開盤或最低
        expect(chars({ reference: 99, limitUp: 108.5, limitDown: 89.2, open: 99, high: 101, low: 98.5, close: 99.5 }, two)).toBe(6);
        // 只有最低價最長（跨 500 元，以上沒有小數，和看板的價格格式一樣）：不能只看最高
        const board = (v: number) => (v >= 500 ? v.toFixed(0) : v.toFixed(2));
        expect(chars({ reference: 500, limitUp: 550, limitDown: 450, open: 502, high: 505, low: 498.5, close: 503 }, board)).toBe(6);
    });

    it('數字列從軌道起點開始排（左邊留出兩端幅度字的寬度），不撐滿軌道', () => {
        const row = render({}).find(hasClass(styles.railNumbers));
        expect(row.props.style.paddingLeft).toBeGreaterThan(8);
    });

    it('跌停、漲停價降成次要灰；兩端格子標 railEdge，railMid、railLow 由 CSS 收起', () => {
        const root = render({});
        expect(root.findAll(hasClass(styles.railEdge)).map(texts)).toEqual([
            ['跌停', '42,556'],
            ['漲停', '52,012'],
        ]);
        expect(root.findAll(hasClass(styles.railNumMuted)).map(texts)).toEqual([['42,556'], ['52,012']]);
    });

    it('開盤價、最高最低各有收起用的 class（軌道變窄時由容器查詢依序收起，開盤價先、最高最低後）', () => {
        const root = render({});
        expect(root.findAll(hasClass(styles.railOpen)).map(texts)).toEqual([['開', '47,269']]);
        expect(root.findAll(hasClass(styles.railHL)).map(texts)).toEqual([
            ['低', '47,214'],
            ['高', '47,380'],
        ]);
    });

    it('低、高跟開盤價比上色；等於開盤時不上色', () => {
        const root = render({});
        const value = (v: string) => root.find((n) => typeof n.type === 'string' && n.children[0] === v);
        expect(value('47,214').props.className).toBe(panel.dirText.down);
        expect(value('47,380').props.className).toBe(panel.dirText.up);
        // 最高等於開盤（開高走低）：開與高都是 47,269，兩格都不上色
        const flat = render({ range: { ...TXF, high: 47269 } });
        const same = flat.findAll((n) => typeof n.type === 'string' && n.children[0] === '47,269');
        expect(same).toHaveLength(2);
        expect(same.map((n) => n.props.className)).toEqual([undefined, undefined]);
    });

    it('指數期：兩端換成距低、距高點數（現價減最低、最高減現價），尺從 ±2.5% 起', () => {
        const root = render({ edges: 'distance', scales: INDEX_FUTURE_SCALES });
        expect(texts(root.find(hasClass(styles.railNumbers)))).toEqual([
            '距低', '75', '低', '47,214', '開', '47,269', '高', '47,380', '距高', '91',
        ]);
        expect(svgTexts(root)).toEqual(['-2.5%', '+2.5%']);
    });

    it('圖的名稱寫現價與尺幅，提示（同時是描述）寫開高低與平盤價，不重複念兩次', () => {
        const img = render({}).find((n) => typeof n.type === 'string' && n.props.role === 'img');
        expect(img.props['aria-label']).toBe('今日區間圖：現價 47,289，刻度 ±1%');
        // 數字列變窄時開高低會收起，提示裡一定要有
        expect(img.props.title).toMatch(
            /^開 47,269｜高 47,380（\+0\.20%）｜低 47,214（-0\.15%）｜平盤 47,284（幅度對平盤）\n較開盤 \+0\.04%（陽線）｜.*｜刻度 ±1%，每格 0\.5%\n粗：開到現價｜細：最低到最高$/,
        );
    });

    it('提示最後一行可加註記（期貨全盤時註明開盤與高低含夜盤）', () => {
        const img = render({ note: '開盤為前一交易日 15:00 夜盤開盤，高低含夜盤' }).find((n) => typeof n.type === 'string' && n.props.role === 'img');
        expect(img.props.title).toMatch(/\n開盤為前一交易日 15:00 夜盤開盤，高低含夜盤$/);
    });

    it('試撮價跳出今天高低之外：引線延伸到現價，實體不會比引線長', () => {
        // 08:30 試撮 47,450 高過最高 47,380（試撮價不算進高低）
        const root = render({ range: { ...TXF, close: 47450 } });
        const [wick] = rects(root, styles.railWick.up);
        const [body] = rects(root, styles.railBody.up);
        expect(wick!.props.x + wick!.props.width).toBeGreaterThanOrEqual(body!.props.x + body!.props.width);
    });

    it('平常日：兩端寫尺幅度 -1%、+1%（不再用像翻頁鍵的箭頭），現價直針照畫', () => {
        const root = render({});
        expect(svgTexts(root)).toEqual(['-1%', '+1%']);
        expect(root.findAll((n) => n.type === 'path' && hasClass(styles.railNeedle)(n))).toHaveLength(1);
        expect(rects(root, styles.railNeedle)).toHaveLength(1);
    });

    it('鎖在漲停：尺用到漲跌停（兩端寫停板幅度）、不畫現價直針，漲停端是實心', () => {
        const root = render({
            range: { ...TXF, open: 50000, high: 52012, low: 49800, close: 52012 },
            locked: 'up',
            touched: { up: true, down: false },
        });
        expect(svgTexts(root)).toEqual(['-10%', '+10%']);
        expect(rects(root, styles.railNeedle)).toHaveLength(0);
        expect(rects(root, styles.railBody.up).some(isCap)).toBe(true);
    });

    it('碰過漲停又打開（沒鎖）：漲停端實心，現價直針照畫', () => {
        const root = render({
            range: { ...TXF, open: 50000, high: 52012, low: 49800, close: 51500 },
            locked: null,
            touched: { up: true, down: false },
        });
        expect(rects(root, styles.railBody.up).some(isCap)).toBe(true);
        expect(rects(root, styles.railNeedle)).toHaveLength(1);
    });

    it('鎖在跌停：跌停端實心、沒有直針，實體停在跌停端內緣（留縫）', () => {
        const root = render({
            range: { ...TXF, open: 44000, high: 44200, low: 42556, close: 42556 },
            locked: 'down',
            touched: { up: false, down: true },
        });
        expect(rects(root, styles.railNeedle)).toHaveLength(0);
        expect(rects(root, styles.railBody.down).some(isCap)).toBe(true);
        const body = rects(root, styles.railBody.down).find((r) => r.props.height === 8)!;
        const track = rects(root, styles.railTrack)[0]!;
        expect(body.props.x).toBeGreaterThanOrEqual(track.props.x + 3);
    });

    it('開在漲停、現價差一檔（沒鎖）：最短 6px 的實體不會超出軌道蓋過漲停端', () => {
        const root = render({
            range: { ...TXF, open: 52012, high: 52012, low: 51900, close: 52011 },
            locked: null,
            touched: { up: true, down: false },
        });
        const body = rects(root, styles.railBody.down).find((r) => r.props.height === 8)!;
        const track = rects(root, styles.railTrack)[0]!;
        expect(body.props.width).toBe(6);
        expect(body.props.x + body.props.width).toBeLessThanOrEqual(track.props.x + track.props.width - 3);
    });

    it('平盤是點線，畫在實體之後（穿過實體時也看得見）', () => {
        const root = render({});
        const svg = root.find((n) => n.type === 'svg');
        const kids = svg.children.filter((c): c is ReactTestInstance => typeof c !== 'string');
        const refIdx = kids.findIndex((k) => k.type === 'line' && hasClass(styles.railRef)(k));
        const bodyIdx = kids.findIndex((k) => k.type === 'rect' && k.props.height === 8);
        expect(refIdx).toBeGreaterThan(bodyIdx);
    });

    it('還沒量到寬度（不在軌道階梯、整條隱藏）時只留文字替代與數字，不畫圖', () => {
        const root = render({}, 0);
        expect(root.findAll((n) => n.type === 'svg')).toHaveLength(0);
        expect(root.findAll((n) => typeof n.type === 'string' && n.props.role === 'img')).toHaveLength(1);
        expect(texts(root.find(hasClass(styles.railNumbers)))).toContain('47,269');
    });
});
