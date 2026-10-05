// src/components/onboarding/sinopac-wizard.test.tsx — the wizard is driven by a stubbed fetch (no real broker, no real credentials).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode, createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 桌面版（預設）要拿回 Secret 去啟動伺服器；網頁版不要。
const tauri = vi.hoisted(() => ({ on: true }));
vi.mock('../../lib/tauri', () => ({ openExternalUrl: vi.fn(), get isTauri() { return tauri.on; } }));
// 完成畫面會查帳戶是否已開通：換成假的，測試不連任何伺服器。
const shioaji = vi.hoisted(() => ({ fetchAccounts: vi.fn() }));
vi.mock('../../lib/shioaji', () => shioaji);

import { ONBOARDING_API_BASE } from '../../lib/sinopac-onboarding/api';
import { TWCA_TERMS } from '../../lib/sinopac-onboarding/twca-terms';
import type { OnboardingPlan, OnboardingStatus, OnboardingStep } from '../../lib/sinopac-onboarding/types';
import { SinopacWizard } from './sinopac-wizard';
import { BirthdayStep } from './steps/BirthdayStep';
import { CreatingStep } from './steps/CreatingStep';
import { DoneStep } from './steps/DoneStep';
import { FlowStepper } from './steps/FlowStepper';
import { LoginStep } from './steps/LoginStep';
import { OtpStep } from './steps/OtpStep';
import { PlanStep } from './steps/PlanStep';
import { StoppedStep } from './steps/StoppedStep';
import { TermsStep } from './steps/TermsStep';

// 測試用假值：格式合法，但不是也不像任何真實帳密或金鑰。
const FAKE_ID = 'A100000000';
const FAKE_PASSWORD = 'fake-password';
const KEYS = { apiKey: 'fake-api-key', secretKey: 'fake-secret-key' };
const RESULT = {
    apiKeyLast4: '1234',
    expiresOn: '2027-10-05',
    permissions: ['quote' as const, 'account' as const, 'prod' as const],
    accountLabels: ['證券 ••••5678'],
};
const PLAN: OnboardingPlan = {
    name: 'test-key',
    expiresOn: '2027-10-05',
    permissions: { quote: true, account: true, trade: false, prod: true },
    accountTypes: ['stock'],
    ip: { mode: 'unlimited', addresses: [] },
};
const ENV_PATH = '/work/project/.env';
// 頁面上的條款：換行與網址和登入畫面那份不同，內容一致。
const PAGE_TERMS = `憑證作業條款\n${TWCA_TERMS.join('\n').replace('網址為', '網址為 https://www.twca.com.tw/repository 。')}`;
const UNAVAILABLE = '此環境沒有帳號密碼申請功能（僅限開發模式的網頁版）。請改用「API Key 登入」。';

const status = (step: OnboardingStep, extra: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
    step,
    expiresAt: null,
    otp: null,
    otpTargets: [],
    termsText: null,
    result: null,
    error: null,
    ...extra,
});
const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
const failure = (code: string, extra: Record<string, unknown> = {}, httpStatus = 409) =>
    json({ success: false, error: { code, message: 'server text', ...extra } }, httpStatus);
const keyCreated = () => json({ result: RESULT, revealed: KEYS, envPath: ENV_PATH });

type Route = (body: unknown) => Response | Promise<Response>;

function serve(routes: Record<string, Route>) {
    const calls: { route: string; body: unknown }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            const route = `${init?.method ?? 'GET'} ${input.slice(ONBOARDING_API_BASE.length + 1)}`;
            const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
            calls.push({ route, body });
            return routes[route]?.(body) ?? new Response('Not Found', { status: 404 });
        }),
    );
    return {
        calls,
        count: (route: string) => calls.filter((call) => call.route === route).length,
        bodyOf: (route: string) => calls.find((call) => call.route === route)?.body,
    };
}

const textOf = (node: ReactTestInstance | ReactTestRenderer['root']): string =>
    node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
const dump = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
const has = (view: ReactTestRenderer, type: Parameters<ReactTestRenderer['root']['findAllByType']>[0]) =>
    view.root.findAllByType(type).length > 0;
const buttons = (view: ReactTestRenderer, label: string) =>
    view.root.findAllByType('button').filter((button) => textOf(button) === label);

async function settle() {
    for (let i = 0; i < 5; i++)
        await act(async () => {
            await new Promise((resolveTick) => setImmediate(resolveTick));
        });
}

const views: ReactTestRenderer[] = [];
async function mount(onKeysReady = vi.fn(), wrap = false, onUseApiKey = vi.fn()) {
    const wizard = createElement(SinopacWizard, { onKeysReady, onUseApiKey });
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(wrap ? createElement(StrictMode, null, wizard) : (wizard as ReactElement));
    });
    views.push(view);
    await settle();
    return { view, onKeysReady };
}
const call = (view: ReactTestRenderer, type: Parameters<ReactTestRenderer['root']['findByType']>[0], prop: string, ...args: unknown[]) =>
    act(async () => {
        await view.root.findByType(type).props[prop](...args);
    });

const storage = () => ({ setItem: vi.fn(), getItem: vi.fn(() => null), removeItem: vi.fn(), clear: vi.fn() });
let local: ReturnType<typeof storage>;
let session: ReturnType<typeof storage>;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    local = storage();
    session = storage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    shioaji.fetchAccounts.mockReset();
    shioaji.fetchAccounts.mockResolvedValue([]);
});

afterEach(async () => {
    tauri.on = true;
    for (const view of views.splice(0)) await act(async () => view.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('restore after refresh', () => {
    it.each([
        ['birthday', BirthdayStep],
        ['cert_otp', OtpStep],
        ['plan', PlanStep],
        ['key_otp', OtpStep],
    ] as const)('shows the %s screen the server reports, with the stepper', async (step, component) => {
        const { count } = serve({ 'GET status': () => json(status(step)) });
        const { view } = await mount();
        expect(has(view, component)).toBe(true);
        expect(has(view, LoginStep)).toBe(false);
        expect(view.root.findByType(FlowStepper).props.step).toBe(step);
        expect(count('GET status')).toBe(1);
    });

    it('uses the key purpose for key_otp and never re-sends an action while restoring', async () => {
        const { calls } = serve({ 'GET status': () => json(status('key_otp')) });
        const { view } = await mount();
        expect(view.root.findByType(OtpStep).props.purpose).toBe('key');
        expect(calls.map((entry) => entry.route)).toEqual(['GET status']);
    });

    it('shows the first login form when the server has no flow', async () => {
        serve({ 'GET status': () => json(status('login')) });
        const { view } = await mount();
        expect(has(view, LoginStep)).toBe(true);
        expect(view.root.findByType(LoginStep).props.relogin).toBeUndefined();
    });

    it('waits for the key instead of sending another create request when restored at creating', async () => {
        const { count } = serve({ 'GET status': () => json(status('creating', { keyRequested: true })) });
        const { view } = await mount();
        expect(view.root.findByType(CreatingStep).props).toMatchObject({ resumed: true, gaveUp: false });
        expect(count('POST key')).toBe(0);
    });

    it('sends the first create request when restored at creating before it ever reached the server', async () => {
        const { count } = serve({
            'GET status': () => json(status('creating', { keyRequested: false })),
            'POST key': keyCreated,
        });
        const { view } = await mount();
        expect(count('POST key')).toBe(1);
        expect(has(view, DoneStep)).toBe(true);
    });

    it('polls a restored creating screen and reports when the server flow has ended', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
        let reads = 0;
        serve({ 'GET status': () => json(status(++reads === 1 ? 'creating' : 'login')) });
        const { view } = await mount();
        expect(has(view, CreatingStep)).toBe(true);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(has(view, CreatingStep)).toBe(false);
        expect(textOf(view.root)).toContain('先前的建立程序已經結束');
    });
});

describe('capability probe', () => {
    it.each([
        ['a 404', () => new Response('Not Found', { status: 404 })],
        ['a non-JSON 200', () => new Response('<!doctype html><html></html>', { status: 200 })],
        ['a server error', () => failure('ONBOARDING_BROWSER_BUSY', {}, 500)],
    ] as const)('shows the unavailable notice on %s and renders no flow', async (_name, reply) => {
        serve({ 'GET status': reply });
        const { view } = await mount();
        expect(textOf(view.root)).toBe(UNAVAILABLE);
        expect(has(view, LoginStep)).toBe(false);
        expect(has(view, FlowStepper)).toBe(false);
        expect(view.root.findAllByType('button')).toHaveLength(0);
    });

    it('shows the unavailable notice when fetch itself rejects, without throwing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        const { view } = await mount();
        expect(textOf(view.root)).toBe(UNAVAILABLE);
    });

    it('does not cancel or post anything when unmounted while unavailable', async () => {
        const { calls } = serve({ 'GET status': () => new Response('', { status: 404 }) });
        const { view } = await mount();
        await act(async () => view.unmount());
        expect(calls.map((entry) => entry.route)).toEqual(['GET status']);
    });
});

describe('credentials stay in memory', () => {
    function certFlow(reloginReply: Route, termsText = PAGE_TERMS, termsReply: Route = () => json(status('relogin'))) {
        return serve({
            'GET status': () => json(status('login')),
            'POST start': () => json(status('birthday')),
            'POST birthday': () => json(status('terms', { termsText })),
            'POST terms': termsReply,
            'POST relogin': reloginReply,
        });
    }
    async function login(view: ReactTestRenderer) {
        await call(view, LoginStep, 'onSubmit', { idNumber: FAKE_ID, password: FAKE_PASSWORD });
        await settle();
        expect(has(view, BirthdayStep)).toBe(true);
        await call(view, BirthdayStep, 'onSubmit', '19900101');
        await settle();
    }

    it('accepts the terms once and logs in again once with the credentials from memory', async () => {
        const { count, bodyOf } = certFlow(() => json(status('plan')));
        const { view } = await mount();
        await login(view);
        expect(count('POST terms')).toBe(1);
        expect(bodyOf('POST terms')).toEqual({ accepted: true });
        expect(count('POST relogin')).toBe(1);
        expect(bodyOf('POST relogin')).toEqual({ idNumber: FAKE_ID, password: FAKE_PASSWORD });
        expect(has(view, PlanStep)).toBe(true);
        await settle();
        expect(count('POST relogin')).toBe(1);
        expect(count('POST terms')).toBe(1);
    });

    it('never sends the second login twice when it fails, and asks for the password again instead', async () => {
        const { count } = certFlow(() => failure('ONBOARDING_BROWSER_BUSY'));
        const { view } = await mount();
        await login(view);
        await settle();
        expect(count('POST relogin')).toBe(1);
        expect(view.root.findByType(LoginStep).props.relogin).toBe(true);
        expect(textOf(view.root)).toContain('瀏覽器目前忙碌中');
    });

    it('does not auto-send a second login after a refresh at the relogin step (no password in memory)', async () => {
        const { count } = serve({ 'GET status': () => json(status('relogin')) });
        const { view } = await mount();
        expect(view.root.findByType(LoginStep).props.relogin).toBe(true);
        expect(count('POST relogin')).toBe(0);
    });

    it('falls back to the manual terms screen when the automatic acceptance does not move on', async () => {
        const { count } = certFlow(() => json(status('plan')), PAGE_TERMS, () => json(status('terms', { termsText: PAGE_TERMS })));
        const { view } = await mount();
        await login(view);
        expect(count('POST terms')).toBe(1);
        expect(has(view, TermsStep)).toBe(true);
        await settle();
        expect(count('POST terms')).toBe(1);
    });

    it('does not accept on the user\'s behalf when the page terms differ from the ones shown at login', async () => {
        const { count } = certFlow(() => json(status('plan')), `${PAGE_TERMS}\n八、新增的條款。`.replace('七、', '柒、'));
        const { view } = await mount();
        await login(view);
        expect(count('POST terms')).toBe(0);
        expect(has(view, TermsStep)).toBe(true);
        await call(view, TermsStep, 'onSubmit');
        await settle();
        expect(count('POST terms')).toBe(1);
    });

    it('asks for the terms by hand after a refresh, since the consent was given in another page load', async () => {
        const { count } = serve({ 'GET status': () => json(status('terms', { termsText: PAGE_TERMS })) });
        const { view } = await mount();
        expect(count('POST terms')).toBe(0);
        expect(has(view, TermsStep)).toBe(true);
    });

    it('keeps credentials and keys out of the rendered tree, storage and the console', async () => {
        const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
            vi.spyOn(console, level).mockImplementation(() => undefined),
        );
        certFlow(() => json(status('plan')));
        const { view } = await mount();
        await login(view);
        const everything = [dump(view), JSON.stringify(logs.flatMap((spy) => spy.mock.calls))].join('\n');
        for (const secret of [FAKE_PASSWORD, FAKE_ID]) expect(everything).not.toContain(secret);
        for (const store of [local, session]) {
            expect(store.setItem).not.toHaveBeenCalled();
            expect(store.getItem).not.toHaveBeenCalled();
        }
    });

    it('does not use a wizard-level cancel while a request is running', async () => {
        let release!: () => void;
        serve({
            'GET status': () => json(status('plan')),
            'POST plan': () => new Promise<Response>((done) => (release = () => done(json(status('key_otp'))))),
        });
        const { view } = await mount();
        expect(buttons(view, '取消申請')).toHaveLength(1);
        await call(view, PlanStep, 'onSubmit', PLAN);
        expect(buttons(view, '取消申請')).toHaveLength(0);
        const statuses = view.root.findAll((node) => node.props.role === 'status');
        expect(statuses.map(textOf)).toContain('正在前往身分驗證…');
        expect(view.root.findAll((node) => node.props.inert !== undefined)).toHaveLength(0);
        await act(async () => release());
        await settle();
        expect(has(view, OtpStep)).toBe(true);
    });
});

describe('creating the key', () => {
    function keyFlow(keyReply: Route) {
        return serve({
            'GET status': () => json(status('key_otp')),
            'POST otp/verify': () => json(status('creating')),
            'POST key': keyReply,
            'POST cancel': () => json({}),
        });
    }
    const verify = async (view: ReactTestRenderer) => {
        await call(view, OtpStep, 'onVerify', '123456');
        await settle();
    };
    const finishButton = (view: ReactTestRenderer, label: string) => buttons(view, label)[0] as ReactTestInstance;

    it('requests the secret once, saves nothing itself and hands the keys over only when the user finishes', async () => {
        const { count, bodyOf } = keyFlow(keyCreated);
        const { view, onKeysReady } = await mount();
        await verify(view);
        expect(count('POST key')).toBe(1);
        expect(bodyOf('POST key')).toEqual({ revealSecret: true });
        expect(onKeysReady).not.toHaveBeenCalled();
        const done = view.root.findByType(DoneStep).props;
        expect(done).toMatchObject({ result: RESULT, revealed: null, saveFailed: false, savedPath: ENV_PATH });
        expect(textOf(view.root)).toContain(ENV_PATH);
        for (const secret of Object.values(KEYS)) expect(dump(view)).not.toContain(secret);
        expect(count('POST cancel')).toBe(0);

        await act(async () => finishButton(view, '進入 Shioaji Pro').props.onClick());
        await settle();
        expect(onKeysReady).toHaveBeenCalledTimes(1);
        expect(onKeysReady).toHaveBeenCalledWith(KEYS, { saveFailed: false });

        // 交給上層之後，精靈手上不再有金鑰：再叫一次完成會失敗，onKeysReady 也不會再被呼叫。
        await expect(view.root.findByType(DoneStep).props.onFinish()).rejects.toThrow();
        expect(onKeysReady).toHaveBeenCalledTimes(1);
        for (const secret of Object.values(KEYS)) expect(dump(view)).not.toContain(secret);
        for (const store of [local, session]) expect(store.setItem).not.toHaveBeenCalled();
    });

    it('hands DoneStep one readiness check bound to the new key\'s account labels', async () => {
        shioaji.fetchAccounts.mockResolvedValue([{ account_type: 'S', account_id: '9A12345678', signed: false }]);
        keyFlow(keyCreated);
        const { view } = await mount();
        await verify(view);
        expect(shioaji.fetchAccounts).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
        expect(textOf(view.root)).toContain('證券 ••••5678：請先簽署證券 API 約定書');
        const check = view.root.findByType(DoneStep).props.checkReadiness as () => Promise<unknown>;
        await expect(check()).resolves.toEqual({ kind: 'pending', items: [{ product: 'stock', label: '證券 ••••5678' }] });

        // 按下完成會換掉 finished，但結果沒變：同一個 check，也不會再查一次。
        await act(async () => finishButton(view, '進入 Shioaji Pro').props.onClick());
        await settle();
        expect(view.root.findByType(DoneStep).props.checkReadiness).toBe(check);
        expect(shioaji.fetchAccounts).toHaveBeenCalledTimes(2);
    });

    it('shows the secret once when saving failed and finishes only after the user confirms', async () => {
        const { count } = keyFlow(() =>
            failure('ONBOARDING_KEY_CAPTURE_FAILED', { result: RESULT, revealed: KEYS }, 500),
        );
        const onLockedChange = vi.fn();
        const wizard = createElement(SinopacWizard, { onKeysReady: vi.fn(), onUseApiKey: vi.fn(), onLockedChange });
        let view!: ReactTestRenderer;
        await act(async () => {
            view = create(wizard);
        });
        views.push(view);
        await settle();
        const onKeysReady = view.root.findByType(SinopacWizard).props.onKeysReady as ReturnType<typeof vi.fn>;
        await verify(view);
        expect(count('POST key')).toBe(1);
        expect(view.root.findByType(DoneStep).props).toMatchObject({ revealed: KEYS, saveFailed: true });
        // 上層靠它鎖住分頁切換，免得 Secret 還沒保存就被切走。
        expect(onLockedChange).toHaveBeenLastCalledWith(true);
        expect(has(view, StoppedStep)).toBe(false);
        expect(finishButton(view, '進入 Shioaji Pro').props.disabled).toBe(true);
        await act(async () => view.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
        expect(onLockedChange).toHaveBeenLastCalledWith(false);
        await act(async () => view.root.findByProps({ 'aria-label': '顯示 Secret Key' }).props.onClick());
        expect(dump(view)).toContain(KEYS.secretKey);
        expect(onKeysReady).not.toHaveBeenCalled();

        await act(async () => finishButton(view, '進入 Shioaji Pro').props.onClick());
        await settle();
        expect(onKeysReady).toHaveBeenCalledTimes(1);
        expect(onKeysReady).toHaveBeenCalledWith(KEYS, { saveFailed: true });
        for (const secret of Object.values(KEYS)) expect(dump(view)).not.toContain(secret);
        expect(view.root.findByType(DoneStep).props.revealed).toBeNull();
    });

    it('keeps the keys for a retry when the parent fails to start', async () => {
        keyFlow(keyCreated);
        const onKeysReady = vi.fn().mockRejectedValueOnce(new Error('start failed')).mockResolvedValue(undefined);
        const { view } = await mount(onKeysReady);
        await verify(view);
        await act(async () => finishButton(view, '進入 Shioaji Pro').props.onClick());
        await settle();
        expect(textOf(view.root)).toContain('沒有完成');
        await act(async () => finishButton(view, '進入 Shioaji Pro').props.onClick());
        await settle();
        expect(onKeysReady).toHaveBeenCalledTimes(2);
        expect(onKeysReady).toHaveBeenLastCalledWith(KEYS, { saveFailed: false });
    });

    it('in the browser, does not ask for the secret: the dev server already wrote .env', async () => {
        tauri.on = false;
        const { count, bodyOf } = keyFlow(() => json({ result: RESULT, revealed: null, envPath: ENV_PATH }));
        const { view, onKeysReady } = await mount();
        await verify(view);
        expect(count('POST key')).toBe(1);
        expect(bodyOf('POST key')).toEqual({ revealSecret: false });
        expect(view.root.findByType(DoneStep).props).toMatchObject({ revealed: null, saveFailed: false, savedPath: ENV_PATH });
        expect(has(view, StoppedStep)).toBe(false);
        await act(async () => finishButton(view, '進入 Shioaji Pro').props.onClick());
        await settle();
        expect(onKeysReady).toHaveBeenCalledExactlyOnceWith(null, { saveFailed: false });
    });

    it('on the desktop, stops when the server saved the key but returned no secret to start with', async () => {
        keyFlow(() => json({ result: RESULT, revealed: null, envPath: ENV_PATH }));
        const { view } = await mount();
        await verify(view);
        expect(view.root.findByType(StoppedStep).props.code).toBe('ONBOARDING_KEY_CAPTURE_FAILED');
    });

    describe('when the key response is lost', () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
        });
        // 驗證碼通過後 /key 的回應遺失；之後的進度由 later 決定。
        function lostKey(later: () => OnboardingStatus) {
            let dropped = false;
            return serve({
                'GET status': () => json(dropped ? later() : status('key_otp')),
                'POST otp/verify': () => json(status('creating')),
                'POST key': () => {
                    dropped = true;
                    throw new TypeError('network');
                },
                'POST cancel': () => json({}),
            });
        }
        const wait = (ms: number) =>
            act(async () => {
                await vi.advanceTimersByTimeAsync(ms);
            });

        it('waits until the server leaves creating, then stops with KEY_UNSURE without resending or cancelling', async () => {
            let creating = true;
            const { count } = lostKey(() => (creating ? status('creating', { keyRequested: true }) : status('login')));
            const { view, onKeysReady } = await mount();
            await verify(view);
            expect(has(view, StoppedStep)).toBe(false);
            expect(textOf(view.root)).toContain('正在建立 API Key…');
            await wait(3000);
            expect(has(view, StoppedStep)).toBe(false);
            creating = false;
            await wait(3000);
            await settle();
            expect(view.root.findByType(StoppedStep).props.code).toBe('KEY_UNSURE');
            expect(count('POST key')).toBe(1);
            expect(count('POST cancel')).toBe(0);
            expect(onKeysReady).not.toHaveBeenCalled();
        });

        it('cancels quietly when the server says the create request never arrived', async () => {
            const { count } = lostKey(() => status('creating', { keyRequested: false }));
            const { view } = await mount();
            await verify(view);
            await wait(3000);
            await settle();
            expect(view.root.findByType(StoppedStep).props.code).toBe('KEY_UNSURE');
            expect(count('POST key')).toBe(1);
            expect(count('POST cancel')).toBe(1);
        });
    });

    it('stops with the server code when the key request is refused', async () => {
        keyFlow(() => failure('ONBOARDING_KEY_LIMIT_REACHED'));
        const { view } = await mount();
        await verify(view);
        expect(view.root.findByType(StoppedStep).props.code).toBe('ONBOARDING_KEY_LIMIT_REACHED');
    });

    it('stops with its own copy and a restart when none of the chosen account types is on the broker form', async () => {
        keyFlow(() => failure('ONBOARDING_NO_ACCOUNT_TYPE', {}, 400));
        const { view } = await mount();
        await verify(view);
        expect(view.root.findByType(StoppedStep).props.code).toBe('ONBOARDING_NO_ACCOUNT_TYPE');
        expect(textOf(view.root)).toContain('這個帳號沒有你選的帳戶類型');
        expect(textOf(view.root)).not.toContain('輸入內容的格式不正確');
        await act(async () => (buttons(view, '重新開始')[0] as ReactTestInstance).props.onClick());
        expect(has(view, LoginStep)).toBe(true);
    });

    it('offers no way to leave while the create request is in flight', async () => {
        let release!: () => void;
        const { count } = keyFlow(() => new Promise<Response>((done) => (release = () => done(keyCreated()))));
        const { view } = await mount();
        await act(async () => {
            void view.root.findByType(OtpStep).props.onVerify('123456');
        });
        await settle();
        expect(count('POST key')).toBe(1);
        expect(textOf(view.root)).toContain('正在建立 API Key…');
        expect(buttons(view, '取消申請')).toHaveLength(0);
        await act(async () => release());
        await settle();
        expect(has(view, DoneStep)).toBe(true);
    });

    it('does not create a key when the wizard is unmounted before the OTP check returns', async () => {
        let release!: () => void;
        const { count } = serve({
            'GET status': () => json(status('key_otp')),
            'POST otp/verify': () => new Promise<Response>((done) => (release = () => done(json(status('creating'))))),
            'POST key': keyCreated,
            'POST cancel': () => json({}),
        });
        const { view } = await mount();
        await act(async () => {
            void view.root.findByType(OtpStep).props.onVerify('123456');
        });
        await act(async () => view.unmount());
        await act(async () => release());
        await settle();
        expect(count('POST key')).toBe(0);
    });
});

describe('leaving', () => {
    it('cancels the server flow and returns to the login form after the user confirms', async () => {
        const { count } = serve({ 'GET status': () => json(status('plan')), 'POST cancel': () => json({}) });
        const { view } = await mount();
        await act(async () => (buttons(view, '取消申請')[0] as ReactTestInstance).props.onClick());
        expect(textOf(view.root)).toContain('要取消申請嗎？');
        await act(async () => (buttons(view, '繼續')[0] as ReactTestInstance).props.onClick());
        expect(count('POST cancel')).toBe(0);
        await act(async () => (buttons(view, '取消申請')[0] as ReactTestInstance).props.onClick());
        await act(async () => (buttons(view, '取消申請')[0] as ReactTestInstance).props.onClick());
        await settle();
        expect(count('POST cancel')).toBe(1);
        expect(has(view, LoginStep)).toBe(true);
        expect(has(view, PlanStep)).toBe(false);
    });

    it('closes the remote browser when unmounted with a flow in progress, but not when idle', async () => {
        const active = serve({ 'GET status': () => json(status('plan')), 'POST cancel': () => json({}) });
        const first = await mount();
        await act(async () => first.view.unmount());
        await settle();
        expect(active.count('POST cancel')).toBe(1);

        const idle = serve({ 'GET status': () => json(status('login')), 'POST cancel': () => json({}) });
        const second = await mount();
        await act(async () => second.view.unmount());
        await settle();
        expect(idle.count('POST cancel')).toBe(0);
    });

    it('survives StrictMode double mounting without cancelling the restored flow', async () => {
        const { count } = serve({ 'GET status': () => json(status('plan')), 'POST cancel': () => json({}) });
        const { view } = await mount(vi.fn(), true);
        expect(has(view, PlanStep)).toBe(true);
        expect(count('POST cancel')).toBe(0);
    });

    it('restarts from the stopped screen and lets the user choose the guided way', async () => {
        serve({ 'GET status': () => json(status('login')) });
        const onUseApiKey = vi.fn();
        const { view } = await mount(vi.fn(), false, onUseApiKey);
        await call(view, LoginStep, 'onManual');
        expect(view.root.findByType(StoppedStep).props.code).toBe('MANUAL');
        expect(view.root.findAllByType('ol')).toHaveLength(0);
        await call(view, StoppedStep, 'onRestart');
        expect(has(view, LoginStep)).toBe(true);
        await call(view, LoginStep, 'onManual');
        await call(view, StoppedStep, 'onClose');
        expect(onUseApiKey).toHaveBeenCalledOnce();
        expect(has(view, StoppedStep)).toBe(true);
    });
});

describe('error handling', () => {
    it('shows a fixed message and goes back to the login form after a wrong password', async () => {
        serve({
            'GET status': () => json(status('login')),
            'POST start': () => failure('ONBOARDING_BAD_CREDENTIALS', {}, 401),
        });
        const { view } = await mount();
        await call(view, LoginStep, 'onSubmit', { idNumber: FAKE_ID, password: FAKE_PASSWORD });
        await settle();
        expect(textOf(view.root)).toContain('永豐金證券回應帳號或密碼錯誤');
        expect(textOf(view.root)).not.toContain('server text');
        expect(has(view, LoginStep)).toBe(true);
        expect(dump(view)).not.toContain(FAKE_PASSWORD);
    });

    it('reads the progress again instead of resending when the connection drops during login', async () => {
        const { count } = serve({
            'GET status': () => json(status('login')),
            'POST start': () => {
                throw new TypeError('network');
            },
        });
        const { view } = await mount();
        await call(view, LoginStep, 'onSubmit', { idNumber: FAKE_ID, password: FAKE_PASSWORD });
        await settle();
        expect(count('POST start')).toBe(1);
        expect(count('GET status')).toBe(2);
        expect(textOf(view.root)).toContain('不會自動重試');
    });
});

describe('busy, status and focus', () => {
    it('shows one status line and a step-1 skeleton while the progress loads', async () => {
        let release!: () => void;
        serve({ 'GET status': () => new Promise<Response>((done) => (release = () => done(json(status('login'))))) });
        const { view } = await mount();
        const statuses = () => view.root.findAll((node) => node.props.role === 'status');
        expect(statuses().map(textOf)).toEqual(['正在讀取目前的進度…']);
        expect(has(view, LoginStep)).toBe(false);
        await act(async () => release());
        await settle();
        expect(statuses()).toHaveLength(0);
        expect(has(view, LoginStep)).toBe(true);
    });

    it('moves focus to the error and scrolls it into view after a failed request', async () => {
        const focus = vi.fn();
        const scrollIntoView = vi.fn();
        serve({
            'GET status': () => json(status('login')),
            'POST start': () => failure('ONBOARDING_BAD_CREDENTIALS', {}, 401),
        });
        let view!: ReactTestRenderer;
        await act(async () => {
            view = create(createElement(SinopacWizard, { onKeysReady: vi.fn(), onUseApiKey: vi.fn() }), {
                createNodeMock: (element) =>
                    (element.props as { role?: string }).role === 'alert' ? { focus, scrollIntoView } : { focus, closest: () => null },
            });
        });
        views.push(view);
        await settle();
        focus.mockClear();
        // 不等待整個 act：讓「處理中」與「處理完」分成兩次 commit，如同真實的網路請求。
        await act(async () => {
            void view.root.findByType(LoginStep).props.onSubmit({ idNumber: FAKE_ID, password: FAKE_PASSWORD });
        });
        await settle();
        const alert = view.root.findAll((node) => node.props.role === 'alert' && node.props.tabIndex === -1);
        expect(alert).toHaveLength(1);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
        expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    });
});

describe('mock leftovers', () => {
    const root = resolve(__dirname, '../../..');
    const walk = (dir: string): string[] =>
        readdirSync(dir, { recursive: true })
            .map((name) => resolve(dir, String(name)))
            .filter((file) => /\.tsx?$/.test(file) && !/\.test\.|test-helpers|fake-site/.test(file));

    it('has no mock client and nothing that fakes keys, OTP targets or delays', () => {
        expect(existsSync(resolve(root, 'src/lib/sinopac-onboarding/client.ts'))).toBe(false);
        const files = [
            ...walk(resolve(root, 'src/components/onboarding')),
            ...walk(resolve(root, 'src/lib/sinopac-onboarding')),
            ...walk(resolve(root, 'scripts/sinopac-onboarding')),
        ];
        expect(files.length).toBeGreaterThan(10);
        const forbidden = /Math\.random|genApiKey|genSecKey|defaultOtpTargets|maskIdNumber|INITIAL_PLAN|INITIAL_WIZARD_STATE|sinopac-onboarding\/client/;
        const hits = files.filter((file) => forbidden.test(readFileSync(file, 'utf8')));
        expect(hits).toEqual([]);
        const wizard = readFileSync(resolve(__dirname, 'sinopac-wizard.tsx'), 'utf8');
        expect(wizard).not.toMatch(/setTimeout\(\w+,\s*\d{3}\)/);
    });
});
