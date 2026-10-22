import { describe, expect, it, vi } from 'vitest';
import { fmtPrice, fmtSigned } from './format';

const values = [undefined, '', null, 0, -0, -1234.5, 99999.995, 1e21, NaN, Infinity, -Infinity, '1234', '1.0856', '-0.0035', 'invalid'];
// 保存舊的數字格式契約，避免快取改變負零、捨入、非有限數或字串的輸出。
function oldPrice(value: unknown, digits?: number) {
    if (value === undefined || value === null || value === '') return '—';
    const number = Number(value);
    if (Number.isNaN(number)) return '—';
    const d = digits ?? (Math.abs(number) >= 500 ? 0 : 2);
    return number.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 2) });
}
function oldSigned(value: unknown, digits = 2) {
    if (value === undefined || value === null || value === '') return '—';
    const number = Number(value);
    if (Number.isNaN(number)) return '—';
    const text = number.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return number > 0 ? `+${text}` : text;
}

describe('數字格式快取的相容性', () => {
    it.each(values)('輸入 %s 在預設與 0 到 6 位小數下完全沿用舊輸出', value => {
        for (const digits of [undefined, 0, 1, 2, 3, 4, 5, 6]) {
            const input = value as number | string | undefined;
            expect(fmtPrice(input, digits)).toBe(oldPrice(value, digits));
            expect(fmtSigned(input, digits)).toBe(oldSigned(value, digits));
        }
    });

    it('相同小數位設定只建立一個 Intl.NumberFormat', async () => {
        vi.resetModules();
        const Original = Intl.NumberFormat;
        const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function(locales, options) {
            return new Original(locales, options);
        } as typeof Intl.NumberFormat);
        try {
            const cached = await import('./format');
            for (let index = 0; index < 20; index++) {
                cached.fmtPrice(1.0856, 4);
                cached.fmtSigned(0.0035, 4);
            }
            expect(spy).toHaveBeenCalledTimes(1);
        } finally { spy.mockRestore(); }
    });
});
