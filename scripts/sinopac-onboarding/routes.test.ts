// routes.ts 與 vite-plugin-sinopac-onboarding.ts 的測試：真的 http server + 真的 service + 假 gateway，不碰真實網站。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer as createViteServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_ERROR_CODES } from '../../src/lib/sinopac-onboarding/types';
import {
  buildEnvContent,
  saveKeysToEnv,
  vitePluginSinopacOnboarding,
  type EnvWatcher,
} from '../vite-plugin-sinopac-onboarding';
import { OnboardingDriverError } from './driver';
import {
  createOnboardingRouteHandler,
  INVALID_REQUEST_MESSAGE,
  isLoopbackAddress,
  isLoopbackHost,
  ONBOARDING_API_PREFIX,
} from './routes';
import {
  createInMemoryOnboardingRepository,
  createOnboardingService,
  OnboardingError,
  type OnboardingRepository,
  type OnboardingService,
} from './service';
import { createFakeGateway, credentials, SENTINEL, validPlan } from './service-fakes';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await delay(25);
  }
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void,
) => unknown;

const openServers: http.Server[] = [];

async function listen(handler: Handler) {
  const nextCalls: string[] = [];
  const server = http.createServer((req, res) => {
    void handler(req, res, () => {
      nextCalls.push(`${req.method} ${req.url}`);
      res.statusCode = 599;
      res.end('next');
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, nextCalls };
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function request(
  base: string,
  pathname: string,
  init: { method?: string; body?: string | Uint8Array; contentType?: string | null; origin?: string } = {},
): Promise<Reply> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.contentType) headers['Content-Type'] = init.contentType;
  if (init.origin) headers.Origin = init.origin;
  const response = await fetch(base + pathname, { method, headers, body: init.body });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** 精靈端點：status 用 GET，其餘 POST + JSON。raw 直接當本文送出。 */
function call(base: string, name: string, body?: unknown, raw?: string) {
  const method = name === 'status' ? 'GET' : 'POST';
  return request(base, `${ONBOARDING_API_PREFIX}/${name}`, {
    method,
    contentType: method === 'POST' ? 'application/json' : null,
    body: method === 'POST' ? (raw ?? (body === undefined ? '{}' : JSON.stringify(body))) : undefined,
  });
}

const NO_SECRETS = Object.values(SENTINEL);
function expectNoSecrets(...texts: string[]) {
  for (const text of texts) for (const secret of NO_SECRETS) expect(text).not.toContain(secret);
}

const FIXED_400 = {
  success: false,
  error: { code: 'ONBOARDING_INVALID_REQUEST', message: INVALID_REQUEST_MESSAGE },
};

const futureDate = () => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
const plan = () => ({ ...validPlan(), expiresOn: futureDate() });

let logged: string[] = [];
let tempDirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinopac-routes-'));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  logged = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openServers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('延後載入', () => {
  it('config 會 bundle 到的檔案沒有 bare value import（否則 puppeteer 會在載入 config 時就被 import）', () => {
    const IMPORT = /^[ \t]*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/gm;
    const queue = [
      path.join(DIR, '..', 'vite-plugin-sinopac-onboarding.ts'),
      path.join(DIR, 'routes.ts'),
      path.join(DIR, 'service.ts'),
      path.join(DIR, 'gateway.ts'),
    ];
    const seen = new Set<string>();
    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT)) {
        const specifier = match[1]!;
        if (specifier.startsWith('.')) queue.push(path.resolve(path.dirname(file), `${specifier}.ts`));
        else if (!specifier.startsWith('node:')) violations.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
    // 走訪確實涵蓋到 driver、parsing 與共用型別，不是只看了入口。
    const names = [...seen].map((file) => path.basename(file));
    expect(names).toEqual(expect.arrayContaining(['sinopac-driver.ts', 'parsing.ts', 'types.ts']));
  });
});

describe('REST 邊界（真的 http server + 真的 service + 假 gateway）', () => {
  let fake: ReturnType<typeof createFakeGateway>;
  let saved: { apiKey: string; secretKey: string }[];
  let loads: number;

  async function start(options: {
    service?: () => OnboardingService;
    getService?: () => Promise<OnboardingService>;
    saveCredentials?: (keys: { apiKey: string; secretKey: string }) => Promise<void>;
    maxBodyBytes?: number;
    envPath?: string;
  } = {}) {
    const real = createOnboardingService({
      gateway: fake.gateway,
      saveCredentials:
        options.saveCredentials ??
        (async (keys) => {
          saved.push(keys);
        }),
    });
    const handler = createOnboardingRouteHandler({
      getService:
        options.getService ??
        (async () => {
          loads += 1;
          return options.service ? options.service() : real;
        }),
      maxBodyBytes: options.maxBodyBytes,
      envPath: options.envPath,
    });
    return listen(handler);
  }

  beforeEach(() => {
    fake = createFakeGateway();
    saved = [];
    loads = 0;
  });

  const valid: Record<string, unknown> = {
    start: credentials,
    relogin: credentials,
    birthday: { birthday: '19900101' },
    'otp/send': { purpose: 'cert', channel: 'sms', targetIndex: 0 },
    'otp/verify': { purpose: 'cert', code: 'ABCD1234' },
    terms: { accepted: true },
    plan: plan(),
    key: { revealSecret: true },
  };

  it('每個 POST 端點：多餘或缺少的 key、非物件本文都回固定 400，不載入 service、不回顯輸入', async () => {
    const { base } = await start();
    for (const [name, body] of Object.entries(valid)) {
      const keys = Object.keys(body as object);
      const variants: [string, string][] = [
        ['extra key', JSON.stringify({ ...(body as object), extra: SENTINEL.otp })],
        ['missing key', JSON.stringify(Object.fromEntries(Object.entries(body as object).slice(1)))],
        ['null', 'null'],
        ['array', JSON.stringify([body])],
        ['string', JSON.stringify(SENTINEL.password)],
        ['number', '42'],
        ['malformed json', `{"${keys[0]}": ${SENTINEL.password}`],
        ['empty body', ''],
      ];
      for (const [label, raw] of variants) {
        const reply = await call(base, name, undefined, raw);
        expect([name, label, reply.status]).toEqual([name, label, 400]);
        expect(reply.json).toEqual(FIXED_400);
        expectNoSecrets(reply.text);
        expect(reply.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(loads).toBe(0);
    expect(fake.state.launches).toBe(0);
    expectNoSecrets(logged.join('\n'));
  });

  it('固定 400 的訊息與 service 的固定文案表一致', () => {
    expect(INVALID_REQUEST_MESSAGE).toBe(new OnboardingError('ONBOARDING_INVALID_REQUEST', 400).message);
  });

  it('欄位型別與範圍：每個不合法值都回固定 400', async () => {
    const { base } = await start();
    const bad: [string, unknown][] = [
      ['start', { ...credentials, idNumber: 'not-an-id' }],
      ['start', { ...credentials, idNumber: 'A1' + '0'.repeat(20) }],
      ['start', { ...credentials, idNumber: 42 }],
      ['start', { ...credentials, password: '' }],
      ['start', { ...credentials, password: 'x'.repeat(129) }],
      ['start', { ...credentials, password: 123456 }],
      ['relogin', { ...credentials, idNumber: 'Z088776655' }],
      ['birthday', { birthday: '1990-01-01' }],
      ['birthday', { birthday: '1990010' }],
      ['birthday', { birthday: '199001011' }],
      ['birthday', { birthday: '19900101\n' }],
      ['birthday', { birthday: 19900101 }],
      ['otp/send', { ...(valid['otp/send'] as object), purpose: 'both' }],
      ['otp/send', { ...(valid['otp/send'] as object), channel: 'voice' }],
      ['otp/send', { ...(valid['otp/send'] as object), targetIndex: 21 }],
      ['otp/send', { ...(valid['otp/send'] as object), targetIndex: -1 }],
      ['otp/send', { ...(valid['otp/send'] as object), targetIndex: 1.5 }],
      ['otp/send', { ...(valid['otp/send'] as object), targetIndex: '0' }],
      ['otp/verify', { purpose: 'cert', code: 'abc' }],
      ['otp/verify', { purpose: 'cert', code: 'a'.repeat(13) }],
      ['otp/verify', { purpose: 'cert', code: 'ab-cd' }],
      ['otp/verify', { purpose: 'cert', code: 123456 }],
      ['otp/verify', { purpose: 'sms', code: 'ABCD1234' }],
      ['terms', { accepted: false }],
      ['terms', { accepted: 'true' }],
      ['terms', { accepted: 1 }],
      ['key', { revealSecret: 'yes' }],
      ['key', { revealSecret: 1 }],
      ['key', { revealSecret: null }],
      ['plan', { ...plan(), name: 'n'.repeat(101) }],
      ['plan', { ...plan(), expiresOn: '2'.repeat(21) }],
      ['plan', { ...plan(), accountTypes: ['stock', 'futures', 'overseas', 'stock'] }],
      ['plan', { ...plan(), accountTypes: ['crypto'] }],
      ['plan', { ...plan(), permissions: { quote: true, account: true, trade: false } }],
      ['plan', { ...plan(), permissions: { quote: true, account: true, trade: 'no', prod: false } }],
      ['plan', { ...plan(), permissions: { ...plan().permissions, extra: true } }],
      ['plan', { ...plan(), ip: { mode: 'any', addresses: [] } }],
      ['plan', { ...plan(), ip: { mode: 'restricted', addresses: Array(21).fill('1.1.1.1') } }],
      ['plan', { ...plan(), ip: { mode: 'restricted', addresses: ['1'.repeat(46)] } }],
      ['plan', { ...plan(), ip: { mode: 'restricted', addresses: [42] } }],
      ['plan', { ...plan(), ip: { mode: 'restricted', addresses: [], extra: 1 } }],
    ];
    for (const [name, body] of bad) {
      const reply = await call(base, name, body);
      expect([name, JSON.stringify(body).slice(0, 60), reply.status]).toEqual([
        name,
        JSON.stringify(body).slice(0, 60),
        400,
      ]);
      expect(reply.json).toEqual(FIXED_400);
    }
    expect(loads).toBe(0);
  });

  it('身分證字號去空白並轉大寫後才交給 service；本文用新物件，不夾帶多餘欄位', async () => {
    fake.state.loginOutcome = 'logged_in';
    const { base } = await start();
    const reply = await call(base, 'start', { idNumber: ' z188776655 ', password: SENTINEL.password });
    expect(reply.status).toBe(200);
    expect(fake.received.login).toEqual([{ idNumber: 'Z188776655', password: SENTINEL.password }]);
  });

  it('POST 一律要求 JSON Content-Type（含 /cancel），缺少或不是 JSON 都回固定 400 且不碰 service', async () => {
    const { base } = await start();
    const url = `${ONBOARDING_API_PREFIX}/cancel`;
    const json = new TextEncoder().encode('{}');
    for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp', 'multipart/form-data']) {
      const reply = await request(base, url, { method: 'POST', contentType, body: json });
      expect([contentType, reply.status]).toEqual([contentType, 400]);
      expect(reply.json).toEqual(FIXED_400);
    }
    expect(loads).toBe(0);
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/vnd.api+json']) {
      const reply = await request(base, url, { method: 'POST', contentType, body: json });
      expect([contentType, reply.status]).toEqual([contentType, 200]);
    }
  });

  it('本文上限以位元組計算：剛好等於上限通過，多 1 位元組就是固定 400', async () => {
    const body = JSON.stringify({ idNumber: SENTINEL.idNumber, password: '密'.repeat(20) });
    const bytes = Buffer.byteLength(body);
    expect(bytes).toBeGreaterThan(body.length + 20); // 多位元組字元：位元組數遠大於字元數
    const exact = await start({ maxBodyBytes: bytes });
    expect((await call(exact.base, 'start', undefined, body)).status).toBe(200);
    fake = createFakeGateway();
    const tight = await start({ maxBodyBytes: bytes - 1 });
    const reply = await call(tight.base, 'start', undefined, body);
    expect(reply.status).toBe(400);
    expect(reply.json).toEqual(FIXED_400);
    expect(fake.state.launches).toBe(0);
  });

  it('no-store 套用在 200、400、404、405、409、500 所有回應', async () => {
    fake.state.loginOutcome = 'logged_in';
    const { base } = await start();
    const replies = [
      await call(base, 'status'),
      await call(base, 'start', { ...credentials, idNumber: 'x' }),
      await request(base, `${ONBOARDING_API_PREFIX}/nope`),
      await request(base, `${ONBOARDING_API_PREFIX}/start`),
      await call(base, 'birthday', { birthday: '19900101' }),
    ];
    expect(replies.map((r) => r.status)).toEqual([200, 400, 404, 405, 409]);
    const broken = await listen(
      createOnboardingRouteHandler({ getService: () => Promise.reject(new Error('boom')) }),
    );
    replies.push(await call(broken.base, 'status'));
    expect(replies[5]!.status).toBe(500);
    for (const reply of replies) {
      expect(reply.headers.get('cache-control')).toBe('no-store');
      expect(reply.headers.get('content-type')).toContain('application/json');
    }
  });

  it('精靈前綴底下的請求絕不 next()（否則會被 /api proxy 轉給 sidecar）；前綴以外一律 next()', async () => {
    const { base, nextCalls } = await start();
    for (const pathname of [
      ONBOARDING_API_PREFIX,
      `${ONBOARDING_API_PREFIX}/`,
      `${ONBOARDING_API_PREFIX}/unknown`,
      `${ONBOARDING_API_PREFIX}/status/`,
      `${ONBOARDING_API_PREFIX}/otp`,
      `${ONBOARDING_API_PREFIX}/__proto__`,
      `${ONBOARDING_API_PREFIX}/constructor`,
      `${ONBOARDING_API_PREFIX}//status`,
    ]) {
      const reply = await request(base, pathname);
      expect([pathname, reply.status]).toEqual([pathname, 404]);
      expect(reply.json.error.code).toBe('NOT_FOUND');
    }
    expect(nextCalls).toEqual([]);
    for (const pathname of ['/', '/api/save-env', `${ONBOARDING_API_PREFIX}X/status`, '/api/sinopac-onboarding-extra']) {
      expect((await request(base, pathname)).status).toBe(599);
    }
    expect(nextCalls).toHaveLength(4);
  });

  it('Host 不是本機回送位址時回 403（DNS rebinding），不論有沒有帶 Origin', async () => {
    const { base } = await start();
    const { port } = new URL(base);
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: `${ONBOARDING_API_PREFIX}/status`, method: 'GET', headers },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await raw({ Host: 'evil.example' })).toBe(403);
    expect(await raw({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).toBe(403);
    expect(await raw({ Host: `localhost:${port}` })).toBe(200);
    expect(await raw({ Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` })).toBe(200);
    expect(isLoopbackHost('127.0.0.1:5178')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.nip.io:5178')).toBe(false);
  });

  it('連線來源不是本機回送位址時一律拒絕（區網機器自帶 Host: localhost 也一樣）', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of [undefined, '', '192.168.1.5', '::ffff:192.168.1.5', '10.0.0.1', '127.0.0.1.evil'])
      expect(isLoopbackAddress(address)).toBe(false);
  });

  it('帶 Origin 時必須同源：跨站回 403 且不載入 service；同源或沒帶 Origin 照常處理', async () => {
    const { base, nextCalls } = await start();
    for (const origin of ['https://evil.example', 'http://localhost:1', `${base}.evil.example`, 'null']) {
      const get = await request(base, `${ONBOARDING_API_PREFIX}/status`, { origin });
      expect([origin, get.status]).toEqual([origin, 403]);
      expect(get.json).toEqual({
        success: false,
        error: { code: 'ONBOARDING_FORBIDDEN_ORIGIN', message: expect.any(String) },
      });
      const post = await request(base, `${ONBOARDING_API_PREFIX}/start`, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify(credentials),
        origin,
      });
      expect([origin, post.status]).toEqual([origin, 403]);
    }
    expect(loads).toBe(0);
    expect(fake.events).toEqual([]);

    expect((await request(base, `${ONBOARDING_API_PREFIX}/status`, { origin: base })).status).toBe(200);
    const httpsSameHost = base.replace('http://', 'https://');
    expect((await request(base, `${ONBOARDING_API_PREFIX}/status`, { origin: httpsSameHost })).status).toBe(200);
    expect((await request(base, `${ONBOARDING_API_PREFIX}/status`)).status).toBe(200);
    // 前綴以外的路徑不檢查，照常交給下一個 middleware。
    expect((await request(base, '/', { origin: 'https://evil.example' })).status).toBe(599);
    expect(nextCalls).toHaveLength(1);
  });

  it('方法不符回 405 並帶 Allow；查詢字串不影響路由', async () => {
    const { base } = await start();
    const cases: [string, string, string][] = [
      ['GET', 'start', 'POST'],
      ['PUT', 'plan', 'POST'],
      ['DELETE', 'cancel', 'POST'],
      ['POST', 'status', 'GET'],
    ];
    for (const [method, name, allow] of cases) {
      const reply = await request(base, `${ONBOARDING_API_PREFIX}/${name}`, {
        method,
        contentType: method === 'GET' ? null : 'application/json',
        body: method === 'GET' ? undefined : '{}',
      });
      expect([method, name, reply.status]).toEqual([method, name, 405]);
      expect(reply.headers.get('allow')).toBe(allow);
    }
    expect((await request(base, `${ONBOARDING_API_PREFIX}/status?x=1`)).status).toBe(200);
    expect(loads).toBe(1);
  });

  it('錯誤碼 -> HTTP 狀態與原版一致；固定文案，不轉述 driver 的原始訊息或機敏值', async () => {
    const expected: Record<(typeof ONBOARDING_ERROR_CODES)[number], number> = {
      ONBOARDING_BAD_CREDENTIALS: 400,
      ONBOARDING_ACCOUNT_LOCKED: 429,
      ONBOARDING_OTP_INVALID: 400,
      ONBOARDING_OTP_EXPIRED: 409,
      ONBOARDING_SESSION_EXPIRED: 409,
      ONBOARDING_BROWSER_BUSY: 409,
      ONBOARDING_BLOCKED_BY_SITE: 502,
      ONBOARDING_RECAPTCHA_CHALLENGE: 502,
      ONBOARDING_QUOTA_EXHAUSTED: 429,
      ONBOARDING_KEY_LIMIT_REACHED: 409,
      ONBOARDING_SITE_CHANGED: 502,
      ONBOARDING_KEY_CAPTURE_FAILED: 502,
      ONBOARDING_INVALID_REQUEST: 400,
      ONBOARDING_INVALID_STATE: 409,
      ONBOARDING_FORBIDDEN_ORIGIN: 403,
      ONBOARDING_NO_ACCOUNT_TYPE: 400,
    };
    expect(Object.keys(expected).sort()).toEqual([...ONBOARDING_ERROR_CODES].sort());
    for (const code of ONBOARDING_ERROR_CODES) {
      fake = createFakeGateway();
      fake.failures.set('login', new OnboardingDriverError(code, `leak ${SENTINEL.password} ${SENTINEL.otp}`));
      const { base } = await start();
      const reply = await call(base, 'start', credentials);
      expect([code, reply.status]).toEqual([code, expected[code]]);
      expect(reply.json.success).toBe(false);
      expect(reply.json.error.code).toBe(code);
      expect(typeof reply.json.error.message).toBe('string');
      expect(reply.text).not.toContain('leak');
      expectNoSecrets(reply.text);
    }
    expect(logged.join('\n')).not.toContain('leak');
    expectNoSecrets(logged.join('\n'));
  });

  it('OnboardingError：Retry-After 取進位整數；extra 併入 error 但不能蓋掉 code／message', async () => {
    const throwing = (error: Error) =>
      ({ status: async () => Promise.reject(error) }) as unknown as OnboardingService;
    const locked = await start({
      service: () => throwing(new OnboardingError('ONBOARDING_ACCOUNT_LOCKED', 429, undefined, 90.2)),
    });
    const lockedReply = await call(locked.base, 'status');
    expect(lockedReply.status).toBe(429);
    expect(lockedReply.headers.get('retry-after')).toBe('91');

    const extra = await start({
      service: () =>
        throwing(
          new OnboardingError('ONBOARDING_INVALID_REQUEST', 400, '固定訊息', undefined, {
            fields: { name: '請輸入名稱。' },
            code: 'HACK',
            message: 'HACK',
          }),
        ),
    });
    const extraReply = await call(extra.base, 'status');
    expect(extraReply.status).toBe(400);
    expect(extraReply.json).toEqual({
      success: false,
      error: {
        code: 'ONBOARDING_INVALID_REQUEST',
        message: '固定訊息',
        fields: { name: '請輸入名稱。' },
      },
    });
    expect(extraReply.headers.get('retry-after')).toBeNull();
  });

  it('以形狀辨識 OnboardingError（不靠 instanceof），狀態不合理則視為內部錯誤', async () => {
    class Lookalike extends Error {
      name = 'OnboardingError';
      code = 'ONBOARDING_OTP_EXPIRED';
      status = 409;
    }
    class BadStatus extends Error {
      name = 'OnboardingError';
      code = 'ONBOARDING_OTP_EXPIRED';
      status = 200;
    }
    const failing = (error: Error) => ({ status: async () => Promise.reject(error) }) as unknown as OnboardingService;
    expect((await call((await start({ service: () => failing(new Lookalike('shape')) })).base, 'status')).status).toBe(409);
    expect((await call((await start({ service: () => failing(new BadStatus('shape')) })).base, 'status')).status).toBe(500);
  });

  it('未預期的錯誤（含 service 載入失敗）回固定 500，log 只記錯誤名稱', async () => {
    const leak = `LEAK-${SENTINEL.password}`;
    const loadFailure = await listen(
      createOnboardingRouteHandler({ getService: () => Promise.reject(new TypeError(leak)) }),
    );
    const thrown = await start({
      service: () => ({ status: async () => Promise.reject(new RangeError(leak)) }) as unknown as OnboardingService,
    });
    const nonError = await start({
      service: () => ({ status: async () => Promise.reject(leak) }) as unknown as OnboardingService,
    });
    const replies = [
      await call(loadFailure.base, 'status'),
      await call(thrown.base, 'status'),
      await call(nonError.base, 'status'),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(500);
      expect(reply.json).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: '發生未預期的錯誤，請稍後再試。' },
      });
      expect(reply.text).not.toContain('LEAK');
    }
    const output = logged.join('\n');
    expect(output).toContain('sinopac_onboarding_internal_error');
    expect(output).toContain('TypeError');
    expect(output).toContain('RangeError');
    expect(output).not.toContain('LEAK');
  });

  it('方案欄位錯誤：service 的 400 帶 fields 原樣轉出；交易＋無限制 IP 則可以送出', async () => {
    fake.state.loginOutcome = 'logged_in';
    const { base } = await start();
    expect((await call(base, 'start', credentials)).status).toBe(200);
    const reply = await call(base, 'plan', {
      ...plan(),
      ip: { mode: 'restricted', addresses: ['999.1.1.1'] },
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('ONBOARDING_INVALID_REQUEST');
    expect(Object.keys(reply.json.error.fields)).toEqual(['ip']);
    expect(fake.count('openKeyIdentityDialog')).toBe(0);

    const trade = await call(base, 'plan', {
      ...plan(),
      permissions: { quote: true, account: true, trade: true, prod: false },
      ip: { mode: 'unlimited', addresses: [] },
    });
    expect(trade.status).toBe(200);
    expect(trade.json.step).toBe('key_otp');
    expect(fake.count('openKeyIdentityDialog')).toBe(1);
  });

  async function toCreatingStep(base: string) {
    fake.state.loginOutcome = 'logged_in';
    return [
      await call(base, 'start', credentials),
      await call(base, 'plan', plan()),
      await call(base, 'otp/send', { purpose: 'key', channel: 'sms', targetIndex: 0 }),
      await call(base, 'otp/verify', { purpose: 'key', code: SENTINEL.otp }),
    ];
  }

  it('既有憑證的完整流程：金鑰只出現在 /key 回應與存檔，status 回到 login', async () => {
    const { base } = await start();
    const steps = await toCreatingStep(base);
    expect(steps.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(steps.map((r) => r.json.step)).toEqual(['plan', 'key_otp', 'key_otp', 'creating']);
    for (const step of steps) expectNoSecrets(step.text.replaceAll(SENTINEL.otp, ''));

    const key = await call(base, 'key', { revealSecret: true });
    expect(key.status).toBe(200);
    expect(key.json).toEqual({
      result: expect.objectContaining({ apiKeyLast4: 'ABCD' }),
      revealed: { apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey },
    });
    expect(key.json).not.toHaveProperty('envPath');
    expect(saved).toEqual([{ apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey }]);
    expect(fake.open.size).toBe(0);
    expect((await call(base, 'status')).json.step).toBe('login');
    expectNoSecrets(logged.join('\n'));
  });

  it('revealSecret:false：存檔照做，回應不含金鑰', async () => {
    const { base } = await start();
    await toCreatingStep(base);
    const key = await call(base, 'key', { revealSecret: false });
    expect(key.status).toBe(200);
    expect(key.json.revealed).toBeNull();
    expect(saved).toHaveLength(1);
    expectNoSecrets(key.text);
  });

  it('存檔失敗：不論 revealSecret，金鑰只出現在這一個 502 的本體，不進 log', async () => {
    for (const reveal of [true, false]) {
      fake = createFakeGateway();
      const { base } = await start({
        saveCredentials: async () => {
          throw new Error(`disk full ${SENTINEL.secretKey}`);
        },
      });
      await toCreatingStep(base);
      const key = await call(base, 'key', { revealSecret: reveal });
      expect(key.status).toBe(502);
      expect(key.json.error.code).toBe('ONBOARDING_KEY_CAPTURE_FAILED');
      expect(key.text).not.toContain('disk full');
      void reveal;
      expect(key.json.error.revealed).toEqual({ apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey });
      expectNoSecrets(logged.join('\n'));
      logged = [];
    }
  });

  it('有設定 envPath：只有成功的 /key 回應多帶它，其他步驟與任何錯誤回應都不帶', async () => {
    const envPath = '/fake/project/.env';
    const { base } = await start({ envPath });
    const early = await call(base, 'key', { revealSecret: true });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(early.text).not.toContain(envPath);
    const steps = await toCreatingStep(base);
    for (const step of steps) expect(step.text).not.toContain(envPath);

    const key = await call(base, 'key', { revealSecret: false });
    expect(key.status).toBe(200);
    expect(key.json).toEqual({ result: expect.objectContaining({ apiKeyLast4: 'ABCD' }), revealed: null, envPath });
    expect((await call(base, 'status')).text).not.toContain(envPath);
  });

  it('有設定 envPath 但存檔失敗：502 本體不含 envPath', async () => {
    const { base } = await start({
      envPath: '/fake/project/.env',
      saveCredentials: async () => {
        throw new Error('disk full');
      },
    });
    await toCreatingStep(base);
    const key = await call(base, 'key', { revealSecret: true });
    expect(key.status).toBe(502);
    expect(key.text).not.toContain('/fake/project/.env');
    expect(key.json.error).not.toHaveProperty('envPath');
  });

  it('建立金鑰時用戶端中途斷線：請求照樣跑完並存檔', async () => {
    const { base } = await start();
    await toCreatingStep(base);
    const release = fake.hold('createKey', true);
    const controller = new AbortController();
    const aborted = fetch(`${base}${ONBOARDING_API_PREFIX}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revealSecret: true }),
      signal: controller.signal,
    }).catch(() => 'aborted');
    await until(() => fake.count('createKey') === 1);
    controller.abort();
    expect(await aborted).toBe('aborted');
    release();
    await until(() => saved.length === 1);
    expect(saved).toEqual([{ apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey }]);
    await until(() => fake.open.size === 0);
  });
});

describe('.env 存檔（saveKeysToEnv）', () => {
  const keys = { apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey };

  function recordingWatcher(envPath: string) {
    const calls: { op: 'unwatch' | 'add'; path: string; content: string | null }[] = [];
    const snapshot = () => (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null);
    const watcher: EnvWatcher = {
      unwatch(p) {
        calls.push({ op: 'unwatch', path: p, content: snapshot() });
      },
      add(p) {
        calls.push({ op: 'add', path: p, content: snapshot() });
      },
    };
    return { calls, watcher };
  }

  it('.env 不存在：用既有格式建立（SJ_PRODUCTION=false、權限 0600）；順序為 unwatch -> 寫入 -> add', async () => {
    const envPath = path.join(tempDir(), '.env');
    const { calls, watcher } = recordingWatcher(envPath);
    const { resumed } = saveKeysToEnv(keys, { envPath, getWatcher: () => watcher, resumeDelayMs: 0 });
    await resumed;
    const expected = buildEnvContent({ ...keys, production: false });
    expect(fs.readFileSync(envPath, 'utf8')).toBe(expected);
    expect(calls).toEqual([
      { op: 'unwatch', path: envPath, content: null },
      { op: 'add', path: envPath, content: expected },
    ]);
    if (process.platform !== 'win32') expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('.env 已存在：只換 SJ_API_KEY／SJ_SEC_KEY（含 export、重複行、CRLF），其餘逐字不動', async () => {
    const envPath = path.join(tempDir(), '.env');
    const before = [
      '# 開發設定',
      'VITE_DEV_SERVER_PORT=21323',
      'STATSIG_CLIENT_KEY=client-xyz',
      'SJ_API_KEY=old-key',
      'export SJ_SEC_KEY=old-secret',
      'SJ_PRODUCTION=true',
      'SJ_CA_PATH=/keep/Sinopac.pfx',
      'SJ_CA_PASSWD=keep-this',
      '# SJ_API_KEY=commented-stays',
      'SJ_API_KEY_OTHER=stays',
      'SJ_API_KEY=duplicate-old',
      '',
    ].join('\r\n');
    fs.writeFileSync(envPath, before, 'utf8');
    const { calls, watcher } = recordingWatcher(envPath);
    const { resumed } = saveKeysToEnv(keys, { envPath, getWatcher: () => watcher, resumeDelayMs: 0 });
    await resumed;
    const after = fs.readFileSync(envPath, 'utf8');
    expect(after).toBe(
      before
        .replace('SJ_API_KEY=old-key', `SJ_API_KEY=${keys.apiKey}`)
        .replace('export SJ_SEC_KEY=old-secret', `export SJ_SEC_KEY=${keys.secretKey}`)
        .replace('SJ_API_KEY=duplicate-old', `SJ_API_KEY=${keys.apiKey}`),
    );
    expect(after).toContain('VITE_DEV_SERVER_PORT=21323');
    expect(after).toContain('SJ_PRODUCTION=true');
    expect(after).toContain('SJ_CA_PASSWD=keep-this');
    expect(after).toContain('# SJ_API_KEY=commented-stays');
    expect(calls.map((c) => c.op)).toEqual(['unwatch', 'add']);
    expect(calls[0]!.content).toBe(before);
    expect(calls[1]!.content).toBe(after);
  });

  it('原子寫入：既有 .env 的權限收緊成 0600，不留下暫存檔', () => {
    const dir = tempDir();
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'VITE_X=1\n', { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);
    saveKeysToEnv(keys, { envPath, resumeDelayMs: 0 });
    expect(fs.readFileSync(envPath, 'utf8')).toBe(`VITE_X=1\nSJ_API_KEY=${keys.apiKey}\nSJ_SEC_KEY=${keys.secretKey}\n`);
    if (process.platform !== 'win32') expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it.skipIf(process.platform === 'win32')('.env 是 symlink：寫進連結指向的檔案，連結本身保留', () => {
    const dir = tempDir();
    const real = path.join(dir, 'shared.env');
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(real, 'VITE_X=1\n', 'utf8');
    fs.symlinkSync(real, envPath);
    saveKeysToEnv(keys, { envPath, resumeDelayMs: 0 });
    expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(`VITE_X=1\nSJ_API_KEY=${keys.apiKey}\nSJ_SEC_KEY=${keys.secretKey}\n`);
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', 'shared.env']);
  });

  it('.env 已存在但沒有這兩個變數：附加在最後', () => {
    const envPath = path.join(tempDir(), '.env');
    fs.writeFileSync(envPath, 'VITE_X=1', 'utf8');
    saveKeysToEnv(keys, { envPath, resumeDelayMs: 0 });
    expect(fs.readFileSync(envPath, 'utf8')).toBe(`VITE_X=1\nSJ_API_KEY=${keys.apiKey}\nSJ_SEC_KEY=${keys.secretKey}\n`);
  });

  it('含空白或換行的值一律拒絕，不寫檔、不動 watcher', () => {
    const envPath = path.join(tempDir(), '.env');
    const { calls, watcher } = recordingWatcher(envPath);
    for (const bad of ['a b', 'a\nSJ_PRODUCTION=true', '', '  ']) {
      expect(() => saveKeysToEnv({ apiKey: bad, secretKey: 'ok' }, { envPath, getWatcher: () => watcher })).toThrow();
      expect(() => saveKeysToEnv({ apiKey: 'ok', secretKey: bad }, { envPath, getWatcher: () => watcher })).toThrow();
    }
    expect(fs.existsSync(envPath)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('寫入失敗仍會把 .env 加回監看，錯誤原樣丟出；watcher 不存在或拋錯不影響存檔', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'no-such-dir', '.env');
    const { calls, watcher } = recordingWatcher(missing);
    expect(() => saveKeysToEnv(keys, { envPath: missing, getWatcher: () => watcher, resumeDelayMs: 0 })).toThrow();
    await delay(30);
    expect(calls.map((c) => c.op)).toEqual(['unwatch', 'add']);

    const envPath = path.join(dir, '.env');
    saveKeysToEnv(keys, { envPath, resumeDelayMs: 0 });
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`SJ_API_KEY=${keys.apiKey}`);
    const exploding: EnvWatcher = {
      unwatch() {
        throw new Error('closed');
      },
      add() {
        throw new Error('closed');
      },
    };
    const { resumed } = saveKeysToEnv(keys, { envPath, getWatcher: () => exploding, resumeDelayMs: 0 });
    await resumed;
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`SJ_SEC_KEY=${keys.secretKey}`);
  });

  it('透過 /key：存檔發生在回應之前，.env 只多這兩把金鑰，回應與 log 不含金鑰以外的機敏值', async () => {
    const fake = createFakeGateway();
    fake.state.loginOutcome = 'logged_in';
    const envPath = path.join(tempDir(), '.env');
    fs.writeFileSync(envPath, 'VITE_DEV_SERVER_PORT=21323\nSJ_PRODUCTION=false\n', 'utf8');
    const { calls, watcher } = recordingWatcher(envPath);
    const pending: Promise<void>[] = [];
    const service = createOnboardingService({
      gateway: fake.gateway,
      saveCredentials: async (saved) => {
        pending.push(saveKeysToEnv(saved, { envPath, getWatcher: () => watcher, resumeDelayMs: 0 }).resumed);
      },
    });
    const { base } = await listen(createOnboardingRouteHandler({ getService: async () => service }));
    await call(base, 'start', credentials);
    await call(base, 'plan', plan());
    await call(base, 'otp/send', { purpose: 'key', channel: 'sms', targetIndex: 0 });
    await call(base, 'otp/verify', { purpose: 'key', code: SENTINEL.otp });
    const key = await call(base, 'key', { revealSecret: true });
    expect(key.status).toBe(200);
    await Promise.all(pending);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(
      `VITE_DEV_SERVER_PORT=21323\nSJ_PRODUCTION=false\nSJ_API_KEY=${SENTINEL.apiKey}\nSJ_SEC_KEY=${SENTINEL.secretKey}\n`,
    );
    expect(calls.map((c) => c.op)).toEqual(['unwatch', 'add']);
    for (const secret of [SENTINEL.idNumber, SENTINEL.password, SENTINEL.birthday, SENTINEL.otp]) {
      expect(key.text).not.toContain(secret);
      expect(logged.join('\n')).not.toContain(secret);
      expect(fs.readFileSync(envPath, 'utf8')).not.toContain(secret);
    }
  });

  // 升級 Vite 後這個測試若失敗，代表 .env 的重啟邏輯變了，要重新評估 saveKeysToEnv。
  it('Vite 實際行為：saveKeysToEnv 不觸發 .env 重啟，之後手動修改 .env 仍照常重啟', async () => {
    const root = tempDir();
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, 'VITE_DEV_SERVER_PORT=21323\n', 'utf8');
    const infos: string[] = [];
    const logger = createLogger('info', { allowClearScreen: false });
    logger.info = (message) => {
      infos.push(message);
    };
    const restarts = () => infos.filter((line) => line.includes('restarting server')).length;
    const server = await createViteServer({
      root,
      configFile: false,
      customLogger: logger,
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, ws: false },
    });
    try {
      await delay(500); // 等 chokidar 就緒
      // 用正式的預設延遲（1 秒）：macOS 的檔案事件在負載下可能晚於 100ms 才送到。
      const { resumed } = saveKeysToEnv(keys, { envPath, getWatcher: () => server.watcher });
      await resumed;
      await delay(1500);
      expect(fs.readFileSync(envPath, 'utf8')).toContain(`SJ_API_KEY=${keys.apiKey}`);
      expect(restarts()).toBe(0);

      fs.appendFileSync(envPath, '# 手動修改\n');
      await until(() => restarts() === 1, 10_000);
    } finally {
      await server.close();
    }
  }, 30_000);
});

describe('vitePluginSinopacOnboarding', () => {
  afterEach(() => {
    delete (globalThis as { __sinopacOnboardingRepository?: unknown }).__sinopacOnboardingRepository;
  });

  async function mount(envPath: string) {
    const plugin = vitePluginSinopacOnboarding({ envPath });
    const stack: Handler[] = [];
    (plugin.configureServer as (server: unknown) => void)({
      middlewares: { use: (fn: Handler) => stack.push(fn) },
      watcher: undefined,
    });
    expect(stack).toHaveLength(1);
    return listen((req, res, next) => {
      let index = 0;
      const step = (): unknown => {
        const fn = stack[index++];
        return fn ? fn(req, res, step) : next();
      };
      return step();
    });
  }

  it('只在 dev server 套用；舊的 /api/save-env、/api/read-env 已移除，交給下一個 middleware', async () => {
    expect(vitePluginSinopacOnboarding().apply).toBe('serve');
    const envPath = path.join(tempDir(), '.env');
    const { base, nextCalls } = await mount(envPath);
    expect((await request(base, '/api/read-env')).status).toBe(599);
    const save = await request(base, '/api/save-env', {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ apiKey: 'k', secretKey: 's' }),
    });
    expect(save.status).toBe(599);
    expect(nextCalls).toEqual(['GET /api/read-env', 'POST /api/save-env']);
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('精靈端點：第一個請求才動態載入 service 與 gateway（不啟動瀏覽器），不合法的本文不需要載入', async () => {
    const { base } = await mount(path.join(tempDir(), '.env'));
    const invalid = await call(base, 'start', { idNumber: 'bad' });
    expect(invalid.status).toBe(400);
    expect(invalid.json).toEqual(FIXED_400);
    const status = await call(base, 'status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ step: 'login', expiresAt: null, result: null, error: null });
    expect(status.headers.get('cache-control')).toBe('no-store');
  });

  it('/key 成功回應帶 plugin 實際寫入的 .env 路徑', async () => {
    const fake = createFakeGateway();
    fake.state.loginOutcome = 'logged_in';
    vi.doMock('./gateway', () => ({ localOnboardingGateway: fake.gateway }));
    // 萬一 mock 沒套用，真 gateway 也只會因找不到 Chrome 而失敗，不會開瀏覽器。
    vi.stubEnv('SINOPAC_CHROME_PATH', '/nonexistent/chrome');
    try {
      const envPath = path.join(tempDir(), '.env');
      const { base } = await mount(envPath);
      await call(base, 'start', credentials);
      await call(base, 'plan', plan());
      await call(base, 'otp/send', { purpose: 'key', channel: 'sms', targetIndex: 0 });
      await call(base, 'otp/verify', { purpose: 'key', code: SENTINEL.otp });
      const key = await call(base, 'key', { revealSecret: false });
      expect(key.status).toBe(200);
      expect(key.json.envPath).toBe(envPath);
      expect(fs.readFileSync(envPath, 'utf8')).toContain(`SJ_API_KEY=${SENTINEL.apiKey}`);
    } finally {
      vi.doUnmock('./gateway');
      vi.unstubAllEnvs();
    }
  });

  it('repository 掛在 globalThis：重建 plugin（Vite 重啟）後 /status 仍能還原進行中的流程', async () => {
    const shared = globalThis as typeof globalThis & { __sinopacOnboardingRepository?: OnboardingRepository };
    const repository = createInMemoryOnboardingRepository();
    const now = Date.now();
    await repository.update(() => ({
      session: {
        flowId: 'flow-1',
        sessionId: 'local-1',
        step: 'plan',
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
        lock: null,
        logins: 1,
        otp: null,
        otpTargets: [],
        termsText: null,
        plan: null,
      },
    }));
    shared.__sinopacOnboardingRepository = repository;
    const { base } = await mount(path.join(tempDir(), '.env'));
    expect((await call(base, 'status')).json).toMatchObject({ step: 'plan' });
  });
});
