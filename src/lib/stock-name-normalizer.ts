export type EquityExchange = 'TSE' | 'OTC' | 'OES';
export interface EquityNameEntry {
    readonly code: string;
    readonly exchange: EquityExchange;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly sourceDate: string;
}
export interface EquityNameSource {
    readonly entries: readonly EquityNameEntry[];
    readonly sourceDate: string;
    readonly invalidRows: number;
    readonly conflictingCodes: number;
}

function text(value: unknown): string | undefined {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 200 ? trimmed : undefined;
}

function sourceDate(value: unknown, today: string): string {
    const raw = text(value) ?? '';
    if (!/^\d{7}$/.test(raw) || Number(raw.slice(0, 3)) < 1) throw new Error('Invalid equity source date');
    const date = `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5)}`;
    const stamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date ||
        stamp > Date.parse(`${today}T00:00:00Z`) + 86_400_000) throw new Error('Invalid or future equity source date');
    return date;
}

/** Source cleaning only; searchStocks owns name matching normalization. */
export function normalizeStockNames(payload: unknown, exchange: EquityExchange, today: string, previousCount = 0): EquityNameSource {
    if (!Array.isArray(payload) || !payload.length) throw new Error('Equity source must be a nonempty array');
    const keys = exchange === 'TSE'
        ? ['公司代號', '公司簡稱', '公司名稱', '出表日期'] as const
        : ['SecuritiesCompanyCode', 'CompanyAbbreviation', 'CompanyName', 'Date'] as const;
    const byCode = new Map<string, EquityNameEntry>();
    const conflicts = new Set<string>();
    let invalidRows = 0;
    let earliestDate = '';
    for (const row of payload) {
        if (!row || typeof row !== 'object' || !keys.every(key => Object.hasOwn(row, key))) {
            throw new Error('Equity source is missing required fields');
        }
        const record = row as Record<string, unknown>;
        const date = sourceDate(record[keys[3]], today);
        if (!earliestDate || date < earliestDate) earliestDate = date;
        const code = text(record[keys[0]]);
        if (!code) { invalidRows++; continue; }
        // Ordinary companies only; ETF membership and names use their own feed.
        if (!/^[1-9]\d{3}$/.test(code)) continue;
        const name = text(record[keys[1]]);
        const fullName = text(record[keys[2]]);
        if (!name || !fullName) { invalidRows++; continue; }
        if (conflicts.has(code)) continue;
        const aliases = Object.freeze(fullName === name ? [] : [fullName]);
        const previous = byCode.get(code);
        if (previous && (previous.name !== name || previous.aliases[0] !== aliases[0])) {
            conflicts.add(code);
            byCode.delete(code);
            continue;
        }
        byCode.set(code, Object.freeze({ code, exchange, name, aliases, sourceDate: date }));
    }
    if (!byCode.size) throw new Error('Equity source has no valid ordinary company names');
    if (byCode.size < previousCount * 0.9) throw new Error('Equity source shrank by more than 10%');
    return Object.freeze({
        entries: Object.freeze([...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))),
        sourceDate: earliestDate, invalidRows, conflictingCodes: conflicts.size,
    });
}
