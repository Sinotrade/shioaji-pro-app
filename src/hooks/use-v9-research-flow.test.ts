import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SseTick } from '../lib/types/market';
import { useV9ResearchFlow } from './use-v9-research-flow';
const stream = vi.hoisted(() => ({ listeners: new Set<(tick: SseTick) => void>() }));
vi.mock('../lib/stream', () => ({
    onAnyTick: (listener: (tick: SseTick) => void) => {
        stream.listeners.add(listener);
        return () => stream.listeners.delete(listener);
    },
}));
let root: ReactTestRenderer | undefined;
let snapshot: ReturnType<typeof useV9ResearchFlow>;
function Probe({ code = '1528', minutes = 1, enabled = true }) {
    snapshot = useV9ResearchFlow(code, 'STK', minutes, enabled);
    return null;
}
function emit(patch: Partial<SseTick> = {}) {
    const tick = { code: '1528', date: '2026-09-18', time: '09:01:00.000001', volume: 1,
        total_volume: 1, tick_type: 1, ...patch } as SseTick;
    stream.listeners.forEach(listener => listener(tick));
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    expect(stream.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers(); vi.unstubAllGlobals();
});
it('clears pending batches on symbol change and does not leak old-symbol markers', async () => {
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { emit(); });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root!.update(createElement(Probe, { code: '6770' })));
    expect(vi.getTimerCount()).toBe(0);
    expect(snapshot.sampleCount).toBe(0);
    await act(async () => { emit(); emit({ code: '6770' }); vi.advanceTimersByTime(250); });
    expect(snapshot.sampleCount).toBe(1);
});
it('does not create a listener or timer outside V9 research mode', async () => {
    await act(async () => { root = create(createElement(Probe, { enabled: false })); });
    expect(stream.listeners.size).toBe(0);
});
it('excludes simulated, odd-lot and other-symbol ticks and deduplicates replay', async () => {
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => {
        emit({ simtrade: true }); emit({ intraday_odd: true }); emit({ code: '2330' });
        emit(); emit(); vi.advanceTimersByTime(250);
    });
    expect(snapshot.sampleCount).toBe(1);
});
it('rebuckets without resetting the stream baseline when the chart timeframe changes', async () => {
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => {
        for (let i = 0; i < 20; i++) emit({ total_volume: i + 1 });
        emit({ time: '09:01:01', volume: 10, total_volume: 30 });
        vi.advanceTimersByTime(250);
    });
    expect(snapshot.markers[0]?.text).toBe('大單偏買');
    const firstTime = snapshot.markers[0]!.time;
    await act(async () => root!.update(createElement(Probe, { minutes: 5 })));
    expect(snapshot.sampleCount).toBe(21);
    expect(snapshot.markers[0]!.time - firstTime).toBe(180);
    expect(stream.listeners.size).toBe(1);
});
