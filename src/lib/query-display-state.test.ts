import { describe, expect, it } from 'vitest';
import { queryDisplayState } from './query-display-state';
import type { TradingQueryStatus } from './trading-state';

const query = (override: Partial<TradingQueryStatus>): TradingQueryStatus => ({
    updatedAt: null, needsReconcile: false, error: null, reasons: [], ...override,
});

describe('query display state', () => {
    it('does not declare an empty initial or partial multi-account read complete', () => {
        expect(queryDisplayState(query({}))).toBe('loading');
        expect(queryDisplayState(query({ updatedAt: null }))).toBe('loading');
    });

    it('shows empty only after a successful complete read', () => {
        expect(queryDisplayState(query({ updatedAt: 123 }))).toBe('ready');
    });

    it('keeps initial, partial, and refresh failures distinct from verified empty', () => {
        expect(queryDisplayState(query({ error: '帳戶查詢失敗' }))).toBe('failed');
        expect(queryDisplayState(query({ updatedAt: 123, reasons: ['query-failed'] }))).toBe('failed');
        expect(queryDisplayState(query({ updatedAt: 123, reasons: ['disconnect'] }))).toBe('failed');
        expect(queryDisplayState(query({ updatedAt: 123, needsReconcile: true }))).toBe('failed');
        expect(queryDisplayState(query({ updatedAt: 123, error: 'refresh failed' }))).toBe('ready');
    });
});
