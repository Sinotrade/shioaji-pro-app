export interface Usage { connections: number; bytes: number; limit_bytes: number; remaining_bytes: number }
export interface EndpointStats {
    plane: string; origin: string; method: string; endpoint: string; category: string;
    count: number; errors: number; timeouts: number; cancelled: number; in_flight: number; p95_us: number;
}
export interface MetricsReport {
    source: string; range: { from: string; to: string }; endpoints: EndpointStats[];
    series: { timestamp_ms: number; count: number; complete: boolean }[];
    series_interval_ms: number; history_incomplete: boolean; dropped: number;
    persistence_error: string | null; last_saved_ms: number | null;
    settings: { capture: { metrics: boolean; requests: boolean; streams: string } };
    coverage: { aggregation_enabled: boolean; dropped_requests: number; from_ms: number; to_ms: number }[];
}
export interface SubscriptionsReport {
    total: number; market_data: number; trade_accounts: number;
    by_type: Record<string, number>; partial: boolean; unavailable: boolean;
}
const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function parseMetrics(value: MetricsReport): MetricsReport {
    if (!value || value.source !== 'backend' || !Array.isArray(value.endpoints) || !Array.isArray(value.series) || !Array.isArray(value.coverage)
        || !Number.isFinite(Date.parse(value.range?.from)) || !Number.isFinite(Date.parse(value.range?.to))
        || typeof value.settings?.capture?.metrics !== 'boolean' || typeof value.settings.capture.requests !== 'boolean'
        || !['auto', 'off'].includes(value.settings.capture.streams) || typeof value.history_incomplete !== 'boolean'
        || !(value.persistence_error === null || typeof value.persistence_error === 'string')
        || !(value.last_saved_ms === null || count(value.last_saved_ms))
        || !count(value.dropped) || !count(value.series_interval_ms)
        || value.coverage.some(c => !c || typeof c.aggregation_enabled !== 'boolean' || ![c.from_ms, c.to_ms, c.dropped_requests].every(count))
        || value.series.some(p => !p || !count(p.timestamp_ms) || !count(p.count) || typeof p.complete !== 'boolean')
        || value.endpoints.some(e => !e || ![e.endpoint, e.origin, e.plane, e.method, e.category].every(s => typeof s === 'string') || ![e.count, e.errors, e.timeouts, e.in_flight, e.p95_us].every(count))) throw new Error('Monitor 格式不相容');
    return value;
}
export function parseSubscriptions(value: SubscriptionsReport): SubscriptionsReport {
    if (!value || ![value.total, value.market_data, value.trade_accounts].every(count) || !value.by_type
        || !Object.values(value.by_type).every(count) || typeof value.partial !== 'boolean' || typeof value.unavailable !== 'boolean') throw new Error('訂閱格式不相容');
    return value;
}
export function parseUsage(value: Usage): Usage {
    if (!value || ![value.connections, value.bytes, value.limit_bytes, value.remaining_bytes]
        .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new Error('用量格式不相容');
    return value;
}
export function quotaState(usage: Usage | null) {
    if (!usage || usage.limit_bytes <= 0) return { percent: null, label: '額度未知', tone: 'muted' } as const;
    const percent = usage.bytes / usage.limit_bytes * 100;
    if (usage.remaining_bytes === 0 || percent >= 100) return { percent, label: '流量額度已耗盡', tone: 'danger' } as const;
    if (percent >= 80) return { percent, label: '流量接近上限', tone: 'warning' } as const;
    return { percent, label: '流量尚有餘額', tone: 'normal' } as const;
}
export function monitorWarnings(report: MetricsReport): string[] {
    const warnings: string[] = [];
    if (!report.settings.capture.metrics) warnings.push('請求統計已停錄，保留值不是現在流量');
    if (report.history_incomplete || !covered(report, Math.ceil(Date.parse(report.range.from) / 1000) * 1000, Math.floor(Date.parse(report.range.to) / 1000) * 1000)) warnings.push('區間有缺口，完成量僅為觀測下限');
    if (report.dropped > 0) warnings.push(`本次 Server 已遺漏 ${report.dropped} 筆觀測`);
    if (report.series.some(p => !p.complete)) warnings.push('含未完整秒桶；短窗統計排除這些桶');
    if (report.persistence_error) warnings.push('監控歷史儲存失敗');
    return warnings;
}
function covered(report: MetricsReport, from: number, to: number): boolean {
    if (to <= from || !report.coverage.length) return false;
    let cursor = from;
    for (const span of [...report.coverage].sort((a, b) => a.from_ms - b.from_ms)) {
        if (!span.aggregation_enabled || span.dropped_requests > 0 || span.to_ms <= cursor) continue;
        if (span.from_ms > cursor) return false;
        cursor = Math.max(cursor, span.to_ms);
        if (cursor >= to) return true;
    }
    return false;
}
// Whole, contiguous second buckets only. Never extrapolate an average into
// a broker quota or fill missing / partial seconds with valid zeroes.
export function completionWindows(report: MetricsReport, seconds = 5) {
    if (report.series_interval_ms !== 1000 || !report.settings.capture.metrics) return { latest: null, peak: null };
    const end = Math.floor(Date.parse(report.range.to) / 1000) * 1000;
    const start = Date.parse(report.range.from);
    const points = new Map(report.series.filter(p => p.complete && p.timestamp_ms >= start && p.timestamp_ms < end
        && covered(report, p.timestamp_ms, p.timestamp_ms + 1000))
        .map(p => [p.timestamp_ms, p.count]));
    const sum = (stop: number): number | null => {
        let total = 0;
        for (let i = 1; i <= seconds; i++) {
            const count = points.get(stop - i * 1000);
            if (count === undefined) return null;
            total += count;
        }
        return total;
    };
    const windows = [...points.keys()].map(t => sum(t + 1000)).filter((n): n is number => n !== null);
    return { latest: sum(end), peak: windows.length ? Math.max(...windows) : null };
}
