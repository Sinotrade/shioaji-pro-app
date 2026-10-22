import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ETF_SOURCE_ROUTES, EQUITY_SOURCE_ROUTES, type PublicMetadataRoute } from './public-metadata-routes';

const m = vi.hoisted(() => ({ native: false, fetch: vi.fn() }));
vi.mock('./runtime', () => ({ get isTauri() { return m.native; } }));
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); m.native = false; m.fetch.mockReset(); vi.stubGlobal('fetch', m.fetch); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['https://example.test/private', '//example.test/a', '/metadata/etf/tse-funds?url=x', '/api/v1/info'])(
    'rejects any unlisted route before fetch: %s', async route => {
        const { fetchPublicJson } = await import('./public-metadata');
        await expect(fetchPublicJson(route as PublicMetadataRoute)).rejects.toThrow(/route/);
        expect(m.fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    },
);

it.each([
    [ETF_SOURCE_ROUTES.tseFunds, 'GET'], [ETF_SOURCE_ROUTES.otcFunds, 'POST'],
    [ETF_SOURCE_ROUTES.tseNames, 'GET'], [EQUITY_SOURCE_ROUTES.tseCompanies, 'GET'],
    [EQUITY_SOURCE_ROUTES.otcCompanies, 'GET'], [EQUITY_SOURCE_ROUTES.oesCompanies, 'GET'],
])('uses the fixed public route without credentials: %s', async (route, method) => {
    m.fetch.mockResolvedValue(new Response('[{"name":"公開名稱"}]', { headers: { 'Content-Type': 'application/json' } }));
    const { fetchPublicJson } = await import('./public-metadata');
    await expect(fetchPublicJson(route as PublicMetadataRoute)).resolves.toEqual([{ name: '公開名稱' }]);
    expect(m.fetch).toHaveBeenCalledExactlyOnceWith(route, {
        method, credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
});

it('gates the native path even if a caller bypasses its catalog gate', async () => {
    m.native = true;
    const { fetchPublicJson } = await import('./public-metadata');
    await expect(fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds)).rejects.toThrow(/not enabled/);
    expect(m.fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

const opaqueRedirect = () => Object.defineProperties(new Response(null), {
    type: { value: 'opaqueredirect' }, status: { value: 0 }, ok: { value: false },
});
it.each([
    ['404 JSON', () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })],
    ['403 JSON', () => new Response('{"error":"ETF_METADATA_LOCAL_ONLY"}', { status: 403, headers: { 'Content-Type': 'application/json' } })],
    ['405 HTML', () => new Response('<html>no</html>', { status: 405, headers: { 'Content-Type': 'text/html' } })],
    ['200 SPA HTML fallback', () => new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['opaque redirect', opaqueRedirect],
])('marks the environment as having no route after %s', async (_label, reply) => {
    m.fetch.mockResolvedValue(reply());
    const { fetchPublicJson, isPublicMetadataUnavailable } = await import('./public-metadata');
    expect(isPublicMetadataUnavailable()).toBe(false);
    await expect(fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds)).rejects.toThrow(/route unavailable|not JSON/);
    expect(isPublicMetadataUnavailable()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it.each([
    ['502 JSON from the dev proxy', 502, 'application/json'],
    ['503 HTML error page', 503, 'text/html'],
    ['408 timeout', 408, 'application/json'],
    ['429 rate limit', 429, 'text/html'],
])('keeps %s retryable', async (_label, status, type) => {
    m.fetch.mockResolvedValue(new Response('<html>busy</html>', { status, headers: { 'Content-Type': type } }));
    const { fetchPublicJson, isPublicMetadataUnavailable } = await import('./public-metadata');
    await expect(fetchPublicJson(EQUITY_SOURCE_ROUTES.tseCompanies)).rejects.toThrow(`Public metadata HTTP ${status}`);
    expect(isPublicMetadataUnavailable()).toBe(false);
});

it('counts body wait in its deadline and cancels the owned reader', async () => {
    const cancel = vi.fn();
    m.fetch.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([91])); }, cancel }),
        { headers: { 'Content-Type': 'application/json' } }));
    const { fetchPublicJson } = await import('./public-metadata');
    const pending = expect(fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(5001); await pending;
    expect(cancel).toHaveBeenCalledOnce(); expect(m.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
});

it('rejects an already-cancelled caller without starting fetch', async () => {
    const controller = new AbortController(); controller.abort();
    const { fetchPublicJson } = await import('./public-metadata');
    await expect(fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(m.fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('cancels a body whose headers arrive after an ignored deadline', async () => {
    let reply!: (response: Response) => void;
    m.fetch.mockImplementation(() => new Promise<Response>(resolve => { reply = resolve; }));
    const { fetchPublicJson } = await import('./public-metadata');
    const pending = expect(fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(5001); await pending;
    const cancel = vi.fn();
    reply(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('releases its reader even when the underlying cancel never settles', async () => {
    const body = new ReadableStream({ cancel: () => new Promise<void>(() => undefined) });
    m.fetch.mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    const controller = new AbortController();
    const { fetchPublicJson } = await import('./public-metadata');
    const pending = expect(fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(true);
    controller.abort(); await pending;
    expect(body.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
});
