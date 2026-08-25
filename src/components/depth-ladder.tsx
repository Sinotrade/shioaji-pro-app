// src/components/depth-ladder.tsx — 5-level bid/ask "energy bars".
// Clicking a price loads it into the order ticket.

import { useMemo } from 'react';
import { useQuote } from '../hooks/use-stream';
import { setPickedPrice } from '../lib/price-sync';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './depth-ladder.css';

export function DepthLadder({ code }: { code: string }) {
    const onPickPrice = (price: number) => setPickedPrice(code, price);
    const quote = useQuote(code);
    const ba = quote?.bidask;

    const { bids, asks, maxVol, totalBid, totalAsk, spread } = useMemo(() => {
        // 「檔位存在」以掛量判斷，不看價格真值 — 一般商品的空檔以
        // 價 0/量 0 填充，而組合商品（跨月價差）的價位可以合法為
        // 0 或負值，用價格 truthiness 會把真實檔位當成空檔
        const bids = (ba?.bid_price ?? []).map((p, i) => ({
            price: Number(p),
            vol: ba?.bid_volume[i] ?? 0,
        }));
        const asks = (ba?.ask_price ?? []).map((p, i) => ({
            price: Number(p),
            vol: ba?.ask_volume[i] ?? 0,
        }));
        const maxVol = Math.max(
            1,
            ...bids.map((b) => b.vol),
            ...asks.map((a) => a.vol),
        );
        const totalBid = bids.reduce((s, b) => s + b.vol, 0);
        const totalAsk = asks.reduce((s, a) => s + a.vol, 0);
        const b1 = bids[0] && bids[0].vol > 0 ? bids[0].price : undefined;
        const a1 = asks[0] && asks[0].vol > 0 ? asks[0].price : undefined;
        const spread =
            b1 !== undefined && a1 !== undefined && a1 > b1
                ? Number((a1 - b1).toFixed(2))
                : null;
        return { bids, asks, maxVol, totalBid, totalAsk, spread };
    }, [ba]);

    // bid share of the 5-level book — the "買賣力道" gauge
    const bidShare =
        totalBid + totalAsk > 0
            ? (totalBid / (totalBid + totalAsk)) * 100
            : 50;

    return (
        <div className={styles.grid}>
                <div className={styles.headerRow}>
                    <span>買量</span>
                    <span style={{ textAlign: 'right' }}>BID</span>
                    <span>ASK</span>
                    <span style={{ textAlign: 'right' }}>賣量</span>
                </div>
                {[0, 1, 2, 3, 4].map((i) => {
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
                                    {hasBid ? fmtPrice(bid.price) : ''}
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
                                    {hasAsk ? fmtPrice(ask.price) : ''}
                                </span>
                            </div>
                            <span className={styles.volTextRight}>
                                {hasAsk ? fmtInt(ask.vol) : ''}
                            </span>
                        </div>
                    );
                })}
            <div className={styles.totals}>
                <span className={panel.dirText.up}>Σ買 {fmtInt(totalBid)}</span>
                {spread !== null && (
                    <span className={styles.spread} title='買一賣一價差'>
                        價差 {fmtPrice(spread)}
                    </span>
                )}
                <span className={panel.dirText.down}>
                    Σ賣 {fmtInt(totalAsk)}
                </span>
            </div>
            <div
                className={styles.forceTrack}
                title={`五檔買賣力道 買${bidShare.toFixed(0)}%`}
            >
                <div
                    className={styles.forceBid}
                    style={{ width: `${bidShare}%` }}
                />
            </div>
        </div>
    );
}
