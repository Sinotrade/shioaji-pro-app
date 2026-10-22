import { useCallback, useEffect, useRef, useState } from 'react';
import { getProductCatalogVersion, useProductCatalogVersion } from '../lib/product-catalog-version';
import { loadStockCatalog, type StockMeta } from '../lib/stock-index';
import { useProductNamesVersion } from './use-product-names-version';

interface StockCatalogEvents {
    // 目前版本的目錄讀到時呼叫，與目錄狀態同一批更新
    onLoad?: (catalog: StockMeta[]) => void;
    onError?: () => void;
}

// 標的股票目錄：目錄版本、名稱版本變更、視窗重新取得焦點或 retry 時重讀。
// 已取消或屬於舊版本的回應一律丟棄，ready 只在目錄屬於目前版本且未失敗時成立。
// reloads 是 focus 與 retry 的累計次數，衍生資料以它決定何時跟著重抓。
export function useStockCatalog(events: StockCatalogEvents = {}) {
    const version = useProductCatalogVersion();
    const namesVersion = useProductNamesVersion();
    const [catalog, setCatalog] = useState<StockMeta[]>([]);
    const [catalogVersion, setCatalogVersion] = useState(-1);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(false);
    const [reloads, setReloads] = useState(0);
    const eventsRef = useRef(events);
    eventsRef.current = events;

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        const isCurrent = () => active && getProductCatalogVersion() === version;
        setLoading(true);
        setError(false);
        loadStockCatalog({ signal: controller.signal })
            .then((rows) => {
                if (!isCurrent()) return;
                setCatalog(rows);
                setCatalogVersion(version);
                eventsRef.current.onLoad?.(rows);
            })
            .catch(() => { if (isCurrent()) { setError(true); eventsRef.current.onError?.(); } })
            .finally(() => { if (isCurrent()) setLoading(false); });
        return () => { active = false; controller.abort(); };
    }, [version, namesVersion, reloads]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onFocus = () => setReloads(value => value + 1);
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, []);

    const retry = useCallback(() => setReloads(value => value + 1), []);
    return { catalog, ready: catalogVersion === version && !error, error, loading, retry, reloads, version };
}
