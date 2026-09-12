import { existsSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerIndicatorCommandHost } from './indicator-command';
import { IndicatorInstanceService, initializeIndicatorPanels } from './indicator-instance-service';

// This cross-repo regression runs in composite CI. Public-only CI has no
// private provider bridge; keep the public host tests active there as usual.
const bridgePath = '../../modules/agent/lib/app-tool-bridge';
const storesPath = '../../modules/agent/lib/app-tool-idempotency';
const approvalsPath = '../../modules/agent/lib/approvals';
const hasOverlay = existsSync(new URL('../../modules/agent/lib/app-tool-bridge.ts', import.meta.url));

let cleanup = () => {};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe.skipIf(!hasOverlay)('native bridge to real indicator host', () => {
    beforeAll(() => {
        const storage = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        });
    });

    it('lists, mounts, updates and confirms removal without leaking native call metadata', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        const { NativeAppToolBridge } = await import(bridgePath);
        const { AppToolMutationIdempotency } = await import(storesPath);
        const { resolveApproval } = await import(approvalsPath);
        let workspace = initializeIndicatorPanels({ blocks: [
            { id: 'chart-a', type: 'chart', pin: null, indicatorState: { revision: 'a0', instances: [] } },
            { id: 'chart-b', type: 'chart', pin: null, indicatorState: { revision: 'b0', instances: [] } },
        ], layout: [] });
        const service = new IndicatorInstanceService({ getWorkspace: () => workspace,
            updateWorkspace: next => { workspace = next; } });
        service.registerPanel('chart-a');
        service.registerPanel('chart-b');
        service.focus('chart-a');
        cleanup = registerIndicatorCommandHost(target, service);
        const approvals: string[] = [];
        const bridge = new NativeAppToolBridge({
            providerLabel: 'integration', policy: 'readonly', permission: 'auto_safe',
            signal: new AbortController().signal, runtimeScope: () => 'integration-runtime',
            emit: (blocks: Array<{ type: string; id?: string }>) => {
                for (const block of blocks) if (block.type === 'approval' && block.id) {
                    approvals.push(block.id);
                    // Approval changes focus, proving removal remains bound to A.
                    service.focus('chart-b');
                    setTimeout(() => resolveApproval(block.id, true), 0);
                }
            },
            mutationStores: { trade: new AppToolMutationIdempotency(), local: new AppToolMutationIdempotency() },
        });
        expect((await bridge.call('list_indicator_instances', {}, 'list-before')).success).toBe(true);
        const args = { panel_id: 'chart-a', indicator_type: 'sma', params: { period: 5 }, idempotency_key: 'mount-one' };
        const mounted = await bridge.call('mount_indicator', args, 'mount');
        expect(mounted.success).toBe(true);
        expect((await bridge.call('mount_indicator', args, 'mount-replay')).result).toEqual(mounted.result);
        expect(service.snapshot('chart-a').instances).toHaveLength(1);
        const updated = await bridge.call('update_indicator_instance', {
            panel_id: 'chart-a', instance_id: mounted.result.instance.id,
            params: { period: 10 }, hidden: true, expected_revision: mounted.result.revision,
            idempotency_key: 'update-one',
        }, 'update');
        expect(updated.success).toBe(true);
        expect(service.snapshot('chart-a').instances[0]).toMatchObject({ params: { period: 10 }, hidden: true });
        const removed = await bridge.call('remove_indicator_instance', {
            instance_id: mounted.result.instance.id, expected_revision: updated.result.revision,
            idempotency_key: 'remove-one',
        }, 'remove');
        expect(removed.success).toBe(true);
        expect(approvals).toHaveLength(1);
        expect(service.snapshot('chart-a').instances).toEqual([]);
        expect(service.snapshot('chart-b')).toEqual({ revision: 'b0', instances: [] });
    });
});
