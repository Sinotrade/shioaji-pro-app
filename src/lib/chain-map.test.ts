import { describe, expect, it } from 'vitest';
import {
    breadthScore,
    buildQuotes,
    chainLinks,
    groupStats,
    layoutChain,
    linkPath,
    memberCodes,
    orderedStages,
    rankThemes,
    revenueYoy,
    stageMembers,
    stockContract,
} from './chain-map';
import type { Edge, MarketDaily, Theme } from './company-data/types';
import type { Snapshot } from './types/market';

function theme(id: string, stages: [string, string][], members: [string, string][], kind: Theme['kind'] = 'chain'): Theme {
    return {
        id,
        kind,
        name: id,
        aliases: [],
        related: [],
        as_of: '2026-10-20',
        stages: stages.map(([sid, tier]) => ({ id: sid, name: sid, tier })),
        members: members.map(([mid, stage]) => ({
            id: mid,
            stage,
            tier: stages.find(([sid]) => sid === stage)?.[1] ?? 'upstream',
            detail: null,
            as_of: null,
            confidence: 'ai_cross_checked',
        })),
    };
}

function snap(code: string, close: number, rate: number, amount: number): Snapshot {
    return {
        code,
        exchange: 'TSE',
        datetime: '2026-10-21T13:30:00',
        open: close,
        high: close,
        low: close,
        close,
        average_price: close,
        buy_price: 0,
        buy_volume: 0,
        sell_price: 0,
        sell_volume: 0,
        volume: 0,
        total_volume: 0,
        amount: 0,
        total_amount: amount,
        change_price: 0,
        change_rate: rate,
        change_type: '',
        tick_type: '',
        volume_ratio: 0,
        yesterday_volume: 0,
    };
}

const market: MarketDaily = {
    as_of: { twse: '2026-10-20' },
    quotes: {
        '1111': { close: 100, date: '2026-10-20', market_cap_twd: 1e10, shares: 1e8 },
        '2222': { close: 50, date: '2026-10-20', market_cap_twd: 5e9, shares: 1e8 },
        '3333': { close: 10, date: '2026-10-20', market_cap_twd: 1e9, shares: 1e8 },
    },
};

const chain = theme(
    'chain.x',
    [
        ['down', 'downstream'],
        ['up', 'upstream'],
        ['mid', 'midstream'],
    ],
    [
        ['tw.1111', 'up'],
        ['tw.2222', 'mid'],
        ['tw.3333', 'down'],
        ['tw.3333', 'mid'],
        ['us.NVDA', 'down'],
    ],
);

describe('chain-map model', () => {
    it('orders stages upstream → midstream → downstream', () => {
        expect(orderedStages(chain).map((s) => s.id)).toEqual(['up', 'mid', 'down']);
    });

    it('collects Taiwan members only, deduplicated', () => {
        expect(memberCodes([chain, chain])).toEqual(['1111', '2222', '3333']);
        expect(stageMembers(chain).get('down')).toEqual(['3333']);
        expect(stageMembers(chain).get('mid')).toEqual(['2222', '3333']);
    });

    it('maps the market to the snapshot exchange', () => {
        expect(stockContract('6488', 'tpex').exchange).toBe('OTC');
        expect(stockContract('2330', 'twse').exchange).toBe('TSE');
    });

    it('prefers live snapshots and falls back to the daily close', () => {
        const quotes = buildQuotes(['1111', '2222', '3333'], market, new Map([
            ['1111', snap('1111', 110, 10, 5e8)],
            ['2222', snap('2222', 0, 0, 0)], // not traded yet
        ]));
        expect(quotes.get('1111')).toEqual({ close: 110, pct: 10, amount: 5e8, cap: 1.1e10 });
        expect(quotes.get('2222')).toEqual({ close: 50, pct: null, amount: 0, cap: 5e9 });
        expect(quotes.get('3333')?.pct).toBeNull();
    });

    it('weights group change by the previous-close market cap', () => {
        const quotes = buildQuotes(['1111', '2222'], market, new Map([
            ['1111', snap('1111', 110, 10, 1)],
            ['2222', snap('2222', 45, -10, 1)],
        ]));
        const stats = groupStats(['1111', '2222', '3333'], quotes);
        // prev caps 1e10 and 5e9 → (1e10·10 − 5e9·10) / 1.5e10
        expect(stats.pct).toBeCloseTo(10 / 3, 6);
        expect(stats.breadth).toEqual({ up: 1, flat: 0, down: 1, none: 1 });
        expect(breadthScore(stats.breadth)).toBe(0);
    });

    it('ranks themes by weighted change and skips foreign-only themes', () => {
        const a = theme('a', [['s', 'upstream']], [['tw.1111', 's']]);
        const b = theme('b', [['s', 'upstream']], [['tw.2222', 's']]);
        const foreign = theme('f', [['s', 'upstream']], [['us.NVDA', 's']]);
        const quotes = buildQuotes(['1111', '2222'], market, new Map([
            ['1111', snap('1111', 99, -1, 1)],
            ['2222', snap('2222', 51, 2, 9)],
        ]));
        expect(rankThemes([a, b, foreign], quotes, 'pct').map((r) => r.theme.id)).toEqual(['b', 'a']);
        expect(rankThemes([a, b], quotes, 'amount').map((r) => r.theme.id)).toEqual(['b', 'a']);
    });

    it('lays stages out left to right inside the box', () => {
        const layout = layoutChain(chain, (code) => market.quotes[code]?.market_cap_twd ?? 0, 600, 300);
        expect(layout.columns.map((c) => c.stage.id)).toEqual(['up', 'mid', 'down']);
        const [up, mid, down] = layout.columns;
        expect(up!.x).toBe(0);
        expect(mid!.x).toBeGreaterThan(up!.x + up!.width - 1);
        expect(down!.x + down!.width).toBeLessThanOrEqual(600);
        for (const column of layout.columns) {
            for (const tile of column.tiles) {
                expect(tile.x0).toBeGreaterThanOrEqual(column.x);
                expect(tile.x1).toBeLessThanOrEqual(column.x + column.width);
                expect(tile.y1).toBeLessThanOrEqual(300);
            }
        }
        // a company in two stages keeps the first (upstream-most) tile for edges
        expect(layout.byCode.get('3333')?.stage).toBe('mid');
    });

    it('lays out 1,000 members quickly and gives every member a tile', () => {
        const big = theme(
            'big',
            [
                ['u', 'upstream'],
                ['m', 'midstream'],
                ['d', 'downstream'],
            ],
            Array.from({ length: 1000 }, (_, i) => [`tw.${1000 + i}`, ['u', 'm', 'd'][i % 3]!] as [string, string]),
        );
        const started = performance.now();
        const layout = layoutChain(big, (code) => Number(code) % 97, 1600, 900);
        const elapsed = performance.now() - started;
        expect(layout.columns.reduce((n, c) => n + c.tiles.length, 0)).toBe(1000);
        expect(elapsed).toBeLessThan(250);
    });

    it('keeps in-chain Taiwan supplier links only, once per pair', () => {
        const edge = (id: string, src: string, dst: string, type: Edge['type'] = 'supplier'): Edge => ({
            id,
            src,
            dst,
            type,
            direction: 'directed',
            detail: null,
            as_of: null,
            confidence: 'ai_cross_checked',
            evidence_level: 'primary',
            evidence: [],
        });
        const links = chainLinks(
            [
                edge('e1', 'tw.1111', 'tw.2222'),
                edge('e2', 'tw.1111', 'tw.2222'),
                edge('e3', 'tw.2222', 'tw.9999'),
                edge('e4', 'us.NVDA', 'tw.2222'),
                edge('e5', 'tw.1111', 'tw.3333', 'competitor'),
            ],
            new Set(['1111', '2222', '3333']),
        );
        expect(links.map((l) => `${l.from}>${l.to}`)).toEqual(['1111>2222']);
    });

    it('draws link curves between tile edges', () => {
        const a = { key: 'a', code: 'a', stage: 's', x0: 0, y0: 0, x1: 10, y1: 10 };
        const b = { key: 'b', code: 'b', stage: 't', x0: 100, y0: 20, x1: 110, y1: 40 };
        expect(linkPath(a, b).startsWith('M10,5 ')).toBe(true);
        expect(linkPath(a, b).endsWith(' 100,30')).toBe(true);
        const c = { ...b, stage: 's', x0: 0, x1: 10, y0: 50, y1: 60 };
        expect(linkPath(a, c)).toBe('M5,10 C5,30 5,30 5,50');
    });

    it('reads revenue YoY from the untyped revenue dataset', () => {
        const map = revenueYoy({ '2330': { yoy_pct: 54.6 }, '1101': { yoy_pct: null }, bad: null });
        expect([...map]).toEqual([['2330', 54.6]]);
    });
});
