import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real loopback fetch against synthetic metadata only. Never a broker or order.
const m = vi.hoisted(() => ({ base: '' }));
vi.mock('./runtime', async original => ({ ...await original<object>(), getApiBase: () => m.base, isTauri: false }));
vi.mock('./utils/date', async original => ({ ...await original<object>(), todayStr: () => '2026-10-17' }));

const stock = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', category: '' };
const future = { ...stock, code: 'CDFR1', name: '台積電期貨 近月', security_type: 'FUT', exchange: 'TAIFEX',
    underlying_code: '2330', target_code: 'CDFJ6' };
const warrant = { ...stock, code: 'TESTW', name: '合成權證', security_type: 'WRT', underlying_code: '2330',
    expiry_date: '2027-01-01', last_trading_date: '2027-01-01' };
let server: Server;
let mode: 'related' | 'catalog-failure';
let requests: string[];
let held: ServerResponse[];
let closedBeforeReply: number;
let controllers: AbortController[];
let failingBase: ServerResponse | undefined;
const controller = () => {
    const value = new AbortController();
    controllers.push(value);
    return value;
};
function reply(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
}

beforeEach(async () => {
    vi.resetModules();
    mode = 'related';
    requests = [];
    held = [];
    controllers = [];
    closedBeforeReply = 0;
    failingBase = undefined;
    server = createServer((request, response) => {
        const url = new URL(request.url!, 'http://fixture');
        requests.push(url.pathname);
        if (url.pathname.endsWith('/warrants') || mode === 'catalog-failure' && url.pathname.endsWith('/warrants/underlyings')) {
            held.push(response);
            response.on('close', () => { if (!response.writableEnded) closedBeforeReply++; });
            if (mode === 'catalog-failure' && failingBase) reply(failingBase, { message: 'synthetic Base failure' }, 503);
        } else if (url.pathname.endsWith('/warrants/underlyings')) {
            reply(response, [{ underlying_code: '2330', name: '台積電' }]);
        } else if (url.pathname === '/api/v1/data/contracts') {
            if (mode === 'catalog-failure') {
                failingBase = response;
                if (held.length) reply(response, { message: 'synthetic Base failure' }, 503);
            } else reply(response, { region: 'TW', contracts: [{ code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null }] });
        } else if (url.pathname === '/api/v1/data/contracts/2330' || url.pathname === '/api/v1/data/contracts/2330/info') {
            reply(response, stock);
        } else if (url.pathname === '/api/v1/data/contracts/futures') {
            reply(response, [future]);
        } else if (url.pathname === '/api/v1/data/contracts/futures/roots') {
            reply(response, []);
        } else {
            reply(response, { message: 'unexpected non-metadata endpoint' }, 400);
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind');
    m.base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
    controllers.forEach(value => value.abort());
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('search cancellation reaches real loopback fetch', () => {
    it('last reader cancels an in-flight HTTP response after primary results are available', async () => {
        const { searchProducts } = await import('./product-search');
        const signal = controller();
        const onUpdate = vi.fn();
        const pending = searchProducts('2330', 8, { includeWarrants: true, signal: signal.signal, onUpdate });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => {
            expect(held).toHaveLength(1);
            expect(onUpdate.mock.calls.at(-1)?.[0].map((row: { code: string }) => row.code)).toEqual(['2330', 'CDFR1']);
        });
        signal.abort();
        await rejected;
        await vi.waitFor(() => expect(closedBeforeReply).toBe(1));
        // A direct stock code also reads the shared stock catalog for same-prefix stocks.
        expect(requests).toEqual(expect.arrayContaining([
            '/api/v1/data/contracts/2330', '/api/v1/data/contracts/2330/info',
            '/api/v1/data/contracts', '/api/v1/data/contracts/warrants/underlyings',
            '/api/v1/data/contracts/futures', '/api/v1/data/contracts/warrants',
        ]));
        expect(requests).toHaveLength(6);
    });

    it('one cancelled reader leaves the shared real HTTP request usable for the other reader', async () => {
        const { searchProducts } = await import('./product-search');
        const first = controller();
        const second = controller();
        const old = searchProducts('2330', 8, { includeWarrants: true, signal: first.signal });
        const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
        const current = searchProducts('2330', 8, { includeWarrants: true, signal: second.signal });
        await vi.waitFor(() => expect(held).toHaveLength(1));
        first.abort();
        await rejected;
        expect(held[0]?.destroyed).toBe(false);
        expect(closedBeforeReply).toBe(0);
        reply(held[0]!, [warrant]);
        expect((await current).map(row => row.code)).toEqual(['2330', 'CDFR1', 'TESTW']);
        expect(requests.filter(path => path.endsWith('/2330'))).toHaveLength(1);
        expect(requests.filter(path => path.endsWith('/2330/info'))).toHaveLength(1);
        expect(requests.filter(path => path.endsWith('/warrants'))).toHaveLength(1);
    });

    it('an early Base failure releases the composite catalog reader and closes its remaining HTTP source', async () => {
        mode = 'catalog-failure';
        const { searchProducts } = await import('./product-search');
        const pending = searchProducts('不存在商品', 8, { includeWarrants: true });
        await expect(pending).rejects.toThrow('商品搜尋暫時無法完成');
        expect(held).toHaveLength(1);
        // Must close before the source's 1000 ms natural deadline; otherwise
        // the old orphaned-reader implementation could pass by timing out.
        await vi.waitFor(() => expect(held[0]?.destroyed).toBe(true), { timeout: 500, interval: 5 });
        expect(closedBeforeReply).toBe(1);
        expect(requests.filter(path => path.endsWith('/futures'))).toHaveLength(0);
    });
});
