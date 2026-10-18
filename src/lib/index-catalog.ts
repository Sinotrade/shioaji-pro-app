import { indexSearchSuggestions } from './index-search';
import { getProductCatalogVersion, subscribeProductCatalog } from './product-catalog-version';
import { SearchRequestCache } from './search-request';
import { fetchContracts } from './shioaji';

const baseCache = new SearchRequestCache<Awaited<ReturnType<typeof fetchContracts>>>({
    ttlMs: 60_000, limit: 1, deadlineMs: 1200, queue: 'none',
});
let activeVersion = getProductCatalogVersion();

function currentVersion(): number {
    const version = getProductCatalogVersion();
    if (version !== activeVersion) {
        activeVersion = version;
        baseCache.clear();
    }
    return version;
}

const unsubscribe = subscribeProductCatalog(() => { currentVersion(); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

/** Local names are suggestions only; live Base identities decide availability.
 * New IND codes outside the local name list remain accessible by direct code.
 */
export async function loadIndexSuggestions(query: string, opts?: { signal?: AbortSignal }) {
    if (opts?.signal?.aborted) throw new DOMException('商品搜尋已取消', 'AbortError');
    const candidates = indexSearchSuggestions(query);
    if (candidates.length === 0) return [];
    const version = currentVersion();
    const assertVersion = () => {
        if (getProductCatalogVersion() !== version) throw new Error('指數目錄載入期間商品目錄已更新，請重試');
    };
    const result = await baseCache.read(String(version), signal => {
        assertVersion();
        return fetchContracts('IND', undefined, undefined, { signal });
    }, opts?.signal);
    assertVersion();
    const supported = new Set(result.contracts
        // Base.region is optional; the batch envelope carries the query region.
        .filter(row => (row.region ?? result.region) === 'TW' && row.security_type === 'IND')
        .map(row => JSON.stringify([row.exchange, row.code])));
    return candidates.filter(row => supported.has(JSON.stringify([row.exchange, row.code])));
}
