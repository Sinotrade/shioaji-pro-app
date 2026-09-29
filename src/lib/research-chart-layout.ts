import type { IChartApi } from 'lightweight-charts';

// Ratios resize with the panel. Three standard sub-panes leave 62% to price.
export function applyResearchPaneLayout(chart: IChartApi, assignments: { paneIndex: number; type: string }[]) {
    const weights: Record<string, number> = { v9macd: 1.6, v9kdj: 1.2, v8trend: 1 };
    chart.panes().forEach((pane, index) => pane.setStretchFactor(index === 0 ? 6.2
        : weights[assignments.find(item => item.paneIndex === index)?.type ?? ''] ?? 1.2));
}
