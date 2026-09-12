import { describe, expect, it } from 'vitest';
import { buildVersionLabel } from './build-version';

describe('App build display identity', () => {
    it('labels an ordinary dev session with its source instead of a native placeholder', () => {
        expect(buildVersionLabel({ command: 'serve', revision: 'ffe613f5c0aae135235298f2bde83ab6a574231d', dirty: true }))
            .toBe('dev · ffe613f5+dirty');
    });
    it('keeps untagged production-mode and debug bundle builds visibly unreleased', () => {
        expect(buildVersionLabel({ command: 'build', refType: 'branch', refName: 'main', revision: 'abcdef12' }))
            .toBe('dev · abcdef12');
    });
    it('uses the release tag only for a tagged build, never a dev server', () => {
        expect(buildVersionLabel({ command: 'build', refType: 'tag', refName: 'v0.1.47' })).toBe('v0.1.47');
        expect(buildVersionLabel({ command: 'serve', refType: 'tag', refName: 'v0.1.47' })).toBe('dev · unknown');
    });
    it('does not substitute an old version when provenance is unavailable or invalid', () => {
        expect(buildVersionLabel({ command: 'build', refType: 'tag', refName: 'not-a-release' })).toBe('dev · unknown');
    });
});
