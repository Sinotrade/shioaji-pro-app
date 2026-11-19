// src/components/us-depth.tsx — 美股最佳一檔（取代五檔）
//
// 美股行情只有最佳買賣一檔（us_bidask）。只看盤：美股下單面板不接點價帶入。
// 價格是原始 decimal 字串。
//
// 頁面剛載入、第一筆 us_bidask 還沒到時，用 SDK 快照（buy_price／buy_volume／
// sell_price／sell_volume）墊底並標「快照」；即時 bidask 一到（任一邊有效）就
// 整列改用即時，之後快照不再參與，舊快照不會蓋掉新的即時資料。

import { useEffect, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { useUsSnapshot } from '../hooks/use-us-snapshot';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractInfo } from '../lib/types/contract';
import { decSub, fmtUsPrice } from '../lib/us/decimal';
import type { UsSnapshot } from '../lib/us/us-history';
import { fmtInt } from '../lib/utils/format';
import * as styles from './us-depth.css';
import * as ladder from './depth-ladder.css';
import * as panel from './panel.css';

type BidAsk = { bid_price?: (string | number)[]; bid_volume?: number[]; ask_price?: (string | number)[]; ask_volume?: number[] };
type Side = { price: string; vol: number } | null;

function side(price: string | number | null | undefined, vol: unknown): Side {
    const v = Number(vol) || 0;
    return price !== undefined && price !== null && Number(price) > 0 && v > 0 ? { price: String(price), vol: v } : null;
}

function withSpread(bid: Side, ask: Side) {
    const spread = bid && ask && Number(ask.price) > Number(bid.price) ? decSub(ask.price, bid.price) : null;
    return { bid, ask, spread };
}

export function usBestLevel(bidask: BidAsk | undefined) {
    return withSpread(side(bidask?.bid_price?.[0], bidask?.bid_volume?.[0]), side(bidask?.ask_price?.[0], bidask?.ask_volume?.[0]));
}

/**
 * 即時 bidask 有任一邊有效就用即時；否則用快照墊底。liveSeen：這個商品已經
 * 收過有效的即時一檔 — 之後即時變成兩邊皆空也照顯示空，不再退回舊快照。
 */
export function usDepthLevel(bidask: BidAsk | undefined, snap: Pick<UsSnapshot, 'buyPrice' | 'buyVolume' | 'sellPrice' | 'sellVolume'> | null, liveSeen = false) {
    const live = usBestLevel(bidask);
    if (live.bid || live.ask || liveSeen || !snap) return { ...live, source: 'live' as const };
    const seeded = withSpread(side(snap.buyPrice, snap.buyVolume), side(snap.sellPrice, snap.sellVolume));
    return { ...seeded, source: seeded.bid || seeded.ask ? ('snapshot' as const) : ('live' as const) };
}

export function UsDepth({ contract }: { contract: ContractInfo }) {
    const quote = useQuote(contractLinkKey(contract));
    const hasLive = usBestLevel(quote?.bidask);
    const linkKey = contractLinkKey(contract);
    // 每個商品記住「收過有效即時一檔」：換商品重新開始，同商品之後不再用快照
    const [liveSeenKey, setLiveSeenKey] = useState<string | null>(null);
    const liveNow = !!(hasLive.bid || hasLive.ask);
    const liveSeen = liveSeenKey === linkKey || liveNow;
    useEffect(() => { if (liveNow) setLiveSeenKey(linkKey); }, [liveNow, linkKey]);
    const snap = useUsSnapshot(contract, !liveSeen);
    const { bid, ask, spread, source } = usDepthLevel(quote?.bidask, snap, liveSeen);
    const maxVol = Math.max(1, bid?.vol ?? 0, ask?.vol ?? 0);
    const total = (bid?.vol ?? 0) + (ask?.vol ?? 0);
    const bidShare = total > 0 ? ((bid?.vol ?? 0) / total) * 100 : 50;
    const dim = source === 'snapshot' ? styles.seeded : undefined;
    return (
        <div className={styles.root} data-testid='us-depth' data-source={source}>
            <div className={styles.note}>
                <span>美股只有最佳一檔</span>
                {source === 'snapshot' && <span title='即時買賣價到達前先顯示快照'>快照</span>}
            </div>
            <div className={styles.sides}>
                <div className={styles.bidCell}>
                    <div className={styles.bidBar} style={{ width: `${((bid?.vol ?? 0) / maxVol) * 100}%` }} />
                    <span className={styles.sideLabel}>BID 買</span>
                    <span className={`${styles.priceBid} ${dim ?? ''}`}>{bid ? fmtUsPrice(bid.price) : '—'}</span>
                    <span className={styles.vol}>{bid ? fmtInt(bid.vol) : '—'}</span>
                </div>
                <div className={styles.askCell}>
                    <div className={styles.askBar} style={{ width: `${((ask?.vol ?? 0) / maxVol) * 100}%` }} />
                    <span className={styles.sideLabel}>ASK 賣</span>
                    <span className={`${styles.priceAsk} ${dim ?? ''}`}>{ask ? fmtUsPrice(ask.price) : '—'}</span>
                    <span className={styles.vol}>{ask ? fmtInt(ask.vol) : '—'}</span>
                </div>
            </div>
            <div className={ladder.totals}>
                <span className={panel.dirText.up}>買 {fmtInt(bid?.vol ?? 0)}</span>
                {spread !== null && <span className={ladder.spread} title='買一賣一價差'>價差 {fmtUsPrice(spread)}</span>}
                <span className={panel.dirText.down}>賣 {fmtInt(ask?.vol ?? 0)}</span>
            </div>
            <div className={ladder.forceTrack} title={`最佳一檔買賣力道 買${bidShare.toFixed(0)}%`}>
                <div className={ladder.forceBid} style={{ width: `${bidShare}%` }} />
            </div>
        </div>
    );
}
