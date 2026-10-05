import { describe, expect, it, vi } from 'vitest';
import { assessReadiness, checkReadiness } from './readiness';

// 測試用假帳號：格式像券商帳號，但不是任何真實帳戶。
const stock = (account_id: string, signed = true) => ({ account_type: 'S', account_id, signed });
const futures = (account_id: string, signed = true) => ({ account_type: 'F', account_id, signed });
const UNKNOWN = { kind: 'unknown' };

describe('assessReadiness', () => {
    it('is ready when every stock and futures label matches a signed account of the same type', () => {
        const labels = ['證券 ••••5678', '期權 ••••4321', '海外 ••••2222'];
        expect(assessReadiness(labels, [stock('9A-1234-5678'), futures('9B87654321')])).toEqual({ kind: 'ready' });
    });

    it('lists only the unsigned accounts, stock first and once each', () => {
        const labels = ['期權 ••••4321', '證券 ••••5678', '證券 ••••5678', '證券 ••••9999'];
        const accounts = [futures('9B87654321', false), stock('9A12345678', false), stock('9A00009999')];
        expect(assessReadiness(labels, accounts)).toEqual({
            kind: 'pending',
            items: [
                { product: 'stock', label: '證券 ••••5678' },
                { product: 'futures', label: '期權 ••••4321' },
            ],
        });
    });

    it('counts only signed === true, and any unsigned account sharing the tail', () => {
        const wire = { account_type: 'S', account_id: '9A12345678', signed: 'true' as unknown as boolean };
        expect(assessReadiness(['證券 ••••5678'], [wire])).toMatchObject({ kind: 'pending' });
        expect(assessReadiness(['證券 ••••5678'], [stock('1112345678'), stock('9A12345678', false)])).toMatchObject({
            kind: 'pending',
        });
    });

    it.each([
        ['no labels', [], [stock('9A12345678')]],
        ['only an overseas label', ['海外 ••••2222'], [stock('9A12345678')]],
        ['a label without a tail', ['證券 ••••5678', '期權'], [stock('9A12345678'), futures('9B87654321')]],
        ['a label of unknown type', ['證券 ••••5678', '帳戶 ••••4321'], [stock('9A12345678'), futures('9B87654321')]],
        ['an account of another type', ['證券 ••••5678'], [futures('9A12345678')]],
        ['a label the server has no account for', ['證券 ••••5678', '期權 ••••4321'], [stock('9A12345678')]],
    ])('cannot tell with %s', (_name, labels: string[], accounts) => {
        expect(assessReadiness(labels, accounts)).toEqual(UNKNOWN);
    });
});

describe('checkReadiness', () => {
    it('hands fetch an abort signal and assesses what it returns', async () => {
        const fetch = vi.fn().mockResolvedValue([stock('9A12345678')]);
        await expect(checkReadiness(['證券 ••••5678'], fetch)).resolves.toEqual({ kind: 'ready' });
        expect(fetch).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
    });

    it.each([
        ['rejects', () => Promise.reject(new Error('503'))],
        ['returns something other than a list', () => Promise.resolve({ accounts: [] })],
        ['returns malformed accounts', () => Promise.resolve([null])],
    ])('is unknown when fetch %s', async (_name, fetch) => {
        await expect(checkReadiness(['證券 ••••5678'], fetch)).resolves.toEqual(UNKNOWN);
    });

    it('aborts and gives up as unknown when the request outlives the timeout', async () => {
        const hang = ({ signal }: { signal?: AbortSignal }) =>
            new Promise<unknown>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        await expect(checkReadiness(['證券 ••••5678'], hang, 5)).resolves.toEqual(UNKNOWN);
    });

    it('never aborts a request that already finished', async () => {
        let signal: AbortSignal | undefined;
        const fetch = async (opts: { signal?: AbortSignal }) => {
            signal = opts.signal;
            return [];
        };
        await checkReadiness(['證券 ••••5678'], fetch, 5);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(signal?.aborted).toBe(false);
    });
});
