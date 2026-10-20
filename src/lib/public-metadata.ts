import { isTauri } from './runtime';
import { ETF_SOURCE_ROUTES, EQUITY_SOURCE_ROUTES, type PublicMetadataRoute } from './public-metadata-routes';

const ROUTES = new Set<string>([...Object.values(ETF_SOURCE_ROUTES), ...Object.values(EQUITY_SOURCE_ROUTES)]);
const DEADLINE_MS = 5000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Public name metadata only. Native transport stays gated until its cookie policy is verified. */
export function fetchPublicJson(route: PublicMetadataRoute, options: {
    signal?: AbortSignal; onCleanupError?: (error: unknown) => void;
} = {}): Promise<unknown> {
    if (!ROUTES.has(route)) return Promise.reject(new Error('Public metadata route is not allowed'));
    if (isTauri) return Promise.reject(new Error('Native public metadata transport is not enabled'));
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let settled = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        const settle = (result: { data: unknown } | { error: unknown }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
            if ('error' in result) {
                const owned = reader;
                reader = null;
                if (owned) {
                    void owned.cancel().catch(error => options.onCleanupError?.(error));
                    owned.releaseLock();
                }
                controller.abort();
                reject(result.error);
            } else resolve(result.data);
        };
        const abort = () => settle({ error: new Error('Public metadata refresh cancelled') });
        const timer = setTimeout(() => settle({ error: new Error('Public metadata deadline exceeded') }), DEADLINE_MS);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        void (async () => {
            const response = await fetch(route, {
                method: route === ETF_SOURCE_ROUTES.otcFunds ? 'POST' : 'GET',
                credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
            });
            if (settled) {
                void response.body?.cancel().catch(error => options.onCleanupError?.(error));
                return;
            }
            if (!response.ok) throw new Error(`Public metadata HTTP ${response.status}`);
            if (!response.body) throw new Error('Public metadata body is empty');
            if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
                throw new Error('Public metadata response is not JSON');
            }
            const owned = response.body.getReader();
            reader = owned;
            try {
                const declaredBytes = Number(response.headers.get('content-length'));
                if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) throw new Error('Public metadata exceeds 2 MiB');
                const chunks: Uint8Array[] = [];
                let total = 0;
                for (;;) {
                    const chunk = await owned.read();
                    if (settled) return;
                    if (chunk.done) break;
                    total += chunk.value.byteLength;
                    if (total > MAX_BODY_BYTES) throw new Error('Public metadata exceeds 2 MiB');
                    chunks.push(chunk.value);
                }
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                settle({ data });
            } catch (error) { settle({ error }); }
            finally { if (reader === owned) { reader = null; owned.releaseLock(); } }
        })().catch(error => settle({ error }));
    });
}
