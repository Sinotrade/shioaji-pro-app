import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('命令面板展開完整資訊後仍限制於視窗內，超出內容可捲動', () => {
    const source = readFileSync(new URL('./command-palette.css.ts', import.meta.url), 'utf8');
    expect(source).toContain("const paletteTop = 'clamp(0.5rem, calc((100vh - 20rem) / 2), 18vh)'");
    expect(source).toContain('paddingTop: paletteTop');
    const box = source.split('export const box = style({')[1]?.split('export const input')[0];
    expect(box).toContain('maxHeight: `calc(100vh - ${paletteTop} - 1rem)`');
    expect(box).toContain("display: 'flex'");
    expect(box).toContain("flexDirection: 'column'");
    expect(box).toContain("overflowX: 'hidden'");
    expect(box).toContain("overflowY: 'auto'");
    expect(box).toContain("overscrollBehavior: 'contain'");
    const results = source.split('export const results = style({')[1]?.split('const resultBase')[0];
    expect(results).toContain("minHeight: 'calc(2.4rem + 2px)'");
    expect(results).toContain("flex: '1 1 2.4rem'");
    expect(results).toContain("overflowY: 'auto'");
    for (const [start, end] of [['export const input', 'export const hint'], ['export const hint', 'const searchContainer']] as const) {
        expect(source.split(start)[1]?.split(end)[0]).toContain('flexShrink: 0');
        expect(source.split(start)[1]?.split(end)[0]).toContain("'(max-height: 360px)'");
    }
});

it('搜尋共用 surface 只在支援且允許透明時使用有界毛玻璃，文字不降透明度', () => {
    const source = readFileSync(new URL('./search-surface.css.ts', import.meta.url), 'utf8');
    expect(source).toContain('background: vars.color.panelRaised');
    expect(source).toContain('color: vars.color.foreground');
    expect(source).toContain('opacity: 1');
    expect(source).toContain("backdropFilter: 'blur(12px)'");
    expect(source).toContain('panelRaised} 90%, transparent');
    expect(source).toContain('@supports');
    expect(source).toContain('(prefers-reduced-transparency: no-preference) and (forced-colors: none)');
    expect(source).toContain('(prefers-reduced-transparency: reduce)');
    expect(source).toContain('(forced-colors: active)');
    expect(source).toContain("background: 'Canvas'");
    expect(source).toContain("color: 'CanvasText'");
    expect(source).not.toMatch(/animation|transition|setInterval|setTimeout|ResizeObserver/);
    for (const file of ['watchlist.css.ts', 'command-palette.css.ts']) {
        const css = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
        expect(css).toContain("from './search-surface.css'");
        expect(css.match(/\.\.\.searchSurface/g)).toHaveLength(1);
        expect(css).not.toContain('backdropFilter');
    }
});
