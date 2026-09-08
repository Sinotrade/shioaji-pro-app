import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeIndicatorCommand, INDICATOR_REQUEST_EVENT, INDICATOR_RESPONSE_EVENT, registerIndicatorCommandHost } from './indicator-command';
import { IndicatorInstanceService, initializeIndicatorPanels } from './indicator-instance-service';

function setup() {
    let workspace = initializeIndicatorPanels({ blocks: [{ id: 'a', type: 'chart', pin: null }], layout: [] });
    const service = new IndicatorInstanceService({ getWorkspace: () => workspace, updateWorkspace: next => { workspace = next; } });
    const unmount = service.registerPanel('a');
    service.focus('a');
    return { service, unmount };
}
beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} }); });
afterEach(() => vi.unstubAllGlobals());

describe('indicator command boundary', () => {
    it('bounds and detaches paginated reads and returns the exact revision', () => {
        const { service } = setup();
        for (let i = 0; i < 25; i++) service.mount('a', 'sma', { period: i + 1 });
        const page = executeIndicatorCommand(service, 'list_indicator_instances', {}) as { instances: { params: Record<string, number> }[]; revision: string; page: object };
        expect(page.page).toEqual({ offset: 0, limit: 20, returned: 20, total: 25, hasMore: true });
        expect(page.revision).toBe(service.snapshot('a').revision);
        page.instances[0]!.params.period = 500;
        expect(service.snapshot('a').instances[0]!.params.period).toBe(1);
        expect(executeIndicatorCommand(service, 'list_indicator_instances', { offset: 20, limit: 10 })).toMatchObject({ page: { returned: 5, hasMore: false } });
        expect(executeIndicatorCommand(service, 'list_indicator_instances', { offset: 100, limit: 10 })).toMatchObject({ instances: [], page: { returned: 0, hasMore: false } });
        expect(() => executeIndicatorCommand(service, 'list_indicator_instances', { limit: 101 })).toThrow(/limit/);
        expect(() => executeIndicatorCommand(service, 'list_indicator_instances', { limit: 0 })).toThrow(/limit/);
        expect(() => executeIndicatorCommand(service, 'list_indicator_instances', { offset: -1 })).toThrow(/offset/);
    });

    it('caps panel storage at 100 instances without altering the last valid revision', () => {
        const { service } = setup();
        for (let i = 0; i < 100; i++) executeIndicatorCommand(service, 'mount_indicator', { indicator_type: 'sma' });
        const before = structuredClone(service.snapshot('a'));
        expect(() => executeIndicatorCommand(service, 'mount_indicator', { indicator_type: 'sma' })).toThrow(/100/);
        expect(service.snapshot('a')).toEqual(before);
    });

    it.each([
        ['mount_indicator', { indicator_type: 'sma', unknown: true }],
        ['mount_indicator', { indicator_type: 'sma', params: { period: '2' } }],
        ['mount_indicator', { indicator_type: 'sma', panel_id: '' }],
        ['update_indicator_instance', { instance_id: 'any' }],
        ['update_indicator_instance', { instance_id: 'any', hidden: 'true' }],
        ['update_indicator_instance', { instance_id: 'any', index: 0.5 }],
        ['bogus', {}],
    ])('rejects malformed %s without modifying panel', (name, args) => {
        const { service } = setup();
        const before = structuredClone(service.snapshot('a'));
        expect(() => executeIndicatorCommand(service, name as string, args)).toThrow();
        expect(service.snapshot('a')).toEqual(before);
    });

    it('replays mutations by idempotency key across new request IDs and fails conflicting reuse', () => {
        const { service, unmount } = setup();
        const target = new EventTarget();
        const stop = registerIndicatorCommandHost(target, service);
        const responses: Record<string, unknown>[] = [];
        target.addEventListener(INDICATOR_RESPONSE_EVENT, e => responses.push((e as CustomEvent).detail));
        const send = (requestId: string, args: object, name = 'mount_indicator') => {
            target.dispatchEvent(new CustomEvent(INDICATOR_REQUEST_EVENT, { detail: { requestId, command: { name, args } } }));
            return responses.at(-1)!;
        };
        const args = { indicator_type: 'sma', params: { period: 2 }, idempotency_key: 'operation-1' };
        const first = send('request-1', args);
        expect(first).toMatchObject({ ok: true, requestId: 'request-1', result: { panel_id: 'a', instance: { params: { period: 2 } } } });
        const replay = send('request-2', args);
        expect(replay).toEqual({ ...first, requestId: 'request-2' });
        expect(service.snapshot('a').instances).toHaveLength(1);
        expect(send('request-3', { ...args, params: { period: 3 } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(send('request-4', { indicator_type: 'sma' })).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
        unmount();
        expect(send('request-5', {}, 'list_indicator_instances')).toMatchObject({ ok: false, error: { code: 'not_found' } });
        stop();
        const count = responses.length;
        send('request-6', args);
        expect(responses).toHaveLength(count);
    });

    it('returns stale-revision failures without removing or overwriting the instance', () => {
        const { service } = setup();
        const item = service.mount('a', 'sma', { period: 2 });
        service.update('a', item.instance.id, { params: { period: 3 } });
        expect(() => executeIndicatorCommand(service, 'update_indicator_instance', { instance_id: item.instance.id, expected_revision: item.revision, hidden: true })).toThrow(/changed/);
        expect(() => executeIndicatorCommand(service, 'remove_indicator_instance', { instance_id: item.instance.id, expected_revision: item.revision })).toThrow(/changed/);
        expect(service.snapshot('a').instances[0]).toMatchObject({ params: { period: 3 } });
    });
});
