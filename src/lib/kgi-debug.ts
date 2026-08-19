const REDACTED = '[redacted]';
const MAX_ARRAY = 20;
const MAX_DEPTH = 5;

const SENSITIVE_KEY =
    /(account|acct|broker|person|token|secret|password|passwd|authorization|certificate|cert|ca_|ca$)/i;

export function isKgiDebugEnabled(): boolean {
    return import.meta.env.VITE_DEBUG_KGI === 'true';
}

function sanitize(value: unknown, depth = 0): unknown {
    if (depth >= MAX_DEPTH) return '[truncated]';
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
    }
    if (typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key)
            ? REDACTED
            : sanitize(item, depth + 1);
    }
    return out;
}

export function logKgiDebug(label: string, value: unknown): void {
    if (!isKgiDebugEnabled()) return;
    console.debug(label, sanitize(value));
}
