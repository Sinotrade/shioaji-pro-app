import type { StockMeta } from './stock-index';
import { sectorLabel } from './stock-index';
import type {
    IndexContributionEntry,
    IndustryContributionEntry,
} from './types/market';

export type ContributionDirection = 'up' | 'down';

export interface ContributionFlowNode {
    id: string;
    label: string;
    kind: 'direction' | 'sector' | 'stock';
    direction: ContributionDirection;
    points: number;
    code?: string;
    pctChg?: number;
}

export interface ContributionFlowLink {
    source: string;
    target: string;
    value: number;
    direction: ContributionDirection;
}

export interface ContributionFlowGraph {
    nodes: ContributionFlowNode[];
    links: ContributionFlowLink[];
}

const MAX_STOCKS_PER_SECTOR = 5;

export function buildContributionFlow(
    entries: IndexContributionEntry[],
    details: StockMeta[],
    industries: IndustryContributionEntry[],
): ContributionFlowGraph {
    const metaByCode = new Map(details.map((stock) => [stock.code, stock]));
    const nodes = new Map<string, ContributionFlowNode>();
    const links: ContributionFlowLink[] = [];

    for (const industry of industries) {
        if (!Number.isFinite(industry.points) || industry.points === 0) continue;
        const direction: ContributionDirection =
            industry.points > 0 ? 'up' : 'down';
        const value = Math.abs(industry.points);
        const category = industry.category.startsWith('other-')
            ? industry.category
            : industry.category.padStart(2, '0');
        const rootId = `direction:${direction}`;
        const sectorId = `sector:${direction}:${category}`;

        if (!nodes.has(rootId)) {
            nodes.set(rootId, {
                id: rootId,
                label:
                    direction === 'up' ? '上漲貢獻' : '下跌貢獻',
                kind: 'direction',
                direction,
                points: 0,
            });
        }
        nodes.set(sectorId, {
            id: sectorId,
            label: category.startsWith('other-')
                ? '其他產業'
                : sectorLabel(category),
            kind: 'sector',
            direction,
            points: value,
        });
        nodes.get(rootId)!.points += value;
        links.push({
            source: rootId,
            target: sectorId,
            value,
            direction,
        });

        const matching = entries
            .filter((entry) => {
                const meta = metaByCode.get(entry.code);
                return (
                    meta?.category?.padStart(2, '0') === category &&
                    (entry.points > 0 ? 'up' : 'down') === direction &&
                    entry.points !== 0
                );
            })
            .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
            .slice(0, MAX_STOCKS_PER_SECTOR);
        const rankedTotal = matching.reduce(
            (sum, entry) => sum + Math.abs(entry.points),
            0,
        );
        const scale = rankedTotal > value ? value / rankedTotal : 1;

        for (const entry of matching) {
            const meta = metaByCode.get(entry.code);
            const stockId = `stock:${entry.code}`;
            nodes.set(stockId, {
                id: stockId,
                label: `${entry.code} ${meta?.name || '名稱未取得'}`,
                kind: 'stock',
                direction,
                points: Math.abs(entry.points),
                code: entry.code,
                pctChg: entry.pct_chg,
            });
            links.push({
                source: sectorId,
                target: stockId,
                value: Math.abs(entry.points) * scale,
                direction,
            });
        }

        const remainder = Math.max(0, value - rankedTotal);
        if (remainder > 0 || matching.length === 0) {
            const otherId = `other:${direction}:${category}`;
            const otherValue = matching.length === 0 ? value : remainder;
            nodes.set(otherId, {
                id: otherId,
                label: category.startsWith('other-')
                    ? '其他產業成分股'
                    : `其他${sectorLabel(category)}成分股`,
                kind: 'stock',
                direction,
                points: otherValue,
            });
            links.push({
                source: sectorId,
                target: otherId,
                value: otherValue,
                direction,
            });
        }
    }

    return {
        nodes: [...nodes.values()],
        links,
    };
}
