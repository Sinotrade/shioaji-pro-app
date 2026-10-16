import { describe, expect, it } from 'vitest';
import { CUSTOM_BASES, CUSTOM_PRESETS, customTokens, isCustomTheme, mix } from './custom-theme';

describe('custom theme', () => {
    it('內建基底與 preset 的引線色對面板對比至少 3:1', () => {
        // 只守 JS 推算與內建色票，不假裝驗證任意自訂色或另一份 CSS 公式。
        const luminance = (hex: string) => {
            const linear = [1, 3, 5].map(start => {
                const s = parseInt(hex.slice(start, start + 2), 16) / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
        };
        for (const theme of [...Object.values(CUSTOM_BASES), ...CUSTOM_PRESETS.map(preset => preset.theme)]) {
            for (const convention of ['tw', 'intl'] as const) {
                const tokens = customTokens(theme, convention);
                for (const key of ['wickUp', 'wickDown']) {
                    const values = [luminance(tokens[key]!), luminance(tokens.panel!)].sort((a, b) => a - b);
                    expect((values[1]! + 0.05) / (values[0]! + 0.05), `${theme.panel}/${convention}/${key}`).toBeGreaterThanOrEqual(3);
                }
            }
        }
    });

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

    it('引線色跟著自訂的漲跌色走：深底往次要文字色混一半、淺底往底色混兩成', () => {
        const darkTheme = { ...CUSTOM_BASES.dark, red: '#f23645', green: '#16b389' };
        const d = customTokens(darkTheme, 'tw');
        expect(d.wickUp).toBe(mix('#f23645', d.mutedForeground!, 0.5));
        expect(d.wickDown).toBe(mix('#16b389', d.mutedForeground!, 0.5));
        expect(customTokens(darkTheme, 'intl').wickUp).toBe(mix('#16b389', d.mutedForeground!, 0.5));
        const lightTheme = { ...CUSTOM_BASES.light, red: '#d6213a', panel: '#ffffff' };
        expect(customTokens(lightTheme, 'tw').wickUp).toBe('#de4d61');
        // 底色不是白色時也真的往底色混
        const tinted = customTokens({ ...CUSTOM_BASES.light, green: '#0a8a66', panel: '#f5f5f5' }, 'tw');
        expect(tinted.wickDown).toBe(mix('#0a8a66', '#f5f5f5', 0.2));
    });
});
