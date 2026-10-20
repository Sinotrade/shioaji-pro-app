import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, createFakeHost, type FakeHost } from './__fixtures__/server';
import {
    CompanyDataError,
    MANIFEST_TTL_MS,
    companyDataErrorText,
    createCompanyDataClient,
    normalizeCompanyCode,
} from './client';
import { createMemoryStore, type CompanyDataStore } from './store';

let host: FakeHost;
let clock: number;
let store: CompanyDataStore;
const client = () =>
    createCompanyDataClient({ baseUrl: BASE, fetch: host.fetch, store, now: () => clock });
const fileRequests = () => host.requests.filter((u) => !u.includes('manifest.json'));
const manifestRequests = () => host.requests.filter((u) => u.includes('manifest.json'));

async function errorOf(promise: Promise<unknown>): Promise<CompanyDataError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(CompanyDataError);
        return error as CompanyDataError;
    }
    throw new Error('expected a CompanyDataError');
}

beforeEach(() => {
    host = createFakeHost();
    clock = 1_000_000;
    store = createMemoryStore();
});

describe('company data reader', () => {
    it('reads the company file the manifest lists, cache-busted by its sha256', async () => {
        const c = client();
        const { data, meta } = await c.getCompany('tw.2330');
        expect(data.name).toBe('台積電');
        expect(meta.releaseId).toBe('2026.10.20.2220');
        expect(meta.stale).toBe(false);
        expect(fileRequests()).toEqual([
            `${BASE}v1/tw/companies/json/2330.json?v=${host.manifest.companies['2330']!.sha256}`,
        ]);
    });

    it('never downloads a file again while its sha256 is unchanged', async () => {
        const c = client();
        await c.getCompany('2330');
        await c.getCompany('2330');
        clock += MANIFEST_TTL_MS + 1;
        await c.getCompany('2330');
        // a new client on the same persistent store reuses the stored copy too
        await createCompanyDataClient({ baseUrl: BASE, fetch: host.fetch, store, now: () => clock }).getCompany('2330');
        expect(fileRequests()).toHaveLength(1);
    });

    it('rechecks the manifest only after the TTL and refetches a file whose sha256 changed', async () => {
        const c = client();
        await c.getCompany('2330');
        expect(manifestRequests()).toHaveLength(1);
        clock += MANIFEST_TTL_MS - 1;
        await c.getCompany('2330');
        expect(manifestRequests()).toHaveLength(1);

        const path = 'v1/tw/companies/json/2330.json';
        const updated = JSON.parse(host.files.get(path)!);
        updated.summary_short = '新版摘要';
        host.setFile(path, JSON.stringify(updated), true);
        clock += 2;
        const { data } = await c.getCompany('2330');
        expect(manifestRequests()).toHaveLength(2);
        expect(data.summary_short).toBe('新版摘要');
        expect(fileRequests()).toHaveLength(2);
    });

    it('refuses a file whose bytes do not match the manifest sha256', async () => {
        host.setFile('v1/tw/companies/json/2330.json', '{"tampered":true}', false);
        const error = await errorOf(client().getCompany('2330'));
        expect(error.code).toBe('integrity');
        // refetched the manifest once in case a new release was published mid-read
        expect(manifestRequests()).toHaveLength(2);
        expect(companyDataErrorText(error)).toContain('sha256');
    });

    it('recovers when a new release lands between the manifest and the file read', async () => {
        const c = client();
        await c.getManifest();
        const path = 'v1/tw/companies/json/2330.json';
        const next = JSON.parse(host.files.get(path)!);
        next.summary_short = '新版';
        host.setFile(path, JSON.stringify(next), true); // host now serves the new release
        const stale = await c.getManifest();
        expect(stale.manifest.companies['2330']!.sha256).not.toBe(host.manifest.companies['2330']!.sha256);
        // the cached manifest still points at the old hash → mismatch → refresh → success
        const { data } = await c.getCompany('2330');
        expect(data.summary_short).toBe('新版');
    });

    it('rejects an unknown major manifest schema', async () => {
        host.manifest.manifest_schema_version = '2.0.0';
        host.publish();
        const error = await errorOf(client().getCompany('2330'));
        expect(error.code).toBe('unsupported_schema');
        expect(companyDataErrorText(error)).toContain('更新 Shioaji Pro');
    });

    it('rejects only the dataset whose major schema is unknown', async () => {
        host.manifest.files['tw/market']!.schema_version = '3.0.0';
        host.publish();
        const c = client();
        expect((await errorOf(c.getMarket())).code).toBe('unsupported_schema');
        await expect(c.getThemes()).resolves.toBeTruthy();
        // minor bumps stay compatible
        host.manifest.files['tw/themes']!.schema_version = '1.9.0';
        host.publish();
        await expect(client().getThemes()).resolves.toBeTruthy();
    });

    it('reads only safe relative v1 paths from the manifest', async () => {
        host.manifest.companies['2330']!.path = 'https://evil.test/x.json';
        host.publish();
        expect((await errorOf(client().getCompany('2330'))).code).toBe('invalid_data');
        host.manifest.companies['2330']!.path = 'v1/../secret.json';
        host.publish();
        expect((await errorOf(client().getCompany('2330'))).code).toBe('invalid_data');
    });

    it('reports a code that is not in the manifest as not_found', async () => {
        const c = client();
        expect((await errorOf(c.getCompany('9999'))).code).toBe('not_found');
        expect((await errorOf(c.getFinancials('1108'))).code).toBe('not_found');
        expect((await errorOf(c.getCompany('us.NVDA'))).code).toBe('not_found');
        expect(fileRequests()).toHaveLength(0);
    });

    it('keeps serving cached data, flagged stale, when the network drops', async () => {
        const c = client();
        await c.getCompany('2330');
        host.offline = true;
        clock += MANIFEST_TTL_MS + 1;
        const { data, meta } = await c.getCompany('2330');
        expect(data.code).toBe('2330');
        expect(meta.stale).toBe(true);
        expect(c.getStatus()).toMatchObject({ phase: 'stale', releaseId: '2026.10.20.2220' });
        // nothing cached for financials → a clear offline error
        expect((await errorOf(c.getFinancials('2330'))).code).toBe('offline');
        // the manifest is not retried on every call while offline
        const before = manifestRequests().length;
        await c.getCompany('2330');
        expect(manifestRequests()).toHaveLength(before);
    });

    it('starts offline from the persisted manifest and files', async () => {
        await client().getCompany('2330');
        host.offline = true;
        const { data, meta } = await client().getCompany('2330');
        expect(data.name).toBe('台積電');
        expect(meta.stale).toBe(true);
    });

    it('fails as offline when there is no network and no cache', async () => {
        host.offline = true;
        const error = await errorOf(client().getCompany('2330'));
        expect(error.code).toBe('offline');
        expect(companyDataErrorText(error)).toContain('沒有快取');
    });

    it('reports HTTP failures as network errors', async () => {
        host.files.delete('v1/manifest.json');
        expect((await errorOf(client().getCompany('2330'))).code).toBe('offline');
        host.publish();
        host.files.delete('v1/tw/companies/json/2330.json');
        expect((await errorOf(client().getCompany('2330'))).code).toBe('network');
    });

    it('shares one manifest request between concurrent readers', async () => {
        const c = client();
        await Promise.all([c.getCompany('2330'), c.getThemes(), c.getMarket(), c.getCompany('1108')]);
        expect(manifestRequests()).toHaveLength(1);
    });
});

describe('normalizeCompanyCode', () => {
    it.each([
        ['2330', '2330'],
        [' tw.2330 ', '2330'],
        ['TW.2330', '2330'],
        ['00878', '00878'],
        [2330, '2330'],
    ])('%s → %s', (input, code) => {
        expect(normalizeCompanyCode(input)).toBe(code);
    });

    it.each(['us.NVDA', 'TXFR1x', '', 'tw.', null])('rejects %s', (input) => {
        expect(normalizeCompanyCode(input)).toBeNull();
    });
});
