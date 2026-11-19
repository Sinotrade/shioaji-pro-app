// src/hooks/use-us-snapshot.ts — 美股快照（SDK 1.8.0b1），報價板與五檔共用
//
// enabled 時抓一次（同商品的請求在 us-history 共用）；失敗不重試，換商品或
// 重新掛載再抓。快照只當即時資料到達前的墊底，呼叫端一律以即時資料優先。

import { useEffect, useState } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import { fetchUsSnapshotShared, type UsSnapshot } from '../lib/us/us-history';
import { usTickReference } from '../lib/us/us-quotes';
import type { SseTick } from '../lib/types/market';

export function useUsSnapshot(contract: Pick<ContractInfo, 'code' | 'exchange'>, enabled: boolean): UsSnapshot | null {
    const [snap, setSnap] = useState<{ key: string; row: UsSnapshot } | null>(null);
    const key = `${contract.exchange}:${contract.code}`;
    const have = snap?.key === key;
    useEffect(() => {
        if (!enabled || have) return;
        let cancelled = false;
        fetchUsSnapshotShared(contract)
            .then(row => { if (!cancelled && row && row.close > 0) setSnap({ key, row }); })
            .catch(() => { /* 沒有快照：呼叫端維持原本的顯示 */ });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled, have]);
    return have ? snap!.row : null;
}

/**
 * 美股參考價（報價板、下單面板、閃電下單共用同一條規則）：
 * 有即時成交 → 成交回推（close − price_chg，一般盤漲跌的基準）；
 * 還沒有成交 → 快照的參考價（當天的）；都沒有 → 合約檔的前一日參考價。
 * 合約檔的參考價可能落後一天（商品檔沒換日），所以快照優先。
 * date 只在用合約檔時給（reference_date＝收盤日）。
 */
export function pickUsReference(
    tick: Pick<SseTick, 'close' | 'price_chg'> | undefined,
    snap: Pick<UsSnapshot, 'reference'> | null,
    contract: Pick<ContractInfo, 'us_reference' | 'reference_date'>,
): { price: string | null; date: string | null } {
    const fromTick = tick ? usTickReference(tick) : null;
    if (fromTick) return { price: fromTick, date: null };
    if (!tick && snap?.reference && snap.reference > 0) return { price: String(snap.reference), date: null };
    return { price: contract.us_reference ?? null, date: contract.us_reference ? contract.reference_date ?? null : null };
}
