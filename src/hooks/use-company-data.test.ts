import { describe, expect, it } from 'vitest';
import { createCompanyDataClient } from '../lib/company-data';
import { createMemoryStore } from '../lib/company-data/store';
import { BASE, createFakeHost } from '../lib/company-data/__fixtures__/server';
import { loadCompanyView } from './use-company-data';

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

    it('rejects codes the data set does not cover', async () => {
        await expect(loadCompanyView(client(), '0050')).rejects.toMatchObject({ code: 'not_found' });
    });
});
