// src/lib/spawn-keys.test.ts — the adoption decision must NEVER force a
// respawn on missing data (restart-loop safety, issue #16 / bc69648).

import { describe, expect, it } from 'vitest';
import { shouldForceRespawn } from './spawn-keys';

describe('shouldForceRespawn', () => {
    it('is false when nothing is stored (upgrade user / cleared storage)', () => {
        expect(shouldForceRespawn(null, 'abc')).toBe(false);
        expect(shouldForceRespawn(undefined, 'abc')).toBe(false);
        expect(shouldForceRespawn('', 'abc')).toBe(false);
    });

    it('is false when the current hash is unavailable (no crypto.subtle)', () => {
        expect(shouldForceRespawn('abc', null)).toBe(false);
        expect(shouldForceRespawn('abc', undefined)).toBe(false);
        expect(shouldForceRespawn('abc', '')).toBe(false);
    });

    it('is false when both are missing', () => {
        expect(shouldForceRespawn(null, null)).toBe(false);
    });

    it('is false when the hashes match (same keys → adopt as before)', () => {
        expect(shouldForceRespawn('same', 'same')).toBe(false);
    });

    it('is true only when both exist and differ (keys really changed)', () => {
        expect(shouldForceRespawn('old', 'new')).toBe(true);
    });
});
