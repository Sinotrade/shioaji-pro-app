// src/lib/agent/models.ts — fetch each provider's available models so the
// settings tab shows a real dropdown instead of a free-text guess.

import { isTauri } from '../runtime';
import { borrowCodexCredentials } from './codex-auth';
import { getAgentKey } from './config';
import type { AgentProvider } from './types';

async function llmFetch(url: string, init: RequestInit): Promise<Response> {
    if (isTauri) {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        return tauriFetch(url, init as Parameters<typeof tauriFetch>[1]);
    }
    return fetch(url, init);
}

const CODEX_FALLBACK = [
    'gpt-5.4-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
];

const cache = new Map<string, string[]>();

export async function listModels(provider: AgentProvider): Promise<string[]> {
    const hit = cache.get(provider);
    if (hit) return hit;
    let models: string[] = [];
    try {
        if (provider === 'anthropic') {
            const key = getAgentKey('anthropic');
            if (!key) return [];
            const res = await llmFetch('https://api.anthropic.com/v1/models?limit=50', {
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
            });
            if (!res.ok) throw new Error(String(res.status));
            const data = (await res.json()) as { data: { id: string }[] };
            models = data.data.map((m) => m.id);
        } else if (provider === 'openai') {
            const key = getAgentKey('openai');
            if (!key) return [];
            const res = await llmFetch('https://api.openai.com/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (!res.ok) throw new Error(String(res.status));
            const data = (await res.json()) as { data: { id: string }[] };
            models = data.data
                .map((m) => m.id)
                .filter((id) => /^(gpt-|o[0-9])/.test(id))
                .sort()
                .reverse();
        } else {
            // codex: ChatGPT backend models list; fall back to known set
            const cred = await borrowCodexCredentials();
            const headers: Record<string, string> = {
                Authorization: `Bearer ${cred.accessToken}`,
            };
            if (cred.accountId) headers['ChatGPT-Account-ID'] = cred.accountId;
            const res = await llmFetch(
                'https://chatgpt.com/backend-api/codex/models',
                { headers },
            );
            if (res.ok) {
                const data = (await res.json()) as {
                    models?: {
                        slug?: string;
                        id?: string;
                        supported_in_api?: boolean;
                        visibility?: string;
                    }[];
                };
                models = (data.models ?? [])
                    .filter(
                        (m) =>
                            m.supported_in_api !== false &&
                            (m.visibility === undefined ||
                                m.visibility === 'list'),
                    )
                    .map((m) => m.slug ?? m.id ?? '')
                    .filter(Boolean);
            }
            if (models.length === 0) models = CODEX_FALLBACK;
        }
    } catch {
        models = provider === 'codex' ? CODEX_FALLBACK : [];
    }
    if (models.length) cache.set(provider, models);
    return models;
}
