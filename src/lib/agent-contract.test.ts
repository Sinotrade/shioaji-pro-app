import { describe, expect, it } from 'vitest';

import {
    AGENT_APP_COMMANDS,
    AGENT_APP_TOOL_CAPABILITIES,
    AGENT_APP_TOOL_CONTRACT_VERSION,
    AGENT_APP_TOOL_EFFECTS,
    AGENT_RESTART_POLICY,
    isAgentAppToolCapability,
    isAgentAppCommandName,
} from './agent-contract';
import appToolSchema from '../../schemas/agent-app-tools-v1.schema.json';

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
        expect(AGENT_APP_TOOL_EFFECTS).toEqual(['read', 'mutation']);
        expect(appToolSchema.properties.contractVersion.const).toBe(
            AGENT_APP_TOOL_CONTRACT_VERSION,
        );
        expect(appToolSchema.properties.capability.enum).toEqual(
            AGENT_APP_TOOL_CAPABILITIES,
        );
        expect(appToolSchema.properties.name.maxLength).toBe(128);
        expect(
            appToolSchema.allOf[0]!.then.properties.inputSchema.properties
                .required.contains.const,
        ).toBe('idempotency_key');
        expect(appToolSchema.required).toContain('effect');
        expect(appToolSchema.properties.effect.enum).toEqual([
            'read',
            'mutation',
        ]);
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
