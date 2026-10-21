// src/lib/company-data/types.ts — shioaji-data v1 wire types (#337, #338).
//
// Mirrors the published JSON at sinotrade.github.io/shioaji-data/v1/. Only the
// fields the App reads are typed; everything else passes through untouched.
// Schema compatibility is decided by the manifest's major versions, not here.

/** One file entry in `manifest.files` (datasets shared by all companies). */
export interface ManifestFile {
    path: string;
    sha256: string;
    bytes?: number;
    records?: number;
    schema_version: string;
    as_of: string | null;
    /** tw/market only: latest trading day per market (twse / tpex). */
    as_of_by_market?: Record<string, string>;
}

/** Per-company file entry (`manifest.companies` / `manifest.financials`). */
export interface ManifestEntry {
    path: string;
    sha256: string;
    as_of?: string | null;
}

export interface Manifest {
    manifest_schema_version: string;
    release_id: string;
    built_at: string;
    /** Date the official (exchange open data) part was fetched. */
    official_fetched_at: string | null;
    disclaimer: string | null;
    files: Record<string, ManifestFile>;
    companies: Record<string, ManifestEntry>;
    financials: Record<string, ManifestEntry>;
    financials_schema_version: string;
    revocations?: unknown[];
}

/** Dataset keys inside `manifest.files` that the App knows how to read. */
export type DatasetKey =
    | 'tw/cards'
    | 'tw/edges'
    | 'tw/themes'
    | 'tw/market'
    | 'tw/revenue'
    | 'global/entities'
    | 'global/sources'
    | 'global/taxonomy';

/** Research confidence: `official` = exchange data only, no AI research. */
export type Confidence = 'official' | 'ai_cross_checked' | (string & {});
/** primary = the company's own / counterparty filings; media = named press. */
export type EvidenceLevel = 'primary' | 'media' | (string & {});
export type ChainTier = 'upstream' | 'midstream' | 'downstream' | (string & {});

export interface Industry {
    /** Exchange industry (官方產業別). */
    l0_code?: string;
    l0_name?: string;
    l0_name_en?: string;
    /** Sector > group > industry (AI research taxonomy). */
    l1?: string;
    l1_name?: string;
    l1_name_en?: string;
    l2?: string;
    l2_name?: string;
    l2_name_en?: string;
    l3?: string;
    l3_name?: string;
    l3_name_en?: string;
}

export interface ChainStage {
    stage: string;
    stage_name: string;
    tier: ChainTier;
    reason?: string;
    agreement?: string;
    also?: { stage: string; stage_name: string; tier: ChainTier }[];
}

export interface CompanyThemeRef {
    theme: string;
    stage: string;
    tier: ChainTier;
    also?: unknown[];
}

export interface Segment {
    id: string;
    name: string;
    period: string | null;
    revenue_share_pct: number | null;
    evidence_ids?: string[];
}

/** One counterparty row in a company's `relations` lists. */
export interface RelationRow {
    id: string;
    name: string;
    detail: string | null;
    details?: string[];
    as_of: string | null;
    confidence: Confidence;
    evidence_level: EvidenceLevel;
    edge: string;
    weight?: number;
    share_pct?: number | null;
    share_basis?: string | null;
    ranking_basis?: string;
    /** transactions only */
    amount?: string | null;
    event_date?: string | null;
    role?: string;
}

export interface CompanyRelations {
    suppliers: RelationRow[];
    customers: RelationRow[];
    competitors: RelationRow[];
    partners: RelationRow[];
    subsidiaries: RelationRow[];
    parents: RelationRow[];
    transactions: RelationRow[];
}

export interface Evidence {
    title: string | null;
    url: string | null;
    publisher: string | null;
    published_date: string | null;
    locator?: string | null;
    quote_check?: string;
}

/** `v1/tw/companies/json/<code>.json` */
export interface Company {
    id: string;
    code: string;
    name: string;
    full_name: string | null;
    english_short: string | null;
    market: 'twse' | 'tpex' | (string & {});
    /** null = not researched yet: only official exchange data. */
    as_of: string | null;
    has_research: boolean;
    confidence: Confidence;
    quality_flags: string[];
    industry: Industry;
    chain: string | null;
    chain_stage: ChainStage | null;
    primary_chain_position: ChainTier | 'unknown';
    main_theme: string | null;
    themes: CompanyThemeRef[];
    summary_short: string | null;
    summary_long: string | null;
    segments: Segment[];
    relations: CompanyRelations;
    top_customers: RelationRow[];
    top_suppliers: RelationRow[];
    evidence: Record<string, Evidence>;
    unresolved_mentions: string[];
    website: string | null;
    incorporated: string | null;
    listed: string | null;
    tax_id: string | null;
}

export interface MonthlyRevenue {
    period: string;
    revenue_thousand_twd: number | null;
    mom_pct: number | null;
    yoy_pct: number | null;
    ytd_thousand_twd: number | null;
    ytd_yoy_pct: number | null;
    revenue_prev_month?: number | null;
    revenue_last_year_month?: number | null;
    note?: string | null;
}

/** Column-store statement: each account is aligned with `periods`. */
export type StatementTable = Record<string, (number | null)[]>;

export interface Financials {
    code: string;
    name: string;
    market: string;
    /** Oldest first, thousand TWD. */
    monthly_revenue: MonthlyRevenue[];
    statements: {
        /** Oldest first, e.g. 2026Q2. */
        periods: string[];
        /** 'general' or a financial-industry format, per period. */
        format: string[];
        income_quarter: StatementTable;
        income_ytd: StatementTable;
        balance: StatementTable;
        cash_flow_quarter: StatementTable;
        cash_flow_ytd: StatementTable;
    };
}

export interface ThemeStage {
    id: string;
    name: string;
    name_en?: string;
    tier: ChainTier;
}

export interface ThemeMember {
    id: string;
    stage: string;
    tier: ChainTier;
    stage_role?: string;
    detail: string | null;
    as_of: string | null;
    confidence: Confidence;
    source?: string;
    evidence?: string[];
}

/** One entry in `v1/tw/themes/themes.json`. */
export interface Theme {
    id: string;
    kind: 'chain' | 'theme' | (string & {});
    name: string;
    name_en?: string | null;
    aliases: string[];
    related: string[];
    stages: ThemeStage[];
    members: ThemeMember[];
    as_of: string | null;
}

export type EdgeType =
    | 'supplier'
    | 'customer'
    | 'competitor'
    | 'partner'
    | 'subsidiary'
    | 'transaction'
    | (string & {});

/**
 * One row of `v1/tw/relations/edges.json`.
 * supplier: src supplies dst. subsidiary: src is a subsidiary of dst.
 * transaction: src is the acting party. competitor/partner are undirected.
 */
export interface Edge {
    id: string;
    src: string;
    dst: string;
    type: EdgeType;
    direction: 'directed' | 'undirected' | (string & {});
    detail: string | null;
    details?: string[];
    as_of: string | null;
    confidence: Confidence;
    evidence_level: EvidenceLevel;
    evidence: string[];
    amount?: string | null;
    event_date?: string | null;
    weight?: number;
}

export interface Entity {
    id: string;
    kind: 'company' | 'theme' | 'chain' | (string & {});
    name: string;
    aliases?: string[];
    code?: string;
    region?: string;
    market?: string;
    has_quote?: boolean;
    status?: string;
}

export interface MarketQuote {
    close: number | null;
    date: string | null;
    market_cap_twd: number | null;
    shares: number | null;
}

/** `v1/tw/market/daily.json` */
export interface MarketDaily {
    as_of: Record<string, string>;
    quotes: Record<string, MarketQuote>;
}

export interface SourceInfo {
    id: string;
    name: string;
    provider: string;
    attribution: string;
    license?: string;
    license_url?: string;
    url?: string;
    update?: string;
}

/** `v1/global/sources/sources.json` */
export interface Sources {
    disclaimer: string | null;
    sources: SourceInfo[];
}
