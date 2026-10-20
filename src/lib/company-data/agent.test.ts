import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, createFakeHost, type FakeHost } from './__fixtures__/server';
import { COMPANY_DATA_TOOL_NAMES, COMPANY_DATA_TOOL_SPECS, createCompanyDataTools, isCompanyDataTool } from './agent';
import { createCompanyDataClient } from './client';
import { createMemoryStore } from './store';

let host: FakeHost;
let tools: ReturnType<typeof createCompanyDataTools>;

beforeEach(() => {
    host = createFakeHost();
    tools = createCompanyDataTools(
        createCompanyDataClient({ baseUrl: BASE, fetch: host.fetch, store: createMemoryStore() }),
    );
});

type Json = Record<string, any>;
const run = async (name: (typeof COMPANY_DATA_TOOL_NAMES)[number], input: Json) =>
    (await tools.run(name, input)) as Json;

describe('company data Agent tools', () => {
    it('declares four read-only tools with object schemas', () => {
        expect(COMPANY_DATA_TOOL_SPECS.map((t) => t.name)).toEqual([...COMPANY_DATA_TOOL_NAMES]);
        for (const spec of COMPANY_DATA_TOOL_SPECS) {
            expect(spec.schema.type).toBe('object');
            expect(spec.schema.additionalProperties).toBe(false);
        }
        expect(isCompanyDataTool('get_company')).toBe(true);
        expect(isCompanyDataTool('place_order')).toBe(false);
    });

    it('get_company returns researched data labelled third-party with as_of and sources', async () => {
        const r = await run('get_company', { code: 'tw.2330', max_relations: 2 });
        expect(r).toMatchObject({
            code: '2330',
            name: '台積電',
            market: '上市',
            industry: { exchange: '半導體業', sector: '科技', group: '半導體', industry: '晶圓代工' },
            research: { status: 'researched', as_of: '2026-10-13' },
            chain: { name: '半導體產業鏈', stage_name: '晶圓製造', tier: '中游' },
            main_theme: 'AI 伺服器',
            data: { release_id: '2026.10.20.2220', official_fetched_at: '2026-10-20' },
        });
        expect(r.notice).toContain('第三方資料');
        expect(r.relations.suppliers.items).toHaveLength(2);
        expect(r.relations.suppliers.count).toBeGreaterThan(2);
        expect(r.sources.length).toBeGreaterThan(0);
        expect(r.sources[0]).toHaveProperty('url');
        expect(r.daily.market_cap_twd).toBeGreaterThan(0);
        expect(r.official_sources[0]).toContain('臺灣證券交易所');
        expect(r.themes.find((t: Json) => t.id === 'theme.ai_server')).toMatchObject({ name: 'AI 伺服器', tier: '上游' });
    });

    it('get_company says an unresearched company only has official data', async () => {
        const r = await run('get_company', { code: '1108' });
        expect(r.research).toEqual({ status: 'official_only', as_of: null, confidence: 'official' });
        expect(r.notice).toContain('只有官方資料');
        expect(r.chain).toBeNull();
        expect(r.relations.suppliers.count).toBe(0);
    });

    it('get_financials returns newest-first revenue and quarter metrics', async () => {
        const r = await run('get_financials', { code: '2330', months: 3, quarters: 2 });
        expect(r.monthly_revenue).toHaveLength(3);
        expect(r.monthly_revenue[0].period > r.monthly_revenue[1].period).toBe(true);
        expect(r.quarters).toHaveLength(2);
        const q = r.quarters[0];
        expect(q.period > r.quarters[1].period).toBe(true);
        expect(q.grossMarginPct).toBeCloseTo((q.grossProfit / q.revenue) * 100, 1);
        expect(r.notice).toContain('官方資料');
        expect(r.as_of).toBe('2026-09');
        expect(typeof r.trailing_eps).toBe('number');
    });

    it('find_theme_members filters by stage and sorts by market cap', async () => {
        const r = await run('find_theme_members', { theme: 'AI 伺服器', stage: '上游' });
        expect(r.theme.id).toBe('theme.ai_server');
        expect(r.members.length).toBeGreaterThan(0);
        expect(r.members.every((m: Json) => m.tier === '上游')).toBe(true);
        const caps = r.members.map((m: Json) => m.market_cap_twd ?? 0);
        expect([...caps].sort((a, b) => b - a)).toEqual(caps);
        expect(r.members[0]).toHaveProperty('name');
        expect(r.notice).toContain('第三方資料');
    });

    it('find_theme_members resolves chains and lists everything without a query', async () => {
        const chain = await run('find_theme_members', { chain: '半導體' });
        expect(chain.theme.id).toBe('chain.semiconductor');
        const all = await run('find_theme_members', {});
        expect(all.themes.map((t: Json) => t.id)).toContain('theme.cowos');
        const missing = await run('find_theme_members', { theme: '不存在的題材' });
        expect(missing.error).toBeTruthy();
        expect(missing.candidates.length).toBeGreaterThan(0);
        const badStage = await run('find_theme_members', { theme: 'theme.cowos', stage: '不存在' });
        expect(badStage.stages.length).toBeGreaterThan(0);
    });

    it('find_relations reads both directions of the edge table', async () => {
        const suppliers = await run('find_relations', { code: '2330', type: 'supplier' });
        expect(suppliers.entity).toEqual({ id: 'tw.2330', name: '台積電' });
        expect(suppliers.items.map((i: Json) => i.id)).toEqual(
            expect.arrayContaining(['tw.5443', 'tw.6223', 'tw.6944']),
        );
        const customers = await run('find_relations', { code: '2330', type: 'customer' });
        expect(customers.items.map((i: Json) => i.id)).toEqual(
            expect.arrayContaining(['tw.2454', 'us.AMD']),
        );
        const subs = await run('find_relations', { code: '2330', type: 'subsidiary' });
        expect(subs.items.map((i: Json) => i.id)).toContain('org.esmc');
        expect(subs.notice).toContain('第三方資料');
    });

    it('find_relations attaches evidence the owning company file holds', async () => {
        const r = await run('find_relations', { code: '2330', type: 'subsidiary' });
        const withSources = r.items.filter((i: Json) => i.source_ids.some((id: string) => r.sources[id]));
        expect(withSources.length).toBeGreaterThan(0);
    });

    it('find_relations accepts foreign entity ids and names', async () => {
        const byId = await run('find_relations', { code: 'us.NVDA', type: 'supplier' });
        expect(byId.items.map((i: Json) => i.code)).toEqual(expect.arrayContaining(['6515', '9945', '2356']));
        const byName = await run('find_relations', { code: 'NVIDIA', type: 'supplier' });
        expect(byName.entity.id).toBe('us.NVDA');
    });

    it('find_relations rejects an unknown type', async () => {
        const r = await run('find_relations', { code: '2330', type: 'friend' });
        expect(r.error).toContain('supplier');
    });

    it('turns data-source failures into an error result instead of throwing', async () => {
        host.offline = true;
        const r = await run('get_company', { code: '2330' });
        expect(r).toMatchObject({ code: 'offline' });
        expect(r.error).toContain('沒有快取');
        host.offline = false;
        expect(await run('get_company', { code: '9999' })).toMatchObject({ code: 'not_found' });
    });
});
