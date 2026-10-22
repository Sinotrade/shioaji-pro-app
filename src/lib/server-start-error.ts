// src/lib/server-start-error.ts — why a server start failed, as one kind the
// UI can explain. The onboarding screen used to say 「請確認帳號設定、網路與
// 憑證」 for every failure, including a dev build whose sidecar was never
// copied next to the App. The native shell appends one machine-readable line
// (SIDECAR_ERROR_MARKER + JSON) for an unusable bundled binary; everything
// else is read from the sidecar's start log.

import { diagnoseOutput } from './server-diagnostics';

/** Prefix of the native machine-readable error line (bundled_bin.rs). */
export const SIDECAR_ERROR_MARKER = '@@sjpro-error ';

export type BinaryProblem = 'not_found' | 'not_a_file' | 'empty' | 'not_executable';

export type ServerStartError =
    | { kind: 'sidecar_missing'; binary: string; path: string; reason: BinaryProblem }
    | { kind: 'port_in_use'; port: number; lastLines: string[] }
    | { kind: 'sidecar_exited'; lastLines: string[] }
    | { kind: 'auth_failed'; hint: string | null; lastLines: string[] }
    | { kind: 'account_setup'; message: string }
    | { kind: 'ca_cert'; hint: string | null; lastLines: string[] }
    | { kind: 'network'; timeout: boolean; hint: string | null; lastLines: string[] }
    | { kind: 'unknown'; message: string; lastLines: string[] };

export type ServerStartErrorKind = ServerStartError['kind'];

/** How the start ended, as far as the spawn wait can tell. */
export type StartFailureStage =
    | 'precheck' // refused before spawning (settings, port policy)
    | 'spawn' // the native spawn command itself failed
    | 'died' // the sidecar process exited before its listener answered
    | 'timeout'; // still not answering after the wait

const LAST_LINES = 6;

// The native log writer already masks the launch's secrets; this is a second
// net for anything shaped like a credential that reaches the screen.
const SECRET_ASSIGN_RE =
    /([A-Za-z0-9_-]*(?:api[_-]?key|sec(?:ret)?[_-]?key|secret|passw(?:or)?d|passwd|token))(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/g;
const PERSON_ID_RE = /\b[A-Z][12]\d{8}\b/g;

export function redactLogLine(line: string): string {
    return line
        .replace(SECRET_ASSIGN_RE, '$1$2***')
        .replace(BEARER_RE, '$1 ***')
        .replace(PERSON_ID_RE, '**********');
}

/** The last few meaningful log lines, redacted. */
export function lastLogLines(output: string, count = LAST_LINES): string[] {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith(SIDECAR_ERROR_MARKER.trim()))
        .slice(-count)
        .map(redactLogLine);
}

function nativeBinaryError(output: string): ServerStartError | null {
    for (const line of output.split('\n')) {
        const at = line.indexOf(SIDECAR_ERROR_MARKER);
        if (at < 0) continue;
        try {
            const detail = JSON.parse(line.slice(at + SIDECAR_ERROR_MARKER.length)) as {
                kind?: unknown; binary?: unknown; path?: unknown; reason?: unknown;
            };
            if (detail.kind !== 'sidecar_missing') continue;
            return {
                kind: 'sidecar_missing',
                binary: typeof detail.binary === 'string' ? detail.binary : 'shioaji',
                path: typeof detail.path === 'string' ? detail.path : '',
                reason: (['not_found', 'not_a_file', 'empty', 'not_executable'] as const)
                    .find((r) => r === detail.reason) ?? 'not_found',
            };
        } catch {
            // a garbled marker line is just log text
        }
    }
    return null;
}

const ACCOUNT_SETUP_RE =
    /請先完成帳號設定|請先選擇帳號設定|帳號設定已變更|系統憑證庫|Missing required environment variable/;
const PORT_IN_USE_RE =
    /address already in use|addrinuse|os error (48|98|10048)\b|only one usage of each socket address|連接埠已被占用|已有一個 shioaji server/i;
// mirrors diagnoseOutput: a Solace timeout is wrapped as "Authentication
// failed: Shioaji connect error", so network wins over login failure
const NETWORK_RE =
    /timed? ?out|connection (refused|reset)|network is unreachable|failed to (lookup|resolve)|dns error|Session initialization failed|solClient_context_create/i;
const SIGN_TIMEOUT_RE = /sign data is timeout/i;
const AUTH_RE =
    /Authentication failed|auth rejected|login validation error|LOGINING|not exist|invalid (secret_key|api_key)|base58/i;
// Sinopac.pfx problems are named outright; checked before login failure so a
// missing .pfx ("… not exist") is not blamed on the API key
const CA_STRONG_RE = /Ca Password Incorrect|Ca has expired|CA error|ca.*(password|passwd)|pfx|pkcs ?12/i;
// local HTTPS certificate problems stop the listener from starting
const TLS_RE = /\btls\b|certificate|SJ_HTTP_TLS/i;
// CA activation failing is only a warning: the server still starts and logs
// in, so these lines never explain a failed start on their own
const CA_WARNING_RE = /Failed to activate CA|Failed to get CA expire/i;

/**
 * Classify a failed start. `output` is what the start returned (native error
 * text and/or the sidecar's start log tail); `stage` says how it ended.
 */
export function classifyServerStart(input: {
    output: string;
    stage?: StartFailureStage;
    port: number;
}): ServerStartError {
    const { output, stage, port } = input;
    const native = nativeBinaryError(output);
    if (native) return native;
    const lastLines = lastLogLines(output);
    if (ACCOUNT_SETUP_RE.test(output)) {
        return { kind: 'account_setup', message: redactLogLine(firstLine(output)) };
    }
    if (PORT_IN_USE_RE.test(output)) return { kind: 'port_in_use', port, lastLines };
    const fatal = output.split('\n').filter((line) => !CA_WARNING_RE.test(line)).join('\n');
    const hint = diagnoseOutput(fatal);
    if (SIGN_TIMEOUT_RE.test(fatal)) return { kind: 'auth_failed', hint, lastLines };
    if (NETWORK_RE.test(fatal)) {
        return { kind: 'network', timeout: /timed? ?out/i.test(fatal), hint, lastLines };
    }
    if (CA_STRONG_RE.test(fatal)) return { kind: 'ca_cert', hint, lastLines };
    if (AUTH_RE.test(fatal)) return { kind: 'auth_failed', hint, lastLines };
    if (stage === 'timeout') return { kind: 'network', timeout: true, hint: null, lastLines };
    if (TLS_RE.test(fatal)) return { kind: 'ca_cert', hint: null, lastLines };
    if (stage === 'died') return { kind: 'sidecar_exited', lastLines };
    return { kind: 'unknown', message: redactLogLine(firstLine(output)), lastLines };
}

function firstLine(output: string): string {
    return output.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

export const BINARY_PROBLEM_TEXT: Record<BinaryProblem, string> = {
    not_found: '檔案不存在',
    not_a_file: '不是一般檔案',
    empty: '檔案是 0 bytes，下載或複製不完整',
    not_executable: '檔案沒有執行權限',
};

export interface ServerStartErrorCopy {
    title: string;
    body: string;
    /** a path or log tail shown in a monospace block */
    detail: string[];
    detailLabel?: string;
}

/** What the user is told for each kind. Never echoes credential values. */
export function serverStartErrorCopy(error: ServerStartError): ServerStartErrorCopy {
    switch (error.kind) {
        case 'sidecar_missing':
            return {
                title: error.binary === 'mkcert' ? '找不到內建的憑證工具' : '找不到內建的伺服器程式',
                body: `App 內建的 ${error.binary} 無法執行（${BINARY_PROBLEM_TEXT[error.reason]}），伺服器沒有啟動。請重新安裝 Shioaji Pro；開發版請重新建置，讓 sidecar 複製到執行檔旁。`,
                detail: error.path ? [error.path] : [],
                detailLabel: '已搜尋的路徑',
            };
        case 'port_in_use':
            return {
                title: '連接埠被占用',
                body: `${error.port ? `port ${error.port}` : '伺服器的連接埠'} 已被其他程式使用，伺服器無法開始監聽。請關閉占用的程式，或重新開啟 App 後再試。`,
                detail: error.lastLines,
                detailLabel: '記錄最後幾行',
            };
        case 'sidecar_exited':
            return {
                title: '伺服器啟動後立即結束',
                body: '伺服器程式啟動後就結束了，尚未開始服務。請依下方記錄排除問題後重試。',
                detail: error.lastLines,
                detailLabel: '記錄最後幾行',
            };
        case 'auth_failed':
            return {
                title: '登入失敗',
                body: error.hint ?? '永豐主機拒絕登入 — 請確認 API Key／Secret Key 正確、API 約定書已簽署，且模擬／正式環境與金鑰一致。',
                detail: error.lastLines,
                detailLabel: '記錄最後幾行',
            };
        case 'account_setup':
            return {
                title: '帳號設定未完成',
                body: error.message || '請先完成帳號設定並選擇使用中的帳號。',
                detail: [],
            };
        case 'ca_cert':
            return {
                title: '憑證無法使用',
                body: error.hint ?? '憑證（Sinopac.pfx）或本機 HTTPS 憑證無法載入 — 請確認憑證檔與密碼，或在伺服器管理重新啟用本機 HTTPS。',
                detail: error.lastLines,
                detailLabel: '記錄最後幾行',
            };
        case 'network':
            return {
                title: error.timeout ? '連線逾時' : '無法連線至永豐主機',
                body: error.hint ?? (error.timeout
                    ? '伺服器在 45 秒內沒有就緒，通常是連不到永豐主機 — 請檢查網路、VPN 或防火牆後重試。'
                    : '無法連線至永豐主機 — 請檢查網路、VPN 或防火牆後重試。'),
                detail: error.lastLines,
                detailLabel: '記錄最後幾行',
            };
        case 'unknown':
            return {
                title: '伺服器啟動失敗',
                body: error.message || '伺服器沒有啟動，請查看記錄檔了解原因。',
                detail: error.lastLines.filter((line) => line !== error.message),
                detailLabel: '記錄最後幾行',
            };
    }
}
