// src/lib/us/decimal.ts — 美股 decimal 字串的最小工具（不引入新依賴）
//
// 美股價格／數量在 JSON 是 decimal 字串。顯示一律用原字串；需要加減比較
// （剩餘股數、預估金額）時以 BigInt 定點運算，避免浮點誤差。

import type { UsAmount } from '../types/us';

const DEC_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

interface Fixed { value: bigint; scale: number }

function parse(v: UsAmount | null | undefined): Fixed | null {
    if (v === null || v === undefined) return null;
    let s: string;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        // 數字只來自舊 sidecar 或測試；toString 不會產生指數記號的範圍內才收
        s = String(v);
        if (/e/i.test(s)) return null;
    } else s = v.trim();
    const m = DEC_RE.exec(s);
    if (!m) return null;
    const frac = m[3] ?? '';
    const value = BigInt(`${m[2]}${frac}`) * (m[1] === '-' ? -1n : 1n);
    return { value, scale: frac.length };
}

function align(a: Fixed, b: Fixed): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    return [a.value * 10n ** BigInt(scale - a.scale), b.value * 10n ** BigInt(scale - b.scale), scale];
}

function render({ value, scale }: Fixed): string {
    const neg = value < 0n;
    const digits = (neg ? -value : value).toString().padStart(scale + 1, '0');
    const int = digits.slice(0, digits.length - scale);
    const frac = scale ? digits.slice(digits.length - scale).replace(/0+$/, '') : '';
    const out = frac ? `${int}.${frac}` : int;
    return neg && out !== '0' ? `-${out}` : out;
}

/** 合法 decimal 嗎（字串或有限數字） */
export function isDecimal(v: UsAmount | null | undefined): boolean {
    return parse(v) !== null;
}

/** 標準化字串（去掉多餘的 0）；不合法回 null */
export function decNormalize(v: UsAmount | null | undefined): string | null {
    const p = parse(v);
    return p ? render(p) : null;
}

/** 小數位數（"1.2300" → 4；不合法回 -1） */
export function decFractionDigits(v: UsAmount | null | undefined): number {
    if (typeof v === 'string') {
        const m = DEC_RE.exec(v.trim());
        return m ? (m[3] ?? '').length : -1;
    }
    const p = parse(v);
    return p ? p.scale : -1;
}

export function decCompare(a: UsAmount, b: UsAmount): number {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return Number.NaN;
    const [x, y] = align(pa, pb);
    return x === y ? 0 : x < y ? -1 : 1;
}

export function decAdd(a: UsAmount, b: UsAmount): string | null {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    const [x, y, scale] = align(pa, pb);
    return render({ value: x + y, scale });
}

export function decSub(a: UsAmount, b: UsAmount): string | null {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    const [x, y, scale] = align(pa, pb);
    return render({ value: x - y, scale });
}

export function decMul(a: UsAmount, b: UsAmount): string | null {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    return render({ value: pa.value * pb.value, scale: pa.scale + pb.scale });
}

export function decIsPositive(v: UsAmount | null | undefined): boolean {
    const p = parse(v);
    return !!p && p.value > 0n;
}

export function decIsZero(v: UsAmount | null | undefined): boolean {
    const p = parse(v);
    return !!p && p.value === 0n;
}

/** 整數嗎（"10"、"10.000" 是；"10.5" 不是） */
export function decIsWhole(v: UsAmount | null | undefined): boolean {
    const p = parse(v);
    return !!p && p.value % 10n ** BigInt(p.scale) === 0n;
}

/** 整數值（安全整數範圍內）；非整數或不合法回 null */
export function decToInt(v: UsAmount | null | undefined): number | null {
    const p = parse(v);
    if (!p || p.value % 10n ** BigInt(p.scale) !== 0n) return null;
    const n = Number(p.value / 10n ** BigInt(p.scale));
    return Number.isSafeInteger(n) ? n : null;
}

/** 四捨五入到 digits 位小數（顯示預估金額用） */
export function decRound(v: UsAmount, digits: number): string | null {
    const p = parse(v);
    if (!p) return null;
    if (p.scale <= digits) return render(p);
    const drop = 10n ** BigInt(p.scale - digits);
    const neg = p.value < 0n;
    const abs = neg ? -p.value : p.value;
    let q = abs / drop;
    if ((abs % drop) * 2n >= drop) q += 1n;
    return render({ value: neg ? -q : q, scale: digits });
}

/**
 * 顯示用：千分位、保留原有小數（去尾 0），可指定最少小數位（美元金額 2 位）。
 * 不合法或缺值顯示「—」。
 */
export function fmtDec(v: UsAmount | null | undefined, opts: { minFraction?: number; maxFraction?: number } = {}): string {
    const p = parse(v);
    if (!p) return '—';
    let s = opts.maxFraction !== undefined ? decRound(render(p), opts.maxFraction)! : render(p);
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    let [int, frac = ''] = s.split('.');
    const min = opts.minFraction ?? 0;
    if (frac.length < min) frac = frac.padEnd(min, '0');
    int = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/**
 * 美股價格的顯示小數位：1 美元以上固定 2 位、未滿 1 美元固定 4 位（與下單
 * 跳動 0.01／0.0001 一致）。成交價可能帶 sub-penny（例如 98.083 的中價成交），
 * 顯示時一律四捨五入到這個位數，寬度才不會跳動。
 */
export function usPriceDecimals(v: string | number | null | undefined): number {
    const n = Math.abs(Number(v));
    return Number.isFinite(n) && n > 0 && n < 1 ? 4 : 2;
}

/** 美股價格顯示：1 美元以上 2 位、未滿 1 美元 4 位（固定位數）；不合法回 — */
export function fmtUsPrice(v: string | number | null | undefined): string {
    const d = usPriceDecimals(v);
    return fmtDec(v === null || v === undefined ? v : String(v), { minFraction: d, maxFraction: d });
}

/**
 * 漲跌（價差）顯示：位數跟著所屬的價格走（98.08 的漲跌 +0.50，而不是
 * 依漲跌本身變成 +0.5000）；沒有給價格時用漲跌本身判斷。
 */
export function fmtUsChange(v: string | number | null | undefined, price?: string | number | null): string {
    const d = usPriceDecimals(price ?? v);
    return fmtDec(v === null || v === undefined ? v : String(v), { minFraction: d, maxFraction: d });
}

/** 成交均價、持股成本：至少 2 位、最多 4 位（均價可能是 sub-penny，不硬捨成 2 位） */
export function fmtUsAvgPrice(v: string | number | null | undefined): string {
    return fmtDec(v === null || v === undefined ? v : String(v), { minFraction: 2, maxFraction: 4 });
}
