// src/lib/utils/format.ts

export function fmtPrice(v: number | string | undefined, digits?: number) {
    if (v === undefined || v === null || v === '') return '—';
    const n = Number(v);
    if (Number.isNaN(n)) return '—';
    const d = digits ?? (Math.abs(n) >= 500 ? 0 : 2);
    return n.toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: Math.max(d, 2),
    });
}

export function fmtInt(v: number | undefined) {
    if (v === undefined || v === null) return '—';
    return v.toLocaleString('en-US');
}

export function fmtSigned(v: number | string | undefined, digits = 2) {
    if (v === undefined || v === null || v === '') return '—';
    const n = Number(v);
    if (Number.isNaN(n)) return '—';
    const s = n.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
    return n > 0 ? `+${s}` : s;
}

export function fmtPct(v: number | string | undefined) {
    if (v === undefined || v === null || v === '') return '—';
    const n = Number(v);
    if (Number.isNaN(n)) return '—';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function fmtMoney(v: number | undefined) {
    if (v === undefined || v === null) return '—';
    return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Compact volume for tight ladder cells — odd-lot (盤中零股) books are in
// shares and routinely reach six digits: 9,999 → "9,999"  104,264 → "10.4萬"
// 2,345,678 → "235萬"  123,456,789 → "1.2億"
export function fmtCompactInt(v: number | undefined) {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a < 10_000) return Math.round(v).toLocaleString('en-US');
    if (a < 100_000_000) return `${(v / 10_000).toFixed(a < 1_000_000 ? 1 : 0)}萬`;
    return `${(v / 100_000_000).toFixed(1)}億`;
}

/** hh:mm:ss of an exchange time string (drops fractional seconds). */
export function fmtClock(time: string | undefined): string {
    const m = /(\d{1,2}:\d{2}:\d{2})/.exec(time ?? '');
    return m ? m[1]! : '';
}

// stock quantities arrive in SHARES (unit=Share). Brokers, fills and
// exchange statements show odd lots as 股, never as fractional 張 — render
// whole lots as 張 and the odd-lot remainder as 股 (issue #3). Compact,
// space-free form so tight table cells can't wrap mid-quantity:
//   1000 → "1張"   10 → "10股"   5010 → "5張+10股"
export function fmtStockLots(shares: number): string {
    const s = Math.round(shares);
    const lots = Math.trunc(s / 1000);
    const odd = s - lots * 1000;
    if (lots && odd) return `${lots.toLocaleString()}張+${odd}股`;
    if (lots) return `${lots.toLocaleString()}張`;
    return `${odd}股`;
}

// direction: TW convention — red up / green down. Returns 1 / -1 / 0.
export function dirOf(v: number | string | undefined): 1 | -1 | 0 {
    const n = Number(v ?? 0);
    if (Number.isNaN(n) || n === 0) return 0;
    return n > 0 ? 1 : -1;
}
