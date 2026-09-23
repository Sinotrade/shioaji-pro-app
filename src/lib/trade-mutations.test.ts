import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cancellationOutcome, cancellationSummary, observeTradeMutation, onTradeMutation } from './trade-mutations';
import type { Trade } from './types/order';
const trade = (status: string) => ({ order: { id: 'fixture' }, status: { status } }) as Trade;
beforeEach(() => {
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
});
afterEach(() => vi.unstubAllGlobals());
describe('manual mutation acknowledgement', () => {
    it('does not call HTTP 200 or a filled order a confirmed cancellation', () => {
        expect(cancellationOutcome(trade('Cancelled'))).toBe('confirmed');
        for (const status of ['Submitted', 'PartFilled', 'PendingSubmit']) expect(cancellationOutcome(trade(status))).toBe('pending');
        expect(cancellationOutcome(trade('Filled'))).toBe('filled');
        for (const status of ['Failed', 'Inactive']) expect(cancellationOutcome(trade(status))).toBe('unknown');
        expect(cancellationSummary([{status:'fulfilled', value:trade('Submitted')}, {status:'rejected', reason: new Error('timeout')}])).toMatchObject({kind:'err'});
    });
    it('observes begin before request, preserves success despite a throwing display listener', async () => {
        const calls: string[] = [];
        const off = onTradeMutation(e => { calls.push(e.phase); throw new Error('display'); });
        const result = trade('Cancelled');
        const request = vi.fn(async () => { expect(calls).toEqual(['begin']); return result; });
        try { await expect(observeTradeMutation('fixture', request)).resolves.toBe(result); expect(calls).toEqual(['begin', 'settled']); expect(request).toHaveBeenCalledOnce(); }
        finally { off(); }
    });
    it('preserves unknown failure without retry or mutationNotStarted fabrication', async () => {
        const failure = new Error('timeout'); const request = vi.fn().mockRejectedValue(failure);
        const events: unknown[] = []; const off = onTradeMutation(e => events.push(e));
        try {
            await expect(observeTradeMutation('fixture', request)).rejects.toBe(failure);
            expect(request).toHaveBeenCalledOnce(); expect(failure).not.toHaveProperty('mutationNotStarted');
            expect(events).toHaveLength(2); expect(events[1]).not.toHaveProperty('trade');
        } finally { off(); }
    });
});
it('refuses a duplicate pending mutation rather than queueing or sending it', async () => {
    let resolve!: (trade: Trade) => void;
    const first = observeTradeMutation('duplicate', () => new Promise<Trade>(r => { resolve = r; }));
    const second = vi.fn(async () => trade('Cancelled'));
    await expect(observeTradeMutation('duplicate', second)).rejects.toThrow('已有');
    expect(second).not.toHaveBeenCalled();
    resolve(trade('Cancelled')); await first;
});

it('refuses dispatch without Web Locks rather than guessing when a remote request finished', async () => {
    vi.stubGlobal('navigator', {});
    const request = vi.fn(async () => trade('Cancelled'));
    await expect(observeTradeMutation('unsupported', request)).rejects.toThrow('Web Locks');
    expect(request).not.toHaveBeenCalled();
});
it('a lost remote settled event cannot retain a gate after the window releases its Web Lock', async () => {
    vi.resetModules();
    let receive!: (event: { data: unknown }) => void;
    vi.stubGlobal('BroadcastChannel', class {
        addEventListener(_type: string, listener: typeof receive) { receive = listener; }
        postMessage() {}
        close() {}
    });
    let held = true;
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => callback(held ? null : {}) } });
    const { getApiBase } = await import('./runtime');
    const mutations = await import('./trade-mutations');
    const request = vi.fn(async () => trade('Cancelled'));
    receive({ data: { token: 'closed-window', base: getApiBase(), tradeId: 'remote', phase: 'begin' } });
    await expect(mutations.observeTradeMutation('remote', request)).rejects.toThrow('已有');
    expect(request).not.toHaveBeenCalled();
    // Closing the owner releases the browser lock, without a settled broadcast.
    held = false;
    expect(request).not.toHaveBeenCalled(); // no automatic retry
    await expect(mutations.observeTradeMutation('remote', request)).resolves.toEqual(trade('Cancelled'));
    expect(request).toHaveBeenCalledOnce();
});

it('summarises confirmed, sent-but-unconfirmed, not-sent and unknown cancellations separately', async () => {
    const { cancellationSummary: summary } = await import('./trade-mutations');
    const unconfirmed = Object.assign(new Error('刪單已送出但未確認取消'), { code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true });
    const notSent = Object.assign(new Error('委託或帳戶歸屬不明'), { mutationNotStarted: true });
    expect(summary([{ status: 'fulfilled', value: trade('Cancelled') }, { status: 'fulfilled', value: trade('Cancelled') }]))
        .toEqual({ kind: 'ok', body: '已確認取消 2 筆。' });
    const mixed = summary([{ status: 'fulfilled', value: trade('Cancelled') }, { status: 'rejected', reason: unconfirmed },
        { status: 'rejected', reason: notSent }, { status: 'rejected', reason: new Error('timeout') }]);
    expect(mixed.kind).toBe('err');
    expect(mixed.body).toBe('已確認取消 1 筆；已送出未確認 1 筆；未送出 1 筆；失敗或結果未知 1 筆。未確認項目請手動更新委託核對，勿自動重送。');
    expect(summary([{ status: 'rejected', reason: notSent }]).kind).toBe('err');
    expect(summary([{ status: 'fulfilled', value: trade('Filled') }])).toEqual({ kind: 'info', body: '已確認取消 0 筆；已全部成交、無可取消 1 筆。' });
});
it('flags only read-back confirmed results as confirmed', async () => {
    vi.resetModules();
    vi.stubGlobal('BroadcastChannel', undefined);
    const m = await import('./trade-mutations');
    const events: { phase: string; confirmed?: boolean }[] = [];
    const off = m.onTradeMutation(e => events.push(e));
    try {
        await m.observeTradeMutation('plain', async () => trade('Cancelled'));
        await m.observeTradeMutation('verified', async () => m.markConfirmedCancellation(trade('Cancelled')));
        expect(events.filter(e => e.phase === 'settled').map(e => e.confirmed)).toEqual([undefined, true]);
    } finally { off(); }
});
