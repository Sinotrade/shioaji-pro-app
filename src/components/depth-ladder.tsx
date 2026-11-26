// src/components/depth-ladder.tsx — 5-level bid/ask "energy bars".
// Clicking a price loads it into the order ticket.
//
// 美股（region US）走同一個元件：行情只有最佳一檔（bidask_stk_us），只畫一列；
// 即時一檔到達前用美股快照的買賣價墊底（標「快照一檔」）。美股下單面板
// 不接點價帶入，美股價格不可點。

import { useMemo } from 'react';
import { useDisplayBook } from '../hooks/use-display-book';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractBase } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { setPickedPrice } from '../lib/price-sync';
import { fmtUsChange, fmtUsPrice, usPriceDecimals } from '../lib/us/decimal';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './depth-ladder.css';

const TW_LEVELS = [0, 1, 2, 3, 4];
const US_LEVELS = [0];

export function DepthLadder({ code, snapshot, contract }: { code: string; snapshot?: Snapshot; contract?: ContractBase }) {
    const isUs = contract?.region === 'US';
    // 美股的行情／快照 key 是 US:CODE
    const key = contract && isUs ? contractLinkKey(contract) : code;
    const onPickPrice = (price: number) => { if (!isUs) setPickedPrice(code, price); };
    const { book } = useDisplayBook(key, snapshot, contract);
    const fmt = (v: number) => (isUs ? fmtUsPrice(v) : fmtPrice(v));

    const { bids, asks, maxVol, totalBid, totalAsk, spread, spreadRef } = useMemo(() => {
        const bids = book?.bids ?? [];
        const asks = book?.asks ?? [];
        const maxVol = Math.max(
            1,
            ...bids.map((b) => b.vol),
            ...asks.map((a) => a.vol),
        );
        const totalBid = bids.reduce((s, b) => s + b.vol, 0);
        const totalAsk = asks.reduce((s, a) => s + a.vol, 0);
        const b1 = bids[0] && bids[0].vol > 0 ? bids[0].price : undefined;
        const a1 = asks[0] && asks[0].vol > 0 ? asks[0].price : undefined;
        const digits = isUs ? usPriceDecimals(b1 ?? a1) : 2;
        const spread =
            b1 !== undefined && a1 !== undefined && a1 > b1
                ? Number((a1 - b1).toFixed(digits))
                : null;
        return { bids, asks, maxVol, totalBid, totalAsk, spread, spreadRef: b1 ?? a1 };
    }, [book, isUs]);

    // bid share of the 5-level book — the "買賣力道" gauge
    const bidShare =
        totalBid + totalAsk > 0
            ? (totalBid / (totalBid + totalAsk)) * 100
            : 50;
    const levels = isUs ? US_LEVELS : TW_LEVELS;
    const bookLabel = book?.source === 'snapshot' ? '快照一檔' : isUs ? '最佳一檔' : '五檔';

    return (
        <div className={styles.grid} data-levels={levels.length}>
                {book?.source === 'snapshot' && <span title={book.time}>快照一檔</span>}
                <div className={styles.headerRow}>
                    <span>買量</span>
                    <span style={{ textAlign: 'right' }}>BID</span>
                    <span>ASK</span>
                    <span style={{ textAlign: 'right' }}>賣量</span>
                </div>
                {levels.map((i) => {
                    const bid = bids[i];
                    const ask = asks[i];
                    const hasBid = !!bid && bid.vol > 0;
                    const hasAsk = !!ask && ask.vol > 0;
                    return (
                        <div key={i} className={styles.ladderRow}>
                            <span className={styles.volText}>
                                {hasBid ? fmtInt(bid.vol) : ''}
                            </span>
                            <div
                                className={styles.barTrack}
                                onClick={() =>
                                    hasBid && onPickPrice(bid.price)
                                }
                            >
                                <div
                                    className={styles.bidBar}
                                    style={{
                                        width: `${((bid?.vol ?? 0) / maxVol) * 100}%`,
                                    }}
                                />
                                <span className={styles.priceBid}>
                                    {hasBid ? fmt(bid.price) : ''}
                                </span>
                            </div>
                            <div
                                className={styles.barTrack}
                                onClick={() =>
                                    hasAsk && onPickPrice(ask.price)
                                }
                            >
                                <div
                                    className={styles.askBar}
                                    style={{
                                        width: `${((ask?.vol ?? 0) / maxVol) * 100}%`,
                                    }}
                                />
                                <span className={styles.priceAsk}>
                                    {hasAsk ? fmt(ask.price) : ''}
                                </span>
                            </div>
                            <span className={styles.volTextRight}>
                                {hasAsk ? fmtInt(ask.vol) : ''}
                            </span>
                        </div>
                    );
                })}
            <div className={styles.totals}>
                <span className={panel.dirText.up}>{isUs ? '買' : 'Σ買'} {fmtInt(totalBid)}</span>
                {spread !== null && (
                    <span className={styles.spread} title='買一賣一價差'>
                        價差 {isUs ? fmtUsChange(spread, spreadRef) : fmtPrice(spread)}
                    </span>
                )}
                <span className={panel.dirText.down}>
                    {isUs ? '賣' : 'Σ賣'} {fmtInt(totalAsk)}
                </span>
            </div>
            <div
                className={styles.forceTrack}
                title={`${bookLabel}買賣力道 買${bidShare.toFixed(0)}%`}
            >
                <div
                    className={styles.forceBid}
                    style={{ width: `${bidShare}%` }}
                />
            </div>
        </div>
    );
}
