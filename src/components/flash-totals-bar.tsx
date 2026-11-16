// src/components/flash-totals-bar.tsx — 閃電梯子最底部的合計列，每格對齊上方的欄：
//   觸買｜買單：我的買委託（成交）｜買量：五檔買量合計｜價格：現沖先賣回補狀態｜
//   賣量：五檔賣量合計｜賣單：我的賣委託（成交）｜觸賣
// 點買單／賣單合計＝買全刪／賣全刪（閃電啟用時；沒有在場上的委託時不可點）。
// 不寫「買／賣／Σ」字樣，靠欄位位置與紅綠色。數字定義見 lib/flash-order-totals.ts。
// 「顯示委託合計」關閉時只剩五檔量合計（照舊一直顯示）。
// 遮金額：我的委託與回補數量照「多／空 N」遮；五檔量是公開行情，不遮。
// #402 委託格＝分段：我的委託合計用「成交｜未成交」膠囊（同每個價位），一行高；
// 七欄時我的委託合計跨到外側觸價欄（合計列那一格本來就空），兩種寫法都不溢出。
import { CheckCheck, CircleHelp, RotateCcw } from 'lucide-react';
import type { FlashOrderTotals, SideTotals } from '../lib/flash-order-totals';
import { fmtCompactInt, fmtInt } from '../lib/utils/format';
import * as styles from './flash-order.css';
import { SplitQty } from './flash-split-qty';

// 遮金額：欄寬有限，放不下「•••••」，一律一個「•」（#402）
const DOT = '•';

/** 買全刪／賣全刪：點我的委託合計 */
export interface SideCancel {
    armed: boolean;
    /** 每邊可刪的委託筆數（目前單位、在場上） */
    counts: { buy: number; sell: number };
    onCancel: (side: 'buy' | 'sell') => void;
}

function Mine({ side, s, unit, priv, cancel, split, span }: {
    side: 'buy' | 'sell'; s: SideTotals; unit: string; priv: boolean; cancel?: SideCancel; split?: boolean;
    /** 七欄：跨到外側觸價欄 */
    span: boolean;
}) {
    const word = side === 'buy' ? '買' : '賣';
    const wide = span ? styles.totSpan2 : '';
    const detail = priv ? ''
        : `我的委託${word === '買' ? '買進' : '賣出'} ${fmtInt(s.ordered)} ${unit}${s.cancelled > 0 ? `（已扣刪單 ${fmtInt(s.cancelled)}）` : ''}\n已成交 ${fmtInt(s.filled)} ${unit}\n未成交 ${fmtInt(s.working)} ${unit}`;
    if (s.ordered <= 0) return <span className={`${styles.totMine.none} ${wide}`} title={detail || undefined} data-testid={`flash-tot-${side}`}>—</span>;
    const count = cancel?.counts[side] ?? 0;
    // 遮金額時連筆數也不顯示
    const action = priv ? `刪除全部${word}單` : `刪除全部${word}單（${count} 筆）`;
    const hint = cancel?.armed ? `點一下${action}` : `先啟用閃電下單，才能點一下${action}`;
    // 沒有在場上的委託（全部成交或已刪）：不可點
    const can = !!cancel && count > 0;
    const title = can ? (detail ? `${hint}\n${detail}` : hint) : detail || undefined;
    if (split) {
        // 實心＝已成交、外框＝未成交（點外框＝這一邊全刪）
        return (
            <span className={`${styles.totSplitCell} ${wide}`}>
                <SplitQty side={side} working={s.working} filled={s.filled} priv={priv} title={title} testId={`flash-tot-${side}`}
                    ariaLabel={can ? action : undefined} disabled={can && !cancel.armed}
                    onCancel={can ? () => { if (cancel.armed) cancel.onCancel(side); } : undefined} />
            </span>
        );
    }
    // 萬以上用精簡寫法（零股股數），≤230px 不加千分位；完整數字在 tooltip
    const n = (v: number) => (priv ? DOT : v >= 10_000 ? fmtCompactInt(v)
        : <><span className={styles.totWide}>{fmtInt(v)}</span><span className={styles.totNarrow}>{String(Math.round(v))}</span></>);
    const body = (
        <>
            <span>{n(s.ordered)}</span>
            <span className={styles.totMineFill}>({n(s.filled)})</span>
        </>
    );
    if (!can) return <span className={`${styles.totMine[side]} ${wide}`} title={title} data-testid={`flash-tot-${side}`}>{body}</span>;
    return (
        <button
            type='button'
            className={`${styles.totMine[side]} ${styles.totMineBtn[side]} ${wide}`}
            aria-label={action}
            aria-disabled={!cancel.armed || undefined}
            title={title}
            data-testid={`flash-tot-${side}`}
            onClick={() => { if (cancel.armed) cancel.onCancel(side); }}
        >
            {body}
        </button>
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
        ...(ds.untimedSell + ds.untimedBuy > 0 ? [`另有成交 ${fmtInt(ds.untimedSell + ds.untimedBuy)} ${unit} 尚未收到成交明細（時間未知），無法判斷回補順序，未計入`] : []),
    ];
    const title = priv ? '現股當沖先賣回補狀態' : lines.join('\n');
    // 條件未知的成交可能改變結果：不顯示「補齊」或確定的待回補量
    // 時間未知的先賣一定影響；時間未知的現股買進只在還有待回補時才可能改變結果
    if (ds.unknownSell > 0 || ds.untimedSell > 0 || ((ds.unknownBuy > 0 || ds.untimedBuy > 0) && ds.open > 0)) {
        return (
            <span className={styles.totCover.unknown} title={title} data-testid='flash-tot-cover' data-state='unknown'>
                <CircleHelp size={10} aria-hidden /><span className={styles.totCoverLabel}>待確認</span>
            </span>
        );
    }
    return ds.open > 0
        ? (
            <span className={styles.totCover.open} title={title} data-testid='flash-tot-cover' data-state='open'>
                <RotateCcw size={10} aria-hidden /><span className={styles.totCoverLabel}>待補</span>{priv ? DOT : fmtInt(ds.open)}
            </span>
        )
        : (
            <span className={styles.totCover.done} title={title} data-testid='flash-tot-cover' data-state='done'>
                <CheckCheck size={10} aria-hidden /><span className={styles.totCoverLabel}>補齊</span>
            </span>
        );
}

export function FlashTotalsRow({ columns, mine, cover, sumBid, sumAsk, odd, unit, priv, cancel, split }: {
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
    /** 點買單／賣單合計＝買全刪／賣全刪 */
    cancel?: SideCancel;
    /** #402 委託格＝分段（且面板夠寬）：我的委託合計也用「成交｜未成交」膠囊，一行高 */
    split?: boolean;
}) {
    // ≤230px：不含逗號的短寫（萬以上用「萬」），完整數字在 tooltip
    const vol = (v: number) => (
        <>
            <span className={styles.totWide}>{odd ? fmtCompactInt(v) : fmtInt(v)}</span>
            <span className={styles.totNarrow}>{v >= 10_000 ? fmtCompactInt(v) : String(Math.round(v))}</span>
        </>
    );
    return (
        <div className={`${styles.totGrid} ${columns ? styles.cols7 : styles.totCols5} ${split ? (columns ? styles.colsSplit7 : styles.colsSplit5) : ''} ${
            mine ? (split ? styles.totGridSplit : styles.totGridTall) : ''}`} data-testid='flash-totals'>
            {mine ? <Mine side='buy' s={mine.buy} unit={unit} priv={priv} cancel={cancel} split={split} span={columns} />
                : <span className={`${styles.totEmpty} ${columns ? styles.totSpan2 : ''}`} />}
            <span className={styles.totVol.bid} title={`五檔買量合計 ${fmtInt(sumBid)}${odd ? ' 股' : ''}`} data-testid='flash-tot-bidvol'>{vol(sumBid)}</span>
            {mine && cover ? <Cover t={mine} unit={unit} priv={priv} /> : <span className={styles.totCover.none} />}
            <span className={styles.totVol.ask} title={`五檔賣量合計 ${fmtInt(sumAsk)}${odd ? ' 股' : ''}`} data-testid='flash-tot-askvol'>{vol(sumAsk)}</span>
            {mine ? <Mine side='sell' s={mine.sell} unit={unit} priv={priv} cancel={cancel} split={split} span={columns} />
                : <span className={`${styles.totEmpty} ${columns ? styles.totSpan2 : ''}`} />}
        </div>
    );
}
