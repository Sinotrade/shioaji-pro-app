import { describe, expect, it } from 'vitest';

import { resolveAgentHarnessSetting } from './agent-harness-state';

describe('resolveAgentHarnessSetting', () => {
    it('enables the harness for installs upgraded from before the setting existed', () => {
        expect(resolveAgentHarnessSetting(undefined)).toBe(true);
        expect(resolveAgentHarnessSetting(null)).toBe(true);
    });

    it('migrates the old false default exactly once', () => {
        expect(resolveAgentHarnessSetting(false, false)).toBe(true);
        expect(resolveAgentHarnessSetting(false, true)).toBe(false);
    });

    it('preserves an explicit user choice', () => {
        expect(resolveAgentHarnessSetting(true)).toBe(true);
        expect(resolveAgentHarnessSetting(false)).toBe(false);
    });
});
