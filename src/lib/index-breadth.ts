// src/lib/index-breadth.ts：指數看板的漲跌家數比例（比例條與 tooltip 共用）

export interface Breadth {
    up: number;
    flat: number;
    down: number;
    total: number;
}

// 缺值、NaN、負數一律當 0：盤前或剛訂閱時 quote_idx 尚未帶家數，比例條要空著而不是壞掉
function count(n: number | undefined): number {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function breadthOf(
    raise: number | undefined,
    flat: number | undefined,
    fall: number | undefined,
): Breadth {
    const up = count(raise);
    const fl = count(flat);
    const down = count(fall);
    return { up, flat: fl, down, total: up + fl + down };
}

// 成交金額占預估全日金額的比例（0 到 1）。預估缺值或為 0 時回傳 undefined，進度條留空
export function amountProgress(
    amount: number | undefined,
    estimate: number | undefined,
): number | undefined {
    if (amount === undefined || estimate === undefined) return undefined;
    if (!Number.isFinite(amount) || !Number.isFinite(estimate) || estimate <= 0) return undefined;
    return Math.min(1, Math.max(0, amount / estimate));
}

export function breadthTitle(b: Breadth): string {
    if (b.total === 0) return '';
    const part = (label: string, n: number) =>
        `${label} ${n.toLocaleString('en-US')}（${((n / b.total) * 100).toFixed(1)}%）`;
    return [part('上漲', b.up), part('平盤', b.flat), part('下跌', b.down)].join('　');
}
