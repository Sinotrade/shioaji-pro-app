import { describe, expect, it } from 'vitest';
import { vars } from '../theme.css';
import { CUSTOM_BASES, CUSTOM_PRESETS, customTokens, isCustomTheme, mix } from './custom-theme';

describe('custom theme', () => {
    it('mixes colors and validates saved themes', () => {
        expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
        expect(isCustomTheme(CUSTOM_BASES.light)).toBe(true);
        expect(CUSTOM_PRESETS.every(p => isCustomTheme(p.theme))).toBe(true);
        expect(isCustomTheme({ ...CUSTOM_BASES.dark, accent: 'blue' })).toBe(false);
        expect(isCustomTheme({ ...CUSTOM_BASES.dark, base: 'midnight' })).toBe(false);
    });

    it('derives every token and follows the price-color convention', () => {
        const t = CUSTOM_PRESETS[0]!.theme;
        const tw = customTokens(t, 'tw');
        expect(tw.up).toBe(t.red);
        expect(tw.down).toBe(t.green);
        expect(customTokens(t, 'intl').up).toBe(t.green);
        expect(tw.background).toBe(t.background);
        expect(tw.border).toMatch(/^#[0-9a-f]{6}$/);
        expect(tw.accentDim).toMatch(/^rgba\(/);
    });

    it('covers every theme color token so custom themes never fall back to the base palette', () => {
        const t = CUSTOM_PRESETS[0]!.theme;
        for (const convention of ['tw', 'intl'] as const) {
            // amber 不在自訂六色內，刻意沿用基底主題
            const expected = Object.keys(vars.color).filter(k => k !== 'amber').sort();
            expect(Object.keys(customTokens(t, convention)).sort()).toEqual(expected);
        }
    });

    it('keeps status colors fixed regardless of the price-color convention', () => {
        const t = CUSTOM_PRESETS[0]!.theme;
        for (const convention of ['tw', 'intl'] as const) {
            const k = customTokens(t, convention);
            expect(k.success).toBe(t.green);
            expect(k.danger).toBe(t.red);
            expect(k.successDim).toMatch(/^rgba\(/);
            expect(k.dangerDim).toMatch(/^rgba\(/);
        }
    });
});
