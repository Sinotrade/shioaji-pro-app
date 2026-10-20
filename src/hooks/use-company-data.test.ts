import { describe, expect, it } from 'vitest';
import { createCompanyDataClient } from '../lib/company-data';
import { createMemoryStore } from '../lib/company-data/store';
import { BASE, createFakeHost } from '../lib/company-data/__fixtures__/server';
import { loadCompanyView, staleParts } from './use-company-data';

const client = (host = createFakeHost()) =>
    createCompanyDataClient({ baseUrl: BASE, fetch: host.fetch, store: createMemoryStore() });

describe('company panel data (#337)', () => {
    it('loads a researched company with financials, themes, market and sources', async () => {
        const view = await loadCompanyView(client(), '2330');
        expect(view.company.has_research).toBe(true);
        expect(view.financials?.code).toBe('2330');
        expect(view.financialsError).toBeNull();
        expect(view.themes?.length).toBeGreaterThan(0);
        expect(view.market).not.toBeNull();
        expect(view.sources).not.toBeNull();
    });

    it('treats unlisted financials as absent, not as an error', async () => {
        const view = await loadCompanyView(client(), '1108');
        expect(view.company.has_research).toBe(false);
        expect(view.financials).toBeNull();
        expect(view.financialsError).toBeNull();
    });

    it('keeps the company when an optional dataset fails integrity', async () => {
        const host = createFakeHost();
        host.setFile('v1/tw/themes/themes.json', '[]', false);
        const view = await loadCompanyView(client(host), '2330');
        expect(view.company.code).toBe('2330');
        expect(view.themes).toBeNull();
    });

    it('flags each section that fell back to an older cached copy', async () => {
        const host = createFakeHost();
        let clock = 1_000_000;
        const c = createCompanyDataClient({ baseUrl: BASE, fetch: host.fetch, store: createMemoryStore(), now: () => clock });
        expect(staleParts(await loadCompanyView(c, '2330'))).toEqual([]);
        // a new financials release is listed but cannot be downloaded
        const path = 'v1/tw/financials/json/2330.json';
        host.manifest.release_id = '2026.10.21.0900';
        host.setFile(path, host.files.get(path)!.replace('台積電', '台積電 '), true);
        host.files.delete(path);
        clock += 11 * 60_000;
        const view = await loadCompanyView(c, '2330');
        expect(staleParts(view)).toEqual(['財報']);
        expect(view.financialsMeta).toMatchObject({ stale: true, releaseId: '2026.10.20.2220' });
        expect(view.meta).toMatchObject({ stale: false, releaseId: '2026.10.21.0900' });
    });

    it('rejects codes the data set does not cover', async () => {
        await expect(loadCompanyView(client(), '0050')).rejects.toMatchObject({ code: 'not_found' });
    });
});
