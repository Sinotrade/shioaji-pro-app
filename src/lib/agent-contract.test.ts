import { describe, expect, it } from 'vitest';

import {
    AGENT_APP_COMMANDS,
    AGENT_APP_TOOL_CAPABILITIES,
    AGENT_APP_TOOL_CONTRACT_VERSION,
    AGENT_RESTART_POLICY,
    isAgentAppToolCapability,
    isAgentAppCommandName,
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

    it('publishes the semantic workspace command vocabulary', () => {
        expect(AGENT_APP_COMMANDS).toEqual([
            'get_app_state',
            'list_panels',
            'select_contract',
            'add_panel',
            'remove_panel',
            'set_panel_pin',
            'apply_layout',
        ]);
        expect(isAgentAppCommandName('select_contract')).toBe(true);
        expect(isAgentAppCommandName('click_at')).toBe(false);
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
