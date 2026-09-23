import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandNotAcknowledged, createCommandBus } from './main-window-commands';

// In-memory BroadcastChannel pair: a message posted by one end reaches all
// OTHER ends (like the real API). `drop` simulates a lost message.
function hub() {
    const ends: FakeChannel[] = [];
    let drop: ((data: unknown) => boolean) | null = null;
    class FakeChannel {
        listeners = new Set<(e: Event) => void>();
        constructor() { ends.push(this); }
        postMessage(data: unknown) {
            if (drop?.(data)) return;
            const copy = structuredClone(data);
            for (const end of ends) if (end !== this) {
                queueMicrotask(() => end.listeners.forEach(l => l({ data: copy } as MessageEvent)));
            }
        }
        addEventListener(_: string, l: (e: Event) => void) { this.listeners.add(l); }
        removeEventListener(_: string, l: (e: Event) => void) { this.listeners.delete(l); }
        close() {}
    }
    return { make: () => new FakeChannel() as unknown as BroadcastChannel, setDrop: (d: typeof drop) => { drop = d; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('main-window command bus', () => {
    it('executes in the main window and ACKs the popout', async () => {
        const h = hub();
        const handle = vi.fn((cmd: { n: number }) => cmd.n * 2);
        createCommandBus({ channel: h.make(), main: true, handle, snapshot: () => null });
        const popout = createCommandBus<{ n: number }, null>({ channel: h.make(), main: false, handle: vi.fn(), snapshot: () => null });
        const result = popout.send({ n: 21 });
        await vi.advanceTimersByTimeAsync(0);
        await expect(result).resolves.toBe(42);
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it('resends the SAME id when the ACK is lost and the main window applies it once', async () => {
        const h = hub();
        const handle = vi.fn(() => 'ok');
        createCommandBus({ channel: h.make(), main: true, handle, snapshot: () => null, newId: () => 'fixed' });
        let lostAcks = 1;
        h.setDrop(data => (data as { kind?: string }).kind === 'ack' && lostAcks-- > 0);
        const popout = createCommandBus({ channel: h.make(), main: false, handle: vi.fn(), snapshot: () => null, newId: () => 'cmd-1' });
        const result = popout.send({ op: 'add' });
        await vi.advanceTimersByTimeAsync(1600); // retry at 1500ms
        await expect(result).resolves.toBe('ok');
        expect(handle).toHaveBeenCalledTimes(1); // dedup by command id
    });

    it('never runs a popout command itself and reports "未確認" when the main window is absent', async () => {
        const h = hub();
        const local = vi.fn();
        const popout = createCommandBus({ channel: h.make(), main: false, handle: local, snapshot: () => null });
        const result = popout.send({ op: 'add' });
        const assertion = expect(result).rejects.toBeInstanceOf(CommandNotAcknowledged);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
        expect(local).not.toHaveBeenCalled();
    });

    it('propagates a main-window rejection as an error (not as success)', async () => {
        const h = hub();
        createCommandBus({ channel: h.make(), main: true, handle: () => { throw new Error('此 OCO 群組已觸發過'); }, snapshot: () => null });
        const popout = createCommandBus({ channel: h.make(), main: false, handle: vi.fn(), snapshot: () => null });
        const result = popout.send({});
        const assertion = expect(result).rejects.toThrow('此 OCO 群組已觸發過');
        await vi.advanceTimersByTimeAsync(0);
        await assertion;
    });

    it('mirrors the main snapshot to popouts on hello and publish', async () => {
        const h = hub();
        let state = { v: 1 };
        const mainBus = createCommandBus({ channel: h.make(), main: true, handle: vi.fn(), snapshot: () => state });
        const seen: unknown[] = [];
        createCommandBus({ channel: h.make(), main: false, handle: vi.fn(), snapshot: () => null, onState: s => seen.push(s) });
        await vi.advanceTimersByTimeAsync(0);
        state = { v: 2 };
        mainBus.publish();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([{ v: 1 }, { v: 2 }]);
    });

    it('main heartbeats its snapshot so a mirror can detect a stale copy', async () => {
        const h = hub();
        const mainBus = createCommandBus({ channel: h.make(), main: true, handle: vi.fn(), snapshot: () => 1, heartbeatMs: 5000 });
        const mirror = createCommandBus({ channel: h.make(), main: false, handle: vi.fn(), snapshot: () => null });
        await vi.advanceTimersByTimeAsync(0);
        const first = mirror.lastStateAt();
        expect(first).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(mirror.lastStateAt()).toBeGreaterThan(first);
        mainBus.close(); // executor gone: no more snapshots
        const last = mirror.lastStateAt();
        await vi.advanceTimersByTimeAsync(20000);
        expect(mirror.lastStateAt()).toBe(last);
    });
});

