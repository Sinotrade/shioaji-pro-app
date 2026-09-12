import { IndicatorControlError, type IndicatorInstanceService } from './indicator-instance-service';

export const INDICATOR_REQUEST_EVENT = 'shioaji-pro:indicator-command:request';
export const INDICATOR_RESPONSE_EVENT = 'shioaji-pro:indicator-command:response';
const names = ['mount_indicator', 'list_indicator_instances', 'update_indicator_instance', 'remove_indicator_instance'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (message: string): never => { throw new IndicatorControlError('invalid_arguments', message); };
function string(v: unknown, name: string): string {
    if (typeof v !== 'string' || !v.trim() || v.length > 128) return invalid(`Invalid ${name}`);
    return v;
}
function integer(v: unknown, name: string, max: number): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) return invalid(`Invalid ${name}`);
    return v;
}
function parameters(v: unknown): Record<string, number> {
    if (!record(v) || Object.keys(v).length > 64 || Object.entries(v).some(([k, x]) => k.length > 64 || typeof x !== 'number' || !Number.isFinite(x))) return invalid('Invalid params');
    return v as Record<string, number>;
}

export function executeIndicatorCommand(service: IndicatorInstanceService, name: string, input: unknown) {
    if (!record(input)) return invalid('Expected object arguments');
    const common = ['panel_id', 'idempotency_key'];
    const extra: Record<string, string[]> = {
        mount_indicator: ['indicator_type', 'params'],
        list_indicator_instances: ['offset', 'limit'],
        update_indicator_instance: ['instance_id', 'expected_revision', 'params', 'hidden', 'index'],
        remove_indicator_instance: ['instance_id', 'expected_revision'],
    };
    if (!names.includes(name) || Object.keys(input).some(k => ![...common, ...extra[name]!].includes(k))) return invalid('Unsupported command or argument');
    const id = service.resolvePanel(input.panel_id === undefined ? undefined : string(input.panel_id, 'panel_id'));
    const expected = input.expected_revision === undefined ? undefined : string(input.expected_revision, 'expected_revision');
    switch (name) {
        case 'mount_indicator': return service.mount(id, string(input.indicator_type, 'indicator_type'), input.params === undefined ? {} : parameters(input.params));
        case 'list_indicator_instances': {
            const state = service.snapshot(id);
            const offset = input.offset === undefined ? 0 : integer(input.offset, 'offset', 10000);
            const limit = input.limit === undefined ? 20 : integer(input.limit, 'limit', 100);
            if (limit === 0) return invalid('limit must be positive');
            const instances = structuredClone(state.instances.slice(offset, offset + limit));
            return { panel_id: id, revision: state.revision, instances, page: { offset, limit, returned: instances.length, total: state.instances.length, hasMore: offset + instances.length < state.instances.length } };
        }
        case 'update_indicator_instance': {
            if (input.hidden !== undefined && typeof input.hidden !== 'boolean') return invalid('Invalid hidden');
            if (input.params === undefined && input.hidden === undefined && input.index === undefined) return invalid('No update supplied');
            return service.update(id, string(input.instance_id, 'instance_id'), {
                ...(input.params === undefined ? {} : { params: parameters(input.params) }),
                ...(input.hidden === undefined ? {} : { hidden: input.hidden as boolean }),
                ...(input.index === undefined ? {} : { index: integer(input.index, 'index', 99) }),
            }, expected);
        }
        case 'remove_indicator_instance': return service.remove(id, string(input.instance_id, 'instance_id'), expected);
    }
}

// This host exists only in the native Harness-enabled workspace. The native
// tool boundary grants ui.control and obtains content-removal approval.
export function registerIndicatorCommandHost(target: EventTarget, service: IndicatorInstanceService) {
    const completed = new Map<string, { fingerprint: string; response: unknown }>();
    const listener = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const request = event.detail;
        if (!record(request) || typeof request.requestId !== 'string' || !record(request.command)) return;
        const { requestId } = request;
        const { name, args } = request.command;
        const respond = (response: unknown) => target.dispatchEvent(new CustomEvent(INDICATOR_RESPONSE_EVENT, { detail: response }));
        const failure = (e: unknown) => ({ requestId, command: name, ok: false, error: { code: e instanceof IndicatorControlError ? e.code : 'internal_error', message: e instanceof Error ? e.message : 'Indicator command failed' } });
        try {
            string(requestId, 'requestId');
            if (typeof name !== 'string' || !names.includes(name)) return respond(failure(new IndicatorControlError('unsupported', 'Unsupported indicator command')));
            const fingerprint = JSON.stringify(request.command);
            const mutationKey = name === 'list_indicator_instances' ? requestId : string(record(args) ? args.idempotency_key : undefined, 'idempotency_key');
            const previous = completed.get(mutationKey);
            if (previous) {
                return respond(previous.fingerprint === fingerprint ? { ...(previous.response as object), requestId } : failure(new IndicatorControlError('conflict', 'idempotency_key reused with different arguments')));
            }
            if (name !== 'list_indicator_instances' && completed.size >= 1000) return invalid('Indicator mutation capacity exhausted');
            let response: unknown;
            try { response = { requestId, command: name, ok: true, result: executeIndicatorCommand(service, name, args) }; }
            catch (e) { response = failure(e); }
            if (name !== 'list_indicator_instances') completed.set(mutationKey, { fingerprint, response });
            respond(response);
        } catch (e) { respond(failure(e)); }
    };
    target.addEventListener(INDICATOR_REQUEST_EVENT, listener);
    return () => target.removeEventListener(INDICATOR_REQUEST_EVENT, listener);
}
