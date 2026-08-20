// src/components/market-bar.tsx — index / futures basis strip in the header

import { useSyncExternalStore } from 'react';
import { useQuote } from '../hooks/use-stream';
import { useHeaderItems } from '../lib/header-items';
import {
    getLatestSnapshots,
    subscribeSnapshotStore,
} from '../lib/stream-health';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './hud-header.css';

export function MarketBar() {
    // 頂欄自訂：加權/基差 chips 可各自關閉（settings → 外觀 → 頂欄顯示）
    const headerItems = useHeaderItems();
    // 快照來自 stream-health 的共用輪詢（同兩檔、同 10 秒），顯示與
    // 失聯偵測共用一條 REST 請求，避免對 sidecar 重複打
    const data = useSyncExternalStore(subscribeSnapshotStore, getLatestSnapshots);
    const indexLive = useQuote('IX0001');
    const txfLive = useQuote('TXFR1');

    const indexSnap = data?.find((s) => s.code === 'IX0001');
    const txfSnap = data?.find((s) => s.code !== 'IX0001');
    const indexClose = indexLive?.index
        ? Number(indexLive.index.close)
        : indexSnap?.close;
    const indexReference = indexLive?.index
        ? Number(indexLive.index.reference)
        : indexSnap
          ? indexSnap.close - indexSnap.change_price
          : undefined;
    const indexChange =
        indexClose !== undefined && indexReference !== undefined
            ? indexClose - indexReference
            : undefined;
    const indexPct =
        indexChange !== undefined && indexReference
            ? (indexChange / indexReference) * 100
            : indexSnap?.change_rate;
    const txfClose = txfLive?.tick
        ? Number(txfLive.tick.close)
        : txfSnap?.close;
    const basis =
        indexClose !== undefined && txfClose !== undefined
            ? txfClose - indexClose
            : undefined;

    if (!headerItems.marketIndex && !headerItems.marketBasis) return null;
    if (indexClose === undefined) return null;
    const dir =
        indexChange === undefined || indexChange === 0
            ? 'flat'
            : indexChange > 0
              ? 'up'
              : 'down';
    const basisDir =
        basis === undefined || basis === 0 ? 'flat' : basis > 0 ? 'up' : 'down';

    return (
        <>
            {headerItems.marketIndex && (
                <div className={styles.chip}>
                    <span className={styles.chipLabel}>加權</span>
                    <span className={panel.dirText[dir]}>
                        {fmtPrice(indexClose)} {fmtPct(indexPct)}
                    </span>
                </div>
            )}
            {headerItems.marketBasis && basis !== undefined && (
                <div className={styles.chip} title='台指期 − 加權指數（價差）'>
                    <span className={styles.chipLabel}>基差</span>
                    <span className={panel.dirText[basisDir]}>
                        {fmtSigned(basis, 0)}
                    </span>
                </div>
            )}
        </>
    );
}
