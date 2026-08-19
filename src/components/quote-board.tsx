// src/components/quote-board.tsx — selected symbol mega display

import { useQuote } from '../hooks/use-stream';
import { normalizeQuoteState, finiteNumber } from '../lib/quote-model';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtInt, fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './quote-board.css';

export function QuoteBoard({
    contract,
    snapshot,
}: {
    contract: ContractInfo;
    snapshot?: Snapshot;
}) {
    const quote = useQuote(contract.code);
    const normalized = normalizeQuoteState(quote, snapshot, contract);
    const index = quote?.index;
    const isIndex = contract.security_type === 'IND';

    const close = normalized.price;
    const ref = normalized.reference;
    const chg = normalized.change;
    const pct = normalized.changePercent;
    const open = normalized.open;
    const high = normalized.high;
    const low = normalized.low;
    const vol = normalized.volume;
    const bidask = quote?.bidask;
    const bid1 = bidask ? finiteNumber(bidask.bid_price[0]) : null;
    const ask1 = bidask ? finiteNumber(bidask.ask_price[0]) : null;

    const dir = normalized.direction;
    const atLimit =
        !isIndex && close !== null && contract.limit_up > 0
            ? close >= contract.limit_up
                ? 'up'
                : contract.limit_down > 0 && close <= contract.limit_down
                  ? 'down'
                  : null
            : null;

    return (
        <div className={`${styles.board} drag-handle`}>
            <div className={styles.symbolBlock}>
                <span className={styles.symbolCode}>{contract.code}</span>
                <span className={styles.symbolName}>{contract.name}</span>
            </div>

            <span className={styles.bigPrice[dir]}>{fmtPrice(close)}</span>
            {atLimit && (
                <span className={styles.limitBadge[atLimit]}>
                    {atLimit === 'up' ? '漲停' : '跌停'}
                </span>
            )}

            <div className={`${styles.changeBlock} ${panel.dirText[dir]}`}>
                <span>{fmtSigned(chg)}</span>
                <span>{fmtPct(pct)}</span>
            </div>

            <div className={styles.statGrid}>
                {isIndex ? (
                    <>
                        <span className={styles.statLabel}>開</span>
                        <span className={styles.statLabel}>高</span>
                        <span className={styles.statLabel}>低</span>
                        <span className={styles.statLabel}>量</span>
                        <span className={styles.statValue}>{fmtPrice(open)}</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(high)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(low)}
                        </span>
                        <span className={styles.statValue}>{fmtInt(vol)}</span>
                        <span className={styles.statLabel}>參考</span>
                        <span className={styles.statLabel}>上漲</span>
                        <span className={styles.statLabel}>平盤</span>
                        <span className={styles.statLabel}>下跌</span>
                        <span className={styles.statValue}>{fmtPrice(ref)}</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtInt(index?.raise_count)}
                        </span>
                        <span className={styles.statValue}>
                            {fmtInt(index?.flat_count)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtInt(index?.fall_count)}
                        </span>
                        <span className={styles.statLabel}>漲停</span>
                        <span className={styles.statLabel}>未成交</span>
                        <span className={styles.statLabel}>跌停</span>
                        <span className={styles.statLabel}>時間</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtInt(index?.limit_up_count)}
                        </span>
                        <span className={styles.statValue}>
                            {fmtInt(index?.no_trade)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtInt(index?.limit_down_count)}
                        </span>
                        <span className={styles.statValue}>
                            {index?.time?.slice(0, 8) ?? '—'}
                        </span>
                    </>
                ) : (
                    <>
                        <span className={styles.statLabel}>開</span>
                        <span className={styles.statLabel}>高</span>
                        <span className={styles.statLabel}>低</span>
                        <span className={styles.statLabel}>量</span>
                        <span className={styles.statValue}>{fmtPrice(open)}</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(high)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(low)}
                        </span>
                        <span className={styles.statValue}>{fmtInt(vol)}</span>
                        <span className={styles.statLabel}>參考</span>
                        <span className={styles.statLabel}>漲停</span>
                        <span className={styles.statLabel}>跌停</span>
                        <span className={styles.statLabel}>時間</span>
                        <span className={styles.statValue}>{fmtPrice(ref)}</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(contract.limit_up)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(contract.limit_down)}
                        </span>
                        <span className={styles.statValue}>
                            {quote?.tick?.time?.slice(0, 8) ?? '—'}
                        </span>
                        <span className={styles.statLabel}>委買</span>
                        <span className={styles.statLabel}>買量</span>
                        <span className={styles.statLabel}>委賣</span>
                        <span className={styles.statLabel}>賣量</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(bid1)}
                        </span>
                        <span className={styles.statValue}>
                            {bidask ? fmtInt(bidask.bid_volume[0] ?? 0) : '—'}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(ask1)}
                        </span>
                        <span className={styles.statValue}>
                            {bidask ? fmtInt(bidask.ask_volume[0] ?? 0) : '—'}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
