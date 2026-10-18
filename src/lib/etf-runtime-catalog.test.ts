import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bundled from './data/etf-catalog.json';
import type { EtfNameCatalog } from './etf-runtime-catalog';
import { ETF_SOURCE_ROUTES } from './public-metadata-routes';

const m = vi.hoisted(() => ({ native: false, nativeFetch: vi.fn(), fetch: vi.fn() }));
vi.mock('./runtime', () => ({ get isTauri() { return m.native; } }));
vi.mock('@tauri-apps/plugin-http', () => { throw new Error('Public names must never import native HTTP'); });
const URLS = [
    'https://openapi.twse.com.tw/v1/opendata/t187ap47_L',
    'https://info.tpex.org.tw/api/etfFilter',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
];
const ROUTES = [ETF_SOURCE_ROUTES.tseFunds, ETF_SOURCE_ROUTES.otcFunds, ETF_SOURCE_ROUTES.tseNames];
const AT = '2026-10-17T04:00:00.000Z';
const emptyPrior: EtfNameCatalog = { schemaVersion: 1, retrievedAt: AT, sources: [], entries: [] };
type Runtime = typeof import('./etf-runtime-catalog');
let runtime: Runtime;

function small() {
    // Synthetic identities only; these fixtures are not market observations.
    return {
        tse: [{ 基金代號: 'ETF1', 基金簡稱: '原基金', 基金中文名稱: '基金完整名稱', 出表日期: '1151016' }],
        otc: { status: 'success', data: [{ stockNo: 'ETF2', stockName: '上櫃基金' }] },
        daily: [{ Code: 'ETF1', Name: '新基金', Date: '1151016' }],
    };
}
function full() {
    const tse = bundled.entries.filter(entry => entry.exchange === 'TSE').map(entry => ({
        基金代號: entry.code, 基金簡稱: entry.aliases?.[0] ?? entry.name,
        基金中文名稱: entry.aliases?.[1] ?? '', 出表日期: '1151016',
    }));
    const otc = { status: 'success', data: bundled.entries.filter(entry => entry.exchange === 'OTC').map(entry => ({ stockNo: entry.code, stockName: entry.name })) };
    const daily = bundled.entries.filter(entry => entry.exchange === 'TSE').map(entry => ({ Code: entry.code, Name: entry.name, Date: '1151016' }));
    const dailyCount = bundled.sources.find(source => source.url === URLS[2])!.count;
    for (let index = daily.length; index < dailyCount; index += 1) daily.push({ Code: `X${String(index).padStart(5, '0')}`, Name: `合成普通股票 ${index}`, Date: '1151016' });
    return { tse, otc, daily };
}
function respond(data = full()) {
    return (url: string) => Promise.resolve(new Response(JSON.stringify(
        url === ROUTES[0] ? data.tse : url === ROUTES[1] ? data.otc : data.daily,
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}
async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    vi.stubEnv('DEV', false);
    vi.resetModules();
    m.native = false;
    m.fetch.mockReset().mockImplementation(respond());
    m.nativeFetch.mockReset().mockImplementation(respond());
    vi.stubGlobal('fetch', m.fetch);
    runtime = await import('./etf-runtime-catalog');
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('ETF runtime pure source validation', () => {
    it('keeps public names and aliases only, joins daily names without inventing ETF membership', () => {
        const data = small();
        const catalog = runtime.buildEtfRuntimeCatalog(
            data.tse.map(entry => ({ ...entry, price: 999 })), data.otc,
            [...data.daily, { Code: 'STK1', Name: '普通股，不是 ETF', Date: '1151016', price: 888 }], AT, emptyPrior,
        );
        expect(catalog.entries).toEqual([
            { code: 'ETF2', exchange: 'OTC', name: '上櫃基金' },
            { code: 'ETF1', exchange: 'TSE', name: '新基金', aliases: ['原基金', '基金完整名稱'] },
        ]);
        expect(catalog.sources.map(source => source.url)).toEqual(URLS);
        expect(catalog.sources.map(source => source.dataDate)).toEqual(['2026-10-16', null, '2026-10-16']);
        expect(catalog.retrievedAt).toBe(AT);
        expect(Object.isFrozen(catalog.entries[0])).toBe(true);
        expect(Object.isFrozen(catalog.entries[1]!.aliases)).toBe(true);
    });

    it('decodes named/numeric entities as plain text, not HTML, and deduplicates aliases', () => {
        const data = small();
        const result = runtime.buildEtfRuntimeCatalog(
            [{ ...data.tse[0], 基金簡稱: 'S&amp;P&#174;', 基金中文名稱: 'S&amp;P&#174;' }],
            data.otc, [{ ...data.daily[0], Name: '新&#xAE;&lt;基金&gt;' }], AT, emptyPrior,
        );
        expect(result.entries[1]).toEqual({ code: 'ETF1', exchange: 'TSE', name: '新®<基金>', aliases: ['S&P®'] });
    });

    it.each(['&unknown;', '&constructor;', '&#99999999;', '&#xD800;', '&#0;', '&#10;'])('rejects malformed or control name entity %s', (name) => {
        const data = small();
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse, data.otc, [{ ...data.daily[0], Name: name }], AT, emptyPrior)).toThrow(/entity|name/);
    });

    it.each([null, {}, [], [null], ['bad-row']])('rejects malformed/empty TWSE structure %j', (tse) => {
        const data = small();
        expect(() => runtime.buildEtfRuntimeCatalog(tse, data.otc, data.daily, AT, emptyPrior)).toThrow();
    });

    it('requires success and non-empty TPEx/daily sources', () => {
        const data = small();
        for (const otc of [null, {}, { ...data.otc, status: 'failure' }, { status: 'success', data: [] }]) {
            expect(() => runtime.buildEtfRuntimeCatalog(data.tse, otc, data.daily, AT, emptyPrior)).toThrow();
        }
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse, data.otc, [], AT, emptyPrior)).toThrow();
    });

    it('rejects invalid identity/name fields and same-market duplicates, but allows cross-market code collisions', () => {
        const data = small();
        for (const code of ['<script>', 'etf1', ' ETF1', '', 2330]) {
            expect(() => runtime.buildEtfRuntimeCatalog([{ ...data.tse[0], 基金代號: code }], data.otc, data.daily, AT, emptyPrior)).toThrow(/code/);
        }
        expect(() => runtime.buildEtfRuntimeCatalog([{ ...data.tse[0], 基金簡稱: '' }], data.otc, data.daily, AT, emptyPrior)).toThrow(/name/);
        expect(() => runtime.buildEtfRuntimeCatalog([...data.tse, ...data.tse], data.otc, data.daily, AT, emptyPrior)).toThrow(/Duplicate ETF/);
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse, { ...data.otc, data: [...data.otc.data, ...data.otc.data] }, data.daily, AT, emptyPrior)).toThrow(/Duplicate ETF/);
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse, data.otc, [...data.daily, ...data.daily], AT, emptyPrior)).toThrow(/Duplicate TWSE daily/);
        const result = runtime.buildEtfRuntimeCatalog(data.tse, { status: 'success', data: [{ stockNo: 'ETF1', stockName: '同碼上櫃' }] }, data.daily, AT, emptyPrior);
        expect(result.entries.map(entry => `${entry.exchange}:${entry.code}`)).toEqual(['OTC:ETF1', 'TSE:ETF1']);
    });

    it('rejects impossible, missing, inconsistent, future and regressed source dates', () => {
        const data = small();
        for (const date of ['1150231', '', undefined, '1151018']) {
            expect(() => runtime.buildEtfRuntimeCatalog([{ ...data.tse[0], 出表日期: date }], data.otc, data.daily.map(entry => ({ ...entry, Date: date })), AT, emptyPrior)).toThrow(/date/);
        }
        expect(() => runtime.buildEtfRuntimeCatalog([...data.tse, { ...data.tse[0], 基金代號: 'ETF3', 出表日期: '1151015' }], data.otc, data.daily, AT, emptyPrior)).toThrow(/inconsistent/);
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse, data.otc, data.daily.map(entry => ({ ...entry, Date: '1151015' })), AT, emptyPrior)).toThrow(/older/);
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse, data.otc, data.daily, 'not-a-date', emptyPrior)).toThrow(/timestamp/);
        const prior = runtime.buildEtfRuntimeCatalog(data.tse, data.otc, data.daily, AT, emptyPrior);
        expect(() => runtime.buildEtfRuntimeCatalog(data.tse.map(entry => ({ ...entry, 出表日期: '1151015' })), data.otc, data.daily.map(entry => ({ ...entry, Date: '1151015' })), AT, prior)).toThrow(/became older/);
    });

    it('rejects over-20% shrink in each source independently, preserving the previous snapshot', () => {
        const data = full();
        for (const key of ['tse', 'otc', 'daily']) {
            const reduced = full();
            if (key === 'tse') reduced.tse = reduced.tse.slice(0, 1);
            if (key === 'otc') reduced.otc.data = reduced.otc.data.slice(0, 1);
            if (key === 'daily') reduced.daily = reduced.daily.slice(0, 1);
            expect(() => runtime.buildEtfRuntimeCatalog(reduced.tse, reduced.otc, reduced.daily, AT)).toThrow(/shrank/);
        }
        const result = runtime.buildEtfRuntimeCatalog(data.tse, data.otc, data.daily, AT);
        expect(result.entries).toEqual(bundled.entries);
    });

    it('preserves reviewed old names/aliases for current identities but never resurrects removed ETF membership', () => {
        const data = full();
        const keep = data.tse[0]!.基金代號;
        const remove = data.tse[1]!.基金代號;
        const old = bundled.entries.find(entry => entry.code === keep && entry.exchange === 'TSE')!;
        data.tse[0]!.基金簡稱 = '合成新基金簡稱';
        data.tse[0]!.基金中文名稱 = '合成新基金完整名稱';
        data.daily.find(entry => entry.Code === keep)!.Name = '合成新每日名稱';
        data.tse = data.tse.filter(entry => entry.基金代號 !== remove);
        const result = runtime.buildEtfRuntimeCatalog(data.tse, data.otc, data.daily, AT);
        const current = result.entries.find(entry => entry.code === keep && entry.exchange === 'TSE')!;
        expect(current.name).toBe('合成新每日名稱');
        expect(current.aliases).toEqual(expect.arrayContaining([old.name, ...(old.aliases ?? []), '合成新基金簡稱', '合成新基金完整名稱']));
        expect(result.entries.some(entry => entry.code === remove && entry.exchange === 'TSE')).toBe(false);
        const repeated = runtime.buildEtfRuntimeCatalog(data.tse, data.otc, data.daily, AT, result);
        expect(repeated.entries).toEqual(result.entries);
    });
});

describe('shared background refresh lifecycle', () => {
    it('serves bundled names synchronously and performs no import/read/subscription polling', () => {
        expect(runtime.etfNameForLive('00679B', 'OTC')?.name).toBe('元大美債20年');
        expect(runtime.etfNameForLive('00679B', 'TSE')).toBeUndefined();
        const unsubscribe = runtime.subscribeEtfNames(vi.fn());
        unsubscribe();
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'snapshot', usingSnapshot: true, count: bundled.entries.length });
        expect(m.fetch).not.toHaveBeenCalled();
        expect(m.nativeFetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('coalesces concurrent readers, uses only three fixed public requests and publishes the first official authority once', async () => {
        const notify = vi.fn();
        runtime.subscribeEtfNames(notify);
        const pending = runtime.refreshEtfNames();
        for (let index = 0; index < 20; index += 1) expect(runtime.refreshEtfNames()).toBe(pending);
        expect(runtime.getEtfNamesStatus().phase).toBe('refreshing');
        expect(runtime.etfNameForLive('00679B', 'OTC')).toBeDefined();
        await pending;
        expect(m.fetch.mock.calls.map(call => call[0])).toEqual(ROUTES);
        expect(m.fetch.mock.calls.map(call => call[1].method)).toEqual(['GET', 'POST', 'GET']);
        for (const [url, options] of m.fetch.mock.calls) {
            expect(ROUTES).toContain(url);
            expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) });
            expect(options.headers).toBeUndefined();
            expect(options.body).toBeUndefined();
        }
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'ready', usingSnapshot: false, error: null, lastSuccessAt: AT });
        expect(runtime.getEtfNamesVersion()).toBe(1);
        expect(notify).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesVersion()).toBe(1);
        expect(notify).toHaveBeenCalledOnce();
    });

    it('dev browser uses three fixed same-origin routes while provenance keeps official URLs', async () => {
        vi.stubEnv('DEV', true);
        const routes: readonly string[] = [ETF_SOURCE_ROUTES.tseFunds, ETF_SOURCE_ROUTES.otcFunds, ETF_SOURCE_ROUTES.tseNames];
        const data = full();
        m.fetch.mockImplementation((url: string) => {
            const index = routes.indexOf(url);
            return Promise.resolve(new Response(JSON.stringify(index === 0 ? data.tse : index === 1 ? data.otc : data.daily), { headers: { 'Content-Type': 'application/json' } }));
        });
        await runtime.refreshEtfNames();
        expect(m.fetch.mock.calls.map(call => call[0])).toEqual(routes);
        expect(m.fetch.mock.calls.map(call => call[1].method)).toEqual(['GET', 'POST', 'GET']);
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'ready', usingSnapshot: false });
        expect(runtime.getEtfNamesStatus().sources.map(source => source.url)).toEqual(URLS);
    });

    it('useProductNamesVersion only subscribes, updates on authority change and does not start requests or polling', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const { createElement } = await import('react');
        const { create, act } = await import('react-test-renderer');
        const { useProductNamesVersion } = await import('../hooks/use-product-names-version');
        let renders = 0;
        function Probe() {
            renders += 1;
            return createElement('span', null, useProductNamesVersion());
        }
        let view: import('react-test-renderer').ReactTestRenderer | undefined;
        try {
            act(() => { view = create(createElement(Probe)); });
            expect(view!.root.findByType('span').children).toEqual(['0:0']);
            expect(m.fetch).not.toHaveBeenCalled();
            await act(async () => { await runtime.refreshEtfNames(); });
            expect(view!.root.findByType('span').children).toEqual(['1:0']);
            const rendered = renders;
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(m.fetch).toHaveBeenCalledTimes(3);
            await act(async () => { await runtime.refreshEtfNames(); });
            expect(renders).toBe(rendered);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            const mounted = view;
            if (mounted) act(() => mounted.unmount());
        }
    });

    it('refreshes on the next read after five minutes, but never runs a timer poll while unused', async () => {
        await runtime.refreshEtfNames();
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(m.fetch).toHaveBeenCalledTimes(3);
        const data = full();
        data.tse.push({ 基金代號: 'Z99999', 基金簡稱: '合成新上市 ETF', 基金中文名稱: '', 出表日期: '1151016' });
        data.daily.push({ Code: 'Z99999', Name: '合成新上市 ETF', Date: '1151016' });
        m.fetch.mockImplementation(respond(data));
        await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(6);
        expect(runtime.etfNameForLive('Z99999', 'TSE')?.name).toBe('合成新上市 ETF');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bypasses success TTL immediately at Taiwan midnight, independently of the machine time zone', async () => {
        vi.setSystemTime('2026-10-17T15:59:59.000Z');
        await runtime.refreshEtfNames();
        vi.setSystemTime('2026-10-17T16:00:00.000Z');
        await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(6);
    });

    it('atomically publishes changed names/aliases once; reentrant reads, unchanged responses and removed subscribers do not loop', async () => {
        const data = full();
        const first = data.daily.find(entry => data.tse.some(fund => fund.基金代號 === entry.Code))!;
        first.Name = '合成更名後 ETF';
        m.fetch.mockImplementation(respond(data));
        const removed = vi.fn();
        runtime.subscribeEtfNames(removed)();
        const notify = vi.fn(() => { void runtime.refreshEtfNames(); });
        runtime.subscribeEtfNames(notify);
        await runtime.refreshEtfNames();
        expect(runtime.etfNameForLive(first.Code, 'TSE')?.name).toBe('合成更名後 ETF');
        expect(runtime.getEtfNamesVersion()).toBe(1);
        expect(notify).toHaveBeenCalledOnce();
        expect(removed).not.toHaveBeenCalled();
        expect(m.fetch).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesVersion()).toBe(1);
        expect(notify).toHaveBeenCalledOnce();
    });

    it('HTTP failure aborts unfinished sibling requests, preserves names, backs off typing and later recovers', async () => {
        m.fetch.mockImplementation((url: string) => url === ROUTES[0] ? Promise.resolve(new Response('{}', { status: 503 })) : new Promise(() => undefined));
        await expect(runtime.refreshEtfNames()).resolves.toBeUndefined();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true, error: 'Public metadata HTTP 503' });
        expect(runtime.etfNameForLive('00679B', 'OTC')?.name).toBe('元大美債20年');
        for (const [, options] of m.fetch.mock.calls) expect(options.signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        for (let index = 0; index < 20; index += 1) await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(29_999);
        await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(3);
        m.fetch.mockImplementation(respond());
        await vi.advanceTimersByTimeAsync(1);
        await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(6);
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'ready', error: null, retryAt: null });
    });

    it('invalid/shrunken sources never partially replace the last good map or increment its version', async () => {
        const data = full();
        data.otc.data[0]!.stockName = '不應採用的合成更名';
        data.tse = data.tse.slice(0, 1);
        m.fetch.mockImplementation(respond(data));
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true });
        expect(runtime.getEtfNamesStatus().error).toContain('shrank');
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(runtime.etfNameForLive(data.otc.data[0]!.stockNo, 'OTC')?.name).toBe(bundled.entries.find(entry => entry.code === data.otc.data[0]!.stockNo && entry.exchange === 'OTC')!.name);
    });

    it('a transport ignoring abort cannot publish its late reply or overwrite a later successful round', async () => {
        let late!: (response: Response) => void;
        const lateData = full();
        lateData.otc.data[0]!.stockName = '逾時晚到，不得採用';
        m.fetch.mockImplementation((url: string) => url === ROUTES[1] ? new Promise<Response>(resolve => { late = resolve; }) : respond()(url));
        const timedOut = runtime.refreshEtfNames();
        await vi.advanceTimersByTimeAsync(5000);
        await timedOut;
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', error: 'Public metadata deadline exceeded' });
        expect(m.fetch.mock.calls[1]![1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
        m.fetch.mockImplementation(respond());
        await runtime.refreshEtfNames();
        late(new Response(JSON.stringify(lateData.otc)));
        await flush();
        expect(runtime.getEtfNamesStatus().phase).toBe('ready');
        expect(runtime.getEtfNamesVersion()).toBe(1);
        expect(runtime.etfNameForLive(lateData.otc.data[0]!.stockNo, 'OTC')?.name).not.toBe('逾時晚到，不得採用');
    });

    it('deadline covers response body consumption, clears timers and cancels the stream before a late JSON body', async () => {
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
        m.fetch.mockImplementation((url: string) => url === ROUTES[0] ? Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/json' } })) : respond()(url));
        const pending = runtime.refreshEtfNames();
        await flush();
        await vi.advanceTimersByTimeAsync(4999);
        expect(runtime.getEtfNamesStatus().phase).toBe('refreshing');
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(runtime.getEtfNamesStatus().phase).toBe('error');
        expect(m.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
        expect(() => body.enqueue(new TextEncoder().encode(JSON.stringify(full().tse)))).toThrow(/closed/);
        await flush();
        expect(runtime.getEtfNamesStatus().phase).toBe('error');
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('browser rejects a declared oversized body before reading it and cancels the actual Response stream', async () => {
        const pull = vi.fn();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
        m.fetch.mockImplementation((url: string) => url === ROUTES[0]
            ? Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024 + 1) } })) : respond()(url));
        await runtime.refreshEtfNames();
        await flush();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true, error: 'Public metadata exceeds 2 MiB' });
        expect(pull).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledOnce();
        expect(m.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('browser counts streamed bytes despite a lying Content-Length and stops an oversized source early', async () => {
        let chunks = 0;
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(new Uint8Array(chunks++ === 0 ? 2 * 1024 * 1024 : 1)); }, cancel,
        }, { highWaterMark: 0 });
        m.fetch.mockImplementation((url: string) => url === ROUTES[0]
            ? Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } })) : respond()(url));
        await runtime.refreshEtfNames();
        await flush();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true, error: 'Public metadata exceeds 2 MiB' });
        expect(chunks).toBe(2);
        expect(cancel).toHaveBeenCalledOnce();
        expect(runtime.etfNameForLive('00679B', 'OTC')?.name).toBe('元大美債20年');
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a browser slow body still expires at five seconds; reader.cancel rejection is diagnosed without an unhandled rejection', async () => {
        const cancel = vi.fn(async () => { throw new Error('合成 body cleanup 拒絕'); });
        const body = new ReadableStream<Uint8Array>({ cancel });
        m.fetch.mockImplementation((url: string) => url === ROUTES[0] ? Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } })) : respond()(url));
        const pending = runtime.refreshEtfNames();
        await flush();
        await vi.advanceTimersByTimeAsync(5000);
        await expect(pending).resolves.toBeUndefined();
        await flush();
        expect(runtime.getEtfNamesStatus()).toMatchObject({
            phase: 'error', error: 'Public metadata deadline exceeded', cleanupError: '合成 body cleanup 拒絕',
        });
        expect(cancel).toHaveBeenCalledOnce();
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a null Response body is a recoverable error, not a valid empty ETF catalog', async () => {
        m.fetch.mockImplementation((url: string) => url === ROUTES[0] ? Promise.resolve(new Response(null, { status: 204 })) : respond()(url));
        await expect(runtime.refreshEtfNames()).resolves.toBeUndefined();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true, error: 'Public metadata body is empty' });
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('invalid JSON becomes a recoverable diagnostic, not a UI rejection', async () => {
        m.fetch.mockImplementation(() => Promise.resolve(new Response('{not-json', { headers: { 'Content-Type': 'application/json' } })));
        await expect(runtime.refreshEtfNames()).resolves.toBeUndefined();
        expect(runtime.getEtfNamesStatus().phase).toBe('error');
        expect(runtime.getEtfNamesStatus().error).toBeTruthy();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an undeployed production route returning SPA HTML backs off instead of retrying every keystroke', async () => {
        m.fetch.mockImplementation(() => Promise.resolve(new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } })));
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true, error: 'Public metadata response is not JSON' });
        for (let index = 0; index < 20; index++) await runtime.refreshEtfNames();
        expect(m.fetch).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
        m.fetch.mockImplementation(respond());
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesStatus().phase).toBe('ready');
        expect(m.fetch).toHaveBeenCalledTimes(6);
    });

    it('a notification exception is diagnosed without rejecting refresh or starving other subscribers', async () => {
        const data = full();
        data.otc.data[0]!.stockName = '合成更名';
        m.fetch.mockImplementation(respond(data));
        runtime.subscribeEtfNames(() => { throw new Error('測試訂閱者失敗'); });
        const notify = vi.fn();
        runtime.subscribeEtfNames(notify);
        await expect(runtime.refreshEtfNames()).resolves.toBeUndefined();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'ready', error: null, listenerError: '測試訂閱者失敗' });
        expect(notify).toHaveBeenCalledOnce();
    });

    it('native is gated with readable status and zero HTTP imports, requests or timers', async () => {
        m.native = true;
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'gated', usingSnapshot: true });
        expect(runtime.getEtfNamesStatus().error).toContain('原生版官方名稱來源未啟用');
        expect(m.fetch).not.toHaveBeenCalled();
        expect(m.nativeFetch).not.toHaveBeenCalled();
        expect(runtime.getEtfNamesVersion()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('repeated native reads preserve snapshot without falling back, expanding permissions or polling', async () => {
        m.native = true;
        for (let index = 0; index < 20; index++) await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'gated', usingSnapshot: true });
        expect(m.fetch).not.toHaveBeenCalled();
        expect(m.nativeFetch).not.toHaveBeenCalled();
        expect(runtime.etfNameForLive('00679B', 'OTC')).toBeDefined();
        expect(vi.getTimerCount()).toBe(0);
    });
});
