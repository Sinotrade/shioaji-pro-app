// 整零價差行情轉接：整股取一般 store、零股取 #204 盤中零股 store
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const mocks = vi.hoisted(() => ({ useQuote: vi.fn(), useDisplayBook: vi.fn() }));
vi.mock('./use-stream', () => ({ useQuote: mocks.useQuote }));
vi.mock('./use-display-book', () => ({ useDisplayBook: mocks.useDisplayBook }));

import { useOddSpreadFeed, type OddSpreadFeed } from './use-odd-spread-feed';

const contract = { code: '2330', security_type: 'STK', reference: 1080, target_code: null } as unknown as ContractInfo;
let feed: OddSpreadFeed | undefined;
function Probe({ c = contract }: { c?: ContractInfo }) {
    feed = useOddSpreadFeed(c);
    return null;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    feed = undefined;
    mocks.useDisplayBook.mockReturnValue({
        quote: { tick: { close: '1085', price_chg: '5' } },
        snapshot: undefined,
        book: { bids: [{ price: 1080, vol: 1904 }], asks: [{ price: 1085, vol: 2317 }], source: 'stream' },
    });
});
afterEach(() => vi.unstubAllGlobals());

it('零股五檔、成交與撮合時間取零股 store（oddLot 訂閱）', async () => {
    mocks.useQuote.mockReturnValue({
        tick: { code: '2330', close: '1095', time: '10:52:57.123456', intraday_odd: true },
        bidask: { code: '2330', date: '2026/09/30', time: '10:52:57', bid_price: ['1095', '1090'], bid_volume: [380, 1020], ask_price: ['1100'], ask_volume: [86], intraday_odd: true },
    });
    await act(async () => { create(createElement(Probe)); });
    expect(mocks.useQuote).toHaveBeenCalledWith('2330', { oddLot: true });
    expect(feed).toMatchObject({
        round: { bids: [{ price: 1080, vol: 1904 }], asks: [{ price: 1085, vol: 2317 }] },
        odd: { bids: [{ price: 1095, vol: 380 }, { price: 1090, vol: 1020 }], asks: [{ price: 1100, vol: 86 }] },
        roundLast: 1085,
        roundChange: 5,
        oddLast: 1095,
        oddChange: 15,
        oddTime: '10:52:57',
        oddAvailable: true,
    });
});

it('尚未收到零股行情：零股簿為空、oddAvailable=false（不以整股快照補）', async () => {
    mocks.useQuote.mockReturnValue(undefined);
    await act(async () => { create(createElement(Probe)); });
    expect(feed).toMatchObject({ odd: { bids: [], asks: [] }, oddLast: null, oddTime: null, oddAvailable: false });
});

it('非股票不訂閱零股', async () => {
    mocks.useQuote.mockReturnValue(undefined);
    await act(async () => { create(createElement(Probe, { c: { ...contract, security_type: 'FUT' } as ContractInfo })); });
    expect(mocks.useQuote).toHaveBeenCalledWith(null, { oddLot: true });
});
