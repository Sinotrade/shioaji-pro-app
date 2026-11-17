import { describe, expect, it, vi } from 'vitest';
import { createPinSetter, resolveInputContract } from './pin-input';
import type { ContractInfo } from './types/contract';

const us = (code: string) => ({ code, region: 'US' }) as ContractInfo;
const tw = (code: string) => ({ code, region: 'TW' }) as ContractInfo;

describe('pin input', () => {
    it('falls back to US for a typed ticker TW cannot resolve', async () => {
        const ensure = vi.fn(async (k: string) => { if (k === 'AAPL') throw new Error('404'); return k.startsWith('US:') ? us('AAPL') : tw(k); });
        expect((await resolveInputContract('AAPL', ensure)).region).toBe('US');
        await expect(resolveInputContract('9999', vi.fn(async () => { throw new Error('404'); }))).rejects.toThrow('404');
    });

    it('a late US lookup never overwrites a newer pin or unpin', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const ensure = vi.fn(async (k: string) => {
            if (k === 'AAPL') throw new Error('404');
            await gate;
            return us('AAPL');
        });
        const store = vi.fn();
        const set = createPinSetter({ ensure, cached: () => undefined, store });
        const pending = set('flash-1', 'AAPL');
        await set('flash-1', '2317');
        release();
        await pending;
        expect(store.mock.calls).toEqual([['flash-1', '2317']]);

        const store2 = vi.fn();
        let release2!: () => void;
        const gate2 = new Promise<void>(r => { release2 = r; });
        const set2 = createPinSetter({ ensure: async (k) => { if (k === 'AAPL') throw new Error('404'); await gate2; return us('AAPL'); }, cached: () => undefined, store: store2 });
        const p2 = set2('t', 'AAPL');
        await set2('t', null);
        release2();
        await p2;
        expect(store2.mock.calls).toEqual([['t', null]]);
    });

    it('stores US:CODE when the lookup is still current', async () => {
        const store = vi.fn();
        const set = createPinSetter({ ensure: async (k) => { if (k === 'AAPL') throw new Error('404'); return us('AAPL'); }, cached: () => undefined, store });
        await set('x', 'AAPL');
        expect(store).toHaveBeenCalledWith('x', 'US:AAPL');
    });
});
