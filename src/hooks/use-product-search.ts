// src/hooks/use-product-search.ts：命令面板與自選共用的商品名稱搜尋
//
// 停止輸入 PRODUCT_SEARCH_DEBOUNCE_MS 後才查。換字、組字、重試、關閉，或商品
// 目錄／名稱目錄改版，都會取消在途查詢，晚到的結果一律不採用。progressive
// 時先顯示已完成來源的部分結果，其餘來源補齊後再換成最終結果。

import { useEffect, useRef, useState } from 'react';
import { searchProducts, type ProductSuggestion } from '../lib/product-search';
import { getProductCatalogVersion, useProductCatalogVersion } from '../lib/product-catalog-version';
import { getProductNamesVersion } from '../lib/product-names-version';
import { PRODUCT_SEARCH_DEBOUNCE_MS } from '../lib/search-request';
import { useProductNamesVersion } from './use-product-names-version';

const currentScope = () => JSON.stringify([getProductCatalogVersion(), getProductNamesVersion()]);

export function useProductSearch(query: string, { limit, enabled = true, resetKey, progressive = false }: {
    limit: number;
    /** False while the surface is closed: nothing runs, and reopening starts clean. */
    enabled?: boolean;
    /** Restarts the search when the destination changes, for example the active list. */
    resetKey?: unknown;
    /** Publish partial rows while slower sources fill in. */
    progressive?: boolean;
}) {
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
    // Selection by product identity survives rows inserted ahead of it.
    const [activeIdentity, setActiveIdentity] = useState<string | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const composing = useRef(false);
    // Bumped by every cancel; handlers built for an older version are stale.
    const version = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const rowsScope = useRef('');
    const catalogVersion = useProductCatalogVersion();
    const namesVersion = useProductNamesVersion();

    // A fresh array on purpose: the re-render refreshes renderedVersion after a version bump.
    const dropRows = () => setSuggestions([]);
    const clearRows = () => {
        dropRows();
        setActiveIdentity(null);
    };
    const cancel = () => {
        version.current += 1;
        controller.current?.abort();
        controller.current = null;
        setSearching(false);
    };

    useEffect(() => {
        if (!enabled) return;
        composing.current = false;
        version.current += 1;
        clearRows();
        // Closing or unmounting also invalidates a submit still in flight.
        return () => { version.current += 1; };
    }, [enabled]);

    useEffect(() => {
        const text = query.trim();
        if (!enabled || !text || composing.current) {
            dropRows();
            setSearchError(false);
            setSearching(enabled && composing.current && !!text);
            return;
        }
        let active = true;
        let completed = false;
        const request = new AbortController();
        controller.current = request;
        const requestVersion = ++version.current;
        const requestScope = currentScope();
        const isCurrent = () => active && !request.signal.aborted && requestVersion === version.current
            && requestScope === currentScope() && !composing.current;
        const publish = (rows: ProductSuggestion[]) => {
            rowsScope.current = requestScope;
            setSuggestions(rows);
        };
        clearRows();
        setSearchError(false);
        setSearching(true);
        const timer = setTimeout(() => {
            void searchProducts(text, limit, {
                includeWarrants: true,
                signal: request.signal,
                ...(progressive ? { onUpdate: (rows: ProductSuggestion[]) => { if (isCurrent() && !completed) publish(rows); } } : {}),
            })
                .then((rows) => {
                    completed = true;
                    if (!isCurrent()) return;
                    publish(rows);
                    setSearching(false);
                })
                .catch(() => {
                    completed = true;
                    if (!isCurrent()) return;
                    // Ordinary source failures resolve with usable rows in the core.
                    // A rejection (for example a server switch) invalidates every row.
                    clearRows();
                    setSearchError(true);
                    setSearching(false);
                });
        }, PRODUCT_SEARCH_DEBOUNCE_MS);
        request.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        return () => {
            active = false;
            request.abort();
            if (controller.current === request) controller.current = null;
        };
    }, [enabled, query, attempt, catalogVersion, namesVersion, resetKey, limit, progressive]);

    const clear = () => {
        cancel();
        clearRows();
        setSearchError(false);
    };

    return {
        suggestions,
        searching,
        searchError,
        activeIdentity,
        setActiveIdentity,
        /** The version this render was built from. */
        renderedVersion: version.current,
        currentVersion: () => version.current,
        isCurrent: (snapshot: number) => snapshot === version.current,
        isComposing: () => composing.current,
        /** The shown rows predate a catalog or name update and must be fetched again. */
        isStale: () => rowsScope.current !== currentScope(),
        cancel,
        /** Esc or a completed submit: drop the rows and any pending search. */
        clear,
        /** The query is changing: old rows go now, the new search waits for the debounce. */
        change: (next: string) => {
            clear();
            setSearching(!!next.trim());
        },
        retry: () => {
            if (composing.current) return;
            clear();
            setAttempt((count) => count + 1);
        },
        startComposition: () => {
            composing.current = true;
            cancel();
            clearRows();
            setAttempt((count) => count + 1);
        },
        endComposition: () => {
            composing.current = false;
            cancel();
            setAttempt((count) => count + 1);
        },
    };
}
