// src/hooks/use-us-contracts.ts — 美股商品清單／info 快取的 React 綁定
import { useEffect, useSyncExternalStore } from 'react';
import { ensureUsContracts, subscribeUsContracts, usCatalogStatus, usContractsVersion, type UsCatalogStatus } from '../lib/us/us-contracts';

/** 載入代碼清單並回傳狀態；info 快取變動時也會重繪 */
export function useUsCatalog(): { status: UsCatalogStatus; version: number } {
    useEffect(() => { void ensureUsContracts(); }, []);
    const version = useSyncExternalStore(subscribeUsContracts, usContractsVersion);
    return { status: usCatalogStatus(), version };
}
