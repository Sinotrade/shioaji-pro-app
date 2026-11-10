// src/components/flash-totals-bar.tsx — 閃電梯子最底部的合計列，每格對齊上方的欄：
//   觸買｜買單：我的買委託（成交）｜買量：五檔買量合計｜價格：現沖先賣回補狀態｜
//   賣量：五檔賣量合計｜賣單：我的賣委託（成交）｜觸賣
// 不寫「買／賣／Σ」字樣，靠欄位位置與紅綠色。數字定義見 lib/flash-order-totals.ts。
// 「顯示委託合計」關閉時只剩五檔量合計（照舊一直顯示）。
// 遮金額：我的委託與回補數量照「多／空 N」遮；五檔量是公開行情，不遮。
import { CheckCheck, CircleHelp, RotateCcw } from 'lucide-react';
import type { FlashOrderTotals, SideTotals } from '../lib/flash-order-totals';
import { maskMoney } from '../lib/privacy';
import { fmtCompactInt, fmtInt } from '../lib/utils/format';
import * as styles from './flash-order.css';

function Mine({ side, s, unit, priv }: { side: 'buy' | 'sell'; s: SideTotals; unit: string; priv: boolean }) {
    const word = side === 'buy' ? '買進' : '賣出';
    const title = priv ? undefined
        : `我的委託${word} ${fmtInt(s.ordered)} ${unit}${s.cancelled > 0 ? `（已扣刪單 ${fmtInt(s.cancelled)}）` : ''}\n已成交 ${fmtInt(s.filled)} ${unit}\n未成交 ${fmtInt(s.working)} ${unit}`;
    if (s.ordered <= 0) return <span className={styles.totMine.none} title={title ?? undefined} data-testid={`flash-tot-${side}`}>—</span>;
    // 欄寬只有 2rem：萬以上用精簡寫法（零股股數），完整數字在 tooltip
    const n = (v: number) => maskMoney(v >= 10_000 ? fmtCompactInt(v) : fmtInt(v), priv);
    return (
        <span className={styles.totMine[side]} title={title} data-testid={`flash-tot-${side}`}>
            <span>{n(s.ordered)}</span>
            <span className={styles.totMineFill}>({n(s.filled)})</span>
        </span>
    );
}

function Cover({ t, unit, priv }: { t: FlashOrderTotals; unit: string; priv: boolean }) {
    const ds = t.dayShort;
    if (!ds) return <span className={styles.totCover.none} data-testid='flash-tot-cover' />;
    const lines = [
        `現股當沖先賣成交 ${fmtInt(ds.sold)} ${unit}`,
        `已用現股買進回補 ${fmtInt(ds.covered)} ${unit}`,
        `待回補 ${fmtInt(ds.open)} ${unit}`,
        ...(ds.unknownSell > 0 ? [`另有賣出成交 ${fmtInt(ds.unknownSell)} ${unit} 無法確認是否為現股當沖先賣（委託回報不帶這個欄位，只有本 App 送出的委託查得到），未計入`] : []),
        ...(ds.unknownBuy > 0 ? [`另有買進成交 ${fmtInt(ds.unknownBuy)} ${unit} 尚未收到信用條件，未計入回補`] : []),
    ];
    const title = priv ? '現股當沖先賣回補狀態' : lines.join('\n');
    // 條件未知的成交可能改變結果：不顯示「補齊」或確定的待回補量
    if (ds.unknownSell > 0 || (ds.unknownBuy > 0 && ds.open > 0)) {
        return (
            <span className={styles.totCover.unknown} title={title} data-testid='flash-tot-cover' data-state='unknown'>
                <CircleHelp size={10} aria-hidden /><span className={styles.totCoverLabel}>待確認</span>
            </span>
        );
    }
    return ds.open > 0
        ? (
            <span className={styles.totCover.open} title={title} data-testid='flash-tot-cover' data-state='open'>
                <RotateCcw size={10} aria-hidden /><span className={styles.totCoverLabel}>待補</span>{maskMoney(fmtInt(ds.open), priv)}
            </span>
        )
        : (
            <span className={styles.totCover.done} title={title} data-testid='flash-tot-cover' data-state='done'>
                <CheckCheck size={10} aria-hidden /><span className={styles.totCoverLabel}>補齊</span>
            </span>
        );
}

export function FlashTotalsRow({ columns, mine, cover, sumBid, sumAsk, odd, unit, priv }: {
    /** 七欄（外側觸買／觸賣欄）或五欄，與梯子相同 */
    columns: boolean;
    /** 我的委託合計；null＝「顯示委託合計」關閉 */
    mine: FlashOrderTotals | null;
    /** 價格欄放回補狀態（整股現股；期貨、零股、權證沒有） */
    cover: boolean;
    sumBid: number;
    sumAsk: number;
    /** 零股：五檔量以股計，精簡顯示 */
    odd: boolean;
    unit: string;
    priv: boolean;
}) {
    // ≤230px：不含逗號的短寫（萬以上用「萬」），完整數字在 tooltip
    const vol = (v: number) => (
        <>
            <span className={styles.totWide}>{odd ? fmtCompactInt(v) : fmtInt(v)}</span>
            <span className={styles.totNarrow}>{v >= 10_000 ? fmtCompactInt(v) : String(Math.round(v))}</span>
        </>
    );
    return (
        <div className={`${styles.totGrid} ${columns ? styles.cols7 : styles.totCols5} ${mine ? styles.totGridTall : ''}`} data-testid='flash-totals'>
            {columns && <span className={styles.totEmpty} />}
            {mine ? <Mine side='buy' s={mine.buy} unit={unit} priv={priv} /> : <span className={styles.totEmpty} />}
            <span className={styles.totVol.bid} title={`五檔買量合計 ${fmtInt(sumBid)}${odd ? ' 股' : ''}`} data-testid='flash-tot-bidvol'>{vol(sumBid)}</span>
            {mine && cover ? <Cover t={mine} unit={unit} priv={priv} /> : <span className={styles.totCover.none} />}
            <span className={styles.totVol.ask} title={`五檔賣量合計 ${fmtInt(sumAsk)}${odd ? ' 股' : ''}`} data-testid='flash-tot-askvol'>{vol(sumAsk)}</span>
            {mine ? <Mine side='sell' s={mine.sell} unit={unit} priv={priv} /> : <span className={styles.totEmpty} />}
            {columns && <span className={styles.totEmpty} />}
        </div>
    );
}
