// 商品搜尋什麼時候才去載入美股清單（約 1.3 萬檔）：像代碼、或命中美股名稱；台股輸入不載入
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({
    ensure: vi.fn(),
    search: vi.fn(),
}));
vi.mock('../lib/us/us-contracts', () => ({
    ensureUsContracts: mocks.ensure,
    subscribeUsContracts: () => () => undefined,
    usCatalogStatus: () => 'idle',
}));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));

import { useProductSearch } from './use-product-search';

let r: ReactTestRenderer | null = null;
afterEach(() => { act(() => r?.unmount()); r = null; vi.clearAllMocks(); });

function Probe({ query }: { query: string }) {
    useProductSearch(query, { limit: 8 });
    return null;
}
function typed(query: string) {
    mocks.ensure.mockResolvedValue(undefined);
    mocks.search.mockResolvedValue([]);
    act(() => { r = create(createElement(Probe, { query })); });
}

describe('when useProductSearch loads the US catalog', () => {
    // 前兩個像代碼；其餘不像代碼（中文、含空白、含 &、超過 10 字），只靠名稱表命中才會載入
    it.each(['AAPL', 'apple', '蘋果', 'Coca Cola', 'johnson & johnson', 'berkshire hathaway', 'microsoft corp'])('loads it for %s', (query) => {
        typed(query);
        expect(mocks.ensure).toHaveBeenCalledTimes(1);
    });

    // 台股常見輸入、泛用詞（含台股也有的兩字詞：電子、國際、美國、第一、聯合）、沒有名稱的中文都不該去載入 1.3 萬檔清單
    it.each(['2330', '鴻海', '台積電期', '科技', '半導體', '電子股', '銀行', '金融', '電子', '國際', '美國', '第一', '聯合', ''])('does not load it for %j', (query) => {
        typed(query);
        expect(mocks.ensure).not.toHaveBeenCalled();
    });

    it('loads it once when the query changes from one name to another', () => {
        typed('Coca Cola');
        act(() => r!.update(createElement(Probe, { query: 'Coca Cola Co' })));
        expect(mocks.ensure).toHaveBeenCalledTimes(1);
    });
});
