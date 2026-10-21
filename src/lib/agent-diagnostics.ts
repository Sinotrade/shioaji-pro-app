// Shared with the optional desktop Agent overlay. Store only redacted errors,
// so server-manager's copied diagnostics also work after a WebView reload.
const KEY = 'sj-agent-runtime-failure';

function sensitiveField(name: string): boolean {
    const key = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return /(?:token|key|secret|password|passwd|passphrase|credentials?)$/.test(key)
        || /^(?:authorization|proxyauthorization|cookie|setcookie|bearer|sjpersonid|personid|email|username|accountid)$/.test(key);
}

function redactText(text: string): string {
    return text
        .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[=:][^\r\n]*/gi, '[REDACTED]')
        .replace(/\b(?:[\w-]*(?:token|key|secret|password|passwd|passphrase|credential|credentials)|SJ_PERSON_ID|person_id|email|username|account_id)["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '[REDACTED]')
        .replace(/\b(?:bearer|basic)\s+[^\s,"'}]+/gi, '[REDACTED]')
        .replace(/\b(?:sk-|sk_|rk_|pk_|ghp_|gho_|github_pat_|xox)[\w-]+|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]{16,}(?:\.[\w-]+)*/g, '[REDACTED]')
        .replace(/(\w+:\/\/)[^\s/:@]+(?::[^\s/@]*)?@/g, '$1[REDACTED]@')
        .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?[REDACTED]')
        // Quoted paths may contain spaces in any segment. Match them before
        // the unquoted rules, which stop before a following error message.
        .replace(/"(?:[A-Za-z]:[\\/]+|\\{2,})[^"\r\n]*"|'(?:[A-Za-z]:[\\/]+|\\{2,})[^'\r\n]*'/g, '[REDACTED_PATH]')
        .replace(/\/(?:Users|home)\/[^/\r\n"]+/g, '~')
        .replace(/(?:[A-Za-z]:[\\/]+|[\\/]{2}[^\\/\r\n"]+[\\/]+)(?:Users|home)[\\/]+[^\\/\r\n"]+/gi, '~')
        // Beyond the share, continue across spaces only when the next word
        // contains a path separator (e.g. "Fixture User\p failed").
        // Apostrophes are valid inside unquoted paths; quoted paths were
        // already handled above, so they need not delimit these matches.
        .replace(/\b[A-Za-z]:[\\/]+[^\s"]*(?:[ \t]+[^\s"\\/]*[\\/][^\s"]*)*/g, '[REDACTED_PATH]')
        .replace(/\\{2,}(?:\?\\[Uu][Nn][Cc]\\)?[^\s\\/:*?"<>|]+[\\/]+[^\s\\/:*?"<>|]+(?:[\\/][^\s"]*(?:[ \t]+[^\s"\\/]*[\\/][^\s"]*)*)?/g, '[REDACTED_PATH]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

function redactValue(value: unknown): unknown {
    if (typeof value === 'string') return redactAgentRuntimeDetail(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitiveField(key) ? '[REDACTED]' : redactValue(entry)]));
    return value;
}

export function redactAgentRuntimeDetail(text: string): string {
    return text.split('\n').map(line => {
        // Parse before regex replacement so JSON escaping cannot hide paths or
        // quoted credential fields, and numeric diagnostic fields keep their type.
        try { return JSON.stringify(redactValue(JSON.parse(line))); }
        catch { return redactText(line); }
    }).join('\n').slice(0, 24_000);
}

export function recordAgentRuntimeFailure(message: string, detail?: string): string {
    const text = redactAgentRuntimeDetail([message, detail].filter(Boolean).join('\n'));
    try { localStorage.setItem(KEY, text); } catch { /* storage is optional */ }
    return text;
}

export function agentRuntimeDiagnostics(): string {
    try {
        const text = localStorage.getItem(KEY);
        return text ? `--- Agent runtime ---\n${redactAgentRuntimeDetail(text)}` : '';
    } catch { return ''; }
}
