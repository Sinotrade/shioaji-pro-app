import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { EQUITY_SOURCE_ROUTES, EQUITY_SOURCES, ETF_SOURCE_ROUTES } from '../src/lib/public-metadata-routes';
import { ETF_SOURCES } from '../src/lib/etf-catalog-normalizer.mjs';

const routes = new Map<string, { url: string; method: string }>([
    [ETF_SOURCE_ROUTES.tseFunds, { url: ETF_SOURCES.TSE, method: 'GET' }],
    [ETF_SOURCE_ROUTES.otcFunds, { url: ETF_SOURCES.OTC, method: 'POST' }],
    [ETF_SOURCE_ROUTES.tseNames, { url: ETF_SOURCES.TSE_NAMES, method: 'GET' }],
    [EQUITY_SOURCE_ROUTES.tseCompanies, { url: EQUITY_SOURCES.TSE, method: 'GET' }],
    [EQUITY_SOURCE_ROUTES.otcCompanies, { url: EQUITY_SOURCES.OTC, method: 'GET' }],
    [EQUITY_SOURCE_ROUTES.oesCompanies, { url: EQUITY_SOURCES.OES, method: 'GET' }],
]);
const MAX_BYTES = 2 * 1024 * 1024;

class MetadataError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
}

function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
}

// The Host check blocks DNS rebinding. `localhost` (the README dev URL) can only
// come from a page on this machine; the socket check below still applies.
function isLoopback(req: IncomingMessage): boolean {
    return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(req.headers.host ?? '')
        && ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress ?? '');
}

/** Six fixed ETF/equity name-only routes. The injectable transport/bounds support local QA;
 * neither targets nor client request data are configurable or forwarded.
 */
export function createEtfMetadataMiddleware(options: {
    fetch?: typeof globalThis.fetch; deadlineMs?: number; maxBytes?: number;
} = {}): Connect.NextHandleFunction {
    const request = options.fetch ?? globalThis.fetch;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const deadlineMs = options.deadlineMs ?? 3000;
    return (req, res, next) => {
        if (!req.url?.startsWith('/metadata/')) { next(); return; }
        if (!isLoopback(req)) { json(res, 403, { error: 'ETF_METADATA_LOCAL_ONLY' }); return; }
        const route = routes.get(req.url);
        if (!route) {
            json(res, req.url.includes('?') ? 400 : 404, { error: 'ETF_METADATA_ROUTE_INVALID' });
            return;
        }
        if (req.method !== route.method) {
            res.setHeader('Allow', route.method);
            json(res, 405, { error: 'ETF_METADATA_METHOD_INVALID' });
            return;
        }
        if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
            req.resume();
            json(res, 400, { error: 'ETF_METADATA_BODY_FORBIDDEN' });
            return;
        }
        const controller = new AbortController();
        let settled = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const cleanupWarning = () => process.emitWarning('Public metadata reader cleanup failed', { code: 'PUBLIC_METADATA_CLEANUP_FAILED' });
        const release = (owned: ReadableStreamDefaultReader<Uint8Array>) => {
            try { owned.releaseLock(); } catch { cleanupWarning(); }
        };
        const cancel = (owned: ReadableStreamDefaultReader<Uint8Array>) => {
            // Do not await an uncooperative source's cancel promise before releasing our lock.
            try { void owned.cancel().catch(cleanupWarning); } catch { cleanupWarning(); }
            release(owned);
        };
        const settle = (result: { data: unknown } | { error: unknown }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res.removeListener('close', onClose);
            const owned = reader;
            reader = undefined;
            if ('error' in result) {
                if (owned) cancel(owned);
                controller.abort();
                if (res.destroyed) return;
                const failure = result.error instanceof MetadataError ? result.error : new MetadataError(502, 'ETF_METADATA_UPSTREAM_FAILED');
                json(res, failure.status, { error: failure.code });
            } else if (!res.destroyed) json(res, 200, result.data);
        };
        const timer = setTimeout(() => settle({ error: new MetadataError(504, 'ETF_METADATA_TIMEOUT') }), deadlineMs);
        const onClose = () => { if (!res.writableEnded) settle({ error: new MetadataError(499, 'ETF_METADATA_CLIENT_CLOSED') }); };
        res.on('close', onClose);
        const load = async () => {
            const response = await request(route.url, {
                method: route.method, headers: { Accept: 'application/json' },
                credentials: 'omit', redirect: 'error', signal: controller.signal,
            });
            const owned = response.body?.getReader();
            if (settled) { if (owned) cancel(owned); return; }
            reader = owned;
            if (response.headers.has('set-cookie')) throw new MetadataError(502, 'ETF_METADATA_COOKIE_FORBIDDEN');
            if (!response.ok) throw new MetadataError(502, 'ETF_METADATA_UPSTREAM_FAILED');
            if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
                throw new MetadataError(502, 'ETF_METADATA_NOT_JSON');
            }
            if (!owned) throw new MetadataError(502, 'ETF_METADATA_INVALID_JSON');
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            while (true) {
                const chunk = await owned.read();
                if (settled) return;
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > maxBytes) throw new MetadataError(502, 'ETF_METADATA_TOO_LARGE');
                chunks.push(chunk.value);
            }
            reader = undefined;
            release(owned);
            // Fetch exposes decoded body bytes; never forward its content-encoding header.
            try { settle({ data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }); }
            catch { throw new MetadataError(502, 'ETF_METADATA_INVALID_JSON'); }
        };
        void load().catch((error: unknown) => settle({ error }));
    };
}

export function etfMetadataProxyPlugin(): Plugin {
    return {
        name: 'local-etf-metadata', apply: 'serve',
        configureServer(server) {
            if (server.config.server.host === '127.0.0.1') server.middlewares.use(createEtfMetadataMiddleware());
        },
        configurePreviewServer(server) {
            if (server.config.preview.host === '127.0.0.1') server.middlewares.use(createEtfMetadataMiddleware());
        },
    };
}
