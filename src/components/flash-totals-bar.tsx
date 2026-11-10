// src/components/flash-totals-bar.tsx — 閃電下單委託合計列：
// 「買 32（20）未 12｜賣 40（20）未 20｜待回補 N」，數字定義見 lib/flash-order-totals.ts。
// 遮金額開啟時跟「多／空 N」一樣遮數量（合計透露交易規模），進度條也收起。
// 寬度退讓（只看面板寬度，#376）：≤300px 收「未 N」、回補格改短字。
import { CheckCheck, CircleHelp, RotateCcw } from 'lucide-react';
import type { FlashOrderTotals, SideTotals } from '../lib/flash-order-totals';
import { maskMoney } from '../lib/privacy';
import { fmtInt } from '../lib/utils/format';
import * as styles from './flash-order.css';

function Side({ side, s, unit, priv }: { side: 'buy' | 'sell'; s: SideTotals; unit: string; priv: boolean }) {
    const m = (n: number) => maskMoney(fmtInt(n), priv);
    const pct = s.ordered > 0 ? Math.min(100, (s.filled / s.ordered) * 100) : 0;
    const word = side === 'buy' ? '買進' : '賣出';
    const title = priv ? undefined
        : `委託${word} ${fmtInt(s.ordered)} ${unit}${s.cancelled > 0 ? `（已扣刪單 ${fmtInt(s.cancelled)}）` : ''}\n已成交 ${fmtInt(s.filled)} ${unit}\n未成交 ${fmtInt(s.working)} ${unit}`;
    return (
        <span className={styles.totSide[side]} title={title} data-testid={`flash-tot-${side}`}>
            <span className={styles.totWord}>{side === 'buy' ? '買' : '賣'}</span>
            <b className={styles.totNum}>{m(s.ordered)}</b>
            <span className={styles.totFill}>（{m(s.filled)}）</span>
            {s.working > 0 && <span className={styles.totWorking} data-testid={`flash-tot-${side}-working`}>未{m(s.working)}</span>}
            {!priv && <span className={styles.totProgress[side]} style={{ width: `${pct}%` }} aria-hidden />}
        </span>
    );
}

function Cover({ t, unit, priv }: { t: FlashOrderTotals; unit: string; priv: boolean }) {
    const ds = t.dayShort;
    if (!ds) return <span className={styles.totCover.none} title='今日沒有現股當沖先賣成交' data-testid='flash-tot-cover'>—</span>;
    const m = (n: number) => maskMoney(fmtInt(n), priv);
    const lines = [
        `現股當沖先賣成交 ${fmtInt(ds.sold)} ${unit}`,
        `已用現股買進回補 ${fmtInt(ds.covered)} ${unit}`,
        `待回補 ${fmtInt(ds.open)} ${unit}`,
        ...(ds.unknownSell > 0 ? [`另有賣出成交 ${fmtInt(ds.unknownSell)} ${unit} 無法確認是否為現股當沖先賣（委託回報不帶這個欄位，只有本 App 送出的委託查得到），未計入`] : []),
        ...(ds.unknownBuy > 0 ? [`另有買進成交 ${fmtInt(ds.unknownBuy)} ${unit} 尚未收到信用條件，未計入回補`] : []),
    ];
    const title = priv ? undefined : lines.join('\n');
    // 條件未知的成交可能改變結果：不顯示「補齊」或確定的待回補量
    if (ds.unknownSell > 0 || (ds.unknownBuy > 0 && ds.open > 0)) {
        return (
            <span className={styles.totCover.unknown} title={title} data-testid='flash-tot-cover' data-state='unknown'>
                <CircleHelp size={9} aria-hidden />
                <span className={styles.totCoverLabel}>回補待確認</span><span className={styles.totCoverShort}>待確認</span>
            </span>
        );
    }
    return ds.open > 0
        ? (
            <span className={styles.totCover.open} title={title} data-testid='flash-tot-cover'>
                <RotateCcw size={9} aria-hidden />
                <span className={styles.totCoverLabel}>待回補</span><span className={styles.totCoverShort}>待補</span>{m(ds.open)}
            </span>
        )
        : (
            <span className={styles.totCover.done} title={title} data-testid='flash-tot-cover'>
                <CheckCheck size={9} aria-hidden />
                <span className={styles.totCoverLabel}>先賣已補齊</span><span className={styles.totCoverShort}>補齊</span>
            </span>
        );
}

/** @param cover 顯示當沖先賣回補格（整股現股；期貨、零股、權證沒有當沖先賣） */
export function FlashTotalsBar({ totals, unit, priv, cover }: { totals: FlashOrderTotals; unit: string; priv: boolean; cover: boolean }) {
    return (
        <div className={styles.totRow[cover ? 'cover' : 'plain']} data-testid='flash-totals'>
            <Side side='buy' s={totals.buy} unit={unit} priv={priv} />
            <Side side='sell' s={totals.sell} unit={unit} priv={priv} />
            {cover && <Cover t={totals} unit={unit} priv={priv} />}
        </div>
    );
}
