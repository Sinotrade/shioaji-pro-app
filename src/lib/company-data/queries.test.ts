import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchStages, quarterMetrics, recentRevenue, relationsFor, resolveTheme, trailingEps } from './queries';
import type { Edge, Financials, Theme } from './types';

const fixture = <T>(name: string): T =>
    JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as T;

describe('company data queries', () => {
    const themes = fixture<Theme[]>('themes.json');
    const edges = fixture<Edge[]>('edges.json');
    const fin = fixture<Financials>('financials-2330.json');

    it('resolves themes by id, short id, name and alias', () => {
        expect(resolveTheme(themes, 'theme.cowos').theme?.id).toBe('theme.cowos');
        expect(resolveTheme(themes, 'cowos').theme?.id).toBe('theme.cowos');
        expect(resolveTheme(themes, 'AI 伺服器').theme?.id).toBe('theme.ai_server');
        expect(resolveTheme(themes, '半導體', 'chain').theme?.id).toBe('chain.semiconductor');
        expect(resolveTheme(themes, '').theme).toBeNull();
    });

    it('matches stages by tier label, tier id and stage name', () => {
        const ai = themes.find((t) => t.id === 'theme.ai_server')!;
        expect(matchStages(ai, '上游')!.every((s) => s.tier === 'upstream')).toBe(true);
        expect(matchStages(ai, 'downstream')!.map((s) => s.id)).toEqual(['assembly']);
        expect(matchStages(ai, 'chips')!.map((s) => s.id)).toEqual(['chips']);
        expect(matchStages(ai, undefined)).toBeNull();
    });

    it('reads supplier edges in the right direction', () => {
        const suppliers = relationsFor(edges, 'tw.2330', 'supplier');
        expect(suppliers.every((h) => h.edge.dst === 'tw.2330')).toBe(true);
        const customers = relationsFor(edges, 'tw.2330', 'customer');
        expect(customers.every((h) => h.edge.src === 'tw.2330')).toBe(true);
        const parents = relationsFor(edges, 'org.esmc', 'parent');
        expect(parents.map((h) => h.counterparty)).toEqual(['tw.2330']);
    });

    it('derives quarter margins and trailing EPS from the column store', () => {
        const [latest] = quarterMetrics(fin, 1);
        const i = fin.statements.periods.length - 1;
        expect(latest!.period).toBe(fin.statements.periods[i]);
        expect(latest!.revenue).toBe(fin.statements.income_quarter['營業收入']![i]);
        expect(latest!.grossMarginPct).toBeGreaterThan(0);
        const eps = quarterMetrics(fin, 4).reduce((sum, q) => sum + (q.eps ?? 0), 0);
        expect(trailingEps(fin)).toBeCloseTo(eps, 2);
        expect(recentRevenue(fin, 12)).toHaveLength(12);
    });

    it('maps financial-industry statement formats', () => {
        const bank: Financials = {
            code: '2801',
            name: '彰銀',
            market: 'twse',
            monthly_revenue: [],
            statements: {
                periods: ['2026Q1', '2026Q2'],
                format: ['bank', 'bank'],
                income_quarter: {
                    '淨收益': [100, 120],
                    '淨利（損）歸屬於母公司業主': [30, 36],
                    '基本每股盈餘（元）': [0.3, 0.36],
                },
                income_ytd: {},
                balance: { '資產總計': [null, 5000], '負債總額': [null, 4500] },
                cash_flow_quarter: {},
                cash_flow_ytd: {},
            },
        };
        const [q] = quarterMetrics(bank, 1);
        expect(q).toMatchObject({
            period: '2026Q2',
            format: 'bank',
            revenue: 120,
            netIncome: 36,
            netMarginPct: 30,
            grossProfit: null,
            grossMarginPct: null,
            totalLiabilities: 4500,
        });
        expect(trailingEps(bank)).toBeNull();
    });
});
