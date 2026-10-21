// Native revisions identify the profile, keys, CA and environment used for
// each spawn (#16). Missing records stay compatible to avoid restart loops.
// JS receives only the native digest; no hashing or secret input here.

const STORAGE_KEY = 'sj-pro-spawn-keys';

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
