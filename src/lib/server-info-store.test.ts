import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ServerInfo } from './shioaji';

const runtime = vi.hoisted(() => ({ base: 'server-a' }));
vi.mock('./runtime', () => ({ getApiBase: () => runtime.base }));
import {
    beginServerInfoRequest,
    observeServerInfo,
    subscribeServerInfo,
    useServerInfo,
    yesterdayQuantityNotice,
} from './server-info-store';

const simulation = { version: '1.7.5', simulation: true } as ServerInfo;
const production = { version: '1.7.5', simulation: false } as ServerInfo;
const newer = { version: '1.7.6', simulation: true } as ServerInfo;

async function mountProbe() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const seen: { info: ServerInfo | undefined } = { info: undefined };
    function Probe() { seen.info = useServerInfo(); return null; }
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(createElement(Probe)); });
    return {
        seen,
        rerender: () => act(async () => { root.update(createElement(Probe)); }),
        unmount: async () => { await act(async () => { root.unmount(); }); vi.unstubAllGlobals(); },
    };
}

it('warns in simulation unless the version is known fixed, without guessing values', () => {
    expect(yesterdayQuantityNotice({ version: '1.7.5', simulation: true })).toContain('模擬帳務');
    expect(yesterdayQuantityNotice({ version: '1.7.5', simulation: false })).toBeUndefined();
    // Sinotrade/Shioaji#233 still reproduces on a 1.7.6 simulation sidecar.
    expect(yesterdayQuantityNotice({ version: '1.7.6', simulation: true })).toContain('1.7.6 模擬帳務');
    expect(yesterdayQuantityNotice({ version: '1.7.6', simulation: false })).toBeUndefined();
    // Unknown/newer versions keep the warning until verified fixed.
    expect(yesterdayQuantityNotice({ version: '1.7.7', simulation: true })).toContain('1.7.7 模擬帳務');
    expect(yesterdayQuantityNotice({ version: '1.7.7', simulation: false })).toBeUndefined();
    expect(yesterdayQuantityNotice(undefined)).toContain('尚未取得');
});

it('drops a late failure from an older same-base request after a newer success', async () => {
    runtime.base = 'order-fail';
    const probe = await mountProbe();
    try {
        const slow = beginServerInfoRequest();
        const fast = beginServerInfoRequest();
        await act(async () => { observeServerInfo(fast, simulation); });
        expect(probe.seen.info).toBe(simulation);
        await act(async () => { observeServerInfo(slow, undefined); });
        expect(probe.seen.info).toBe(simulation);
    } finally { await probe.unmount(); }
});

it('drops a late success from an older same-base request after a newer success', async () => {
    runtime.base = 'order-success';
    const probe = await mountProbe();
    try {
        const slow = beginServerInfoRequest();
        const fast = beginServerInfoRequest();
        await act(async () => { observeServerInfo(fast, newer); });
        await act(async () => { observeServerInfo(slow, simulation); });
        expect(probe.seen.info).toBe(newer);
    } finally { await probe.unmount(); }
});

it('applies an older success while the newer request is still in flight, then lets the newer result win', async () => {
    runtime.base = 'order-inflight';
    const listener = vi.fn();
    const release = subscribeServerInfo(listener);
    const probe = await mountProbe();
    try {
        const first = beginServerInfoRequest();
        const second = beginServerInfoRequest();
        await act(async () => { observeServerInfo(first, simulation); });
        expect(probe.seen.info).toBe(simulation);
        expect(listener).toHaveBeenCalledTimes(1);
        await act(async () => { observeServerInfo(second, undefined); });
        expect(probe.seen.info).toBeUndefined();
        expect(yesterdayQuantityNotice(probe.seen.info)).toContain('待確認');
        expect(listener).toHaveBeenCalledTimes(2);
        release();
        await act(async () => { observeServerInfo(beginServerInfoRequest(), newer); });
        expect(probe.seen.info).toBe(newer);
        expect(listener).toHaveBeenCalledTimes(2);
    } finally { await probe.unmount(); }
});

it('keeps ordering per base and ignores late responses after a server switch', async () => {
    runtime.base = 'switch-a';
    const probe = await mountProbe();
    try {
        const onA = beginServerInfoRequest();
        await act(async () => { observeServerInfo(onA, simulation); });
        expect(probe.seen.info).toBe(simulation);
        const lateA = beginServerInfoRequest();
        runtime.base = 'switch-b';
        await probe.rerender();
        expect(probe.seen.info).toBeUndefined();
        const onB = beginServerInfoRequest();
        await act(async () => { observeServerInfo(lateA, newer); });
        expect(probe.seen.info).toBeUndefined();
        await act(async () => { observeServerInfo(onB, production); });
        expect(probe.seen.info).toBe(production);
        await act(async () => { observeServerInfo(lateA, undefined); });
        expect(probe.seen.info).toBe(production);
        // Switching back shows the last applied info for that base; the
        // dropped late-A response never landed, so it is still the first one.
        runtime.base = 'switch-a';
        await probe.rerender();
        expect(probe.seen.info).toBe(simulation);
    } finally { await probe.unmount(); }
});
