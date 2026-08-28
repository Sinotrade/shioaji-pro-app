// contribution-flow — 貢獻傳導 sankey 的圖形建構。
// 資料源（1.7.4 index_components）：成分股排行事件自帶 category（server
// 真值，不再靠靜態 StockMeta join）；產業層來自 group_metric(contribution)
// 串流（自帶中文名）。「其他」餘量＝群組總點數－已列示個股合計。

export type ContributionDirection = 'up' | 'down';

export interface FlowStock {
    code: string;
    name?: string;
    category: string;
    points: number;
    pctChg: number;
}

export interface FlowGroup {
    category: string; // 'other-up' / 'other-down' 為呼叫端合成的餘量群組
    name: string;
    points: number;
}

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
    stocks: FlowStock[],
    groups: FlowGroup[],
): ContributionFlowGraph {
    const nodes = new Map<string, ContributionFlowNode>();
    const links: ContributionFlowLink[] = [];

    for (const group of groups) {
        if (!Number.isFinite(group.points) || group.points === 0) continue;
        const direction: ContributionDirection =
            group.points > 0 ? 'up' : 'down';
        const value = Math.abs(group.points);
        const rootId = `direction:${direction}`;
        const sectorId = `sector:${direction}:${group.category}`;

        if (!nodes.has(rootId)) {
            nodes.set(rootId, {
                id: rootId,
                label: direction === 'up' ? '上漲貢獻' : '下跌貢獻',
                kind: 'direction',
                direction,
                points: 0,
            });
        }
        nodes.set(sectorId, {
            id: sectorId,
            label: group.name,
            kind: 'sector',
            direction,
            points: value,
        });
        nodes.get(rootId)!.points += value;
        links.push({ source: rootId, target: sectorId, value, direction });

        const matching = stocks
            .filter(
                (stock) =>
                    stock.category === group.category &&
                    stock.points !== 0 &&
                    (stock.points > 0 ? 'up' : 'down') === direction,
            )
            .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
            .slice(0, MAX_STOCKS_PER_SECTOR);
        const rankedTotal = matching.reduce(
            (sum, stock) => sum + Math.abs(stock.points),
            0,
        );
        const scale = rankedTotal > value ? value / rankedTotal : 1;

        for (const stock of matching) {
            const stockId = `stock:${stock.code}`;
            nodes.set(stockId, {
                id: stockId,
                label: `${stock.code} ${stock.name || '名稱未取得'}`,
                kind: 'stock',
                direction,
                points: Math.abs(stock.points),
                code: stock.code,
                pctChg: stock.pctChg,
            });
            links.push({
                source: sectorId,
                target: stockId,
                value: Math.abs(stock.points) * scale,
                direction,
            });
        }

        const remainder = Math.max(0, value - rankedTotal);
        if (remainder > 0 || matching.length === 0) {
            const otherId = `other:${direction}:${group.category}`;
            const otherValue = matching.length === 0 ? value : remainder;
            nodes.set(otherId, {
                id: otherId,
                label: group.category.startsWith('other-')
                    ? '其他產業成分股'
                    : `其他${group.name}成分股`,
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

    return { nodes: [...nodes.values()], links };
}
