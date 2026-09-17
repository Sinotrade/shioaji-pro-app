import { describe, expect, it } from 'vitest';
import {
    BADGE_HEIGHT,
    badgeId,
    buildBadgeSpecs,
    hitBadge,
    layoutBadges,
    parseBadgeId,
    type BadgeSpec,
} from './chart-line-badges';

const COLORS = {
    up: '#ef5350',
    down: '#26a69a',
    stop: '#e0a43c',
    take: '#2962ff',
    alert: '#8b94a7',
};

// 每個字 7px 的假字型 — 版面只依賴量到的寬度，真實字型不影響邏輯
const measureText = (t: string) => t.length * 7;

function layout(specs: BadgeSpec[], yByPrice: Record<number, number | null>) {
    return layoutBadges(specs, {
        paneWidth: 500,
        yOf: (p) => yByPrice[p] ?? null,
        measureText,
    });
}

const spec = (over: Partial<BadgeSpec> = {}): BadgeSpec => ({
    id: 'order:a',
    price: 100,
    color: '#ef5350',
    text: '委買3',
    draggable: true,
    cancellable: true,
    ...over,
});

describe('標籤版面', () => {
    it('靠右排，取消鈕在最右、握把在它左邊', () => {
        const [box] = layout([spec()], { 100: 200 });
        expect(box).toBeDefined();
        const { rect, drag, close } = box!;
        expect(rect.x + rect.w).toBeLessThanOrEqual(500);
        expect(close!.x).toBeGreaterThan(drag!.x);
        expect(drag!.x).toBeGreaterThan(box!.textX);
    });

    it('垂直置中在價位上 — 線穿過標籤中間', () => {
        const [box] = layout([spec()], { 100: 200 });
        expect(box!.rect.y + BADGE_HEIGHT / 2).toBe(200);
    });

    it('不能拖也不能撤的標籤就只有文字，寬度較窄', () => {
        const [plain] = layout([spec({ draggable: false, cancellable: false })], { 100: 200 });
        const [full] = layout([spec()], { 100: 200 });
        expect(plain!.drag).toBeNull();
        expect(plain!.close).toBeNull();
        expect(plain!.rect.w).toBeLessThan(full!.rect.w);
    });

    it('價位在可視範圍外就不排 — yOf 回 null 代表捲出畫面', () => {
        expect(layout([spec()], { 100: null })).toEqual([]);
    });

    it('同價位的兩張單往下推開，不會疊在一起把按鈕蓋掉', () => {
        const boxes = layout([spec({ id: 'order:a' }), spec({ id: 'order:b' })], { 100: 200 });
        expect(boxes).toHaveLength(2);
        const [top, bottom] = boxes;
        expect(bottom!.rect.y).toBeGreaterThanOrEqual(top!.rect.y + BADGE_HEIGHT);
        // 按鈕跟著整塊一起移動，不會留在原地
        expect(bottom!.close!.y).toBeGreaterThan(top!.close!.y);
    });
});

describe('標籤命中判定', () => {
    const boxes = layout([spec()], { 100: 200 });
    const box = boxes[0]!;
    const mid = (r: { x: number; y: number; w: number; h: number }) => ({
        x: r.x + r.w / 2,
        y: r.y + r.h / 2,
    });

    it('點到 ✕ 回 close，點到握把回 drag，點到文字回 body', () => {
        expect(hitBadge(boxes, mid(box.close!))?.part).toBe('close');
        expect(hitBadge(boxes, mid(box.drag!))?.part).toBe('drag');
        expect(hitBadge(boxes, { x: box.textX + 2, y: mid(box.rect).y })?.part).toBe('body');
    });

    it('標籤外面不算命中 — 圖表照常平移', () => {
        expect(hitBadge(boxes, { x: 10, y: 200 })).toBeNull();
        expect(hitBadge(boxes, { x: mid(box.rect).x, y: 400 })).toBeNull();
    });

    it('按鈕優先於本體 — 按鈕小，本體先搶就永遠按不到', () => {
        // ✕ 的中心同時也落在整塊標籤裡，仍必須判成 close
        expect(hitBadge(boxes, mid(box.close!))?.part).toBe('close');
    });

    it('回傳的是被點到的那張單，不是第一張', () => {
        const two = layout([spec({ id: 'order:a', price: 100 }), spec({ id: 'trigger:b', price: 110 })], {
            100: 200,
            110: 300,
        });
        const target = two.find((b) => b.spec.id === 'trigger:b')!;
        expect(hitBadge(two, mid(target.close!))?.box.spec.id).toBe('trigger:b');
    });
});

describe('標籤內容', () => {
    it('委託單與觸價單用左上角清單同一套寫法', () => {
        const specs = buildBadgeSpecs(
            [{ id: 'o1', action: 'Buy', price: 100, quantity: 3 }],
            [
                { id: 't1', kind: 'stop', action: 'Sell', price: 90, quantity: 1 },
                { id: 't2', kind: 'take', action: 'Sell', price: 120, quantity: 2 },
                { id: 't3', kind: 'alert', action: 'Buy', price: 130, quantity: 0 },
            ],
            COLORS,
        );
        expect(specs.map((s) => s.text)).toEqual(['委買3', '停損賣1', '停利賣2', '警示']);
    });

    it('三種觸價單都可以拖、可以撤', () => {
        const specs = buildBadgeSpecs(
            [],
            [
                { id: 't1', kind: 'stop', action: 'Sell', price: 90, quantity: 1 },
                { id: 't3', kind: 'alert', action: 'Buy', price: 130, quantity: 0 },
            ],
            COLORS,
        );
        expect(specs.every((s) => s.draggable && s.cancellable)).toBe(true);
    });

    it('買賣用漲跌色，觸價單各自有色 — 標籤顏色與線同色才對得起來', () => {
        const specs = buildBadgeSpecs(
            [
                { id: 'o1', action: 'Buy', price: 100, quantity: 1 },
                { id: 'o2', action: 'Sell', price: 101, quantity: 1 },
            ],
            [{ id: 't1', kind: 'alert', action: 'Buy', price: 130, quantity: 0 }],
            COLORS,
        );
        expect(specs.map((s) => s.color)).toEqual([COLORS.up, COLORS.down, COLORS.alert]);
    });

    it('id 帶來源前綴 — 委託單與觸價單的 id 可能撞號', () => {
        const specs = buildBadgeSpecs(
            [{ id: 'x', action: 'Buy', price: 100, quantity: 1 }],
            [{ id: 'x', kind: 'stop', action: 'Sell', price: 90, quantity: 1 }],
            COLORS,
        );
        expect(specs.map((s) => s.id)).toEqual(['order:x', 'trigger:x']);
        expect(parseBadgeId('order:x')).toEqual({ source: 'order', id: 'x' });
        expect(parseBadgeId('trigger:x')).toEqual({ source: 'trigger', id: 'x' });
    });

    it('券商的委託 id 含冒號也還原得回來', () => {
        expect(parseBadgeId(badgeId('order', 'a:b:c'))).toEqual({ source: 'order', id: 'a:b:c' });
    });

    it('認不得的 id 回 null，不會誤判成委託單', () => {
        expect(parseBadgeId('drawing:x')).toBeNull();
        expect(parseBadgeId('x')).toBeNull();
    });
});
