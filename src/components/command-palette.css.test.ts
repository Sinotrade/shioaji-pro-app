import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';

let css: string;
let classes: typeof import('./command-palette.css');

function declarations(className: string) {
    const body = new RegExp(`\\.${className.split(' ')[0]}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
    if (body === undefined) throw new Error(`找不到 ${className} 的編譯結果`);
    return Object.fromEntries(body.split(';').flatMap(part => {
        const colon = part.indexOf(':');
        return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
    }));
}

beforeAll(async () => {
    const built = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [vanillaExtractPlugin({ identifiers: 'debug' })],
        build: { write: false, minify: false, cssCodeSplit: false, lib: {
            entry: path.resolve('src/components/command-palette.css.ts'), formats: ['es'],
        } },
    });
    const output = (Array.isArray(built) ? built : [built]).flatMap(bundle => 'output' in bundle ? bundle.output : []);
    const asset = output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'));
    if (!asset || asset.type !== 'asset') throw new Error('命令面板 CSS 編譯沒有產出樣式');
    css = String(asset.source);
    classes = await import('./command-palette.css');
}, 30_000);

// jsdom 不做 flex 排版；真實幾何在瀏覽器量，這裡鎖住造成回歸的宣告。
describe('command palette result list sizing', () => {
    it('sizes the list from its rows, not from a one-row flex basis', () => {
        // The box height is content-driven: a fixed basis would leave one row visible.
        expect(declarations(classes.results).flex).toBe('0 1 auto');
    });

    it('keeps the selected row reachable when details or a short window squeeze the list', () => {
        const rule = declarations(classes.results);
        expect(rule['min-height']).toContain('2.4rem');
        expect(rule['overflow-y']).toBe('auto');
        expect(rule['max-height']).toBe('18rem');
    });
});
