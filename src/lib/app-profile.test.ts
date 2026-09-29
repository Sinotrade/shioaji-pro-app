import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, PRIMARY_PORT, readAppProfile } from './runtime';

describe('readAppProfile (issue #205 second App)', () => {
    it('keeps the primary App unchanged when nothing is injected', () => {
        expect(readAppProfile(undefined)).toBeNull();
        expect(DEFAULT_PORT).toBe(PRIMARY_PORT);
    });

    it('reads the native profile injected into a secondary App', () => {
        const store = Array.from({ length: 16 }, (_, i) => i * 7);
        expect(
            readAppProfile({ id: 'second', label: '第二組', portBase: 21422, dataStoreIdentifier: store }),
        ).toEqual({ id: 'second', label: '第二組', portBase: 21422, dataStoreIdentifier: store });
        // Windows/Linux isolate by data directory: no store id
        expect(
            readAppProfile({ id: 'second', label: '第二組', portBase: 21422, dataStoreIdentifier: null })
                ?.dataStoreIdentifier,
        ).toBeNull();
    });

    it('rejects malformed profiles instead of guessing ports', () => {
        for (const bad of [
            { id: '../x', label: 'x', portBase: 21422 },
            { id: 'second', label: 'x', portBase: 80 },
            { id: 'second', label: 'x', portBase: 21422.5 },
            { id: 'second', portBase: 21422 },
            'second',
        ]) {
            expect(readAppProfile(bad)).toBeNull();
        }
        expect(
            readAppProfile({ id: 'second', label: 'x', portBase: 21422, dataStoreIdentifier: [1, 2, 3] })
                ?.dataStoreIdentifier,
        ).toBeNull();
    });
});
