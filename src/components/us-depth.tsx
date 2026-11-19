// src/components/us-depth.tsx — 美股最佳一檔（取代五檔）
//
// 美股行情只有最佳買賣一檔（us_bidask）。版面沿用五檔面板的一列，只看盤：
// 美股下單面板不接點價帶入，點價格不做事。價格是原始 decimal 字串。

import { useQuote } from '../hooks/use-stream';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractInfo } from '../lib/types/contract';
import { decSub, fmtUsPrice } from '../lib/us/decimal';
import { fmtInt } from '../lib/utils/format';
import * as styles from './depth-ladder.css';
import * as panel from './panel.css';

export function usBestLevel(bidask: { bid_price?: (string | number)[]; bid_volume?: number[]; ask_price?: (string | number)[]; ask_volume?: number[] } | undefined) {
    const bidPrice = bidask?.bid_price?.[0];
    const askPrice = bidask?.ask_price?.[0];
    const bidVol = Number(bidask?.bid_volume?.[0]) || 0;
    const askVol = Number(bidask?.ask_volume?.[0]) || 0;
    const bid = bidPrice !== undefined && Number(bidPrice) > 0 && bidVol > 0 ? { price: String(bidPrice), vol: bidVol } : null;
    const ask = askPrice !== undefined && Number(askPrice) > 0 && askVol > 0 ? { price: String(askPrice), vol: askVol } : null;
    const spread = bid && ask && Number(ask.price) > Number(bid.price) ? decSub(ask.price, bid.price) : null;
    return { bid, ask, spread };
}

export function UsDepth({ contract }: { contract: ContractInfo }) {
    const quote = useQuote(contractLinkKey(contract));
    const { bid, ask, spread } = usBestLevel(quote?.bidask);
    const maxVol = Math.max(1, bid?.vol ?? 0, ask?.vol ?? 0);
    const total = (bid?.vol ?? 0) + (ask?.vol ?? 0);
    const bidShare = total > 0 ? ((bid?.vol ?? 0) / total) * 100 : 50;
    return (
        <div className={styles.grid} data-testid='us-depth'>
            <span>美股只有最佳一檔</span>
            <div className={styles.headerRow}>
                <span>買量</span>
                <span style={{ textAlign: 'right' }}>BID</span>
                <span>ASK</span>
                <span style={{ textAlign: 'right' }}>賣量</span>
            </div>
            <div className={styles.ladderRow}>
                <span className={styles.volText}>{bid ? fmtInt(bid.vol) : ''}</span>
                <div className={styles.barTrack}>
                    <div className={styles.bidBar} style={{ width: `${((bid?.vol ?? 0) / maxVol) * 100}%` }} />
                    <span className={styles.priceBid}>{bid ? fmtUsPrice(bid.price) : '—'}</span>
                </div>
                <div className={styles.barTrack}>
                    <div className={styles.askBar} style={{ width: `${((ask?.vol ?? 0) / maxVol) * 100}%` }} />
                    <span className={styles.priceAsk}>{ask ? fmtUsPrice(ask.price) : '—'}</span>
                </div>
                <span className={styles.volTextRight}>{ask ? fmtInt(ask.vol) : ''}</span>
            </div>
            <div className={styles.totals}>
                <span className={panel.dirText.up}>買 {fmtInt(bid?.vol ?? 0)}</span>
                {spread !== null && <span className={styles.spread} title='買一賣一價差'>價差 {fmtUsPrice(spread)}</span>}
                <span className={panel.dirText.down}>賣 {fmtInt(ask?.vol ?? 0)}</span>
            </div>
            <div className={styles.forceTrack} title={`最佳一檔買賣力道 買${bidShare.toFixed(0)}%`}>
                <div className={styles.forceBid} style={{ width: `${bidShare}%` }} />
            </div>
        </div>
    );
}
