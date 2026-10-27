import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { build, type ResolvedConfig } from 'vite';

describe('正式 CSS 編譯的 Chromium／Safari 相容性', () => {
    let css = '';
    let javascriptTarget: ResolvedConfig['build']['target'];

    beforeAll(async () => {
        const root = path.resolve(import.meta.dirname, '..');
        const result = await build({
            root,
            configFile: path.join(root, 'vite.config.ts'),
            logLevel: 'silent',
            plugins: [{ name: 'capture-css-compatibility-config', configResolved(config) { javascriptTarget = config.build.target; } }],
            build: {
                write: false,
                // Compile the real search surface without building or replacing the App bundle.
                rolldownOptions: { input: path.join(root, 'src/components/watchlist.css.ts') },
            },
        });
        const bundles = Array.isArray(result) ? result : [result];
        css = bundles.flatMap(bundle => {
            if (!('output' in bundle)) throw new Error('Expected a non-watch Vite build');
            return bundle.output.flatMap(file => file.type === 'asset' && file.fileName.endsWith('.css')
                ? [typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)] : []);
        }).join('\n');
        expect(css.length).toBeGreaterThan(0);
    }, 30_000);

    it('真正產出的 CSS 同時保留標準與 WebKit blur 宣告，不只保留 @supports 條件', () => {
        expect(/[;{]backdrop-filter:blur\(12px\)/.test(css), 'Standard blur declaration is missing from emitted CSS').toBe(true);
        expect(/[;{]-webkit-backdrop-filter:blur\(12px\)/.test(css), 'WebKit blur declaration is missing from emitted CSS').toBe(true);
    });

    it('搜尋結果列編譯後仍是不換行的單行 flex，代碼、名稱與補充以省略號截斷', () => {
        const rules = [...css.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]!.split(';'));
        expect(rules.some(rule => rule.includes('display:flex') && rule.includes('flex-wrap:nowrap')), 'No single-line flex row').toBe(true);
        const truncated = rules.filter(rule => ['overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap'].every(part => rule.includes(part)));
        expect(truncated.length, 'Code, name and detail cells should each truncate').toBeGreaterThanOrEqual(3);
    });

    it('JavaScript 仍維持 ES2020 與 Safari 13 目標', () => {
        expect(javascriptTarget).toEqual(['es2020', 'safari13']);
    });
});
