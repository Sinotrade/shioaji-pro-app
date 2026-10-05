// Node (req, res, next) 版的精靈 REST 路由，移植自 all-set-tw 的 Hono route.ts。
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isTaiwanIdFormat,
  type OnboardingAccountType,
  type OnboardingPlan,
} from "../../src/lib/sinopac-onboarding/types";
import type { OnboardingService } from "./service";

export const ONBOARDING_API_PREFIX = "/api/sinopac-onboarding";

/** 請求本文上限（位元組）。 */
const MAX_BODY_BYTES = 16 * 1024;

// 與 service.ts 的固定文案相同（驗證失敗時 service 還沒載入），routes.test.ts 會比對。
export const INVALID_REQUEST_MESSAGE = "送出的資料不正確，請檢查後再試。";
const INTERNAL_ERROR_MESSAGE = "發生未預期的錯誤，請稍後再試。";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 等同 zod 的 .strict()：key 集合必須完全相同。 */
function exact(value: unknown, keys: readonly string[]): JsonObject | null {
  if (!isRecord(value)) return null;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key))
    ? value
    : null;
}

function str(value: unknown, max: number, min = 0): string | null {
  return typeof value === "string" &&
    value.length >= min &&
    value.length <= max
    ? value
    : null;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : null;
}

function credentials(raw: unknown) {
  const body = exact(raw, ["idNumber", "password"]);
  if (!body) return null;
  const idNumber = str(body.idNumber, 20);
  const password = str(body.password, 128, 1);
  if (idNumber === null || password === null || !isTaiwanIdFormat(idNumber))
    return null;
  return { idNumber: idNumber.trim().toUpperCase(), password };
}

function birthday(raw: unknown) {
  const body = exact(raw, ["birthday"]);
  return body && typeof body.birthday === "string" && /^\d{8}$/.test(body.birthday)
    ? { birthday: body.birthday }
    : null;
}

const PURPOSES = ["cert", "key"] as const;
const CHANNELS = ["sms", "email"] as const;
const ACCOUNT_TYPES: readonly OnboardingAccountType[] = [
  "stock",
  "futures",
  "overseas",
];

function otpSend(raw: unknown) {
  const body = exact(raw, ["purpose", "channel", "targetIndex"]);
  if (!body) return null;
  const purpose = oneOf(body.purpose, PURPOSES);
  const channel = oneOf(body.channel, CHANNELS);
  const index = body.targetIndex;
  if (
    purpose === null ||
    channel === null ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 20
  )
    return null;
  return { purpose, channel, targetIndex: index };
}

function otpVerify(raw: unknown) {
  const body = exact(raw, ["purpose", "code"]);
  if (!body) return null;
  const purpose = oneOf(body.purpose, PURPOSES);
  // UNVERIFIED（沿用原版）：永豐金證券 OTP 的位數與字元集未實測，只擋明顯不合理的輸入。
  if (
    purpose === null ||
    typeof body.code !== "string" ||
    !/^[0-9A-Za-z]{4,12}$/.test(body.code)
  )
    return null;
  return { purpose, code: body.code };
}

function terms(raw: unknown) {
  const body = exact(raw, ["accepted"]);
  return body && body.accepted === true ? { accepted: true as const } : null;
}

function key(raw: unknown) {
  const body = exact(raw, ["revealSecret"]);
  return body && typeof body.revealSecret === "boolean"
    ? { revealSecret: body.revealSecret }
    : null;
}

function plan(raw: unknown): OnboardingPlan | null {
  const body = exact(raw, [
    "name",
    "expiresOn",
    "permissions",
    "accountTypes",
    "ip",
  ]);
  if (!body) return null;
  const name = str(body.name, 100);
  const expiresOn = str(body.expiresOn, 20);
  const permissions = exact(body.permissions, [
    "quote",
    "account",
    "trade",
    "prod",
  ]);
  const ip = exact(body.ip, ["mode", "addresses"]);
  if (name === null || expiresOn === null || !permissions || !ip) return null;
  const { quote, account, trade, prod } = permissions;
  if (
    typeof quote !== "boolean" ||
    typeof account !== "boolean" ||
    typeof trade !== "boolean" ||
    typeof prod !== "boolean"
  )
    return null;
  const types = body.accountTypes;
  if (!Array.isArray(types) || types.length > 3) return null;
  const accountTypes: OnboardingAccountType[] = [];
  for (const type of types) {
    const checked = oneOf(type, ACCOUNT_TYPES);
    if (checked === null) return null;
    accountTypes.push(checked);
  }
  const mode = oneOf(ip.mode, ["unlimited", "restricted"] as const);
  const rawAddresses = ip.addresses;
  if (mode === null || !Array.isArray(rawAddresses) || rawAddresses.length > 20)
    return null;
  const addresses: string[] = [];
  for (const address of rawAddresses) {
    const checked = str(address, 45);
    if (checked === null) return null;
    addresses.push(checked);
  }
  return {
    name,
    expiresOn,
    permissions: { quote, account, trade, prod },
    accountTypes,
    ip: { mode, addresses },
  };
}

/** prepare 回傳 null 代表本文不合法；否則回傳一個只剩「呼叫 service」的動作。 */
type Action = (service: OnboardingService) => Promise<unknown>;
interface Route {
  method: "GET" | "POST";
  /** true 時才解析 JSON 本文並交給 prepare（/cancel 與 GET 不看本文）。 */
  body: boolean;
  prepare(raw: unknown): Action | null;
}

function route<T>(
  parse: (raw: unknown) => T | null,
  run: (service: OnboardingService, input: T) => Promise<unknown>,
): Route {
  return {
    method: "POST",
    body: true,
    prepare(raw) {
      const input = parse(raw);
      return input === null ? null : (service) => run(service, input);
    },
  };
}

const ROUTES: Record<string, Route> = {
  status: {
    method: "GET",
    body: false,
    prepare: () => (service) => service.status(),
  },
  start: route(credentials, (service, input) => service.start(input)),
  birthday: route(birthday, (service, input) => service.birthday(input.birthday)),
  "otp/send": route(otpSend, (service, input) => service.sendOtp(input)),
  "otp/verify": route(otpVerify, (service, input) => service.verifyOtp(input)),
  terms: route(terms, (service) => service.acceptTerms()),
  relogin: route(credentials, (service, input) => service.relogin(input)),
  plan: route(plan, (service, input) => service.submitPlan(input)),
  key: route(key, (service, input) => service.createKey(input.revealSecret)),
  cancel: {
    method: "POST",
    body: false,
    prepare: () => (service) => service.cancel(),
  },
};

// 只接受本機回送位址當 Host（可含 port）：localhost、127.0.0.1、[::1]；DNS rebinding 的網域名稱一律不算。
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK_HOSTS.has(name);
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(headers))
    res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

const failure = (code: string, message: string, extra?: JsonObject) => ({
  success: false as const,
  error: { ...extra, code, message },
});

const invalidRequest = () =>
  failure("ONBOARDING_INVALID_REQUEST", INVALID_REQUEST_MESSAGE);

interface OnboardingErrorShape extends Error {
  code: string;
  status: number;
  retryAfterSeconds?: number;
  extra?: JsonObject;
}

/** 依形狀辨識，不用 instanceof（class 身分不保證相同）。 */
function isOnboardingError(error: unknown): error is OnboardingErrorShape {
  if (!(error instanceof Error) || error.name !== "OnboardingError")
    return false;
  const { code, status } = error as Partial<OnboardingErrorShape>;
  return (
    typeof code === "string" &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  );
}

/** 以 Buffer 計算位元組上限；一超過就放棄（回 null），不再累積。 */
function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ text: string } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8") }));
    // 連線中途關閉（沒有 end）：當作失敗，不執行任何動作。
    req.on("close", () => resolve(null));
    req.on("error", () => resolve(null));
  });
}

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;.*)?$/i;

export interface OnboardingRouteOptions {
  /** 第一次需要時才載入／建立 service；呼叫端負責快取。 */
  getService: () => Promise<OnboardingService>;
  /** 金鑰存檔的 .env 絕對路徑；有給時 /key 的成功回應多帶 envPath。存檔失敗走錯誤回應，不會帶它。 */
  envPath?: string;
  /** 測試用：覆寫本文上限。 */
  maxBodyBytes?: number;
}

export function createOnboardingRouteHandler(options: OnboardingRouteOptions) {
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;

  return async function onboardingRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ): Promise<void> {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (
      pathname !== ONBOARDING_API_PREFIX &&
      !pathname.startsWith(`${ONBOARDING_API_PREFIX}/`)
    )
      return next();

    // 這個前綴底下的請求一律在這裡結束，絕不 next()：否則會被 /api proxy 轉給 sidecar。
    try {
      // Host 必須是本機回送位址（Vite 的 host 檢查在前面，這裡再擋一次，不依賴它），
      // 帶 Origin 時必須與本機 dev server 同源，擋其他網站對本機的跨站請求；沒帶 Origin（同源 GET、非瀏覽器）放行。
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (
        !host ||
        !isLoopbackHost(host) ||
        (origin !== undefined &&
          origin !== `http://${host}` &&
          origin !== `https://${host}`)
      ) {
        return send(
          res,
          403,
          failure("ONBOARDING_FORBIDDEN_ORIGIN", "拒絕來自其他網站的請求。"),
        );
      }

      const name = pathname.slice(ONBOARDING_API_PREFIX.length + 1);
      const entry = Object.hasOwn(ROUTES, name) ? ROUTES[name] : undefined;
      if (!entry) {
        return send(res, 404, failure("NOT_FOUND", "找不到這個路徑。"));
      }
      if (req.method !== entry.method) {
        return send(
          res,
          405,
          failure("METHOD_NOT_ALLOWED", "不支援這個請求方法。"),
          { Allow: entry.method },
        );
      }

      let raw: unknown;
      if (entry.method === "POST") {
        // 要求 JSON Content-Type 是 CSRF 防線（跨站簡單請求不能帶它）。
        const contentType = req.headers["content-type"] ?? "";
        const body = JSON_CONTENT_TYPE.test(contentType)
          ? await readBody(req, limit)
          : null;
        if (!body) {
          // 不排空超大或不合法的本文：回應後直接斷線。
          return send(res, 400, invalidRequest(), { Connection: "close" });
        }
        if (entry.body) {
          try {
            raw = JSON.parse(body.text);
          } catch {
            // raw 維持 undefined，各 prepare 會因不是物件而回 null。
          }
        }
      }

      const action = entry.prepare(raw);
      if (!action) return send(res, 400, invalidRequest());

      // 用戶端中途斷線不會取消這裡的 await：createKey 會照樣跑完並存檔（Secret 只出現一次）。
      const result = await action(await options.getService());
      return send(
        res,
        200,
        name === "key" && options.envPath
          ? { ...(result as object), envPath: options.envPath }
          : result,
      );
    } catch (error) {
      if (isOnboardingError(error)) {
        const headers: Record<string, string> = {};
        const retry = error.retryAfterSeconds;
        if (typeof retry === "number" && Number.isFinite(retry) && retry > 0)
          headers["Retry-After"] = String(Math.ceil(retry));
        return send(
          res,
          error.status,
          failure(
            error.code,
            error.message,
            isRecord(error.extra) ? error.extra : undefined,
          ),
          headers,
        );
      }
      // 不把 error 物件或訊息寫進 log：只記錯誤名稱。
      console.error(
        JSON.stringify({
          event: "sinopac_onboarding_internal_error",
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
      return send(
        res,
        500,
        failure("INTERNAL_ERROR", INTERNAL_ERROR_MESSAGE),
      );
    }
  };
}
