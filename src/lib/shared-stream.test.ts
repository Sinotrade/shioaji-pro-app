import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSharedStream, REMOTE_WANT_TTL_MS } from './shared-stream';

class Channel {
    static all = new Set<Channel>();
    listeners = new Set<(event: MessageEvent) => void>();
    constructor(public name: string) { Channel.all.add(this); }
    postMessage(data: unknown) {
        for (const other of Channel.all) if (other !== this && other.name === this.name)
            queueMicrotask(() => other.listeners.forEach(listener => listener({ data } as MessageEvent)));
    }
    addEventListener(_name: string, listener: (event: MessageEvent) => void) { this.listeners.add(listener); }
    removeEventListener(_name: string, listener: (event: MessageEvent) => void) { this.listeners.delete(listener); }
    close() { Channel.all.delete(this); }
}

const held = new Set<string>();
const locks = {
    async request(name: string, _options: unknown, callback: (lock: object | null) => unknown) {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({}); }
        finally { held.delete(name); }
    },
};

beforeEach(() => {
    vi.useFakeTimers();
    Channel.all.clear(); held.clear();
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.stubGlobal('navigator', { locks });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const make = (main: boolean) => {
    const own = vi.fn();
    const release = vi.fn();
    const wire = vi.fn();
    const remote = vi.fn<(keys: ReadonlySet<string>) => void>();
    const stream = createSharedStream({ name: 'fixture', main, onOwn: own, onRelease: release, onWire: wire, onMissing: vi.fn(), onRemoteWants: remote, snapshot: () => ({ kind: 'status', status: 'live', heartbeat: 1 }) });
    return { stream, own, release, wire, remote };
};
const lastWants = (w: { remote: { mock: { calls: [ReadonlySet<string>][] } } }) => [...(w.remote.mock.calls.at(-1)?.[0] ?? [])];

it('keeps one owner across nine windows and transfers within seconds on close', async () => {
    const main = make(true);
    const children = Array.from({ length: 8 }, () => make(false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(main.stream.isOwner()).toBe(true);
    expect(children.filter(child => child.stream.isOwner())).toHaveLength(0);
    main.stream.publish({ kind: 'event', name: 'tick_fop', raw: '{"code":"TXF"}' });
    await Promise.resolve();
    expect(children.every(child => child.wire.mock.calls.some(call => call[0].kind === 'event'))).toBe(true);
    main.stream.close();
    await vi.advanceTimersByTimeAsync(2500);
    expect(children.filter(child => child.stream.isOwner())).toHaveLength(1);
    children.forEach(child => child.stream.close());
});

it('hands a child-owned stream to a newly opened main window', async () => {
    const child = make(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(child.stream.isOwner()).toBe(true);
    const main = make(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(main.stream.isOwner()).toBe(true);
    expect(child.stream.isOwner()).toBe(false);
    expect(child.release).toHaveBeenCalledTimes(1);
    main.stream.close(); child.stream.close();
});

it('does not open a browser SSE when cross-window coordination is unavailable', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('navigator', {});
    const child = make(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.own).not.toHaveBeenCalled();
    expect(child.stream.isOwner()).toBe(false);
    child.stream.close();
});

it('routes a popout-only want to the owner, and drops it when the popout closes', async () => {
    const main = make(true);
    const child = make(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(main.stream.isOwner()).toBe(true);
    child.stream.want('us-quotes', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastWants(main)).toEqual(['us-quotes']);
    child.stream.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastWants(main)).toEqual([]);
    main.stream.close();
});

it('expires a want from a popout that vanished without saying goodbye', async () => {
    const main = make(true);
    make(false).stream.want('us-quotes', true);
    const childChannel = [...Channel.all][1]!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastWants(main)).toEqual(['us-quotes']);
    // 模擬崩潰：這個視窗不再送任何訊息（也沒有撤回）
    childChannel.postMessage = () => undefined;
    await vi.advanceTimersByTimeAsync(REMOTE_WANT_TTL_MS - 1000);
    expect(lastWants(main)).toEqual(['us-quotes']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastWants(main)).toEqual([]);
    main.stream.close();
});

it('a new owner learns existing popout wants after a handover', async () => {
    const main = make(true);
    const a = make(false);
    const b = make(false);
    await vi.advanceTimersByTimeAsync(1000);
    a.stream.want('us-quotes', true);
    b.stream.want('us-quotes', true);
    main.stream.close();
    await vi.advanceTimersByTimeAsync(2500);
    const owner = [a, b].find(w => w.stream.isOwner())!;
    // 新擁有者自己的訂閱由本地 refs 處理；另一個彈出視窗的需要要轉告到它
    expect(lastWants(owner)).toEqual(['us-quotes']);
    a.stream.close(); b.stream.close();
});
