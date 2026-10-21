import { afterEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./trading-state', () => ({ reconcileOrdersOnce: refresh }));

import { apiPost } from './api';
import { classifyHttpOrderError, classifyOrderError, orderErrorNotice, reportOrderError } from './order-outcome';

afterEach(() => { vi.unstubAllGlobals(); refresh.mockClear(); });

const failure = (p: Promise<unknown>) => p.then(
    () => { throw new Error('expected a rejection'); },
    (e: unknown) => e as Error & Record<string, unknown>,
);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The Agent overlay (shioaji-pro-desktop classifyOrderMutationError) treats
 *  mutationNotStarted or any 4xx (explicit `status` or a leading "4xx " in the
 *  message) as "not sent — safe to resend with the same key". An unknown outcome
 *  must match neither. */
function agentSeesNotSent(e: unknown): boolean {
    const err = e as { mutationNotStarted?: unknown; status?: unknown; message?: string };
    if (err.mutationNotStarted === true) return true;
    const explicit = Number(err.status);
    const fromMessage = /^\s*(\d{3})(?:\s|$)/.exec(err.message ?? '');
    const status = Number.isInteger(explicit) && explicit > 0 ? explicit : Number(fromMessage?.[1] ?? 0);
    return status >= 400 && status < 500;
}

describe('classifyHttpOrderError (#249)', () => {
    it.each([
        [409, 'OrderOutcomeUnknown', 'order outcome unknown', 'unknown'],
        [409, undefined, 'conflict', 'unknown'],
        [400, undefined, 'OrderOutcomeUnknown: write timeout', 'unknown'], // SDK 1.7.7
        [504, undefined, 'gateway timeout', 'unknown'],
        [502, undefined, 'bad gateway', 'unknown'],
        [500, undefined, 'internal', 'unknown'],
        [503, 'NotConnected', 'not connected', 'not-sent'],
        [503, undefined, 'unavailable', 'not-sent'],
        [500, undefined, 'NotConnected: gateway', 'not-sent'], // SDK 1.7.7
        [400, undefined, 'price out of range', null],
        [422, undefined, 'bad params', null],
    ] as const)('%i %s %s → %s', (status, code, message, expected) => {
        expect(classifyHttpOrderError(status, code, message)).toBe(expected);
    });
});

describe('apiPost order errors (#249)', () => {
    const cases = [
        { name: 'SDK 409', res: () => json(409, { code: 409, message: 'order outcome unknown', details: { error_code: 'OrderOutcomeUnknown' } }), kind: 'unknown' },
        { name: 'SDK 1.7.7 400 with code in message', res: () => json(400, { code: 400, message: 'OrderOutcomeUnknown: no ack in 5s' }), kind: 'unknown' },
        { name: 'SDK 504', res: () => json(504, { code: 504, message: 'gateway timeout' }), kind: 'unknown' },
        { name: 'SDK 503 NotConnected', res: () => json(503, { code: 503, message: 'not connected', details: { error_code: 'NotConnected' } }), kind: 'not-sent' },
        { name: 'SDK 1.7.7 500 NotConnected', res: () => json(500, { code: 500, message: 'NotConnected: gateway' }), kind: 'not-sent' },
        { name: 'broker rejection 400', res: () => json(400, { code: 400, message: 'price out of range' }), kind: 'rejected' },
    ] as const;
    it.each(cases)('$name → $kind', async ({ res, kind }) => {
        vi.stubGlobal('fetch', vi.fn(async () => res()));
        const error = await failure(apiPost('/api/v1/order/place_order', {}));
        expect(classifyOrderError(error)).toBe(kind);
        if (kind === 'unknown') {
            expect(agentSeesNotSent(error)).toBe(false);
            expect(error.message).toContain('委託結果不確定');
        }
        if (kind === 'not-sent') expect(error.mutationNotStarted).toBe(true);
        if (kind === 'rejected') expect(error.status).toBe(400);
    });

    it('classifies combo orders the same way, and leaves non-order paths alone', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(409, { code: 409, message: 'x', details: { error_code: 'OrderOutcomeUnknown' } })));
        expect(classifyOrderError(await failure(apiPost('/api/v1/order/place_comboorder', {})))).toBe('unknown');
        const other = await failure(apiPost('/api/v1/data/snapshots', {}));
        expect(other.status).toBe(409);
        expect(other.mutationOutcomeUnknown).toBeUndefined();
    });

    it('a transport error after dispatch is an unknown outcome; a pre-dispatch gate error is untouched', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed'); }));
        const sent = await failure(apiPost('/api/v1/order/place_order', {}));
        expect(classifyOrderError(sent)).toBe('unknown');
        const gate = Object.assign(new Error('帳戶已變更'), { tradingGateRejected: true });
        const blocked = await failure(apiPost('/api/v1/order/place_order', {}, { beforeDispatch: () => { throw gate; } }));
        expect(blocked).toBe(gate);
        expect(blocked.mutationOutcomeUnknown).toBeUndefined();
    });
});

describe('apiPost ambiguous transport (#249 review)', () => {
    it('a 2xx order response whose body cannot be read is an unknown outcome', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"order": {', { status: 200, headers: { 'Content-Type': 'application/json' } })));
        const e = await failure(apiPost('/api/v1/order/place_order', {}));
        expect(classifyOrderError(e)).toBe('unknown');
        expect(agentSeesNotSent(e)).toBe(false);
    });
    it('a non-Error rejection after dispatch becomes an unknown-outcome Error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw 'UI trading proxy request failed: timeout'; }));
        const e = await failure(apiPost('/api/v1/order/place_order', {}));
        expect(e).toBeInstanceOf(Error);
        expect(classifyOrderError(e)).toBe('unknown');
        expect(e.message).toContain('timeout');
    });
});

describe('orderErrorNotice / reportOrderError (#249)', () => {
    it('unknown outcome never says 失敗, guides to the orders tab, and reconciles orders once', async () => {
        const unknown = Object.assign(new Error('委託結果不確定（HTTP 409 OrderOutcomeUnknown）：x'), { mutationOutcomeUnknown: true });
        const notice = orderErrorNotice('⚡ 閃電下單', unknown);
        expect(notice.title).toBe('⚡ 閃電下單結果不確定');
        expect(notice.title + notice.body).not.toContain('失敗');
        expect(notice.body).toContain('委託');
        expect(notice.body).toContain('請勿重新下單');
        const notify = vi.fn();
        expect(reportOrderError('圖表下單', unknown, notify)).toBe('unknown');
        expect(reportOrderError('組合單', unknown, notify)).toBe('unknown');
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it('timeout (runWithTimeout) counts as unknown; not-sent and rejected keep their wording and never reconcile', async () => {
        const timedOut = Object.assign(new Error('連線忙碌，委託送出結果未確認'), { mutationOutcomeUnknown: true, requestTimedOut: true });
        expect(orderErrorNotice('下單', timedOut).title).toBe('下單結果不確定');
        const notify = vi.fn();
        reportOrderError('下單', Object.assign(new Error('503 not connected'), { status: 503, mutationNotStarted: true }), notify);
        reportOrderError('下單', Object.assign(new Error('400 price out of range'), { status: 400 }), notify);
        expect(notify.mock.calls.map(c => c[0].title)).toEqual(['下單未送出', '下單失敗']);
        await Promise.resolve();
        expect(refresh).not.toHaveBeenCalled();
    });
});
