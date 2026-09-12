import { describe, expect, it } from 'vitest';
import payload from './__fixtures__/monitor-175.json';
import { completionWindows, monitorWarnings, parseMetrics, parseUsage, quotaState, type MetricsReport } from './server-monitor';
const real = () => structuredClone(payload) as MetricsReport;
describe('1.7.5 observed monitor data', () => {
    it('preserves real backend/category semantics and partial evidence', () => {
        const report = parseMetrics(real());
        expect(report.endpoints.reduce((n, e) => n + e.count, 0)).toBe(197);
        expect(report.endpoints.filter(e => e.category === 'data').reduce((n, e) => n + e.count, 0)).toBe(51);
        expect(monitorWarnings(report).join(' ')).toContain('4 筆');
        expect(monitorWarnings(report).join(' ')).toContain('未完整秒桶');
        expect(completionWindows(report).latest).not.toBe(197);
    });
    it('excludes missing, partial and out-of-range seconds without filling zeroes', () => {
        const report = real();
        report.range = { from: new Date(0).toISOString(), to: new Date(10_500).toISOString() };
        report.coverage = [{ from_ms: 0, to_ms: 10500, aggregation_enabled: true, dropped_requests: 0 }];
        report.series = Array.from({ length: 11 }, (_, i) => ({ timestamp_ms: i * 1000, count: i === 10 ? 999 : 1, complete: i !== 10 }));
        expect(completionWindows(report)).toEqual({ latest: 5, peak: 5 });
        report.series[8]!.complete = false;
        expect(completionWindows(report)).toEqual({ latest: null, peak: 5 });
        report.series = report.series.filter(p => p.timestamp_ms !== 2000);
        expect(completionWindows(report).latest).toBeNull();
        report.settings.capture.metrics = false;
        expect(completionWindows(report)).toEqual({ latest: null, peak: null });
    });
    it('does not infer short windows from larger buckets or disabled coverage', () => {
        const report = real();
        report.series_interval_ms = 2000;
        expect(completionWindows(report)).toEqual({ latest: null, peak: null });
        report.coverage[0]!.aggregation_enabled = false;
        expect(monitorWarnings(report).join(' ')).toContain('缺口');
    });
    it('separates quota warning, exhaustion and unavailable limits', () => {
        const usage = { bytes: 80, limit_bytes: 100, remaining_bytes: 20, connections: 3 };
        expect(quotaState(usage).tone).toBe('warning');
        expect(quotaState({ ...usage, remaining_bytes: 0 }).tone).toBe('danger');
        expect(quotaState({ ...usage, limit_bytes: 0 }).percent).toBeNull();
        expect(() => parseUsage({ ...usage, bytes: NaN })).toThrow();
        expect(() => parseUsage({ ...usage, connections: -1 })).toThrow();
        expect(() => parseMetrics({} as MetricsReport)).toThrow('格式不相容');
    });
    it('rejects malformed render fields and refuses windows crossing missing coverage', () => {
        const badCoverage = real(); badCoverage.coverage = [null] as unknown as MetricsReport['coverage'];
        expect(() => parseMetrics(badCoverage)).toThrow('格式不相容');
        const badOrigin = real(); badOrigin.endpoints[0]!.origin = {} as string;
        expect(() => parseMetrics(badOrigin)).toThrow('格式不相容');
        const report = real(); report.coverage = [];
        expect(completionWindows(report)).toEqual({ latest: null, peak: null });
    });
    it('detects gaps between otherwise enabled coverage spans', () => {
        const report = real();
        report.range = { from: new Date(0).toISOString(), to: new Date(10000).toISOString() };
        report.series = Array.from({ length: 10 }, (_, i) => ({ timestamp_ms: i * 1000, count: 0, complete: true }));
        report.coverage = [{ from_ms: 0, to_ms: 4000, aggregation_enabled: true, dropped_requests: 0 }, { from_ms: 6000, to_ms: 10000, aggregation_enabled: true, dropped_requests: 0 }];
        expect(monitorWarnings(report).join(' ')).toContain('缺口');
        expect(completionWindows(report)).toEqual({ latest: null, peak: null });
    });
});
