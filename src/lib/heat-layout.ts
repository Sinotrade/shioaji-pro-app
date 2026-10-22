// src/lib/heat-layout.ts — 熱力圖版面（產業全景兩層 treemap、下鑽磚牆）
//
// - 版面用「依權重對半二分」遞迴切割（沿長邊切）：比 squarify 稍方正度差，
//   但排序穩定，資料小變動時 tile 只會微調大小，不會整片重排。
// - 排序帶遲滯（stableOrder）：相鄰兩者權重差超過門檻才交換名次，
//   每秒串流的小波動不會讓位置來回跳。
// - 座標整數化（相鄰 tile 共用邊，寬高＝round(x1)-round(x0)），再統一
//   扣掉間隙，格線一律 1px（產業之間 2px）。

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Weighted {
    key: string;
    weight: number;
}

/**
 * 切割記憶：節點（以其成員 key 串識別）上一次的切點與方向。資料每秒
 * 小幅變動時，若沿用舊切點的比例仍接近一半、矩形長寬也沒明顯翻轉，
 * 就沿用 — 避免切點／方向在臨界值附近來回跳，造成整塊 tile 換位。
 */
export type SplitMemo = Map<string, { cut: number; vertical: boolean }>;

const CUT_TOLERANCE = 0.12; // 舊切點比例與最佳比例的容許差
const ASPECT_FLIP = 1.25; // 長寬比超過才改變切割方向

/** 依權重對半二分；items 須已排好序（大到小），回傳浮點矩形 */
export function binarySplit<T extends Weighted>(
    items: readonly T[],
    rect: Rect,
    previous?: SplitMemo,
    memo?: SplitMemo,
): Map<string, Rect> {
    const out = new Map<string, Rect>();
    const positive = items.filter((item) => item.weight > 0);
    const walk = (list: readonly T[], r: Rect) => {
        if (list.length === 0) return;
        if (list.length === 1) {
            out.set(list[0]!.key, r);
            return;
        }
        const total = list.reduce((sum, item) => sum + item.weight, 0);
        const prefix: number[] = [0];
        for (const item of list) prefix.push(prefix[prefix.length - 1]! + item.weight);
        // 最佳切點：累加到剛好超過一半前切（至少留一個在前半）
        let best = 1;
        while (best < list.length - 1 && prefix[best + 1]! <= total / 2) best += 1;
        const ratioAt = (cut: number) => (total > 0 ? prefix[cut]! / total : 0.5);
        const id = list.map((item) => item.key).join(',');
        const prev = previous?.get(id);
        let cut = best;
        if (
            prev &&
            prev.cut >= 1 &&
            prev.cut < list.length &&
            Math.abs(ratioAt(prev.cut) - 0.5) <=
                Math.abs(ratioAt(best) - 0.5) + CUT_TOLERANCE
        ) {
            cut = prev.cut;
        }
        let vertical = r.w >= r.h; // 直線切（左右兩半）
        if (prev && prev.vertical !== vertical) {
            const aspect = Math.max(r.w, r.h) / Math.max(1e-9, Math.min(r.w, r.h));
            if (aspect < ASPECT_FLIP) vertical = prev.vertical;
        }
        memo?.set(id, { cut, vertical });
        const head = list.slice(0, cut);
        const tail = list.slice(cut);
        const ratio = ratioAt(cut);
        if (vertical) {
            const w0 = r.w * ratio;
            walk(head, { x: r.x, y: r.y, w: w0, h: r.h });
            walk(tail, { x: r.x + w0, y: r.y, w: r.w - w0, h: r.h });
        } else {
            const h0 = r.h * ratio;
            walk(head, { x: r.x, y: r.y, w: r.w, h: h0 });
            walk(tail, { x: r.x, y: r.y + h0, w: r.w, h: r.h - h0 });
        }
    };
    walk(positive, rect);
    return out;
}

/** 整數化並扣間隙：rect 是在 (W+gap, H+gap) 上切出來的 */
export function snapRect(r: Rect, gap: number, offsetX = 0, offsetY = 0): Rect {
    const x0 = Math.round(r.x);
    const y0 = Math.round(r.y);
    const x1 = Math.round(r.x + r.w);
    const y1 = Math.round(r.y + r.h);
    return {
        x: x0 + offsetX,
        y: y0 + offsetY,
        w: Math.max(0, x1 - x0 - gap),
        h: Math.max(0, y1 - y0 - gap),
    };
}

const byWeightDesc = (a: Weighted, b: Weighted) =>
    b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * 帶遲滯的排序：以上一次的順序為底，相鄰兩者只有後者權重超過前者
 * (1+hysteresis) 倍才交換；新出現的項目依權重插入。回傳新順序的 key。
 */
export function stableOrder(
    previous: readonly string[] | undefined,
    items: readonly Weighted[],
    hysteresis = 0.15,
): string[] {
    const weightOf = new Map(items.map((item) => [item.key, item.weight]));
    if (!previous || previous.length === 0) {
        return [...items].sort(byWeightDesc).map((item) => item.key);
    }
    const order = previous.filter((key) => weightOf.has(key));
    const known = new Set(order);
    for (const item of [...items].sort(byWeightDesc)) {
        if (known.has(item.key)) continue;
        const at = order.findIndex((key) => weightOf.get(key)! < item.weight);
        if (at < 0) order.push(item.key);
        else order.splice(at, 0, item.key);
        known.add(item.key);
    }
    // 有限次數的相鄰交換（遲滯門檻）
    for (let pass = 0; pass < order.length; pass++) {
        let swapped = false;
        for (let i = 0; i + 1 < order.length; i++) {
            const a = weightOf.get(order[i]!)!;
            const b = weightOf.get(order[i + 1]!)!;
            if (b > a * (1 + hysteresis) || (a <= 0 && b > 0)) {
                const tmp = order[i]!;
                order[i] = order[i + 1]!;
                order[i + 1] = tmp;
                swapped = true;
            }
        }
        if (!swapped) break;
    }
    return order;
}

/** 依面板像素面積決定要畫幾個產業、每產業幾檔、總共幾檔 */
export function heatBudget(
    width: number,
    height: number,
    maxPerGroup = 10,
): { groups: number; perGroup: number; total: number } {
    const area = Math.max(0, width) * Math.max(0, height);
    const clamp = (v: number, lo: number, hi: number) =>
        Math.min(hi, Math.max(lo, v));
    const total = clamp(Math.round(area / 36000) * 10, 10, 400);
    const groups = clamp(Math.round(Math.sqrt(area) / 47), 3, 40);
    const perGroup = clamp(Math.floor(total / 12), 3, maxPerGroup);
    return { groups, perGroup, total };
}

export interface HeatStockInput {
    key: string;
    weight: number;
}

export interface HeatGroupInput<S extends HeatStockInput> {
    key: string;
    stocks: readonly S[];
}

/**
 * 選取要畫的產業與個股：產業取前 groups 名、每產業前 perGroup 檔；
 * 超過總數時從各產業「第 2 名之後」由小到大刪，每個產業至少留龍頭。
 * 傳入的 groups／stocks 須已排好序（stableOrder）。
 */
export function selectHeatItems<G extends HeatGroupInput<HeatStockInput>>(
    groups: readonly G[],
    budget: { groups: number; perGroup: number; total: number },
): { group: G; stocks: G['stocks'][number][] }[] {
    type S = G['stocks'][number];
    const picked = groups
        .map((group) => ({
            group,
            stocks: (group.stocks as readonly S[])
                .filter((stock) => stock.weight > 0)
                .slice(0, budget.perGroup),
        }))
        .filter((entry) => entry.stocks.length > 0)
        .slice(0, budget.groups);
    let count = picked.reduce((sum, entry) => sum + entry.stocks.length, 0);
    if (count > budget.total) {
        const extras = picked
            .flatMap((entry) =>
                entry.stocks.slice(1).map((stock) => ({ entry, stock })),
            )
            .sort((a, b) => a.stock.weight - b.stock.weight);
        const drop = new Set<S>();
        for (const { stock } of extras) {
            if (count <= budget.total) break;
            drop.add(stock);
            count -= 1;
        }
        for (const entry of picked) {
            entry.stocks = entry.stocks.filter((stock) => !drop.has(stock));
        }
    }
    return picked;
}

export interface HeatSectorBox {
    key: string;
    rect: Rect;
    header: Rect | null;
}

export interface HeatTileBox {
    key: string;
    groupKey: string;
    rect: Rect;
}

export const SECTOR_GAP = 2;
export const TILE_GAP = 1;

/**
 * 兩層 treemap：先切產業（權重＝入選個股加總），每個產業頂端留一條
 * 標題列（夠高夠寬才留），剩下空間再切個股。
 */
export function layoutNested(
    groups: readonly { key: string; stocks: readonly Weighted[] }[],
    width: number,
    height: number,
    headerHeight: number,
    previous?: SplitMemo,
    memo?: SplitMemo,
): { sectors: HeatSectorBox[]; tiles: HeatTileBox[] } {
    const sectors: HeatSectorBox[] = [];
    const tiles: HeatTileBox[] = [];
    if (width <= 0 || height <= 0) return { sectors, tiles };
    const sectorItems = groups.map((group) => ({
        key: group.key,
        weight: group.stocks.reduce(
            (sum, stock) => sum + Math.max(0, stock.weight),
            0,
        ),
    }));
    const sectorRects = binarySplit(sectorItems, {
        x: 0,
        y: 0,
        w: width + SECTOR_GAP,
        h: height + SECTOR_GAP,
    }, previous, memo);
    for (const group of groups) {
        const raw = sectorRects.get(group.key);
        if (!raw) continue;
        const rect = snapRect(raw, SECTOR_GAP);
        if (rect.w <= 0 || rect.h <= 0) continue;
        const showHeader =
            rect.h >= headerHeight + 14 && rect.w >= 34;
        const header = showHeader
            ? { x: rect.x, y: rect.y, w: rect.w, h: headerHeight }
            : null;
        const top = showHeader ? headerHeight + TILE_GAP : 0;
        const inner = binarySplit(group.stocks, {
            x: 0,
            y: 0,
            w: rect.w + TILE_GAP,
            h: rect.h - top + TILE_GAP,
        }, previous, memo);
        for (const stock of group.stocks) {
            const r = inner.get(stock.key);
            if (!r) continue;
            const snapped = snapRect(r, TILE_GAP, rect.x, rect.y + top);
            if (snapped.w <= 0 || snapped.h <= 0) continue;
            tiles.push({ key: stock.key, groupKey: group.key, rect: snapped });
        }
        sectors.push({ key: group.key, rect, header });
    }
    return { sectors, tiles };
}

/** 單層 treemap（下鑽磚牆） */
export function layoutFlat(
    items: readonly Weighted[],
    width: number,
    height: number,
    previous?: SplitMemo,
    memo?: SplitMemo,
): HeatTileBox[] {
    if (width <= 0 || height <= 0) return [];
    const rects = binarySplit(items, {
        x: 0,
        y: 0,
        w: width + TILE_GAP,
        h: height + TILE_GAP,
    }, previous, memo);
    const out: HeatTileBox[] = [];
    for (const item of items) {
        const r = rects.get(item.key);
        if (!r) continue;
        const rect = snapRect(r, TILE_GAP);
        if (rect.w > 0 && rect.h > 0) {
            out.push({ key: item.key, groupKey: '', rect });
        }
    }
    return out;
}

/**
 * 面積權重：主要指標（成交值／|貢獻|）全部為 0 時（開盤前、全面平盤）
 * 改用備援（市值權重），已載入的資料才不會因權重全 0 而整片不畫。
 * fallback＝true 時呼叫端要把面積說明改成備援指標。
 */
export function weightWithFallback<E>(
    groups: readonly (readonly E[])[],
    primary: (entry: E) => number,
    fallback: (entry: E) => number,
): { weight: (entry: E) => number; fallback: boolean } {
    const hasPrimary = groups.some((entries) =>
        entries.some((entry) => primary(entry) > 0),
    );
    return hasPrimary
        ? { weight: primary, fallback: false }
        : { weight: fallback, fallback: true };
}
