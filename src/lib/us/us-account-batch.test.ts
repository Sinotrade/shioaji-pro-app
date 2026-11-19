// 美股帳務批次：同一批只用一種伺服器模式、失敗帳戶保留上次資料、下單後刷新餘額
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ mode: 1, base: 'http://a', send: vi.fn() }));
vi.mock('../server-info-store', () => ({ getServerModeVersion: () => m.mode }));
vi.mock('../runtime', () => ({ getApiBase: () => m.base }));
vi.mock('../shioaji', () => ({ sendOrderMutation: m.send }));
vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../account-query', () => ({ createAccountQuery: () => ({ read: vi.fn(), assertCurrent: vi.fn() }) }));

import { allFailed, onUsAccountRefresh, resetUsAccountBatchForTest, runUsBatch, someFailed, US_MODE_CHANGED_ERROR } from './us-account-batch';
import { cancelUsOrder, placeUsOrder, reduceUsOrderQty } from './us-api';

const H1 = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const H2 = { ...H1, account_id: '0000002' };

beforeEach(() => { m.mode = 1; m.base = 'http://a'; m.send.mockReset(); resetUsAccountBatchForTest(); });

describe('one server mode per batch', () => {
    it('discards and re-runs the whole batch when the mode changes mid-batch', async () => {
        let calls = 0;
        const result = await runUsBatch(async batch => {
            calls++;
            const pnl = await batch.each('pnl', [H1], async () => `pnl@${m.mode}`);
            if (calls === 1) m.mode = 2; // 第一批的損益與股利會跨兩種模式
            const div = await batch.each('div', [H1], async () => `div@${m.mode}`);
            return { pnl, div };
        });
        expect(calls).toBe(2);
        expect(result.pnl[0]).toMatchObject({ state: 'ok', data: 'pnl@2' });
        expect(result.div[0]).toMatchObject({ state: 'ok', data: 'div@2' });
    });

    it('gives up with an error (keeping the old data) when the mode keeps changing', async () => {
        await expect(runUsBatch(async batch => {
            m.mode++;
            return batch.each('pnl', [H1], async () => 1);
        })).rejects.toThrow(US_MODE_CHANGED_ERROR);
    });

    it('treats a per-query mode-change rejection as a batch mode change', async () => {
        let n = 0;
        const r = await runUsBatch(batch => batch.each('pnl', [H1], async () => {
            if (n++ === 0) throw new Error('查詢期間伺服器模式已變更，已丟棄回應；請重新更新');
            return 'ok';
        }));
        expect(r[0]).toMatchObject({ state: 'ok', data: 'ok' });
    });
});

describe('per-account failures keep the last good data', () => {
    it('marks a failed account stale with its previous data, and errors when there is none', async () => {
        await runUsBatch(batch => batch.each('pnl', [H1, H2], async a => [a.account_id]));
        const second = await runUsBatch(batch => batch.each('pnl', [H1, H2], async a => {
            if (a.account_id === '0000002') throw new Error('502 UPSTREAM_ERROR');
            return ['new'];
        }));
        expect(second[0]).toMatchObject({ state: 'ok', data: ['new'] });
        expect(second[1]).toMatchObject({ state: 'stale', data: ['0000002'] });
        expect(someFailed(second)).toBe(true);
        expect(allFailed(second)).toBe(false);
        const none = await runUsBatch(batch => batch.each('div', [H1], async () => { throw new Error('502 x'); }));
        expect(none[0]).toMatchObject({ state: 'error' });
        expect(allFailed(none)).toBe(true);
    });

    it('does not keep data across servers or modes', async () => {
        await runUsBatch(batch => batch.each('pnl', [H1], async () => ['mode1']));
        m.mode = 2;
        const r = await runUsBatch(batch => batch.each('pnl', [H1], async () => { throw new Error('502 x'); }));
        expect(r[0]!.state).toBe('error');
    });

    it('reports 503 as unavailable, never stale', async () => {
        await runUsBatch(batch => batch.each('pnl', [H1], async () => ['x']));
        const r = await runUsBatch(batch => batch.each('pnl', [H1], async () => { throw Object.assign(new Error('503 down'), { status: 503 }); }));
        expect(r[0]!.state).toBe('unavailable');
        expect(allFailed(r)).toBe(false);
    });
});

describe('balance refresh after US order mutations', () => {
    it('requests a refresh after place, cancel and reduce (sent or unknown), not when never sent', async () => {
        const seen = vi.fn();
        const stop = onUsAccountRefresh(seen);
        m.send.mockResolvedValue({ order: { id: 't' }, status: { status: 'PendingSubmit' } });
        await placeUsOrder({ code: 'AAPL', exchange: 'NASDAQ' }, { action: 'Buy', price: '1', quantity: 1, price_type: 'LMT', time_in_force: 'DAY' }, H1);
        await cancelUsOrder('t', H1);
        await reduceUsOrderQty('t', 1, H1);
        expect(seen).toHaveBeenCalledTimes(3);
        m.send.mockRejectedValueOnce(Object.assign(new Error('結果不確定'), { mutationOutcomeUnknown: true }));
        await expect(cancelUsOrder('t', H1)).rejects.toThrow();
        expect(seen).toHaveBeenCalledTimes(4);
        m.send.mockRejectedValueOnce(Object.assign(new Error('沒送出'), { mutationNotStarted: true }));
        await expect(cancelUsOrder('t', H1)).rejects.toThrow();
        expect(seen).toHaveBeenCalledTimes(4);
        stop();
    });
});
