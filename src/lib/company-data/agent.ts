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
                limit: { type: 'number', description: '最多列幾家，預設 60，最大 300' },
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

function clampInt(value: unknown, fallback: number, max: number): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

function dataInfo(meta: DataMeta) {
    return {
        release_id: meta.releaseId,
        built_at: meta.builtAt,
        official_fetched_at: meta.officialFetchedAt,
        ...(meta.stale ? { stale: true, stale_note: '目前無法連線資料來源，使用本機快取' } : {}),
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

async function settled<T>(promise: Promise<Loaded<T>>): Promise<T | null> {
    try {
        return (await promise).data;
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
        const [{ data: c, meta }, themes, market, sources] = await Promise.all([
            client.getCompany(String(input.code ?? '')),
            settled(client.getThemes()),
            settled(client.getMarket()),
            settled(client.getSources()),
        ]);
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
            segments: (c.segments ?? []).map((s) => ({
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
            themes: (c.themes ?? []).map((t) => {
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
            data: dataInfo(meta),
            disclaimer: meta.disclaimer,
        };
    }

    async function getFinancials(input: Record<string, unknown>) {
        const months = clampInt(input.months, 12, 36);
        const quarters = clampInt(input.quarters, 8, 14);
        const [{ data: fin, meta }, sources] = await Promise.all([
            client.getFinancials(String(input.code ?? '')),
            settled(client.getSources()),
        ]);
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
            data: dataInfo(meta),
        };
    }

    async function findThemeMembers(input: Record<string, unknown>) {
        const [{ data: themes, meta }, entities, market] = await Promise.all([
            client.getThemes(),
            settled(client.getEntities()),
            settled(client.getMarket()),
        ]);
        const themeQuery = typeof input.theme === 'string' ? input.theme.trim() : '';
        const chainQuery = typeof input.chain === 'string' ? input.chain.trim() : '';
        const list = (pool: Theme[]) =>
            pool.map((t) => ({ id: t.id, kind: t.kind, name: t.name, members: t.members.length }));
        if (!themeQuery && !chainQuery) {
            return { themes: list(themes), as_of: meta.asOf, notice: THIRD_PARTY_NOTICE, data: dataInfo(meta) };
        }
        const { theme, candidates } = resolveTheme(
            themes,
            themeQuery || chainQuery,
            themeQuery ? undefined : 'chain',
        );
        if (!theme) {
            return {
                error: candidates.length > 1 ? '符合的題材不只一個，請指定 id' : '找不到這個產業鏈或題材',
                candidates: list(candidates.length ? candidates : themes),
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
        const limit = clampInt(input.limit, 60, 300);
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
            data: dataInfo(meta),
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
        const [{ data: edges, meta }, entities] = await Promise.all([
            client.getEdges(),
            settled(client.getEntities()),
        ]);
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
            for (const [id, e] of Object.entries(file?.evidence ?? {})) evidence.set(id, e);
        }
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
            data: dataInfo(meta),
        };
    }

    const handlers: Record<CompanyDataToolName, (input: Record<string, unknown>) => Promise<unknown>> = {
        get_company: getCompany,
        get_financials: getFinancials,
        find_theme_members: findThemeMembers,
        find_relations: findRelations,
    };

    /** Run one tool; data-source failures come back as `{ error, code }`. */
    async function run(name: CompanyDataToolName, input: Record<string, unknown>): Promise<unknown> {
        try {
            return await handlers[name](input ?? {});
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
