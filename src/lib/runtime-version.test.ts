import { describe, expect, it } from 'vitest';
import { canonicalServerVersion, sameServerVersion } from './runtime';

describe('sameServerVersion', () => {
    it('treats PEP 440 and semver pre-releases as the same version', () => {
        expect(sameServerVersion('1.8.0b1', '1.8.0-beta.1')).toBe(true);
        expect(sameServerVersion('v1.8.0b1', '1.8.0-beta.1')).toBe(true);
        expect(sameServerVersion('1.8.0rc2', '1.8.0-rc.2')).toBe(true);
        expect(sameServerVersion('1.8.0a1', '1.8.0-alpha.1')).toBe(true);
        expect(sameServerVersion('1.7.11', '1.7.11')).toBe(true);
    });
    it('keeps different versions apart', () => {
        expect(sameServerVersion('1.8.0b1', '1.8.0b2')).toBe(false);
        expect(sameServerVersion('1.8.0', '1.8.0b1')).toBe(false);
        expect(sameServerVersion('1.8.0-beta.1', '1.8.0-rc.1')).toBe(false);
        expect(sameServerVersion('1.7.11', '1.7.1')).toBe(false);
    });
    it('normalizes to the semver form', () => {
        expect(canonicalServerVersion(' V1.8.0B1 ')).toBe('1.8.0-beta.1');
        expect(canonicalServerVersion('1.8.0')).toBe('1.8.0');
    });
});
