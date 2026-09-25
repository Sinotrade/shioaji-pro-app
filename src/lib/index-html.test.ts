// src/lib/index-html.test.ts — the page shell must not block startup on the
// network (#142): a render/script-blocking external stylesheet delays the
// inline guard and the module bundle on every page load and reload.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

describe('index.html', () => {
    it('loads every external stylesheet without blocking scripts', () => {
        const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
        const external = links.filter((l) => /rel="stylesheet"/.test(l) && /href="https?:\/\//.test(l));
        expect(external.length).toBeGreaterThan(0);
        for (const link of external) {
            expect(link).toMatch(/media="print"/);
            expect(link).toMatch(/onload="this\.media='all'"/);
        }
    });
});
