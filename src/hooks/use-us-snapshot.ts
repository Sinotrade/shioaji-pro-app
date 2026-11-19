// src/hooks/use-us-snapshot.ts — 美股快照（SDK 1.8.0b1），報價板與五檔共用
//
// enabled 時抓一次（同商品的請求在 us-history 共用）；失敗不重試，換商品或
// 重新掛載再抓。快照只當即時資料到達前的墊底，呼叫端一律以即時資料優先。

import { useEffect, useState } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import { fetchUsSnapshotShared, type UsSnapshot } from '../lib/us/us-history';

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
