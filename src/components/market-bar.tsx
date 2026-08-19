// src/components/market-bar.tsx — index strip in the header

import { useCallback, useEffect } from 'react';
import { usePoll } from '../hooks/use-poll';
import { useQuote } from '../hooks/use-stream';
import { useHeaderItems } from '../lib/header-items';
import { logKgiDebug } from '../lib/kgi-debug';
import { fetchSnapshots } from '../lib/kgi';
import { ensureContract } from '../lib/contracts-cache';
import { normalizeQuoteState } from '../lib/quote-model';
import type { Snapshot } from '../lib/types/market';
import { fmtPct, fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './hud-header.css';

export function MarketBar() {
    // 頂欄自訂：加權/基差 chips 可各自關閉（settings → 外觀 → 頂欄顯示）
    const headerItems = useHeaderItems();
    const { data } = usePoll<Snapshot[]>(
        useCallback(async () => {
            const contracts = await Promise.all([ensureContract('IX0001', 'IND')]);
            return fetchSnapshots(contracts);
        }, []),
        10000,
    );
    const indexLive = useQuote('IX0001');

    const indexSnap = data?.find((s) => s.code === 'IX0001');
    const indexQuote = normalizeQuoteState(indexLive, indexSnap);

    useEffect(() => {
        logKgiDebug('[index raw]', {
            live: indexLive?.index,
            snapshot: indexSnap,
        });
        logKgiDebug('[index normalized]', indexQuote);
    }, [indexLive?.seq, indexSnap, indexQuote]);

    if (!headerItems.marketIndex && !headerItems.marketBasis) return null;
    if (indexQuote.price === null) return null;
    const dir = indexQuote.direction;

    return (
        <>
            {headerItems.marketIndex && (
                <div className={styles.chip}>
                    <span className={styles.chipLabel}>加權</span>
                    <span className={panel.dirText[dir]}>
                        {fmtPrice(indexQuote.price)}{' '}
                        {fmtPct(indexQuote.changePercent)}
                    </span>
                </div>
            )}
        </>
    );
}

