// src/lib/spawn-keys.ts — remembers WHICH credentials our spawned server
// was started with, as a SHA-256 hash (never the keys themselves).
//
// Why (issue #16): serverStart adopts a healthy running server without ever
// re-validating credentials — after the user re-logs in with a different
// API key, the old server (logged into the old account) gets adopted and
// the app shows the old account's data (e.g. only a futures account).
// Comparing a stored hash of the spawn-time keys against the current keys
// lets serverStart force a stop+respawn ONLY when the keys verifiably
// changed.
//
// Decision safety (the restart-loop scars — see bc69648 / b432867): a
// missing hash (upgrade user, cleared storage, external server) or an
// unavailable crypto.subtle MUST read as "compatible" so adoption proceeds
// exactly as before. Only "hash stored AND provably different" forces a
// respawn, and the fresh spawn immediately lands the new hash, so the
// check converges after one restart and can never loop.

const STORAGE_KEY = 'sj-pro-spawn-keys';

// SHA-256 hex of "apiKey:secretKey" — null when hashing is unavailable
// (crypto.subtle missing), which downstream treats as "cannot compare".
export async function hashCredentials(
    apiKey: string,
    secretKey: string,
): Promise<string | null> {
    try {
        const data = new TextEncoder().encode(`${apiKey}:${secretKey}`);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        return null;
    }
}

// the adoption decision, pure and unit-tested: force a respawn only when
// BOTH hashes exist and definitely differ. Any missing side → compatible.
export function shouldForceRespawn(
    stored: string | null | undefined,
    current: string | null | undefined,
): boolean {
    return !!stored && !!current && stored !== current;
}

export function getStoredSpawnKeyHash(): string | null {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

export function setStoredSpawnKeyHash(hash: string | null) {
    try {
        if (hash === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, hash);
    } catch {
        // storage unavailable — hash simply won't be comparable next run
    }
}

export function clearStoredSpawnKeyHash() {
    setStoredSpawnKeyHash(null);
}
