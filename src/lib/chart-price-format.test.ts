import { describe, expect, it, vi } from 'vitest';
import { chartPriceFormat, createPriceFormatSync } from './chart-price-format';

const US = { region: 'US' };
const TW = { region: 'TW' };

describe('chart price format', () => {
    it('TW stays 2 decimals; US follows the price ($1+ → 2, under $1 → 4, unknown → 2)', () => {
        expect(chartPriceFormat(TW, 0.5)).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
        expect(chartPriceFormat(US, 0.5)).toEqual({ type: 'price', precision: 4, minMove: 0.0001 });
        expect(chartPriceFormat(US, 98.08)).toMatchObject({ precision: 2 });
        expect(chartPriceFormat(US, null)).toMatchObject({ precision: 2 });
    });
    it('applies only on change and again after reset', () => {
        const apply = vi.fn();
        const s = createPriceFormatSync(apply);
        s.sync(US, 0.5);
        s.sync(US, 0.6);
        s.sync(US, 1.2);
        s.sync(TW, 1000);
        expect(apply.mock.calls.map((c) => c[0].precision)).toEqual([4, 2]);
        s.reset();
        s.sync(TW, 1000);
        expect(apply).toHaveBeenCalledTimes(3);
    });
});
