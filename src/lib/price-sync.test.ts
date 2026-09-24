// src/lib/price-sync.test.ts — #58 游標移動帶價開關：偏好持久化與帶價 gating

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: vi.fn((k: string, v: string) => void m.set(k, v)),
        dump: () => Object.fromEntries(m),
    };
}

async function load(storage: unknown) {
    vi.resetModules();
    vi.stubGlobal('localStorage', storage);
    const prefs = await import('./chart-price-prefs');
    const sync = await import('./price-sync');
    return { ...prefs, ...sync };
}

describe('chart hover price pick (#58)', () => {
    beforeEach(() => vi.unstubAllGlobals());
    afterEach(() => vi.unstubAllGlobals());

    it('defaults OFF: hovering never changes the ticket price, clicking still does', async () => {
        const m = await load(memoryStorage());
        expect(m.getChartHoverPricePick()).toBe(false);
        expect(m.setHoverPickedPrice('TXFJ6', 45000)).toBe(false);
        expect(m.getPickedPrice()).toBeNull();
        m.setPickedPrice('TXFJ6', 45010);
        expect(m.getPickedPrice()).toMatchObject({ code: 'TXFJ6', price: 45010 });
        // further hovering at other levels keeps the clicked price
        m.setHoverPickedPrice('TXFJ6', 44990);
        expect(m.getPickedPrice()?.price).toBe(45010);
    });

    it('stored opt-in restores the legacy hover behaviour with same-tick dedupe', async () => {
        const m = await load(memoryStorage({ 'sj-pro-chart-hover-price': '1' }));
        expect(m.getChartHoverPricePick()).toBe(true);
        expect(m.setHoverPickedPrice('TXFJ6', 45000)).toBe(true);
        const seq = m.getPickedPrice()!.seq;
        expect(m.setHoverPickedPrice('TXFJ6', 45000)).toBe(false);
        expect(m.getPickedPrice()!.seq).toBe(seq);
        expect(m.setHoverPickedPrice('TXFJ6', 45001)).toBe(true);
    });

    it('a click at the same price re-publishes so a manually edited ticket is overwritten again', async () => {
        const m = await load(memoryStorage());
        m.setPickedPrice('2330', 1000);
        const first = m.getPickedPrice()!;
        m.setPickedPrice('2330', 1000);
        const second = m.getPickedPrice()!;
        expect(second.price).toBe(1000);
        expect(second.seq).toBe(first.seq + 1);
        expect(second).not.toBe(first); // ticket effect keys on identity
    });

    it('toggle persists and takes effect immediately', async () => {
        const storage = memoryStorage();
        const m = await load(storage);
        const seen: boolean[] = [];
        m.setChartHoverPricePick(true);
        seen.push(m.getChartHoverPricePick());
        expect(storage.dump()[m.CHART_HOVER_PRICE_KEY]).toBe('1');
        expect(m.setHoverPickedPrice('TXFJ6', 45000)).toBe(true);
        m.setChartHoverPricePick(false);
        seen.push(m.getChartHoverPricePick());
        expect(storage.dump()[m.CHART_HOVER_PRICE_KEY]).toBe('0');
        expect(m.setHoverPickedPrice('TXFJ6', 45005)).toBe(false);
        expect(seen).toEqual([true, false]);

        const reloaded = await load(storage);
        expect(reloaded.getChartHoverPricePick()).toBe(false);
    });

    it('unavailable storage falls back to OFF and keeps the choice for the session', async () => {
        const throwing = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        const m = await load(throwing);
        expect(m.getChartHoverPricePick()).toBe(false);
        m.setChartHoverPricePick(true);
        expect(m.getChartHoverPricePick()).toBe(true);
        expect(m.setHoverPickedPrice('TXFJ6', 45000)).toBe(true);
    });

    it('unknown stored values are treated as OFF', async () => {
        const m = await load(memoryStorage({ 'sj-pro-chart-hover-price': 'true' }));
        expect(m.getChartHoverPricePick()).toBe(false);
    });
});
