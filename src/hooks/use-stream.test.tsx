import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QuoteState } from '../lib/stream';
import { useQuote, type PriceQuoteState } from './use-stream';

const mocks = vi.hoisted(() => ({ quotes: new Map<string, QuoteState>(), listeners: new Set<() => void>() }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => ({ code }) }));
vi.mock('../lib/quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('../lib/stream', () => ({
    ensureStream: vi.fn(), getQuote: (code: string, odd: boolean) => mocks.quotes.get(`${code}:${odd}`),
    subscribeQuoteStore: (_code: string, listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; },
}));
let root: ReactTestRenderer;
let narrow: PriceQuoteState | undefined;
let full: QuoteState | undefined;
let renders = 0;
function Probe({ code = '2330', oddLot = false }: { code?: string; oddLot?: boolean }) {
    narrow = useQuote(code, { narrow: true, oddLot }); renders++;
    return null;
}
function FullProbe() { full = useQuote('2330'); return null; }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.quotes.clear(); mocks.listeners.clear(); renders = 0; });
afterEach(() => { act(() => root?.unmount()); vi.unstubAllGlobals(); });
const quote = () => ({ tick: { close: '2420' }, lastDir: 0, seq: 1, flashSeq: 1 }) as QuoteState;
function publish(value: QuoteState) { act(() => { mocks.quotes.set('2330:false', value); mocks.listeners.forEach(listener => listener()); }); }

it('BidAsk 單獨變更不喚醒窄視圖，成交與指數變更仍更新', async () => {
    const original = quote(); mocks.quotes.set('2330:false', original);
    await act(async () => { root = create(createElement(Probe)); });
    const before = narrow;
    publish({ ...original, bidask: { code: '2330' } as QuoteState['bidask'], seq: 2 });
    expect(narrow).toBe(before); expect(renders).toBe(1);
    const changed = { ...original, tick: { ...original.tick!, close: '2425' } };
    publish(changed);
    expect(narrow).not.toBe(before); expect(narrow?.tick?.close).toBe('2425');
    const previous = narrow;
    publish({ ...changed, index: { code: 'IX0001' } as QuoteState['index'] });
    expect(narrow).not.toBe(previous);
});

it('切換代碼或整股／零股範圍會重新建立窄視圖，即使原始參照相同', async () => {
    const shared = quote();
    for (const key of ['2330:false', '2890:false', '2890:true']) mocks.quotes.set(key, shared);
    await act(async () => { root = create(createElement(Probe)); });
    const stock = narrow;
    act(() => root.update(createElement(Probe, { code: '2890' })));
    expect(narrow).not.toBe(stock);
    const regular = narrow;
    act(() => root.update(createElement(Probe, { code: '2890', oddLot: true })));
    expect(narrow).not.toBe(regular);
});

it('既有完整視圖仍收到 BidAsk 與 seq 變動', async () => {
    mocks.quotes.set('2330:false', quote());
    await act(async () => { root = create(createElement(FullProbe)); });
    const changed = { ...full!, bidask: { code: '2330' } as QuoteState['bidask'], seq: 2 };
    publish(changed);
    expect(full).toBe(changed);
});
