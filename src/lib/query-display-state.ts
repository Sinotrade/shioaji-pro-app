import type { TradingQueryStatus } from './trading-state';

/** A successful result is required before an empty accounting view is authoritative. */
export function queryDisplayState(query: TradingQueryStatus): 'loading' | 'failed' | 'ready' {
    // A disconnect or other unresolved reconciliation reason can invalidate an
    // earlier empty snapshot (for example, a fill may have arrived while away).
    if (query.needsReconcile || query.reasons.length > 0 || (query.updatedAt === null && query.error)) {
        return 'failed';
    }
    return query.updatedAt === null ? 'loading' : 'ready';
}
