// src/lib/broker/backend.ts

import { getKgiBackendBase } from './config';

async function parseError(res: Response): Promise<Error> {
    try {
        const data = (await res.json()) as {
            message?: string;
            details?: unknown;
        };
        const details =
            typeof data.details === 'string'
                ? data.details
                : data.details
                  ? JSON.stringify(data.details)
                  : '';
        return new Error(
            `${res.status} ${data.message ?? res.statusText}${details ? ` ${details}` : ''}`.trim(),
        );
    } catch {
        return new Error(`${res.status} ${res.statusText}`.trim());
    }
}

export async function kgiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${getKgiBackendBase()}${path}`);
    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<T>;
}

export async function kgiPost<T>(
    path: string,
    body: unknown = {},
): Promise<T> {
    const res = await fetch(`${getKgiBackendBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<T>;
}

export async function kgiPut<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${getKgiBackendBase()}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<T>;
}

export async function kgiDelete<T>(
    path: string,
    body?: unknown,
): Promise<T> {
    const res = await fetch(`${getKgiBackendBase()}${path}`, {
        method: 'DELETE',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<T>;
}
