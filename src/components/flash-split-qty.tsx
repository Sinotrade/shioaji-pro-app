// src/components/flash-split-qty.tsx — #402 閃電梯子「我的委託」格的兩種寫法。
//   分段（SplitQty）：一個膠囊，外側實心段＝已成交（不可點），內側外框段＝未成交
//     （點＝刪單）。每個價位與底部合計列共用，只有左右並排一種排法。
//   精簡：只顯示未成交 chip；這個價位沒有未成交才顯示實心成交數。
// 遮金額時每段只放一個「•」，形狀保留（看得出哪裡有單、還能點刪）。
import { cellTitle, fmtCellQty, type LadderCell } from '../lib/flash-cells';
import * as styles from './flash-order.css';

const DOT = '•';

export function SplitQty({ side, working, filled, priv, title, ariaLabel, disabled, multi, pending, onCancel, testId }: {
    side: 'buy' | 'sell';
    working: number;
    filled: number;
    priv: boolean;
    title?: string;
    ariaLabel?: string;
    /** 看得到、但現在不能點（閃電未啟用） */
    disabled?: boolean;
    /** 同價位多筆委託 */
    multi?: boolean;
    /** 刪單送出中 */
    pending?: boolean;
    onCancel?: () => void;
    testId?: string;
}) {
    if (working <= 0 && filled <= 0) return null;
    const n = (v: number) => (priv ? DOT : fmtCellQty(v));
    const buy = side === 'buy';
    const both = working > 0 && filled > 0;
    const fill = filled > 0 && (
        <span key='f' data-seg='filled' className={`${styles.segFill[side]} ${!both ? styles.segAlone : buy ? styles.segOuterL : styles.segOuterR}`}>{n(filled)}</span>
    );
    const work = working > 0 && (
        <span key='w' data-seg='working' className={`${styles.segWork[side]} ${!both ? styles.segAlone : buy ? styles.segInnerR : styles.segInnerL} ${
            pending ? styles.cancelPending : ''}`}>{n(working)}</span>
    );
    const cls = `${styles.split} ${multi ? styles.multiOrders[side] : ''}`;
    const parts = buy ? [fill, work] : [work, fill];
    // 只有成交（或不能刪）：不是按鈕
    if (working <= 0 || !onCancel) return <span className={cls} title={title} data-testid={testId}>{parts}</span>;
    return (
        <button type='button' className={cls} title={title} aria-label={ariaLabel} aria-disabled={disabled || undefined} data-testid={testId} onClick={onCancel}>
            {parts}
        </button>
    );
}

/** 梯子一個價位、一邊的我的委託 */
export function LadderMine({ side, cell, split, priv, priceText, unit, onCancel }: {
    side: 'buy' | 'sell';
    cell: LadderCell | undefined;
    split: boolean;
    priv: boolean;
    priceText: string;
    unit: string;
    onCancel: () => void;
}) {
    if (!cell || (cell.working <= 0 && cell.filled <= 0)) return null;
    const title = cellTitle(side, priceText, cell, unit, priv);
    const multi = cell.orders > 1;
    if (split) {
        return <SplitQty side={side} working={cell.working} filled={cell.filled} priv={priv} title={title}
            multi={multi} pending={cell.pending} onCancel={onCancel} testId={`flash-cell-${side}`} />;
    }
    const n = (v: number) => (priv ? DOT : fmtCellQty(v));
    if (cell.working <= 0) {
        return <span className={`${styles.fillBadge[side]} ${styles.chipFit}`} title={title} data-testid={`flash-cell-${side}`}>{n(cell.filled)}</span>;
    }
    return (
        <button
            type='button'
            className={`${styles.orderChip[side]} ${styles.chipFit} ${multi ? styles.multiOrders[side] : ''} ${cell.pending ? styles.cancelPending : ''}`}
            title={title}
            data-testid={`flash-cell-${side}`}
            onClick={onCancel}
        >
            {n(cell.working)}
        </button>
    );
}
