import { describe, expect, it } from 'vitest';

import {
    AGENT_APP_TOOL_CAPABILITIES,
    AGENT_APP_TOOL_CONTRACT_VERSION,
    AGENT_RESTART_POLICY,
    isAgentAppToolCapability,
} from './agent-contract';

describe('public Agent Harness contract', () => {
    it('publishes a stable v1 capability vocabulary', () => {
        expect(AGENT_APP_TOOL_CONTRACT_VERSION).toBe(1);
        expect(AGENT_APP_TOOL_CAPABILITIES).toEqual([
            'market.read',
            'account.read',
            'ui.control',
            'task.manage',
            'trade.preview',
            'trade.execute',
        ]);
        expect(isAgentAppToolCapability('trade.execute')).toBe(true);
        expect(isAgentAppToolCapability('shell.anything')).toBe(false);
    });

    it('expires authority and pauses controlled-auto across restart', () => {
        expect(AGENT_RESTART_POLICY).toEqual({
            conversations: 'restore',
            taskHistory: 'restore',
            pendingApprovals: 'expire',
            capabilityGrants: 'expire',
            controlledAuto: 'pause',
        });
    });
});
