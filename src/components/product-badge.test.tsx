import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_BADGES, PRODUCT_BADGE_ALPHA, PRODUCT_SEARCH_ACTIVE, productBadgeType, productDetailText } from '../lib/product-badge-presentation';
import { CUSTOM_PRESETS, customTokens } from '../lib/custom-theme';
import { ProductBadge } from './product-badge';

let view: ReactTestRenderer | undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { act(() => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

type RGB = [number, number, number];
function rgb(hex: string): RGB {
    return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as RGB;
}
function composite(top: RGB, bottom: RGB, alpha: number): RGB {
    return top.map((value, index) => value * alpha + bottom[index]! * (1 - alpha)) as RGB;
}
function over(value: string, bottom: RGB): RGB {
    if (value.startsWith('#')) return rgb(value);
    const parts = value.match(/[\d.]+/g)!.map(Number);
    return composite(parts.slice(0, 3) as RGB, bottom, parts[3]!);
}
function luminance(rgb: RGB) {
    const channels = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(first: RGB, second: RGB) {
    const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (high! + 0.05) / (low! + 0.05);
}

// Read the actual base palettes, then apply the same custom overrides as theme-store.
// Custom themes inherit amber from their base; price convention must not affect badge tones.
const themeSource = readFileSync(new URL('../theme.css.ts', import.meta.url), 'utf8');
const basePalette = (mode: 'dark' | 'light'): Record<string, string> => Object.fromEntries(
    [...themeSource.match(new RegExp(`const ${mode}: Palette = \\{([\\s\\S]*?)\\n\\};`))![1]!.matchAll(/(\w+): '([^']+)'/g)]
        .map(match => [match[1]!, match[2]!]),
);
const themes = (['tw', 'intl'] as const).flatMap(convention => [
    ...(['dark', 'light'] as const).map(mode => ({ name: `${mode}-${convention}`, palette: basePalette(mode) })),
    ...CUSTOM_PRESETS.map(preset => ({ name: `${preset.name}-${convention}`, palette: { ...basePalette(preset.theme.base), ...customTokens(preset.theme, convention) } })),
]);

describe('純顯示商品標籤', () => {
    it.each([
        ['STK', undefined, 'STK', '股票'], ['STK', 'ETF', 'ETF', 'ETF'],
        ['FUT', undefined, 'FUT', '期貨'], ['OPT', undefined, 'OPT', '選擇權'],
        ['WRT', undefined, 'WRT', '權證'], ['IND', undefined, 'IND', '指數'],
    ] as const)('%s / %s 使用完整標籤 %s', (security_type, kind, type, label) => {
        expect(productBadgeType(security_type, kind)).toBe(type);
        act(() => { view = create(createElement(ProductBadge, { security_type, kind })); });
        expect(view!.root.findByType('span').children).toEqual([label]);
    });

    it.each(['FUT', 'OPT', 'WRT', 'IND'] as const)('ETF kind 不可覆蓋 %s 的合約型別', type => {
        expect(productBadgeType(type, 'ETF')).toBe(type);
    });

    it.each([
        ['ETF', 'STK', 'ETF', ''],
        ['ETF · 直接代碼', 'STK', 'ETF', '直接代碼'],
        ['期貨 · 近月', 'FUT', undefined, '近月'],
        ['期貨 · 次月', 'FUT', undefined, '次月'],
        ['選擇權 · TXO · 202611', 'OPT', undefined, 'TXO · 202611'],
        ['權證 · 2027-04-07 · 交易日期待確認', 'WRT', undefined, '2027-04-07 · 交易日期待確認'],
        ['認購 · 2027-04-07 · 交易日期待確認', 'WRT', undefined, '認購 · 2027-04-07 · 交易日期待確認'],
        ['認售 · 2027-04-07', 'WRT', undefined, '認售 · 2027-04-07'],
        ['ETF · 近月', 'FUT', 'ETF', 'ETF · 近月'],
        ['ETF', 'STK', undefined, 'ETF'],
        ['ETF連結 · 直接代碼', 'STK', 'ETF', 'ETF連結 · 直接代碼'],
        ['其他 · ETF', 'STK', 'ETF', '其他 · ETF'],
        ['期貨名稱 ETF', 'FUT', undefined, '期貨名稱 ETF'],
        ['期貨· 近月', 'FUT', undefined, '期貨· 近月'],
        [' 期貨 · 近月', 'FUT', undefined, ' 期貨 · 近月'],
    ] as const)('detail 只去除 typed label 的精確重複：%s / %s', (detail, securityType, kind, expected) => {
        expect(productDetailText(detail, securityType, kind)).toBe(expected);
    });

    it.each(themes.flatMap(theme => (['normal', 'selected', 'hover'] as const).map(state => ({ ...theme, state }))))(
        '$name / $state：合成文字對比至少 4.5:1；色調僅驗數值相異，分類以文字為準', ({ palette, state }) => {
            const panel = rgb(palette.panelRaised!);
            const row = state === 'selected' ? over(palette[PRODUCT_SEARCH_ACTIVE.background]!, panel)
                : state === 'hover' ? rgb(palette.muted!) : panel;
            const text = rgb(palette.foreground!);
            // Row/detail text and transparent color-mix fallback share the same foreground/background.
            expect(contrast(text, row), '列文字與透明 fallback 共用 foreground').toBeGreaterThanOrEqual(4.5);
            const tints = new Set<string>();
            for (const [type, presentation] of Object.entries(PRODUCT_BADGES)) {
                const tint = 'blend' in presentation ? composite(rgb(palette[presentation.tint]!), rgb(palette[presentation.blend]!), presentation.tintPercent / 100)
                    : rgb(palette[presentation.tint]!);
                tints.add(tint.map(value => value.toFixed(3)).join(','));
                // normal: panelRaised → badge fill; selected: panelRaised → accentDim → badge fill.
                const fill = composite(tint, row, PRODUCT_BADGE_ALPHA.fill / 100);
                expect(contrast(text, fill), type).toBeGreaterThanOrEqual(4.5);
                // Numeric inequality catches identical paint, not human-perceptual distinction.
                const edge = composite(tint, fill, PRODUCT_BADGE_ALPHA.edge / 100);
                expect(edge, `${type} 邊框僅驗數值不等於列底色`).not.toEqual(row);
            }
            expect(tints.size, '六色調僅數值相異，不代表肉眼可分；分類以文字標籤為準').toBe(6);
        },
    );

    it('色卡透明度與選取列配色維持對比度測試所驗的 token', () => {
        expect(PRODUCT_BADGE_ALPHA).toEqual({ fill: 12, edge: 45 });
        expect(PRODUCT_SEARCH_ACTIVE).toEqual({ background: 'accentDim', color: 'foreground', indicator: 'accent' });
    });
});
