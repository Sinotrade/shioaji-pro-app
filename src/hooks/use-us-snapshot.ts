// src/hooks/use-us-snapshot.ts — 美股快照（SDK 1.8.0b1），報價板與五檔共用
//
// enabled 時抓一次（同商品的請求在 us-history 共用）；失敗不重試，換商品或
// 重新掛載再抓。快照只當即時資料到達前的墊底，呼叫端一律以即時資料優先。

import { useEffect, useState } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import { fetchUsSnapshotShared, nyDateStr, type UsSnapshot } from '../lib/us/us-history';
import { usLinkKey } from '../lib/contract-key';
import { noteUsReference, usChangeFrom, usReferenceFor } from '../lib/us/us-quotes';
import type { SseTick } from '../lib/types/market';

export function useUsSnapshot(contract: Pick<ContractInfo, 'code' | 'exchange'>, enabled: boolean): UsSnapshot | null {
    const [snap, setSnap] = useState<{ key: string; row: UsSnapshot } | null>(null);
    const key = `${contract.exchange}:${contract.code}`;
    const have = snap?.key === key;
    useEffect(() => {
        if (!enabled || have) return;
        let cancelled = false;
        fetchUsSnapshotShared(contract)
            .then(row => {
                if (row?.tradeDate) noteUsReference(usLinkKey(contract.code), row.tradeDate, row.reference);
                if (!cancelled && row && row.close > 0) setSnap({ key, row });
            })
            .catch(() => { /* 沒有快照：呼叫端維持原本的顯示 */ });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled, have]);
    return have ? snap!.row : null;
}

/**
 * 美股參考價（報價板、自選清單、下單面板、閃電下單共用同一個來源）：
 * 交易日＝即時成交的日期，沒有成交時用快照的交易日；參考價取那天的快照
 * reference，其次是確定適用那天的合約檔參考價。不從成交價或 price_chg 回推。
 * 沒有成交也沒有快照時才顯示合約檔參考價（附收盤日）。
 */
export function pickUsReference(
    tick: Pick<SseTick, 'date'> | undefined,
    snap: Pick<UsSnapshot, 'reference' | 'tradeDate'> | null,
    contract: Pick<ContractInfo, 'us_reference' | 'reference_date'>,
    today = nyDateStr(),
): { price: string | null; date: string | null; tradeDate: string } {
    const tradeDate = tick?.date || snap?.tradeDate || today;
    const picked = usReferenceFor(tradeDate, snap, contract);
    // 還沒有成交也沒有快照：只是顯示用（置中、帶價），照合約檔參考價並標它的收盤日；
    // 有成交時漲跌一定要用適用當天的參考價，不走這條
    if (!picked.price && !tick && contract.us_reference) return { price: contract.us_reference, date: contract.reference_date ?? null, tradeDate };
    return { ...picked, tradeDate };
}

/** 報價板／自選清單的即時漲跌：知道參考價就用成交價 − 參考價，否則用 tick 帶的（一般盤 SDK 值） */
export function usLiveChange(tick: Pick<SseTick, 'close' | 'price_chg' | 'pct_chg'>, reference: string | null): { priceChg?: string; pctChg?: string } {
    const own = usChangeFrom(String(tick.close), reference);
    if (own.priceChg !== undefined) return own;
    return { priceChg: tick.price_chg || undefined, pctChg: tick.pct_chg || undefined };
}
