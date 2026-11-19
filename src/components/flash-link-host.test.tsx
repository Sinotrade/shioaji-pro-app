// 閃電「對應商品」：面板收到的來源商品依設定換成實際下單的合約。沒有個股期、
// 非個股都暫停並說明，不保留上一檔；連動狀態一變 linkKey 就跟著變。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ fetchFutures: vi.fn(), ensure: vi.fn(), cache: new Map<string, unknown>() }));
vi.mock('../lib/shioaji', () => ({ fetchFutures: mocks.fetchFutures }));
vi.mock('../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code ? mocks.cache.get(code) : undefined),
    getCachedContract: (code: string) => mocks.cache.get(code),
    primeContract: (c: ContractInfo) => { mocks.cache.set(c.code, c); },
    ensureContract: mocks.ensure,
}));
import { FlashLinkHost, resetStockFuturesCache } from './flash-link-host';
import { DEFAULT_FLASH_LINK, type FlashLink } from '../lib/flash-link';

const stock = (code: string, name: string) => ({ code, name, security_type: 'STK', exchange: 'TSE' }) as unknown as ContractInfo;
const tsmc = stock('2330', '台積電');
const fut = (code: string, root: string, month: string, multiplier: number, und = '2330') => ({
    code, root, delivery_month: month, last_trading_date: `${month.slice(0, 4)}-${month.slice(4)}-20`, multiplier, target_code: null,
    security_type: 'FUT', underlying_code: und, underlying_kind: 'S', name: `${root} ${month}`,
}) as unknown as ContractInfo;
const tsmcFut = [fut('CDFJ6', 'CDF', '202610', 2000), fut('CDFK6', 'CDF', '202611', 2000), fut('QFFJ6', 'QFF', '202610', 100)];
const txf = { code: 'TXFR1', name: '臺股期貨 近月', security_type: 'FUT', underlying_code: 'IX0001', underlying_kind: 'I' } as unknown as ContractInfo;

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
type Seen = { code: string; linkKey: string; paused?: string };
let seen: Seen[] = [];
const host = (source: ContractInfo, link: Partial<FlashLink>, extra: Record<string, unknown> = {}) => createElement(FlashLinkHost, {
    source,
    link: { ...DEFAULT_FLASH_LINK, ...link },
    group: 'A',
    onLinkChange: vi.fn(),
    render: (c: ContractInfo, p: { linkKey: string; paused?: string }) => { seen.push({ code: c.code, linkKey: p.linkKey, paused: p.paused }); return createElement('i', null, `ladder ${c.code}`); },
    ...extra,
});
const mount = async (source: ContractInfo, link: Partial<FlashLink>, extra: Record<string, unknown> = {}) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(host(source, link, extra)); });
    roots.push(r);
    return r;
};
const show = async (r: ReactTestRenderer, source: ContractInfo, link: Partial<FlashLink>, extra: Record<string, unknown> = {}) => {
    await act(async () => { r.update(host(source, link, extra)); });
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:00+08:00'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.cache.clear();
    resetStockFuturesCache();
    seen = [];
    mocks.fetchFutures.mockImplementation(async ({ underlyingCode }: { underlyingCode: string }) =>
        underlyingCode === '2330' ? tsmcFut : underlyingCode === '2317' ? [fut('DHFJ6', 'DHF', '202610', 2000, '2317')] : []);
    mocks.ensure.mockImplementation(async (code: string) => {
        const c = code === '2330' ? tsmc : stock(code, code);
        mocks.cache.set(code, c);
        return c;
    });
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('照選取 passes the selection through unchanged', async () => {
    const r = await mount(txf, {});
    expect(text(r.root)).toBe('ladder TXFR1');
});

it('個股期 maps a stock to its near-month standard future, and follows the group to another stock', async () => {
    const r = await mount(tsmc, { kind: 'future' });
    expect(text(r.root)).toContain('ladder CDFJ6');
    await show(r, stock('2317', '鴻海'), { kind: 'future' });
    expect(text(r.root)).toContain('ladder DHFJ6');
    // the old stock's future is never live against the new stock (only kept, paused, while looking up)
    expect(seen.filter(s => s.linkKey.includes('2317') && !s.paused).every(s => s.code === 'DHFJ6')).toBe(true);
});

it('個股期 spec and month settings pick mini / next month', async () => {
    const r = await mount(tsmc, { kind: 'future', spec: 'mini' });
    expect(text(r.root)).toContain('ladder QFFJ6');
    await show(r, tsmc, { kind: 'future', month: 'next' });
    expect(text(r.root)).toContain('ladder CDFK6');
});

it('a stock without stock futures pauses with an explanation and a 改為現股 button', async () => {
    const onLinkChange = vi.fn();
    const r = await mount(stock('1258', '其祥-KY'), { kind: 'future' }, { onLinkChange });
    expect(text(r.root)).toContain('1258 其祥-KY 沒有個股期貨');
    expect(text(r.root)).not.toContain('ladder');
    const btn = r.root.findAllByType('button').find(b => text(b).includes('改為現股'))!;
    await act(async () => { btn.props.onClick(); });
    expect(onLinkChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stock' }));
});

it('a stock with no mini future says so instead of using the standard one', async () => {
    const r = await mount(stock('2317', '鴻海'), { kind: 'future', spec: 'mini' });
    expect(text(r.root)).toContain('沒有小型個股期');
    expect(text(r.root)).not.toContain('ladder');
});

it('現股／個股期 panels pause on a non-stock (index future) instead of keeping the previous stock', async () => {
    const r = await mount(tsmc, { kind: 'stock' });
    expect(text(r.root)).toContain('ladder 2330');
    await show(r, txf, { kind: 'stock' });
    expect(text(r.root)).toContain('臺股期貨 近月 不是個股');
    expect(text(r.root)).not.toContain('ladder');
    await show(r, txf, { kind: 'future' });
    expect(text(r.root)).toContain('不是個股');
});

it('現股 maps a stock future back to its stock', async () => {
    const r = await mount(tsmcFut[0]!, { kind: 'stock' });
    expect(text(r.root)).toContain('ladder 2330');
});

it('the link key changes with group, mapping, spec, month and source', async () => {
    const r = await mount(tsmc, { kind: 'future' });
    const keys = new Set<string>();
    const last = () => seen.at(-1)!.linkKey;
    keys.add(last());
    await show(r, tsmc, { kind: 'future' }, { group: 'B' });
    keys.add(last());
    await show(r, tsmc, { kind: 'future', month: 'next' }, { group: 'B' });
    keys.add(last());
    await show(r, tsmcFut[1]!, { kind: 'future', month: 'next' }, { group: 'B' });
    keys.add(last());
    expect(keys.size).toBe(4);
});

it('a failed futures lookup says so and can retry', async () => {
    mocks.fetchFutures.mockRejectedValueOnce(new Error('down'));
    const r = await mount(tsmc, { kind: 'future' });
    expect(text(r.root)).toContain('個股期合約載入失敗');
    const retry = r.root.findAllByType('button').find(b => text(b).includes('重試'))!;
    await act(async () => { retry.props.onClick(); });
    expect(text(r.root)).toContain('ladder CDFJ6');
});

it('reports the traded contract for a popout, and nothing while paused', async () => {
    const targetRef = { current: 'stale' as string | null };
    const r = await mount(tsmc, { kind: 'future' }, { targetRef });
    expect(targetRef.current).toBe('CDFJ6');
    await show(r, txf, { kind: 'future' }, { targetRef });
    expect(targetRef.current).toBeNull();
});

it('a chosen month that is not listed says so (not 已到期)', async () => {
    const r = await mount(tsmc, { kind: 'future', month: '202704' });
    expect(text(r.root)).toContain('沒有 2027/4 合約');
});

it('passes the picked contract\'s expiry instant to the ladder', async () => {
    let expiresAt: unknown;
    await mount(tsmc, { kind: 'future' }, { render: (_c: ContractInfo, p: { expiresAt?: number }) => { expiresAt = p.expiresAt; return null; } });
    expect(expiresAt).toBe(Date.parse('2026-10-20T13:30:00+08:00'));
});

it('after a contract expires the futures list is fetched again (newly listed months appear) and rolls to the next month', async () => {
    const r = await mount(tsmc, { kind: 'future' });
    expect(text(r.root)).toContain('ladder CDFJ6');
    expect(mocks.fetchFutures).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-20T14:00:00+08:00'));
    await show(r, tsmc, { kind: 'future' });
    await show(r, tsmc, { kind: 'future' });
    expect(mocks.fetchFutures).toHaveBeenCalledTimes(2);
    expect(text(r.root)).toContain('ladder CDFK6');
});

it('次月 missing for a one-month stock offers 改為近月, not 改為現股', async () => {
    const onLinkChange = vi.fn();
    const r = await mount(stock('2317', '鴻海'), { kind: 'future', month: 'next' }, { onLinkChange });
    expect(text(r.root)).toContain('2317 沒有次月合約');
    const btn = r.root.findAllByType('button').find(b => text(b).includes('改為近月'))!;
    await act(async () => { btn.props.onClick(); });
    expect(onLinkChange).toHaveBeenCalledWith(expect.objectContaining({ month: 'near' }));
});

it('while a lookup is in progress the ladder stays mounted (paused) instead of being replaced', async () => {
    let release!: (rows: ContractInfo[]) => void;
    const r = await mount(tsmc, { kind: 'future' });
    expect(text(r.root)).toContain('ladder CDFJ6');
    mocks.fetchFutures.mockImplementationOnce(() => new Promise(res => { release = res; }));
    const pausedSeen: unknown[] = [];
    const render = (c: ContractInfo, p: { linkKey: string; paused?: string }) => { pausedSeen.push(p.paused); seen.push({ code: c.code, linkKey: p.linkKey }); return createElement('i', null, `ladder ${c.code}${p.paused ? ' paused' : ''}`); };
    await show(r, stock('2317', '鴻海'), { kind: 'future' }, { render });
    expect(text(r.root)).toContain('paused');
    expect(pausedSeen.at(-1)).toBe('載入個股期…');
    await act(async () => { release([fut('DHFJ6', 'DHF', '202610', 2000, '2317')]); });
    await show(r, stock('2317', '鴻海'), { kind: 'future' }, { render });
    expect(text(r.root)).toBe('ladder DHFJ6');
});

it('while paused for a re-fetch the ladder keeps the previous roll-over deadline', async () => {
    const got: unknown[] = [];
    const render = (_c: ContractInfo, p: { expiresAt?: number | null; paused?: string }) => { got.push([p.paused, p.expiresAt]); return null; };
    const r = await mount(tsmc, { kind: 'future', month: 'next' }, { render });
    const deadline = (got.at(-1) as unknown[])[1];
    expect(deadline).toBe(Date.parse('2026-10-20T13:30:00+08:00'));
    mocks.fetchFutures.mockImplementationOnce(() => new Promise(() => undefined));
    vi.setSystemTime(new Date('2026-10-20T14:00:00+08:00'));
    await show(r, tsmc, { kind: 'future', month: 'next' }, { render });
    await show(r, tsmc, { kind: 'future', month: 'next' }, { render });
    expect(got.at(-1)).toEqual(['載入個股期…', deadline]);
});

it('a series without a last trading date pauses with a way out (改為現股)', async () => {
    mocks.fetchFutures.mockImplementation(async () => tsmcFut.map(f => ({ ...f, last_trading_date: undefined })));
    const onLinkChange = vi.fn();
    const r = await mount(tsmc, { kind: 'future' }, { onLinkChange });
    expect(text(r.root)).toContain('到期日無法確認');
    const btn = r.root.findAllByType('button').find(b => text(b).includes('改為現股'))!;
    await act(async () => { btn.props.onClick(); });
    expect(onLinkChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stock' }));
});

it('a month that is not listed yet can be looked up again', async () => {
    const r = await mount(stock('2317', '鴻海'), { kind: 'future', month: 'next' });
    expect(text(r.root)).toContain('沒有次月合約');
    mocks.fetchFutures.mockImplementation(async () => [fut('DHFJ6', 'DHF', '202610', 2000, '2317'), fut('DHFK6', 'DHF', '202611', 2000, '2317')]);
    const retry = r.root.findAllByType('button').find(b => text(b).includes('重新查詢'))!;
    await act(async () => { retry.props.onClick(); });
    await show(r, stock('2317', '鴻海'), { kind: 'future', month: 'next' });
    expect(text(r.root)).toContain('ladder DHFK6');
});

it('a pending group lookup pauses the ladder under a new link key', async () => {
    const r = await mount(tsmc, { kind: 'select' });
    const before = seen.at(-1)!.linkKey;
    const got: { paused?: string; linkKey: string }[] = [];
    const render = (_c: ContractInfo, p: { linkKey: string; paused?: string }) => { got.push(p); return null; };
    await show(r, tsmc, { kind: 'select' }, { render, pending: '2317' });
    expect(got.at(-1)!.paused).toBe('載入商品…');
    expect(got.at(-1)!.linkKey).not.toBe(before);
});

it('a failed stock lookup for 現股 offers retry and 改為照選取', async () => {
    mocks.ensure.mockRejectedValueOnce(new Error('down'));
    const onLinkChange = vi.fn();
    const r = await mount(tsmcFut[0]!, { kind: 'stock' }, { onLinkChange });
    expect(text(r.root)).toContain('找不到 2330');
    const retry = r.root.findAllByType('button').find(b => text(b).includes('重試'))!;
    await act(async () => { retry.props.onClick(); });
    expect(text(r.root)).toContain('ladder 2330');
    expect(r.root.findAllByType('button').length).toBe(0);
});

it('freshly fetched futures replace stale cached copies of the same contract', async () => {
    mocks.cache.set('CDFJ6', { ...tsmcFut[0]!, multiplier: 100, last_trading_date: undefined });
    let got: ContractInfo | undefined;
    await mount(tsmc, { kind: 'future' }, { render: (c: ContractInfo) => { got = c; return null; } });
    expect(got).toMatchObject({ code: 'CDFJ6', multiplier: 2000, last_trading_date: '2026-10-20' });
});

it('two panels on the same stock share one re-fetch at roll-over; a late failure cannot undo a success', async () => {
    const a = await mount(tsmc, { kind: 'future' });
    const b = await mount(tsmc, { kind: 'future' });
    expect(mocks.fetchFutures).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-20T14:00:00+08:00'));
    await act(async () => {
        a.update(host(tsmc, { kind: 'future' }));
        b.update(host(tsmc, { kind: 'future' }));
    });
    await show(a, tsmc, { kind: 'future' });
    expect(mocks.fetchFutures).toHaveBeenCalledTimes(2);
    expect(text(a.root)).toContain('ladder CDFK6');
    expect(text(b.root)).toContain('ladder CDFK6');
});

it('美股來源一律照選取：不查個股期、不找現股，linkKey 用 US:CODE', async () => {
    const aapl = { code: 'AAPL', name: 'Apple', region: 'US', security_type: 'STK', exchange: 'NASDAQ' } as unknown as ContractInfo;
    const targetRef = { current: null as string | null };
    for (const kind of ['future', 'stock', 'select'] as const) {
        seen = [];
        const r = await mount(aapl, { kind }, { targetRef });
        expect(text(r.root)).toBe('ladder AAPL');
        expect(seen.at(-1)).toMatchObject({ code: 'AAPL', paused: undefined });
        expect(seen.at(-1)!.linkKey).toContain('|US:AAPL');
        expect(targetRef.current).toBe('US:AAPL');
    }
    expect(mocks.fetchFutures).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
});
