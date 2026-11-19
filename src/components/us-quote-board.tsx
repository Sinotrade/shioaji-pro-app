// src/components/us-quote-board.tsx — 美股報價板
//
// 有即時逐筆時顯示成交價、漲跌、開高低、總量與最佳買賣。第一筆 tick 前
// 先抓一次美股快照（SDK 1.8.0b1，只有正式環境有資料）顯示最近交易日的
// 收盤與開高低；快照拿不到（舊 SDK、非正式環境）就只顯示前一日參考價。
// 即時價格是原始 decimal 字串（USD），不套用台股級距；快照數字是 float，只供顯示。

import { useEffect, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { fetchUsSnapshots, type UsSnapshot } from '../lib/us/us-history';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractInfo } from '../lib/types/contract';
import { decCompare, fmtUsPrice } from '../lib/us/decimal';
import { usHaltLabel, useUsHalt } from '../lib/us/us-halts';
import { getUsTickMeta, US_SESSION_LABEL, usTickReference } from '../lib/us/us-quotes';
import { fmtInt } from '../lib/utils/format';
import * as styles from './quote-board.css';
import * as us from './us-quote-board.css';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <span className={styles.stat}>
            <span className={styles.statLabel}>{label}</span>
            <span className={styles.statValue}>{children}</span>
        </span>
    );
}

const dirOf = (chg: string | undefined): 'up' | 'down' | 'flat' => {
    if (!chg) return 'flat';
    const c = decCompare(chg, '0');
    return c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
};

/** 第一筆即時成交前抓一次快照；失敗不重試（換商品再抓） */
function useUsSnapshot(contract: ContractInfo, enabled: boolean): UsSnapshot | null {
    const [snap, setSnap] = useState<{ key: string; row: UsSnapshot } | null>(null);
    const key = `${contract.exchange}:${contract.code}`;
    useEffect(() => {
        if (!enabled) return;
        if (snap?.key === key) return;
        let cancelled = false;
        fetchUsSnapshots([contract])
            .then(rows => { const row = rows[0]; if (!cancelled && row && row.close > 0) setSnap({ key, row }); })
            .catch(() => { /* 沒有快照：維持參考價顯示 */ });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled]);
    return snap?.key === key ? snap.row : null;
}

export function snapshotMatchesTradeDate(snap: Pick<UsSnapshot, 'tradeDate'>, tickDate: string | undefined): boolean {
    return !!snap.tradeDate && !!tickDate && snap.tradeDate === tickDate;
}

/** 開高低：即時值 → 快照一般盤值 → 「—」 */
function ohl(live: string | undefined, snap: number | undefined): string {
    if (live && Number(live) > 0) return fmtUsPrice(live);
    if (snap !== undefined && snap > 0) return fmtUsPrice(snap);
    return '—';
}

const numDir = (v: number): 'up' | 'down' | 'flat' => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

export function UsQuoteBoard({ contract }: { contract: ContractInfo }) {
    const key = contractLinkKey(contract);
    const quote = useQuote(key);
    // 沒有即時成交、或即時成交沒有開高低（盤前／盤後）時抓一次快照補一般盤值
    const snap = useUsSnapshot(contract, !quote?.tick || !quote.tick.open);
    const halt = useUsHalt(contract);
    const tick = quote?.tick;
    const bid = quote?.bidask?.bid_price?.[0];
    const ask = quote?.bidask?.ask_price?.[0];
    const meta = tick ? getUsTickMeta(key) : undefined;
    const dir = dirOf(tick?.price_chg);
    // 「參考」與漲跌同一個基準：有即時成交時用成交價−漲跌（盤前／盤後即最近
    // 一般盤收盤價），有快照時用快照的參考價，都沒有才用合約的前一日參考價
    // 快照的一般盤開高低只在它與即時成交同一個美東交易日時才拿來補
    // （隔天盤前不可顯示前一天的開高低）
    const sameDaySnap = snap && tick && snapshotMatchesTradeDate(snap, tick.date) ? snap : null;
    const ref = (tick ? usTickReference(tick) : null)
        ?? (!tick && snap?.reference ? String(snap.reference) : null)
        ?? contract.us_reference;

    return (
        <div className={`${styles.board} ${us.board}`} aria-label='美股報價板' data-testid='us-quote-board'>
            <span className={us.ident}>
                <span className={us.code}>{contract.code}<span className={us.badge}>美股</span></span>
                <span className={us.meta}>{[contract.name !== contract.code ? contract.name : '', contract.exchange, 'USD'].filter(Boolean).join(' · ')}</span>
            </span>
            {tick ? (
                <>
                    <span className={styles.bigPrice[dir]}>{fmtUsPrice(tick.close)}</span>
                    <span className={styles.changeBlock}>
                        <span className={us.dir[dir]}>{tick.price_chg ? `${dir === 'up' ? '+' : ''}${fmtUsPrice(tick.price_chg)}` : '—'}</span>
                        <span className={us.dir[dir]}>{tick.pct_chg ? `${dir === 'up' ? '+' : ''}${Number(tick.pct_chg).toFixed(2)}%` : ''}</span>
                    </span>
                    {/* 盤前一般盤還沒開：開高低留空顯示「—」，有快照就用快照的一般盤值 */}
                    <Stat label='開'>{ohl(tick.open, sameDaySnap?.open)}</Stat>
                    <Stat label='高'>{ohl(tick.high, sameDaySnap?.high)}</Stat>
                    <Stat label='低'>{ohl(tick.low, sameDaySnap?.low)}</Stat>
                    <Stat label='總量'>{fmtInt(tick.total_volume)}</Stat>
                    <Stat label='買'>{bid ? fmtUsPrice(bid) : '—'}</Stat>
                    <Stat label='賣'>{ask ? fmtUsPrice(ask) : '—'}</Stat>
                    {meta && US_SESSION_LABEL[meta.session] && <Stat label='時段'>{US_SESSION_LABEL[meta.session]}</Stat>}
                    {meta?.freshness && meta.freshness !== 'Realtime' && <Stat label='行情'>{meta.freshness === 'Delayed' ? '延遲' : '過時'}</Stat>}
                </>
            ) : snap ? (
                <>
                    <span className={styles.bigPrice[numDir(snap.changePrice)]}>{fmtUsPrice(snap.close)}</span>
                    <span className={styles.changeBlock}>
                        <span className={us.dir[numDir(snap.changePrice)]}>{`${snap.changePrice > 0 ? '+' : ''}${fmtUsPrice(snap.changePrice)}`}</span>
                        <span className={us.dir[numDir(snap.changePrice)]}>{`${snap.changeRate > 0 ? '+' : ''}${snap.changeRate.toFixed(2)}%`}</span>
                    </span>
                    {/* 一般盤還沒開（盤前）時開高低是 0 */}
                    <Stat label='開'>{snap.open > 0 ? fmtUsPrice(snap.open) : '—'}</Stat>
                    <Stat label='高'>{snap.high > 0 ? fmtUsPrice(snap.high) : '—'}</Stat>
                    <Stat label='低'>{snap.low > 0 ? fmtUsPrice(snap.low) : '—'}</Stat>
                    <Stat label='總量'>{fmtInt(snap.totalVolume)}</Stat>
                    {snap.session && snap.session !== 'Regular' && US_SESSION_LABEL[snap.session] && snap.lastPrice !== null && snap.lastPrice > 0 && (
                        <Stat label={US_SESSION_LABEL[snap.session]}>{fmtUsPrice(snap.lastPrice)}</Stat>
                    )}
                    <span className={us.meta}>快照{snap.tradeDate ? `（${snap.tradeDate}）` : ''}<br />尚無即時報價</span>
                </>
            ) : (
                <>
                    <span className={styles.bigPrice.flat}>{ref ? fmtUsPrice(ref) : '—'}</span>
                    <span className={us.meta}>
                        前一日參考價{contract.reference_date ? `（${contract.reference_date}）` : ''}
                        <br />尚無即時報價
                    </span>
                </>
            )}
            {(tick || snap) && ref && <Stat label='參考'>{fmtUsPrice(ref)}</Stat>}
            {(halt || contract.trading_suspended) && (
                <span className={us.halt}>{halt ? usHaltLabel(halt) : '暫停交易'}</span>
            )}
        </div>
    );
}
