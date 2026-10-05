import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_API_BASE,
  OnboardingApiError,
  createOnboardingApi,
  onboardingApi,
  type OnboardingFetch,
} from './api';
import type { OnboardingKeyResponse, OnboardingStatus } from './types';

const STATUS: OnboardingStatus = {
  step: 'birthday',
  expiresAt: null,
  otp: null,
  otpTargets: [],
  termsText: null,
  result: null,
  error: null,
};
const RESULT = { apiKeyLast4: 'ab12', expiresOn: '2027-10-05', permissions: ['quote' as const], accountLabels: ['證券'] };
// 測試用假值，非真實金鑰。
const REVEALED = { apiKey: 'fake-api', secretKey: 'fake-secret' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function stub(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn<OnboardingFetch>(async () => (typeof response === 'function' ? response() : response.clone()));
  return { fetchMock, api: createOnboardingApi(fetchMock) };
}
function errorOf(promise: Promise<unknown>) {
  return promise.then(
    () => { throw new Error('expected rejection'); },
    (e: unknown) => e as OnboardingApiError,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('request shape', () => {
  it('GETs status with no body and no-store', async () => {
    const { fetchMock, api } = stub(json(STATUS));
    await expect(api.status()).resolves.toEqual(STATUS);
    expect(fetchMock).toHaveBeenCalledWith(`${ONBOARDING_API_BASE}/status`, {
      method: 'GET', headers: undefined, body: undefined, cache: 'no-store',
    });
  });

  it.each([
    ['start', 'start', { idNumber: 'X000000000', password: 'pw' }],
    ['birthday', 'birthday', { birthday: '00000000' }],
    ['sendOtp', 'otp/send', { purpose: 'cert', channel: 'sms', targetIndex: 0 }],
    ['verifyOtp', 'otp/verify', { purpose: 'key', code: '000000' }],
    ['relogin', 'relogin', { idNumber: 'X000000000', password: 'pw' }],
  ] as const)('%s POSTs JSON to %s with secrets only in the body', async (method, path, body) => {
    const { fetchMock, api } = stub(json(STATUS));
    await (api[method] as (b: unknown) => Promise<unknown>)(body);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ONBOARDING_API_BASE}/${path}`);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual(body);
  });

  it('acceptTerms sends accepted:true; submitPlan sends the plan', async () => {
    const { fetchMock, api } = stub(json(STATUS));
    await api.acceptTerms();
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ accepted: true });
    const plan = {
      name: 'n', expiresOn: '2027-10-05', accountTypes: ['stock' as const],
      permissions: { quote: true, account: true, trade: false, prod: true },
      ip: { mode: 'unlimited' as const, addresses: [] },
    };
    await api.submitPlan(plan);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${ONBOARDING_API_BASE}/plan`);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual(plan);
  });

  it('step() dispatches by kind', async () => {
    const { fetchMock, api } = stub(json(STATUS));
    await api.step({ kind: 'otpVerify', body: { purpose: 'cert', code: '1' } });
    await api.step({ kind: 'terms', body: { accepted: true } });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${ONBOARDING_API_BASE}/otp/verify`, `${ONBOARDING_API_BASE}/terms`,
    ]);
  });

  it('never puts request data in the URL', async () => {
    const { fetchMock, api } = stub(json(STATUS));
    await api.start({ idNumber: 'X000000000', password: 'pw-secret' });
    expect(fetchMock.mock.calls[0]![0]).not.toMatch(/X000000000|pw-secret|\?/);
  });

  it('uses the global fetch lazily for the default instance', async () => {
    const globalFetch = vi.fn(async () => json(STATUS));
    vi.stubGlobal('fetch', globalFetch);
    await onboardingApi.status();
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe('error normalisation', () => {
  it('reads { success:false, error:{ code } } and drops the server message', async () => {
    const { api } = stub(json({ success: false, error: { code: 'ONBOARDING_OTP_INVALID', message: 'driver said 帳號 X000000000' } }, 409));
    const error = await errorOf(api.verifyOtp({ purpose: 'cert', code: '1' }));
    expect(error).toBeInstanceOf(OnboardingApiError);
    expect(error).toMatchObject({ code: 'ONBOARDING_OTP_INVALID', status: 409, salvage: null });
    expect(error.message).toBe('ONBOARDING_OTP_INVALID');
  });

  it.each([
    ['non-JSON body', () => new Response('<html>bad gateway</html>', { status: 502 })],
    ['missing error field', () => json({ success: false }, 500)],
    ['non-string code', () => json({ error: { code: 42 } }, 500)],
    ['code with unexpected characters', () => json({ error: { code: 'oops <script>' } }, 500)],
  ])('%s becomes REQUEST_FAILED', async (_name, make) => {
    const { api } = stub(async () => make());
    expect(await errorOf(api.status())).toMatchObject({ code: 'REQUEST_FAILED' });
  });

  it('treats a 200 that is not a status as REQUEST_FAILED (e.g. SPA fallback)', async () => {
    const { api } = stub(new Response('<!doctype html>', { status: 200 }));
    expect(await errorOf(api.status())).toMatchObject({ code: 'REQUEST_FAILED', status: 200 });
    const unknownStep = stub(json({ step: 'bogus' }));
    expect(await errorOf(unknownStep.api.status())).toMatchObject({ code: 'REQUEST_FAILED' });
  });

  it('maps a rejected fetch to NETWORK_ERROR without leaking its text', async () => {
    const { api } = stub(async () => { throw new TypeError('failed to fetch pw-secret'); });
    const error = await errorOf(api.start({ idNumber: 'X000000000', password: 'pw-secret' }));
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(error.message).not.toContain('pw-secret');
  });

  it('passes through a 200 status that carries an error object', async () => {
    const body = { ...STATUS, error: { code: 'ONBOARDING_OTP_EXPIRED', message: 'x' } };
    const { api } = stub(json(body));
    await expect(api.status()).resolves.toMatchObject({ error: { code: 'ONBOARDING_OTP_EXPIRED' } });
  });
});

describe('createKey', () => {
  const ok: OnboardingKeyResponse = { result: RESULT, revealed: REVEALED };

  it('returns the response and POSTs revealSecret', async () => {
    const { fetchMock, api } = stub(json(ok));
    await expect(api.createKey({ revealSecret: true })).resolves.toEqual(ok);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ONBOARDING_API_BASE}/key`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ revealSecret: true });
  });

  it('passes the saved .env path through and drops a malformed one', async () => {
    const { api } = stub(json({ ...ok, envPath: '/work/project/.env' }));
    await expect(api.createKey({ revealSecret: true })).resolves.toEqual({ ...ok, envPath: '/work/project/.env' });
    for (const envPath of ['', 42, null, { path: '/x' }]) {
      const { api: other } = stub(json({ ...ok, envPath }));
      expect(await other.createKey({ revealSecret: true })).not.toHaveProperty('envPath');
    }
  });

  it('normalises a missing/invalid revealed to null', async () => {
    const { api } = stub(json({ result: RESULT, revealed: { apiKey: 'only' } }));
    await expect(api.createKey({ revealSecret: false })).resolves.toEqual({ result: RESULT, revealed: null });
  });

  it('keeps the one-time salvage payload when the response is an error', async () => {
    const { api } = stub(json({ success: false, error: { code: 'ONBOARDING_KEY_CAPTURE_FAILED', message: 'x', result: RESULT, revealed: REVEALED } }, 502));
    const error = await errorOf(api.createKey({ revealSecret: true }));
    expect(error).toMatchObject({ code: 'ONBOARDING_KEY_CAPTURE_FAILED', status: 502, salvage: { result: RESULT, revealed: REVEALED } });
    expect(error.salvage).not.toHaveProperty('envPath');
  });

  it.each([
    ['no revealed', { code: 'ONBOARDING_KEY_CAPTURE_FAILED', result: RESULT }],
    ['no result', { code: 'ONBOARDING_KEY_CAPTURE_FAILED', revealed: REVEALED }],
    ['incomplete result', { code: 'ONBOARDING_KEY_CAPTURE_FAILED', result: { apiKeyLast4: 'ab12' }, revealed: REVEALED }],
  ])('salvage is null when the error body has %s', async (_name, error) => {
    const { api } = stub(json({ error }, 502));
    expect((await errorOf(api.createKey({ revealSecret: true }))).salvage).toBeNull();
  });

  it('does not read salvage out of other endpoints', async () => {
    const { api } = stub(json({ error: { code: 'ONBOARDING_INVALID_STATE', result: RESULT, revealed: REVEALED } }, 409));
    expect((await errorOf(api.start({ idNumber: 'X000000000', password: 'p' }))).salvage).toBeNull();
  });

  it('rejects with NETWORK_ERROR when the connection drops', async () => {
    const { api } = stub(async () => { throw new TypeError('network'); });
    expect(await errorOf(api.createKey({ revealSecret: true }))).toMatchObject({ code: 'NETWORK_ERROR', salvage: null });
  });
});

describe('cancel', () => {
  it('POSTs an empty object and surfaces BROWSER_BUSY', async () => {
    const { fetchMock, api } = stub(json({ error: { code: 'ONBOARDING_BROWSER_BUSY' } }, 409));
    expect(await errorOf(api.cancel())).toMatchObject({ code: 'ONBOARDING_BROWSER_BUSY' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ONBOARDING_API_BASE}/cancel`);
    expect(fetchMock.mock.calls[0]![1]!.body).toBe('{}');
  });

  it('cancelQuietly never rejects', async () => {
    const { fetchMock, api } = stub(async () => { throw new TypeError('network'); });
    expect(api.cancelQuietly()).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
  });
});
