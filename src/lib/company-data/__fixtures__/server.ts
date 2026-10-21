// Test helper: a fake shioaji-data host built from trimmed real v1 files.
// The manifest is generated with the fixtures' true sha256, so tests exercise
// the same verification path as production.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Manifest } from '../types';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const BASE = 'https://data.test/shioaji-data/';

export interface FakeHost {
    files: Map<string, string>;
    manifest: Manifest;
    /** URLs requested, in order. */
    requests: string[];
    /** When true every request rejects like a dropped connection. */
    offline: boolean;
    fetch: typeof fetch;
    /** Re-serialise the manifest after a test edits it. */
    publish(): void;
    /** Replace a file's bytes; `updateSha` also updates the manifest. */
    setFile(path: string, text: string, updateSha: boolean): void;
}

export function createFakeHost(): FakeHost {
    const files = new Map<string, string>();
    const datasets: [string, string, string, string][] = [
        ['tw/edges', 'v1/tw/relations/edges.json', 'edges.json', '1.1.0'],
        ['tw/themes', 'v1/tw/themes/themes.json', 'themes.json', '1.2.0'],
        ['tw/market', 'v1/tw/market/daily.json', 'market.json', '2.0.0'],
        ['global/entities', 'v1/global/entities/entities.json', 'entities.json', '1.0.0'],
        ['global/sources', 'v1/global/sources/sources.json', 'sources.json', '1.0.0'],
    ];
    const manifest: Manifest = {
        manifest_schema_version: '1.0.0',
        release_id: '2026.10.20.2220',
        built_at: '2026-10-20T22:20:36+0800',
        official_fetched_at: '2026-10-20',
        disclaimer: '本資料彙整自政府開放資料與公開文件，部分內容由 AI 整理並經多個模型交叉核對，可能過時或有誤，僅供參考。',
        files: {
            'tw/cards': { path: 'v1/tw/companies/cards.json', sha256: sha('[]'), schema_version: '1.3.0', as_of: '2026-10-20' },
        },
        companies: {},
        financials: {},
        financials_schema_version: '1.1.0',
        revocations: [],
    };
    files.set('v1/tw/companies/cards.json', '[]');
    for (const [key, path, name, version] of datasets) {
        const text = read(name);
        files.set(path, text);
        manifest.files[key] = { path, sha256: sha(text), schema_version: version, as_of: '2026-10-20' };
    }
    for (const code of ['2330', '1108']) {
        const path = `v1/tw/companies/json/${code}.json`;
        const text = read(`company-${code}.json`);
        files.set(path, text);
        manifest.companies[code] = { path, sha256: sha(text) };
    }
    {
        const path = 'v1/tw/financials/json/2330.json';
        const text = read('financials-2330.json');
        files.set(path, text);
        manifest.financials['2330'] = { path, sha256: sha(text), as_of: '2026-09' };
    }

    const host: FakeHost = {
        files,
        manifest,
        requests: [],
        offline: false,
        publish() {
            files.set('v1/manifest.json', JSON.stringify(manifest));
        },
        setFile(path, text, updateSha) {
            files.set(path, text);
            if (!updateSha) return;
            for (const group of [manifest.files, manifest.companies, manifest.financials]) {
                for (const entry of Object.values(group)) if (entry.path === path) entry.sha256 = sha(text);
            }
            host.publish();
        },
        fetch: (async (input: RequestInfo | URL) => {
            const url = String(input);
            host.requests.push(url);
            if (host.offline) throw new TypeError('Failed to fetch');
            const path = url.slice(BASE.length).split('?')[0]!;
            const text = files.get(path);
            if (text === undefined) return new Response('not found', { status: 404 });
            return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch,
    };
    host.publish();
    return host;
}
