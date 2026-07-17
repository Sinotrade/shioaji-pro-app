// src/components/market-bar.tsx — index / futures basis strip in the header

import { useCallback } from 'react';
import { usePoll } from '../hooks/use-poll';
import { useQuote } from '../hooks/use-stream';
import { fetchSnapshots } from '../lib/shioaji';
import { ensureContract } from '../lib/contracts-cache';
import type { Snapshot } from '../lib/types/market';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './hud-header.css';

export function MarketBar() {
    const { data } = usePoll<Snapshot[]>(
        useCallback(async () => {
            const contracts = await Promise.all([
                ensureContract('IX0001', 'IND'),
                ensureContract('TXFR1', 'FUT'),
            ]);
            return fetchSnapshots(contracts);
        }, []),
        10000,
    );
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
            <div className={styles.chip}>
                <span className={styles.chipLabel}>加權</span>
                <span className={panel.dirText[dir]}>
                    {fmtPrice(indexClose)} {fmtPct(indexPct)}
                </span>
            </div>
            {basis !== undefined && (
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
