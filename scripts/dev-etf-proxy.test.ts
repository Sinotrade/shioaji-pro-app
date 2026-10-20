import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preview, type Connect, type PreviewServer, type ViteDevServer } from 'vite';
import { ETF_SOURCES } from '../src/lib/etf-catalog-normalizer.mjs';
import { EQUITY_SOURCE_ROUTES, EQUITY_SOURCES, ETF_SOURCE_ROUTES } from '../src/lib/public-metadata-routes';
import { createEtfMetadataMiddleware, etfMetadataProxyPlugin } from './dev-etf-proxy';
import configSource from '../vite.config.ts?raw';

const servers: Server[] = [];
const temporaryRoots: string[] = [];
const nativeFetch = globalThis.fetch;
async function listen(middleware: Connect.NextHandleFunction) {
    const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no address');
    return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

describe('本機開發與 preview 的六條固定名稱 metadata 代理', () => {
    it.each([
        [ETF_SOURCE_ROUTES.tseFunds, 'GET', ETF_SOURCES.TSE],
        [ETF_SOURCE_ROUTES.otcFunds, 'POST', ETF_SOURCES.OTC],
        [ETF_SOURCE_ROUTES.tseNames, 'GET', ETF_SOURCES.TSE_NAMES],
        [EQUITY_SOURCE_ROUTES.tseCompanies, 'GET', EQUITY_SOURCES.TSE],
        [EQUITY_SOURCE_ROUTES.otcCompanies, 'GET', EQUITY_SOURCES.OTC],
        [EQUITY_SOURCE_ROUTES.oesCompanies, 'GET', EQUITY_SOURCES.OES],
    ])('只以指定方法讀取固定上游：%s', async (route, method, upstream) => {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('[{"code":"0050"}]', {
            headers: { 'content-type': 'application/json', 'x-upstream': 'internal', 'content-encoding': 'identity', 'access-control-allow-origin': '*' },
        }));
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport }));
        const response = await fetch(origin + route, {
            method, headers: { Authorization: 'secret', Cookie: 'session=secret', Origin: 'https://other.example', Referer: 'https://other.example/private' },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ code: '0050' }]);
        expect(transport).toHaveBeenCalledExactlyOnceWith(upstream, {
            method, headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
        });
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(response.headers.get('x-upstream')).toBeNull();
        expect(response.headers.get('content-encoding')).toBeNull();
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.each(Object.values({ ...ETF_SOURCE_ROUTES, ...EQUITY_SOURCE_ROUTES }))('上游存在 Set-Cookie 即拒絕，不讀取或轉送 Cookie 值：%s', async route => {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]', {
            headers: { 'content-type': 'application/json', 'set-cookie': 'untrusted=redacted' },
        }));
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport }));
        const response = await fetch(origin + route, { method: route === ETF_SOURCE_ROUTES.otcFunds ? 'POST' : 'GET' });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_COOKIE_FORBIDDEN' });
        expect(response.headers.get('set-cookie')).toBeNull();
    });

    it.each([
        [`${ETF_SOURCE_ROUTES.tseFunds}?url=https://attacker.example`, 'GET', 400],
        ['/metadata/etf/https://attacker.example', 'GET', 404],
        [ETF_SOURCE_ROUTES.tseFunds, 'POST', 405],
        [ETF_SOURCE_ROUTES.otcFunds, 'GET', 405],
        [`${EQUITY_SOURCE_ROUTES.tseCompanies}?url=https://attacker.example`, 'GET', 400],
        ['/metadata/equity/https://attacker.example', 'GET', 404],
        [EQUITY_SOURCE_ROUTES.otcCompanies, 'POST', 405],
        [EQUITY_SOURCE_ROUTES.oesCompanies, 'HEAD', 405],
    ])('拒絕 query、任意 target 與錯誤方法：%s %s', async (route, method, status) => {
        const transport = vi.fn<typeof fetch>();
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport }));
        expect((await fetch(origin + route, { method })).status).toBe(status);
        expect(transport).not.toHaveBeenCalled();
    });

    it('拒絕非 loopback Host 以及自訂 POST body，不混接 sidecar /api', async () => {
        const transport = vi.fn<typeof fetch>();
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport }));
        const foreignHostStatus = await new Promise<number>(resolve => {
            const req = httpRequest(origin + ETF_SOURCE_ROUTES.tseFunds, { headers: { Host: 'attacker.example' } }, res => {
                res.resume(); resolve(res.statusCode!);
            });
            req.end();
        });
        expect(foreignHostStatus).toBe(403);
        expect((await fetch(origin + ETF_SOURCE_ROUTES.otcFunds, { method: 'POST', body: '{"target":"attacker"}' })).status).toBe(400);
        const api = await fetch(origin + '/api/v1/info');
        expect(api.status).toBe(404);
        expect(await api.text()).toBe('next');
        expect(transport).not.toHaveBeenCalled();
    });

    it.each(Object.values({ ...ETF_SOURCE_ROUTES, ...EQUITY_SOURCE_ROUTES }))('六條來源都拒絕 client body：%s', async route => {
        const transport = vi.fn<typeof fetch>();
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport }));
        const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest(origin + route, { method: route === ETF_SOURCE_ROUTES.otcFunds ? 'POST' : 'GET',
                headers: { 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!); });
            req.on('error', reject);
            req.end('{}');
        });
        expect(status).toBe(400);
        expect(transport).not.toHaveBeenCalled();
    });

    it('即使 Host 偽裝 loopback，非 loopback socket 仍拒絕', () => {
        const transport = vi.fn<typeof fetch>();
        const res = { writeHead: vi.fn(), end: vi.fn() };
        const middleware = createEtfMetadataMiddleware({ fetch: transport });
        middleware({ url: EQUITY_SOURCE_ROUTES.tseCompanies, headers: { host: '127.0.0.1:5173' }, socket: { remoteAddress: '192.0.2.4' } } as never,
            res as never, vi.fn());
        expect(res.writeHead.mock.calls[0]?.[0]).toBe(403);
        expect(transport).not.toHaveBeenCalled();
    });

    it.each([
        [new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }), 'ETF_METADATA_NOT_JSON'],
        [new Response('invalid', { headers: { 'content-type': 'application/json' } }), 'ETF_METADATA_INVALID_JSON'],
        [new Response('[]', { status: 500, headers: { 'content-type': 'application/json' } }), 'ETF_METADATA_UPSTREAM_FAILED'],
    ])('來源失敗僅回固定 JSON 錯誤，不轉送 HTML', async (upstream, code) => {
        const origin = await listen(createEtfMetadataMiddleware({ fetch: vi.fn<typeof fetch>().mockResolvedValue(upstream) }));
        const response = await fetch(origin + ETF_SOURCE_ROUTES.tseFunds);
        expect(response.status).toBe(502);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual({ error: code });
    });

    it('fetch 尚未回應時仍有總逾時與 AbortSignal', async () => {
        const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport, deadlineMs: 20 }));
        const response = await fetch(origin + ETF_SOURCE_ROUTES.tseFunds);
        expect(response.status).toBe(504);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_TIMEOUT' });
        expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    it('正式總 deadline 是 3000 ms，沒有額外延長到 body 階段', async () => {
        vi.useFakeTimers();
        const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
        const res = { writeHead: vi.fn(), end: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
        createEtfMetadataMiddleware({ fetch: transport })({ url: ETF_SOURCE_ROUTES.tseFunds, method: 'GET',
            headers: { host: '127.0.0.1:5173' }, socket: { remoteAddress: '127.0.0.1' } } as never, res as never, vi.fn());
        await vi.advanceTimersByTimeAsync(2999);
        expect(res.writeHead).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(res.writeHead.mock.calls[0]?.[0]).toBe(504);
        expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'ETF_METADATA_TIMEOUT' }));
        expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    it('總逾時包含 response body，來源中途停住也不掛住', async () => {
        const cancelled = vi.fn();
        const stream = new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('[')); }, cancel: cancelled,
        });
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('[')); },
        }), { headers: { 'content-type': 'application/json' } }));
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport, deadlineMs: 20 }));
        const response = await fetch(origin + ETF_SOURCE_ROUTES.tseFunds);
        expect(response.status).toBe(504);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_TIMEOUT' });
        // A transport ignoring AbortSignal must still release its owned body reader.
        const ownedOrigin = await listen(createEtfMetadataMiddleware({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
            headers: { 'content-type': 'application/json' },
        })), deadlineMs: 20 }));
        expect((await fetch(ownedOrigin + ETF_SOURCE_ROUTES.tseFunds)).status).toBe(504);
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
        expect(stream.locked).toBe(false);
    });

    it('清理 reader 的 cancel 拒絕仍有固定診斷且不留下 unhandled rejection', async () => {
        const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        const stream = new ReadableStream<Uint8Array>({ cancel: () => Promise.reject(new Error('private upstream detail')) });
        const origin = await listen(createEtfMetadataMiddleware({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
            headers: { 'content-type': 'application/json' },
        })), deadlineMs: 20 }));
        expect((await fetch(origin + ETF_SOURCE_ROUTES.tseFunds)).status).toBe(504);
        await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('Public metadata reader cleanup failed', { code: 'PUBLIC_METADATA_CLEANUP_FAILED' }));
        expect(stream.locked).toBe(false);
    });

    it('cancel promise 不結束也不延後 deadline 回應或 reader lock 釋放', async () => {
        const cancelled = vi.fn(() => new Promise<void>(() => undefined));
        const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
        const origin = await listen(createEtfMetadataMiddleware({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
            headers: { 'content-type': 'application/json' },
        })), deadlineMs: 20 }));
        expect((await fetch(origin + ETF_SOURCE_ROUTES.tseFunds)).status).toBe(504);
        expect(cancelled).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
    });

    it('client 中斷連線會取消並釋放仍在等待的 body reader', async () => {
        const cancelled = vi.fn();
        const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } }));
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport, deadlineMs: 1000 }));
        const req = httpRequest(origin + EQUITY_SOURCE_ROUTES.tseCompanies);
        let clientError: NodeJS.ErrnoException | undefined;
        req.on('error', (error: NodeJS.ErrnoException) => { clientError = error; });
        req.end();
        await vi.waitFor(() => expect(stream.locked).toBe(true));
        req.destroy();
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
        expect(stream.locked).toBe(false);
        expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        await vi.waitFor(() => expect(clientError?.code).toBe('ECONNRESET'));
    });

    it('逾時後才回來的 body 也會取消並釋放，不再發布資料', async () => {
        let complete!: (response: Response) => void;
        const cancelled = vi.fn();
        const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
        const origin = await listen(createEtfMetadataMiddleware({ fetch: () => new Promise(resolve => { complete = resolve; }), deadlineMs: 20 }));
        expect((await fetch(origin + ETF_SOURCE_ROUTES.tseFunds)).status).toBe(504);
        complete(new Response(stream, { headers: { 'content-type': 'application/json' } }));
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
        expect(stream.locked).toBe(false);
    });

    it('拒絕無效 UTF-8，即使 replacement 字元仍可組成 JSON', async () => {
        const origin = await listen(createEtfMetadataMiddleware({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([34, 0xff, 34]), {
            headers: { 'content-type': 'application/json' },
        })) }));
        const response = await fetch(origin + EQUITY_SOURCE_ROUTES.tseCompanies);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_INVALID_JSON' });
    });

    it('逐 chunk 限制 body，超限立即失敗而不等待來源結束', async () => {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(17)); },
        }), { headers: { 'content-type': 'application/json' } }));
        const origin = await listen(createEtfMetadataMiddleware({ fetch: transport, maxBytes: 16, deadlineMs: 100 }));
        const response = await fetch(origin + ETF_SOURCE_ROUTES.tseFunds);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_TOO_LARGE' });
        expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    it('上限計算解壓後串流 bytes，不信任較小的壓縮 Content-Length', async () => {
        const compressed = gzipSync(JSON.stringify('x'.repeat(4096)));
        const upstream = createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.byteLength });
            res.end(compressed);
        });
        servers.push(upstream);
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('compressed upstream has no address');
        const origin = await listen(createEtfMetadataMiddleware({ maxBytes: 1024,
            fetch: (_url, options) => nativeFetch(`http://127.0.0.1:${address.port}`, options) }));
        expect(compressed.byteLength).toBeLessThan(1024);
        const response = await fetch(origin + EQUITY_SOURCE_ROUTES.tseCompanies);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_TOO_LARGE' });
        expect(response.headers.get('content-encoding')).toBeNull();
    });

    it.each([0, 1])('正式 decoded body 上限 2 MiB，超出 %i byte 的邊界正確', async extra => {
        const data = JSON.stringify('x'.repeat(2 * 1024 * 1024 - 2 + extra));
        const upstream = new Response(data, { headers: { 'content-type': 'application/json' } });
        const origin = await listen(createEtfMetadataMiddleware({ fetch: vi.fn<typeof fetch>().mockResolvedValue(upstream) }));
        const response = await fetch(origin + EQUITY_SOURCE_ROUTES.tseCompanies);
        expect(response.status).toBe(extra ? 502 : 200);
        if (extra) expect(await response.json()).toEqual({ error: 'ETF_METADATA_TOO_LARGE' });
        else expect(await response.json()).toHaveLength(2 * 1024 * 1024 - 2);
        expect(upstream.body?.locked).toBe(false);
    });

    it('上游 redirect 禁止跟隨，轉成固定失敗 JSON', async () => {
        let redirected = false;
        const upstream = createServer((req, res) => {
            if (req.url === '/target') { redirected = true; res.end('secret'); return; }
            res.writeHead(302, { Location: '/target' }); res.end();
        });
        servers.push(upstream);
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('test upstream has no address');
        const origin = await listen(createEtfMetadataMiddleware({
            fetch: (_url, options) => fetch(`http://127.0.0.1:${address.port}/redirect`, options),
        }));
        const response = await fetch(origin + ETF_SOURCE_ROUTES.tseFunds);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: 'ETF_METADATA_UPSTREAM_FAILED' });
        expect(redirected).toBe(false);
    });

    it('只安裝於 serve 與 127.0.0.1，production build 與 LAN 不啟用', () => {
        const plugin = etfMetadataProxyPlugin();
        expect(plugin.apply).toBe('serve');
        const use = vi.fn();
        const configure = plugin.configureServer;
        if (typeof configure !== 'function') throw new Error('configureServer hook missing');
        for (const host of ['0.0.0.0', 'localhost', true]) {
            configure.call({} as never, { config: { server: { host } }, middlewares: { use } } as unknown as ViteDevServer);
        }
        expect(use).not.toHaveBeenCalled();
        configure.call({} as never, { config: { server: { host: '127.0.0.1' } }, middlewares: { use } } as unknown as ViteDevServer);
        expect(use).toHaveBeenCalledOnce();
    });

    it('preview hook 也只在明確 loopback 啟用', () => {
        const configure = etfMetadataProxyPlugin().configurePreviewServer;
        if (typeof configure !== 'function') throw new Error('configurePreviewServer hook missing');
        const use = vi.fn();
        for (const host of ['0.0.0.0', 'localhost', true, undefined]) {
            configure.call({} as never, { config: { preview: { host } }, middlewares: { use } } as unknown as PreviewServer);
        }
        expect(use).not.toHaveBeenCalled();
        configure.call({} as never, { config: { preview: { host: '127.0.0.1' } }, middlewares: { use } } as unknown as PreviewServer);
        expect(use).toHaveBeenCalledOnce();
        expect(configSource).toMatch(/preview:\s*\{\s*host:\s*'127\.0\.0\.1'\s*\}/);
    });

    it('真實 Vite preview 會載入 apply:serve plugin 並代理固定 metadata，而非 SPA fallback', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'metadata-preview-'));
        temporaryRoots.push(root);
        await mkdir(path.join(root, 'dist'));
        await writeFile(path.join(root, 'dist/index.html'), '<html>local preview fixture</html>');
        const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[{"name":"public"}]', {
            headers: { 'content-type': 'application/json' },
        }));
        const server = await preview({ configFile: false, root, logLevel: 'silent', plugins: [etfMetadataProxyPlugin()],
            preview: { host: '127.0.0.1', port: 0 }, build: { outDir: 'dist' } });
        servers.push(server.httpServer);
        const address = server.httpServer.address();
        if (!address || typeof address === 'string') throw new Error('preview has no address');
        expect(server.config.command).toBe('serve');
        expect(server.config.plugins.some(plugin => plugin.name === 'local-etf-metadata')).toBe(true);
        const response = await nativeFetch(`http://127.0.0.1:${address.port}${EQUITY_SOURCE_ROUTES.tseCompanies}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ name: 'public' }]);
        expect(transport.mock.calls[0]?.[0]).toBe(EQUITY_SOURCES.TSE);
    });
});
