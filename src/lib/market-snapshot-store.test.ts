import { beforeEach, expect, it, vi } from 'vitest';
import type { Snapshot } from './types/market';
const scope = vi.hoisted(() => ({ base: 'fixture' }));
vi.mock('./runtime', () => ({ getApiBase: () => scope.base }));
const physical = { code: 'TXFI6', target_code: null, security_type: 'FUT', exchange: 'TAIFEX' } as const;
const alias = { ...physical, code: 'TXFR1', target_code: 'TXFI6' };
const snap = (datetime: string) => ({ code: 'TXFI6', datetime }) as Snapshot;
beforeEach(() => { vi.resetModules(); scope.base = 'fixture'; });
it('shares batch pending/cache between alias and physical and isolates servers', async () => {
    const s = await import('./market-snapshot-store'); let resolve!: (v: Snapshot[]) => void;
    const pending = new Promise<Snapshot[]>(r => { resolve = r; }); const listener = vi.fn(); const release = s.subscribeMarketSnapshots(listener);
    expect(s.observeMarketSnapshots([alias], pending)).toBe(pending); expect(s.pendingMarketSnapshot(physical)).toBe(pending);
    const row = snap('2026-09-12 09:00:00'); resolve([row]); await pending; await Promise.resolve(); await Promise.resolve();
    expect(s.getMarketSnapshot(physical)).toBe(row); expect(listener).toHaveBeenCalledOnce(); expect(s.pendingMarketSnapshot(alias)).toBeUndefined();
    scope.base = 'other'; expect(s.getMarketSnapshot(physical)).toBeUndefined(); release();
});
it('retains newest snapshot and does not let an older request clear newer pending work', async () => {
    const s = await import('./market-snapshot-store'); let a!: (v: Snapshot[]) => void; let b!: (v: Snapshot[]) => void;
    const first = new Promise<Snapshot[]>(r => { a = r; }); const next = new Promise<Snapshot[]>(r => { b = r; });
    s.observeMarketSnapshots([physical], first); s.observeMarketSnapshots([physical], next);
    a([snap('2026-09-12 09:00:10')]); await first; await Promise.resolve(); await Promise.resolve();
    expect(s.pendingMarketSnapshot(physical)).toBe(next);
    b([snap('2026-09-12 09:00:00')]); await next; await Promise.resolve();
    expect(s.getMarketSnapshot(physical)!.datetime).toBe('2026-09-12 09:00:10');
});
it('does not publish a late old-server response into the new server cache', async () => {
    const s = await import('./market-snapshot-store'); let resolve!: (v: Snapshot[]) => void;
    const pending = new Promise<Snapshot[]>(r => { resolve = r; });
    s.observeMarketSnapshots([physical], pending); scope.base = 'other-server';
    resolve([snap('2026-09-12 09:00:00')]); await pending; await Promise.resolve();
    expect(s.getMarketSnapshot(physical)).toBeUndefined();
});
it('does not replace a dated snapshot with an unorderable timestamp', async () => {
    const s = await import('./market-snapshot-store');
    await s.observeMarketSnapshots([physical], Promise.resolve([snap('2026-09-12 09:00:00')]));
    await s.observeMarketSnapshots([physical], Promise.resolve([snap('invalid')]));
    expect(s.getMarketSnapshot(physical)!.datetime).toBe('2026-09-12 09:00:00');
});
