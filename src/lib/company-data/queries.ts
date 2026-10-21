// src/lib/company-data/queries.ts — pure lookups over loaded shioaji-data.
//
// Shared by the company panel and the Agent tools so both read relations,
// themes and financial metrics the same way. No I/O here.

import type {
    ChainTier,
    Edge,
    Entity,
    Financials,
    MonthlyRevenue,
    StatementTable,
    Theme,
    ThemeMember,
    ThemeStage,
} from './types';

export const TIER_LABEL: Record<string, string> = {
    upstream: '上游',
    midstream: '中游',
    downstream: '下游',
};

export function tierLabel(tier: ChainTier | null | undefined): string {
    return (tier && TIER_LABEL[tier]) || '未分類';
}

export const MARKET_LABEL: Record<string, string> = { twse: '上市', tpex: '上櫃' };

const entityIndexCache = new WeakMap<readonly Entity[], Map<string, Entity>>();

export function entityIndex(entities: readonly Entity[]): Map<string, Entity> {
    let index = entityIndexCache.get(entities);
    if (!index) {
        index = new Map(entities.map((entity) => [entity.id, entity]));
        entityIndexCache.set(entities, index);
    }
    return index;
}

/** Display name for an entity id (`tw.2330`, `us.NVDA`, `org.esmc`, …). */
export function entityName(index: Map<string, Entity> | null, id: string): string {
    const hit = index?.get(id);
    if (hit) return hit.name;
    const dot = id.indexOf('.');
    return dot >= 0 ? id.slice(dot + 1) : id;
}

/** `tw.2330` → `2330`; anything outside Taiwan → null. */
export function twCodeOf(id: string): string | null {
    return id.startsWith('tw.') ? id.slice(3) : null;
}

// ── themes ────────────────────────────────────────────────────────────────

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s_\-／/]/g, '');

/**
 * Find a theme or chain by id (`theme.cowos` or `cowos`), name or alias.
 * Exact matches win; otherwise every theme containing the query is returned.
 */
export function resolveTheme(
    themes: readonly Theme[],
    query: string,
    kind?: 'theme' | 'chain',
): { theme: Theme | null; candidates: Theme[] } {
    const pool = kind ? themes.filter((t) => t.kind === kind) : themes;
    const q = fold(query);
    if (!q) return { theme: null, candidates: [] };
    const keys = (t: Theme) => [t.id, t.id.replace(/^(theme|chain)\./, ''), t.name, t.name_en ?? '', ...t.aliases].map(fold);
    const exact = pool.filter((t) => keys(t).includes(q));
    if (exact.length === 1) return { theme: exact[0]!, candidates: exact };
    if (exact.length > 1) return { theme: null, candidates: exact };
    const partial = pool.filter((t) => keys(t).some((key) => key && (key.includes(q) || q.includes(key))));
    return { theme: partial.length === 1 ? partial[0]! : null, candidates: partial };
}

/** Match a stage by id, name or tier (`upstream` / `上游`). */
export function matchStages(theme: Theme, query: string | undefined): ThemeStage[] | null {
    if (!query) return null;
    const q = fold(query);
    const tierByLabel = Object.entries(TIER_LABEL).find(([, label]) => fold(label) === q)?.[0];
    const tier = tierByLabel ?? (['upstream', 'midstream', 'downstream'].includes(q) ? q : null);
    if (tier) return theme.stages.filter((s) => s.tier === tier);
    return theme.stages.filter((s) => [s.id, s.name, s.name_en ?? ''].map(fold).some((key) => key === q || key.includes(q)));
}

export function themeMembers(theme: Theme, stages: ThemeStage[] | null): ThemeMember[] {
    if (!stages) return theme.members;
    const ids = new Set(stages.map((s) => s.id));
    return theme.members.filter((m) => ids.has(m.stage));
}

export function stageName(theme: Theme, stageId: string): string {
    return theme.stages.find((s) => s.id === stageId)?.name ?? stageId;
}

// ── relations ─────────────────────────────────────────────────────────────

/** Relation kinds as seen from the queried company. */
export type RelationKind =
    | 'supplier'
    | 'customer'
    | 'competitor'
    | 'partner'
    | 'subsidiary'
    | 'parent'
    | 'transaction';

export const RELATION_KINDS: readonly RelationKind[] = [
    'supplier',
    'customer',
    'competitor',
    'partner',
    'subsidiary',
    'parent',
    'transaction',
];

export const RELATION_LABEL: Record<RelationKind, string> = {
    supplier: '供應商',
    customer: '客戶',
    competitor: '競爭對手',
    partner: '合作夥伴',
    subsidiary: '子公司',
    parent: '母公司',
    transaction: '重大交易',
};

export interface RelationHit {
    kind: RelationKind;
    /** The other party. */
    counterparty: string;
    edge: Edge;
}

/**
 * Relations of `entityId` from the edge table.
 * - supplier: who supplies `entityId` (edge supplier, dst = entity)
 * - customer: whom `entityId` supplies (edge supplier, src = entity)
 * - subsidiary: entity's subsidiaries (edge subsidiary, dst = entity)
 * - parent: entity's parents (edge subsidiary, src = entity)
 * - competitor / partner / transaction: either side
 */
export function relationsFor(
    edges: readonly Edge[],
    entityId: string,
    kind: RelationKind,
): RelationHit[] {
    const hits: RelationHit[] = [];
    for (const edge of edges) {
        const isSrc = edge.src === entityId;
        const isDst = edge.dst === entityId;
        if (!isSrc && !isDst) continue;
        const other = isSrc ? edge.dst : edge.src;
        let match = false;
        switch (kind) {
            case 'supplier':
                match = edge.type === 'supplier' && isDst;
                break;
            case 'customer':
                match = edge.type === 'supplier' && isSrc;
                break;
            case 'subsidiary':
                match = edge.type === 'subsidiary' && isDst;
                break;
            case 'parent':
                match = edge.type === 'subsidiary' && isSrc;
                break;
            default:
                match = edge.type === kind;
        }
        if (match) hits.push({ kind, counterparty: other, edge });
    }
    // strongest (weight) and most recent first
    return hits.sort(
        (a, b) =>
            (b.edge.weight ?? 0) - (a.edge.weight ?? 0) ||
            String(b.edge.as_of ?? '').localeCompare(String(a.edge.as_of ?? '')),
    );
}

// ── financials ────────────────────────────────────────────────────────────

/** First account present in the table, so bank / insurer formats still map. */
function pick(table: StatementTable | undefined, names: readonly string[], i: number): number | null {
    if (!table) return null;
    for (const name of names) {
        const series = table[name];
        if (series && i < series.length) {
            const value = series[i];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
    }
    return null;
}

const ACCOUNTS = {
    revenue: ['營業收入', '淨收益', '收益'],
    grossProfit: ['營業毛利（毛損）淨額', '營業毛利（毛損）'],
    operatingIncome: ['營業利益（損失）', '營業利益'],
    netIncome: [
        '淨利（淨損）歸屬於母公司業主',
        '淨利（損）歸屬於母公司業主',
        '本期淨利（淨損）',
        '本期稅後淨利（淨損）',
        '繼續營業單位本期純益（純損）',
    ],
    eps: ['基本每股盈餘（元）', '基本每股盈餘'],
    totalAssets: ['資產總計', '資產總額'],
    totalLiabilities: ['負債總計', '負債總額'],
    equity: ['權益總計', '權益總額'],
    bookValuePerShare: ['每股參考淨值'],
    operatingCashFlow: ['營業活動之淨現金流入（流出）'],
} as const;

export interface QuarterMetrics {
    period: string;
    format: string;
    /** thousand TWD */
    revenue: number | null;
    grossProfit: number | null;
    operatingIncome: number | null;
    netIncome: number | null;
    /** TWD per share, single quarter */
    eps: number | null;
    grossMarginPct: number | null;
    operatingMarginPct: number | null;
    netMarginPct: number | null;
    totalAssets: number | null;
    totalLiabilities: number | null;
    equity: number | null;
    bookValuePerShare: number | null;
    operatingCashFlow: number | null;
}

const ratio = (num: number | null, den: number | null) =>
    num === null || den === null || den === 0 ? null : Math.round((num / den) * 10000) / 100;

/** Latest `count` quarters, newest first. */
export function quarterMetrics(fin: Financials, count = 8): QuarterMetrics[] {
    const s = fin.statements;
    const periods = s?.periods ?? [];
    const rows: QuarterMetrics[] = [];
    for (let i = periods.length - 1; i >= 0 && rows.length < count; i -= 1) {
        const revenue = pick(s.income_quarter, ACCOUNTS.revenue, i);
        const grossProfit = pick(s.income_quarter, ACCOUNTS.grossProfit, i);
        const operatingIncome = pick(s.income_quarter, ACCOUNTS.operatingIncome, i);
        const netIncome = pick(s.income_quarter, ACCOUNTS.netIncome, i);
        rows.push({
            period: periods[i]!,
            format: s.format?.[i] ?? 'general',
            revenue,
            grossProfit,
            operatingIncome,
            netIncome,
            eps: pick(s.income_quarter, ACCOUNTS.eps, i),
            grossMarginPct: ratio(grossProfit, revenue),
            operatingMarginPct: ratio(operatingIncome, revenue),
            netMarginPct: ratio(netIncome, revenue),
            totalAssets: pick(s.balance, ACCOUNTS.totalAssets, i),
            totalLiabilities: pick(s.balance, ACCOUNTS.totalLiabilities, i),
            equity: pick(s.balance, ACCOUNTS.equity, i),
            bookValuePerShare: pick(s.balance, ACCOUNTS.bookValuePerShare, i),
            operatingCashFlow: pick(s.cash_flow_quarter, ACCOUNTS.operatingCashFlow, i),
        });
    }
    return rows;
}

/** Trailing four quarters' EPS, when all four are known. */
export function trailingEps(fin: Financials): number | null {
    const rows = quarterMetrics(fin, 4);
    if (rows.length < 4 || rows.some((r) => r.eps === null)) return null;
    return Math.round(rows.reduce((sum, r) => sum + (r.eps ?? 0), 0) * 100) / 100;
}

/** Latest `count` months of revenue, oldest first (chart order). */
export function recentRevenue(fin: Financials, count = 12): MonthlyRevenue[] {
    const months = fin.monthly_revenue ?? [];
    return months.slice(Math.max(0, months.length - count));
}
