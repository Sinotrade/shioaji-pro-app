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

// stock quantities arrive in SHARES (unit=Share). Brokers, fills and
// exchange statements show odd lots as 股, never as fractional 張 — render
// whole lots as 張 and the odd-lot remainder as 股 (issue #3):
//   1000 → "1 張"   10 → "10 股"   5010 → "5 張 10 股"
export function fmtStockLots(shares: number): string {
    const s = Math.round(shares);
    const lots = Math.trunc(s / 1000);
    const odd = s - lots * 1000;
    if (lots && odd) return `${lots.toLocaleString()} 張 ${odd} 股`;
    if (lots) return `${lots.toLocaleString()} 張`;
    return `${odd} 股`;
}

// direction: TW convention — red up / green down. Returns 1 / -1 / 0.
export function dirOf(v: number | string | undefined): 1 | -1 | 0 {
    const n = Number(v ?? 0);
    if (Number.isNaN(n) || n === 0) return 0;
    return n > 0 ? 1 : -1;
}
