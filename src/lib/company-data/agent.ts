// src/lib/company-data/agent.ts — read-only Agent tools over shioaji-data (#338).
//
// Tool specs and their implementations live with the shared reader so the
// desktop Agent only registers them. Every result carries as_of, the data
// release and its sources, plus a notice the Agent must relay: research rows
// are third-party (AI-compiled, cross-checked) data, and companies without
// research only have official exchange data.

import {
    companyDataErrorText,
    companyEntityId,
    isCompanyDataError,
    normalizeCompanyCode,
    STALE_TEXT,
    type CompanyDataClient,
    type DataMeta,
    type Loaded,
} from './client';
import {
    MARKET_LABEL,
    RELATION_KINDS,
    RELATION_LABEL,
    entityIndex,
    entityName,
    matchStages,
    quarterMetrics,
    recentRevenue,
    relationsFor,
    resolveTheme,
    stageName,
    themeMembers,
    tierLabel,
    trailingEps,
    twCodeOf,
    type RelationKind,
} from './queries';
import type { Company, Entity, Evidence, MarketDaily, RelationRow, Sources, Theme } from './types';

export const COMPANY_DATA_TOOL_NAMES = [
    'get_company',
    'get_financials',
    'find_theme_members',
    'find_relations',
] as const;
export type CompanyDataToolName = (typeof COMPANY_DATA_TOOL_NAMES)[number];

export interface CompanyDataToolSpec {
    name: CompanyDataToolName;
    description: string;
    schema: Record<string, unknown>;
}

const CODE_DESC = '台股代號，例如 2330 或 tw.2330';

export const COMPANY_DATA_TOOL_SPECS: readonly CompanyDataToolSpec[] = [
    {
        name: 'get_company',
        description:
            '查台股上市櫃公司基本面（shioaji-data）：業務摘要、營收組成、產業分類（交易所產業別＋類別／產業群／產業）、產業鏈位置與上中下游、題材、主要客戶／供應商／合作／子公司、收盤與市值。研究資料是第三方 AI 整理，回答要附 as_of 與 sources；research.status=official_only 時說明只有官方資料',
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: CODE_DESC },
                max_relations: { type: 'number', description: '每種關係最多列幾家，預設 8，最大 30' },
            },
            required: ['code'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_financials',
        description:
            '查台股公司官方財務資料（shioaji-data，來源公開資訊觀測站／交易所）：月營收（含月增、年增、累計）與季度財報重點（營收、毛利率、營益率、稅後淨利、EPS、資產負債、營業現金流）。金額單位千元新台幣，EPS 元',
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: CODE_DESC },
                months: { type: 'number', description: '月營收筆數，預設 12，最大 36' },
                quarters: { type: 'number', description: '季數，預設 8，最大 14' },
            },
            required: ['code'],
            additionalProperties: false,
        },
    },
    {
        name: 'find_theme_members',
        description:
            '查產業鏈或題材的成員公司與上中下游（shioaji-data），例如「AI 伺服器上游」「CoWoS」「半導體產業鏈 封測」。theme 與 chain 都不給時列出所有產業鏈與題材。成員依市值排序',
        schema: {
            type: 'object',
            properties: {
                theme: { type: 'string', description: '題材 id、名稱或別名，例如 theme.ai_server、AI 伺服器、CoWoS' },
                chain: { type: 'string', description: '產業鏈 id 或名稱，例如 chain.semiconductor、半導體' },
                stage: { type: 'string', description: '階段 id／名稱，或 upstream／midstream／downstream（上游／中游／下游）' },
                limit: { type: 'number', description: '最多列幾家（不指定題材時為最多列幾個題材），預設 60，最大 300' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'find_relations',
        description:
            '查公司的上下游與關係（shioaji-data 關係邊表）：supplier＝誰供應給它、customer＝它供應給誰、competitor、partner、subsidiary＝它的子公司、parent＝它的母公司、transaction＝重大交易。code 可用台股代號或實體 id（如 us.NVDA），可查國外公司的台灣供應鏈',
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: '台股代號（2330）、tw.2330 或實體 id（us.NVDA）' },
                type: { type: 'string', enum: [...RELATION_KINDS] },
                limit: { type: 'number', description: '最多列幾筆，預設 30，最大 100' },
            },
            required: ['code', 'type'],
            additionalProperties: false,
        },
    },
];

export function isCompanyDataTool(name: string): name is CompanyDataToolName {
    return (COMPANY_DATA_TOOL_NAMES as readonly string[]).includes(name);
}

const THIRD_PARTY_NOTICE =
    '研究資料為第三方資料：AI 依公開文件整理並經多個模型交叉核對，可能過時或有誤。回答時標示「第三方資料」並附 as_of 與 sources。';
const OFFICIAL_ONLY_NOTICE =
    '此公司尚未研究，只有官方資料（交易所開放資料）；沒有業務、產業鏈與上下游研究，回答時要說明。';
const OFFICIAL_NOTICE = '官方資料：證交所、櫃買中心開放資料與公開資訊觀測站彙總報表。';

/**
 * Upper bound for one tool result, as serialised JSON characters. Results are
 * shrunk to fit (longest lists first, then long text) and flagged `truncated`,
 * so one call cannot flood the model context.
 */
export const MAX_TOOL_RESULT_CHARS = 20_000;
const TRUNCATED_NOTE = '結果過長已截斷：清單只列前幾筆（count 為完整筆數），可用 limit、max_relations、months、quarters 或更精確的條件縮小範圍';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Container = Json[] | { [key: string]: Json };

const jsonSize = (v: unknown): number => {
    try {
        return JSON.stringify(v)?.length ?? 0;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
};

const isContainer = (v: Json): v is Container => typeof v === 'object' && v !== null;
const entryCount = (c: Container) => (Array.isArray(c) ? c.length : Object.keys(c).length);

/**
 * Exact JSON length of `value`, computed in one pass, collecting every
 * non-empty nested list or dict (below the root) with its own length.
 */
function measure(value: Json, out: { c: Container; size: number }[] | null, nested = false): number {
    if (!isContainer(value)) return jsonSize(value);
    let size = 2;
    if (Array.isArray(value)) {
        value.forEach((child, i) => {
            size += measure(child, out, true) + (i > 0 ? 1 : 0);
        });
    } else {
        Object.entries(value).forEach(([key, child], i) => {
            size += jsonSize(key) + 1 + measure(child, out, true) + (i > 0 ? 1 : 0);
        });
    }
    if (nested && out && entryCount(value) > 0) out.push({ c: value, size });
    return size;
}

/** Keep the first `keep` items of a list or entries of a dict. */
function shrinkTo(c: Container, keep: number) {
    if (Array.isArray(c)) {
        c.splice(keep);
        return;
    }
    for (const key of Object.keys(c).slice(keep)) delete c[key];
}

function clipStrings(value: Json, max: number): Json {
    if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
    if (Array.isArray(value)) return value.map((v) => clipStrings(v, max));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max)]));
    }
    return value;
}

/**
 * Size-bounded copy of a tool result: at most `maxChars` of JSON for any input.
 * Over the limit it clips long text, then shrinks the largest nested dicts and
 * lists until it fits, then clips text further; if it still does not fit it
 * keeps only the top-level scalars that fit. Any shrunk result carries
 * `truncated: true`.
 */
export function capToolResult<T>(result: T, maxChars = MAX_TOOL_RESULT_CHARS): T | Record<string, unknown> {
    if (jsonSize(result) <= maxChars) return result;
    const flag = { truncated: true, truncated_note: TRUNCATED_NOTE };
    if (jsonSize(flag) > maxChars) return { truncated: true };
    let root: { [key: string]: Json };
    try {
        const cloned = JSON.parse(JSON.stringify(result ?? null)) as Json;
        root = cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : { items: cloned };
    } catch {
        return flag;
    }
    const fits = () => jsonSize({ ...root, ...flag }) <= maxChars;
    if (!fits()) root = clipStrings(root, 2000) as typeof root;
    // Shrink the largest nested lists / dicts (and any at least half that
    // size) until the result fits: by half, or harder when far over budget.
    // One measuring pass per round.
    for (;;) {
        const containers: { c: Container; size: number }[] = [];
        const total = measure(root, containers) + jsonSize(flag);
        if (total <= maxChars || containers.length === 0) break;
        const ratio = Math.min(0.5, (2 * maxChars) / total);
        const largest = containers.reduce((m, x) => Math.max(m, x.size), 0);
        for (const x of containers) {
            if (x.size * 2 >= largest) shrinkTo(x.c, Math.floor(entryCount(x.c) * ratio));
        }
    }
    for (const max of [500, 120]) {
        if (fits()) break;
        root = clipStrings(root, max) as typeof root;
    }
    if (fits()) return { ...root, ...flag };
    // Last resort: top-level scalars (ids, counts, errors) that fit the budget.
    const summary: { [key: string]: Json } = {};
    let used = jsonSize(flag);
    for (const [key, value] of Object.entries(root)) {
        if (isContainer(value)) continue;
        const cost = jsonSize({ [key]: value }) - 1;
        if (used + cost > maxChars) continue;
        summary[key] = value;
        used += cost;
    }
    return { ...summary, ...flag };
}

function clampInt(value: unknown, fallback: number, max: number): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

type PartMetas = Record<string, DataMeta | null | undefined>;

/**
 * Release and staleness of everything a result was built from: `main` is the
 * file the tool is about, `parts` the supporting datasets (missing → null).
 * Any stale part makes the whole result stale, as the panel shows it.
 */
function dataInfo(meta: DataMeta, main: string, parts: PartMetas = {}) {
    const entries = Object.entries(parts).filter(([, m]) => m !== undefined);
    const staleParts = [
        ...(meta.stale ? [main] : []),
        ...entries.filter(([, m]) => m?.stale).map(([k]) => k),
    ];
    return {
        release_id: meta.releaseId,
        built_at: meta.builtAt,
        official_fetched_at: meta.officialFetchedAt,
        ...(entries.length
            ? {
                  parts: Object.fromEntries(
                      entries.map(([k, m]) => [
                          k,
                          m
                              ? { release_id: m.releaseId, as_of: m.asOf, ...(m.stale ? { stale: true } : {}) }
                              : { unavailable: true },
                      ]),
                  ),
              }
            : {}),
        ...(staleParts.length
            ? {
                  stale: true,
                  stale_parts: staleParts,
                  stale_note: `${STALE_TEXT}：目前無法連線資料來源，${staleParts.join('、')} 使用先前下載並驗證過的本機快取，可能不是最新版`,
              }
            : {}),
    };
}

function evidenceSource(e: Evidence) {
    return {
        title: e.title,
        publisher: e.publisher,
        published_date: e.published_date,
        url: e.url,
    };
}

function officialAttributions(sources: Sources | null): string[] {
    return sources?.sources.map((s) => s.attribution) ?? [];
}

async function settled<T>(promise: Promise<Loaded<T>>): Promise<Loaded<T> | null> {
    try {
        return await promise;
    } catch {
        return null;
    }
}

function relationItems(rows: RelationRow[] | undefined, max: number) {
    const list = rows ?? [];
    return {
        count: list.length,
        items: list.slice(0, max).map((r) => ({
            id: r.id,
            ...(twCodeOf(r.id) ? { code: twCodeOf(r.id) } : {}),
            name: r.name,
            detail: r.detail,
            as_of: r.as_of,
            evidence_level: r.evidence_level,
            ...(r.amount ? { amount: r.amount } : {}),
            ...(r.share_pct != null ? { share_pct: r.share_pct } : {}),
        })),
    };
}

function themeName(themes: Theme[] | null, id: string | null): string | null {
    if (!id) return null;
    return themes?.find((t) => t.id === id)?.name ?? id;
}

function marketOf(market: MarketDaily | null, code: string) {
    const q = market?.quotes[code];
    return q
        ? {
              close: q.close,
              date: q.date,
              market_cap_twd: q.market_cap_twd,
              shares: q.shares,
              note: '最近交易日官方收盤與市值；即時價請用 get_quote',
          }
        : null;
}

export function createCompanyDataTools(client: CompanyDataClient) {
    async function getCompany(input: Record<string, unknown>) {
        const max = clampInt(input.max_relations, 8, 30);
        const [{ data: c, meta }, themesL, marketL, sourcesL] = await Promise.all([
            client.getCompany(String(input.code ?? '')),
            settled(client.getThemes()),
            settled(client.getMarket()),
            settled(client.getSources()),
        ]);
        const themes = themesL?.data ?? null;
        const market = marketL?.data ?? null;
        const sources = sourcesL?.data ?? null;
        const researched = c.has_research && c.as_of !== null;
        const chainTheme = c.chain ? themes?.find((t) => t.id === c.chain) : undefined;
        const evidence = Object.values(c.evidence ?? {});
        return {
            id: c.id,
            code: c.code,
            name: c.name,
            full_name: c.full_name,
            english_short: c.english_short,
            market: MARKET_LABEL[c.market] ?? c.market,
            website: c.website,
            listed: c.listed,
            incorporated: c.incorporated,
            industry: {
                exchange: c.industry?.l0_name ?? null,
                sector: c.industry?.l1_name ?? null,
                group: c.industry?.l2_name ?? null,
                industry: c.industry?.l3_name ?? null,
            },
            research: {
                status: researched ? 'researched' : 'official_only',
                as_of: c.as_of,
                confidence: c.confidence,
            },
            notice: researched ? THIRD_PARTY_NOTICE : OFFICIAL_ONLY_NOTICE,
            summary: c.summary_long ?? c.summary_short,
            segments: (c.segments ?? []).slice(0, 20).map((s) => ({
                name: s.name,
                revenue_share_pct: s.revenue_share_pct,
                period: s.period,
            })),
            chain: c.chain_stage
                ? {
                      id: c.chain,
                      name: chainTheme?.name ?? c.chain,
                      stage: c.chain_stage.stage,
                      stage_name: c.chain_stage.stage_name,
                      tier: tierLabel(c.chain_stage.tier),
                      reason: c.chain_stage.reason ?? null,
                      also: (c.chain_stage.also ?? []).map((a) => `${a.stage_name}（${tierLabel(a.tier)}）`),
                  }
                : null,
            main_theme: themeName(themes, c.main_theme),
            themes: (c.themes ?? []).slice(0, 30).map((t) => {
                const theme = themes?.find((x) => x.id === t.theme);
                return {
                    id: t.theme,
                    name: theme?.name ?? t.theme,
                    stage: theme ? stageName(theme, t.stage) : t.stage,
                    tier: tierLabel(t.tier),
                };
            }),
            relations: {
                suppliers: relationItems(c.relations?.suppliers, max),
                customers: relationItems(c.relations?.customers, max),
                competitors: relationItems(c.relations?.competitors, max),
                partners: relationItems(c.relations?.partners, max),
                subsidiaries: relationItems(c.relations?.subsidiaries, max),
                parents: relationItems(c.relations?.parents, max),
                transactions: relationItems(c.relations?.transactions, max),
            },
            daily: marketOf(market, c.code),
            sources: evidence.slice(0, 20).map(evidenceSource),
            ...(evidence.length > 20 ? { sources_truncated: evidence.length - 20 } : {}),
            official_sources: officialAttributions(sources),
            data: dataInfo(meta, 'company', { themes: themesL?.meta ?? null, market: marketL?.meta ?? null, sources: sourcesL?.meta ?? null }),
            disclaimer: meta.disclaimer,
        };
    }

    async function getFinancials(input: Record<string, unknown>) {
        const months = clampInt(input.months, 12, 36);
        const quarters = clampInt(input.quarters, 8, 14);
        const [{ data: fin, meta }, sourcesL] = await Promise.all([
            client.getFinancials(String(input.code ?? '')),
            settled(client.getSources()),
        ]);
        const sources = sourcesL?.data ?? null;
        return {
            code: fin.code,
            name: fin.name,
            market: MARKET_LABEL[fin.market] ?? fin.market,
            unit: '金額千元新台幣；EPS、每股淨值為元；百分比為 %',
            as_of: meta.asOf,
            notice: OFFICIAL_NOTICE,
            monthly_revenue: recentRevenue(fin, months)
                .slice()
                .reverse()
                .map((m) => ({
                    period: m.period,
                    revenue: m.revenue_thousand_twd,
                    mom_pct: m.mom_pct,
                    yoy_pct: m.yoy_pct,
                    ytd: m.ytd_thousand_twd,
                    ytd_yoy_pct: m.ytd_yoy_pct,
                })),
            quarters: quarterMetrics(fin, quarters),
            trailing_eps: trailingEps(fin),
            official_sources: officialAttributions(sources),
            data: dataInfo(meta, 'financials', { sources: sourcesL?.meta ?? null }),
        };
    }

    async function findThemeMembers(input: Record<string, unknown>) {
        const [{ data: themes, meta }, entitiesL, marketL] = await Promise.all([
            client.getThemes(),
            settled(client.getEntities()),
            settled(client.getMarket()),
        ]);
        const entities = entitiesL?.data ?? null;
        const market = marketL?.data ?? null;
        const info = dataInfo(meta, 'themes', { entities: entitiesL?.meta ?? null, market: marketL?.meta ?? null });
        const themeQuery = typeof input.theme === 'string' ? input.theme.trim() : '';
        const chainQuery = typeof input.chain === 'string' ? input.chain.trim() : '';
        const limit = clampInt(input.limit, 60, 300);
        const list = (pool: Theme[], max: number) =>
            pool.slice(0, max).map((t) => ({ id: t.id, kind: t.kind, name: t.name, members: t.members.length }));
        if (!themeQuery && !chainQuery) {
            return {
                count: themes.length,
                themes: list(themes, limit),
                as_of: meta.asOf,
                notice: THIRD_PARTY_NOTICE,
                data: info,
            };
        }
        const { theme, candidates } = resolveTheme(
            themes,
            themeQuery || chainQuery,
            themeQuery ? undefined : 'chain',
        );
        if (!theme) {
            const pool = candidates.length ? candidates : themes;
            return {
                error: candidates.length > 1 ? '符合的題材不只一個，請指定 id' : '找不到這個產業鏈或題材',
                count: pool.length,
                candidates: list(pool, Math.min(limit, 40)),
            };
        }
        const stageQuery = typeof input.stage === 'string' ? input.stage.trim() : '';
        const stages = matchStages(theme, stageQuery || undefined);
        if (stages && stages.length === 0) {
            return {
                error: `${theme.name} 沒有「${stageQuery}」這個階段`,
                stages: theme.stages.map((s) => ({ id: s.id, name: s.name, tier: tierLabel(s.tier) })),
            };
        }
        const index = entities ? entityIndex(entities) : null;
        const cap = (id: string) => {
            const code = twCodeOf(id);
            return (code && market?.quotes[code]?.market_cap_twd) || 0;
        };
        const members = themeMembers(theme, stages)
            .slice()
            .sort((a, b) => cap(b.id) - cap(a.id));
        return {
            theme: {
                id: theme.id,
                kind: theme.kind,
                name: theme.name,
                stages: theme.stages.map((s) => ({ id: s.id, name: s.name, tier: tierLabel(s.tier) })),
            },
            ...(stages ? { stage_filter: stages.map((s) => s.name) } : {}),
            count: members.length,
            members: members.slice(0, limit).map((m) => ({
                id: m.id,
                ...(twCodeOf(m.id) ? { code: twCodeOf(m.id) } : {}),
                name: entityName(index, m.id),
                stage: stageName(theme, m.stage),
                tier: tierLabel(m.tier),
                role: m.stage_role ?? null,
                detail: m.detail,
                as_of: m.as_of,
                market_cap_twd: cap(m.id) || null,
            })),
            as_of: theme.as_of ?? meta.asOf,
            notice: THIRD_PARTY_NOTICE,
            data: info,
        };
    }

    function resolveEntity(input: string, entities: Entity[] | null): string | null {
        const code = normalizeCompanyCode(input);
        if (code) return companyEntityId(code);
        const text = input.trim();
        if (!text) return null;
        const index = entities ? entityIndex(entities) : null;
        if (index?.has(text)) return text;
        const folded = text.toLowerCase();
        const hit = entities?.find(
            (e) => e.kind === 'company' && (e.name.toLowerCase() === folded || e.aliases?.some((a) => a.toLowerCase() === folded)),
        );
        return hit?.id ?? (text.includes('.') ? text : null);
    }

    async function findRelations(input: Record<string, unknown>) {
        const kind = String(input.type ?? '') as RelationKind;
        if (!RELATION_KINDS.includes(kind)) {
            return { error: `type 必須是 ${RELATION_KINDS.join('／')}` };
        }
        const [{ data: edges, meta }, entitiesL] = await Promise.all([
            client.getEdges(),
            settled(client.getEntities()),
        ]);
        const entities = entitiesL?.data ?? null;
        const entityId = resolveEntity(String(input.code ?? ''), entities);
        if (!entityId) return { error: `看不懂 code：${String(input.code ?? '')}` };
        const index = entities ? entityIndex(entities) : null;
        const limit = clampInt(input.limit, 30, 100);
        const hits = relationsFor(edges, entityId, kind);
        const shown = hits.slice(0, limit);

        // Evidence lives in the owning company's file (`tw.2330#e_x` → 2330).
        const owners: string[] = [];
        for (const hit of shown) {
            for (const ev of hit.edge.evidence ?? []) {
                const owner = twCodeOf(ev.split('#')[0] ?? '');
                if (owner && !owners.includes(owner)) owners.push(owner);
            }
        }
        const evidence = new Map<string, Evidence>();
        const files = await Promise.all(
            owners.slice(0, 8).map((code) => settled<Company>(client.getCompany(code))),
        );
        for (const file of files) {
            for (const [id, e] of Object.entries(file?.data.evidence ?? {})) evidence.set(id, e);
        }
        const evidenceMeta = files.length
            ? (files.find((f) => f?.meta.stale)?.meta ?? files.find((f) => f)?.meta ?? null)
            : undefined;
        const sources = new Map<string, ReturnType<typeof evidenceSource>>();
        const items = shown.map((hit) => {
            const refs = (hit.edge.evidence ?? []).filter((id) => evidence.has(id));
            for (const id of refs) sources.set(id, evidenceSource(evidence.get(id)!));
            return {
                id: hit.counterparty,
                ...(twCodeOf(hit.counterparty) ? { code: twCodeOf(hit.counterparty) } : {}),
                name: entityName(index, hit.counterparty),
                detail: hit.edge.detail,
                as_of: hit.edge.as_of,
                confidence: hit.edge.confidence,
                evidence_level: hit.edge.evidence_level,
                ...(hit.edge.amount ? { amount: hit.edge.amount } : {}),
                ...(hit.edge.event_date ? { event_date: hit.edge.event_date } : {}),
                ...(kind === 'transaction' ? { acting_party: entityName(index, hit.edge.src) } : {}),
                source_ids: hit.edge.evidence ?? [],
            };
        });
        return {
            entity: { id: entityId, name: entityName(index, entityId) },
            type: kind,
            label: RELATION_LABEL[kind],
            count: hits.length,
            items,
            sources: Object.fromEntries(sources),
            ...(hits.length === 0
                ? { note: '關係邊表沒有這類資料；未研究的公司只有官方資料，沒有上下游關係' }
                : {}),
            as_of: meta.asOf,
            notice: THIRD_PARTY_NOTICE,
            data: dataInfo(meta, 'edges', { entities: entitiesL?.meta ?? null, evidence: evidenceMeta }),
        };
    }

    const handlers: Record<CompanyDataToolName, (input: Record<string, unknown>) => Promise<unknown>> = {
        get_company: getCompany,
        get_financials: getFinancials,
        find_theme_members: findThemeMembers,
        find_relations: findRelations,
    };

    /** Run one tool (result capped to MAX_TOOL_RESULT_CHARS); data-source failures come back as `{ error, code }`. */
    async function run(name: CompanyDataToolName, input: Record<string, unknown>): Promise<unknown> {
        try {
            return capToolResult(await handlers[name](input ?? {}));
        } catch (error) {
            if (isCompanyDataError(error)) {
                return { error: companyDataErrorText(error), code: error.code };
            }
            throw error;
        }
    }

    return { run, getCompany, getFinancials, findThemeMembers, findRelations };
}

export type CompanyDataTools = ReturnType<typeof createCompanyDataTools>;
