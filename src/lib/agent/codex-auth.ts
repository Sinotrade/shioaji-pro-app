// src/lib/agent/codex-auth.ts — borrow the Codex CLI's ChatGPT subscription
// credentials (~/.codex/auth.json) for the AI Agent. Unlike Claude,
// OpenAI's Codex terms allow programmatic use of the subscription quota
// (the 5-hour rolling window applies). Tokens are refreshed against
// auth.openai.com with Codex's public client_id and written back so the
// CLI keeps working. Desktop only.

import { isTauri } from '../runtime';

const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // Codex CLI public id
const REFRESH_MARGIN_MS = 5 * 60_000;

interface CodexTokens {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
}

interface CodexAuthFile {
    auth_mode?: string;
    tokens?: CodexTokens;
    last_refresh?: string;
    OPENAI_API_KEY?: string;
}

function jwtPayload(token: string): Record<string, unknown> | null {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        return JSON.parse(
            atob(part.replace(/-/g, '+').replace(/_/g, '/')),
        ) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function accountIdFrom(tokens: CodexTokens): string | null {
    if (tokens.account_id) return tokens.account_id;
    for (const t of [tokens.id_token, tokens.access_token]) {
        if (!t) continue;
        const payload = jwtPayload(t);
        const auth = payload?.['https://api.openai.com/auth'] as
            | { chatgpt_account_id?: string }
            | undefined;
        if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
    }
    return null;
}

function isExpiring(accessToken: string): boolean {
    const payload = jwtPayload(accessToken);
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return false;
    return exp * 1000 - Date.now() < REFRESH_MARGIN_MS;
}

export interface CodexCredentials {
    accessToken: string;
    accountId: string | null;
}

// reads (and if needed refreshes + persists) the Codex CLI credentials
export async function borrowCodexCredentials(): Promise<CodexCredentials> {
    if (!isTauri) {
        throw new Error('Codex 訂閱模式僅桌面版可用');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<string>('read_codex_auth');
    let auth: CodexAuthFile;
    try {
        auth = JSON.parse(raw) as CodexAuthFile;
    } catch {
        throw new Error('~/.codex/auth.json 格式無法解析');
    }
    const tokens = auth.tokens;
    if (!tokens?.access_token) {
        throw new Error('auth.json 沒有 ChatGPT 登入 token — 請先執行 codex login');
    }

    if (isExpiring(tokens.access_token) && tokens.refresh_token) {
        const res = await fetch(REFRESH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh_token,
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(
                `Codex token 刷新失敗（${res.status}）：請重新 codex login。${body.slice(0, 120)}`,
            );
        }
        const data = (await res.json()) as Partial<CodexTokens>;
        if (data.access_token) tokens.access_token = data.access_token;
        if (data.refresh_token) tokens.refresh_token = data.refresh_token;
        if (data.id_token) tokens.id_token = data.id_token;
        auth.last_refresh = new Date().toISOString();
        // write back so the Codex CLI stays logged in too
        await invoke('write_codex_auth', {
            content: JSON.stringify(auth, null, 2),
        }).catch(() => undefined);
    }

    return {
        accessToken: tokens.access_token,
        accountId: accountIdFrom(tokens),
    };
}

export async function codexLoginStatus(): Promise<string> {
    try {
        const cred = await borrowCodexCredentials();
        const payload = jwtPayload(cred.accessToken);
        const email =
            (payload?.['https://api.openai.com/profile'] as { email?: string })
                ?.email ?? '';
        return email ? `已登入（${email}）` : '已登入';
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}
