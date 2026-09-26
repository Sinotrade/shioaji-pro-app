import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ nativeFetch: vi.fn(), port: 21322 }));

vi.mock('./runtime', () => ({
    getApiBase: () => `http://127.0.0.1:${mocks.port}`,
    isTauri: true,
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.nativeFetch }));

import { apiGet } from './api';

const infoPath = '/api/v1/data/contracts/2330/info?security_type=STK&region=TW';

describe('contract Info transport in the desktop WebView', () => {
    let browserFetch: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.port++;
        mocks.nativeFetch.mockReset();
        browserFetch = vi.spyOn(globalThis, 'fetch');
        browserFetch.mockReset();
    });

    afterEach(() => browserFetch.mockRestore());

    it('uses WebView fetch for a successful local Info GET', async () => {
        browserFetch.mockResolvedValue(new Response('{"code":"2330"}'));

        await expect(apiGet(infoPath)).resolves.toEqual({ code: '2330' });
        expect(browserFetch).toHaveBeenCalledExactlyOnceWith(
            `http://127.0.0.1:${mocks.port}${infoPath}`, undefined,
        );
        expect(mocks.nativeFetch).not.toHaveBeenCalled();
    });

    it('falls back to the native transport when WebView fetch rejects', async () => {
        browserFetch.mockRejectedValue(new TypeError('Failed to fetch'));
        mocks.nativeFetch.mockResolvedValue(new Response('{"code":"2330"}'));

        await expect(apiGet(infoPath)).resolves.toEqual({ code: '2330' });
        expect(mocks.nativeFetch).toHaveBeenCalledExactlyOnceWith(
            `http://127.0.0.1:${mocks.port}${infoPath}`, undefined,
        );
    });

    it('cools down a rejected origin and reprobes after a transient failure', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        browserFetch.mockRejectedValue(new TypeError('CORS rejected'));
        mocks.nativeFetch.mockImplementation(async () => new Response('{}'));

        try {
            await apiGet(infoPath);
            await apiGet(infoPath.replace('2330', '2317'));
            expect(browserFetch).toHaveBeenCalledTimes(1);
            expect(mocks.nativeFetch).toHaveBeenCalledTimes(2);

            now.mockReturnValue(6_001);
            browserFetch.mockResolvedValue(new Response('{}'));
            await apiGet(infoPath.replace('2330', '2408'));
            expect(browserFetch).toHaveBeenCalledTimes(2);
            expect(mocks.nativeFetch).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });

    it('limits parallel WebView Info GETs to leave connections for SSE', async () => {
        const finish: Array<() => void> = [];
        browserFetch.mockImplementation(() => new Promise<Response>((resolve) => {
            finish.push(() => resolve(new Response('{}')));
        }));
        const requests = Array.from({ length: 8 }, (_, index) =>
            apiGet(infoPath.replace('2330', String(2330 + index))),
        );

        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(4));
        finish.splice(0).forEach((resolve) => resolve());
        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(8));
        finish.splice(0).forEach((resolve) => resolve());
        await expect(Promise.all(requests)).resolves.toHaveLength(8);
        expect(mocks.nativeFetch).not.toHaveBeenCalled();
    });

    it('removes a cancelled request waiting for a WebView slot', async () => {
        const finish: Array<() => void> = [];
        browserFetch.mockImplementation(() => new Promise<Response>((resolve) => {
            finish.push(() => resolve(new Response('{}')));
        }));
        const active = Array.from({ length: 4 }, (_, index) =>
            apiGet(infoPath.replace('2330', String(2330 + index))),
        );
        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(4));

        const controller = new AbortController();
        const cancelled = apiGet(infoPath.replace('2330', '2408'), { signal: controller.signal });
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        expect(browserFetch).toHaveBeenCalledTimes(4);
        expect(mocks.nativeFetch).not.toHaveBeenCalled();

        finish.splice(0).forEach((resolve) => resolve());
        await expect(Promise.all(active)).resolves.toHaveLength(4);
    });

    it('holds a WebView slot until the Info body has arrived', async () => {
        const finish: Array<() => void> = [];
        browserFetch.mockImplementation(async () => new Response(new ReadableStream({
            start(controller) {
                finish.push(() => {
                    controller.enqueue(new TextEncoder().encode('{}'));
                    controller.close();
                });
            },
        })));
        const requests = Array.from({ length: 5 }, (_, index) =>
            apiGet(infoPath.replace('2330', String(2330 + index))),
        );

        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(4));
        expect(browserFetch).toHaveBeenCalledTimes(4);
        finish.shift()?.();
        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(5));
        finish.splice(0).forEach((resolve) => resolve());
        await expect(Promise.all(requests)).resolves.toHaveLength(5);
        expect(mocks.nativeFetch).not.toHaveBeenCalled();
    });

    it('does not let stalled reads on an old port block a newly selected sidecar', async () => {
        const finish: Array<() => void> = [];
        browserFetch.mockImplementation(async () => new Response(new ReadableStream({
            start(controller) {
                finish.push(() => {
                    controller.enqueue(new TextEncoder().encode('{}'));
                    controller.close();
                });
            },
        })));
        const oldPort = Array.from({ length: 4 }, () => apiGet(infoPath));
        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(4));

        mocks.port++;
        const newPort = apiGet(infoPath);
        await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledTimes(5));
        finish.splice(0).forEach((resolve) => resolve());
        await expect(Promise.all([...oldPort, newPort])).resolves.toHaveLength(5);
    });

    it('does not retry an HTTP error through another transport', async () => {
        browserFetch.mockResolvedValue(new Response('{"message":"unknown code"}', { status: 404 }));

        await expect(apiGet(infoPath)).rejects.toThrow('404 unknown code');
        expect(mocks.nativeFetch).not.toHaveBeenCalled();
    });

    it('does not retry an aborted request', async () => {
        const controller = new AbortController();
        browserFetch.mockImplementation(async () => {
            controller.abort();
            throw new DOMException('aborted', 'AbortError');
        });

        await expect(apiGet(infoPath, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.nativeFetch).not.toHaveBeenCalled();
    });

    it('keeps other GETs on the native transport', async () => {
        mocks.nativeFetch.mockResolvedValue(new Response('{}'));

        await expect(apiGet('/api/v1/data/contracts/2330')).resolves.toEqual({});
        expect(browserFetch).not.toHaveBeenCalled();
        expect(mocks.nativeFetch).toHaveBeenCalledTimes(1);
    });
});
