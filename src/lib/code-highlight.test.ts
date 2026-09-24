import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    HIGHLIGHT_MAX_LINES,
    highlightCode,
    resolveHighlightLanguage,
} from './code-highlight';

const html = (code: string, lang?: string) => {
    const out = highlightCode(code, lang);
    return out === null ? null : renderToStaticMarkup(createElement('code', null, ...out));
};

describe('code highlight', () => {
    it('known languages and aliases produce hljs spans', () => {
        const out = html('import shioaji as sj\nprint(1)', 'python')!;
        expect(out).toContain('<span class="hljs-keyword">import</span>');
        expect(html('const a = 1;', 'ts')).toContain('hljs-keyword');
        expect(html('[server]\nport = 21323', 'toml')).toContain('hljs-');
        expect(resolveHighlightLanguage('sh')).toBe('bash');
        expect(resolveHighlightLanguage('YML')).toBe('yaml');
    });

    it('unknown or missing language falls back to plain text', () => {
        expect(highlightCode('x', 'cobol')).toBeNull();
        expect(highlightCode('x', '')).toBeNull();
        expect(highlightCode('x')).toBeNull();
    });

    it('skips blocks longer than the line limit', () => {
        const long = Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, (_, i) => `x = ${i}`).join('\n');
        expect(highlightCode(long, 'python')).toBeNull();
        const ok = Array.from({ length: HIGHLIGHT_MAX_LINES }, (_, i) => `x = ${i}`).join('\n');
        expect(highlightCode(ok, 'python')).not.toBeNull();
    });

    it('escapes code text (no markup injection)', () => {
        const out = html('s = "<img src=x onerror=alert(1)>"</span><script>alert(1)</script>', 'python')!;
        expect(out).not.toContain('<img');
        expect(out).not.toContain('<script>');
        expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(out).toContain('&lt;script&gt;');
    });
});
