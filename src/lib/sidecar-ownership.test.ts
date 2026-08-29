import { describe, expect, it } from 'vitest';
import { harnessOwnershipCompatible } from './sidecar-ownership';

describe('Agent Harness sidecar ownership', () => {
    it('rejects an orphan daemon when a new App instance enables Harness', () => {
        expect(harnessOwnershipCompatible(true, false)).toBe(false);
    });

    it('accepts only the current native-owned sidecar for Harness', () => {
        expect(harnessOwnershipCompatible(true, true)).toBe(true);
        expect(harnessOwnershipCompatible(false, false)).toBe(true);
    });
});
