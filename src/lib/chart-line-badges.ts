// src/lib/chart-line-badges.ts — 價格線上的操作標籤（純函式）
//
// 委託單、停損停利、警示三種價格線在圖上都只是一條線加一段文字，要改價
// 得盲拖、要刪掉得跑去左上角的清單。這裡把那段文字換成一個可以互動的
// 標籤：文字 ＋ 拖曳握把 ＋ 取消鈕。持倉的進場均價線也用同一套標籤，
// 只是沒有握把（均價不是掛單價，拖不動）。
//
// 版面計算刻意做成純函式並把文字寬度量測注入，命中判定才能在沒有 canvas
// 的測試環境下驗證（本專案測試環境沒有 jsdom）。畫與點的座標由同一份
// BadgeBox 決定，看到的位置與點得到的位置不可能對不上。

export interface BadgeSpec {
    id: string;
    price: number;
    color: string;
    text: string; // 例如「委買3」「停損賣1」「警示」
    draggable: boolean;
    cancellable: boolean;
}

export interface BadgeRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

// 標籤 id 帶上來源，命中之後才知道該去撤委託還是刪觸價單。委託單 id 由
// 券商給、觸價單 id 由本地產生，兩邊不保證不撞號，所以加前綴分開。
export type BadgeSource = 'order' | 'trigger' | 'position';

export function badgeId(source: BadgeSource, id: string): string {
    return `${source}:${id}`;
}

export function parseBadgeId(value: string): { source: BadgeSource; id: string } | null {
    const i = value.indexOf(':');
    if (i < 0) return null;
    const source = value.slice(0, i);
    if (source !== 'order' && source !== 'trigger' && source !== 'position') return null;
    return { source, id: value.slice(i + 1) };
}

export interface BadgeOrder {
    id: string;
    action: 'Buy' | 'Sell';
    price: number;
    quantity: number;
}

export interface BadgeTrigger {
    id: string;
    kind: 'stop' | 'take' | 'alert';
    action: 'Buy' | 'Sell';
    price: number;
    quantity: number;
}

export interface BadgePosition {
    code: string;
    direction: 'Buy' | 'Sell';
    quantity: number;
    price: number; // 進場均價
    // 平倉是市價單、不可逆，所以按下 ✕ 之後先進入待確認狀態，再按一次才送
    arming: boolean;
    unit: string; // 「口」或「股」— 期貨與股票的計量單位不同
}

export interface BadgeColors {
    up: string;
    down: string;
    stop: string;
    take: string;
    alert: string;
}

// 標籤文字沿用左上角清單的寫法（委買3、停損賣1、警示），同一張單在兩處
// 讀起來一樣。三種觸價單都可以拖、可以撤 — 警示沒有數量，就不寫數量。
export function buildBadgeSpecs(
    orders: readonly BadgeOrder[],
    triggers: readonly BadgeTrigger[],
    colors: BadgeColors,
    positions: readonly BadgePosition[] = [],
): BadgeSpec[] {
    const specs: BadgeSpec[] = [];
    for (const p of positions) {
        specs.push({
            id: badgeId('position', p.code),
            price: p.price,
            color: p.direction === 'Buy' ? colors.up : colors.down,
            // 進場均價不是掛單價，拖不動 — 給握把等於騙人
            text: p.arming
                ? '再按 ✕ 平倉'
                : `持${p.direction === 'Buy' ? '多' : '空'}${p.quantity}${p.unit}`,
            draggable: false,
            cancellable: true,
        });
    }
    for (const o of orders) {
        specs.push({
            id: badgeId('order', o.id),
            price: o.price,
            color: o.action === 'Buy' ? colors.up : colors.down,
            text: `委${o.action === 'Buy' ? '買' : '賣'}${o.quantity}`,
            draggable: true,
            cancellable: true,
        });
    }
    for (const t of triggers) {
        specs.push({
            id: badgeId('trigger', t.id),
            price: t.price,
            color: t.kind === 'stop' ? colors.stop : t.kind === 'alert' ? colors.alert : colors.take,
            text:
                t.kind === 'alert'
                    ? '警示'
                    : `${t.kind === 'stop' ? '停損' : '停利'}${t.action === 'Buy' ? '買' : '賣'}${t.quantity}`,
            draggable: true,
            cancellable: true,
        });
    }
    return specs;
}

export interface BadgeBox {
    spec: BadgeSpec;
    rect: BadgeRect; // 整個標籤
    textX: number; // 文字左緣（垂直置中）
    drag: BadgeRect | null;
    close: BadgeRect | null;
}

export const BADGE_HEIGHT = 16;
const PAD_X = 5;
const GAP = 4;
const BTN = 12; // 握把與取消鈕的方形邊長
const RIGHT_MARGIN = 4; // 與價格軸之間留一點縫
const STACK_GAP = 2; // 兩個標籤疊在一起時的間距

export interface BadgeLayoutOptions {
    paneWidth: number;
    yOf(price: number): number | null;
    measureText(text: string): number;
}

// 由右往左排：取消鈕在最右（最靠價格軸、最好按），握把次之，文字在左。
export function layoutBadges(specs: readonly BadgeSpec[], opts: BadgeLayoutOptions): BadgeBox[] {
    const boxes: BadgeBox[] = [];
    for (const spec of specs) {
        const y = opts.yOf(spec.price);
        if (y === null || !Number.isFinite(y)) continue;
        const textW = Math.ceil(opts.measureText(spec.text));
        let w = PAD_X * 2 + textW;
        if (spec.draggable) w += GAP + BTN;
        if (spec.cancellable) w += GAP + BTN;
        const right = opts.paneWidth - RIGHT_MARGIN;
        const x = right - w;
        const top = y - BADGE_HEIGHT / 2;
        let cursor = right - PAD_X;
        let close: BadgeRect | null = null;
        if (spec.cancellable) {
            close = { x: cursor - BTN, y: top + (BADGE_HEIGHT - BTN) / 2, w: BTN, h: BTN };
            cursor -= BTN + GAP;
        }
        let drag: BadgeRect | null = null;
        if (spec.draggable) {
            drag = { x: cursor - BTN, y: top + (BADGE_HEIGHT - BTN) / 2, w: BTN, h: BTN };
            cursor -= BTN + GAP;
        }
        boxes.push({
            spec,
            rect: { x, y: top, w, h: BADGE_HEIGHT },
            textX: x + PAD_X,
            drag,
            close,
        });
    }
    // 同價位（或很接近）的委託疊在一起會互相蓋掉按鈕 — 由上往下推開。
    // 只動標籤，線本身還是畫在真正的價位上。
    boxes.sort((a, b) => a.rect.y - b.rect.y);
    for (let i = 1; i < boxes.length; i++) {
        const prev = boxes[i - 1]!.rect;
        const cur = boxes[i]!;
        const minTop = prev.y + prev.h + STACK_GAP;
        if (cur.rect.y < minTop) {
            const dy = minTop - cur.rect.y;
            cur.rect.y += dy;
            if (cur.drag) cur.drag.y += dy;
            if (cur.close) cur.close.y += dy;
        }
    }
    return boxes;
}

export type BadgePart = 'body' | 'drag' | 'close';

export interface Point {
    x: number;
    y: number;
}

function inside(r: BadgeRect, at: Point, pad = 0): boolean {
    return (
        at.x >= r.x - pad && at.x <= r.x + r.w + pad && at.y >= r.y - pad && at.y <= r.y + r.h + pad
    );
}

// 取消鈕優先於握把、握把優先於本體 — 按鈕小，讓它先搶，不然永遠按不到。
// 後排的標籤畫在上層，所以從尾端往前找。
export function hitBadge(
    boxes: readonly BadgeBox[],
    at: Point,
    pad = 2,
): { box: BadgeBox; part: BadgePart } | null {
    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i]!;
        if (box.close && inside(box.close, at, pad)) return { box, part: 'close' };
        if (box.drag && inside(box.drag, at, pad)) return { box, part: 'drag' };
    }
    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i]!;
        if (inside(box.rect, at)) return { box, part: 'body' };
    }
    return null;
}
