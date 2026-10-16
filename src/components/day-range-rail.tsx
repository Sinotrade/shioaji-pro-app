// src/components/day-range-rail.tsx：個股看板的日內區間軌（rail、railMid、railLow 三級）。
// 上面是圖：今天的日 K 橫放在以平盤（參考價）為中心的尺上，實體＝開盤到現價（陽紅陰綠，和 K 線圖一樣
// 看現價比開盤），引線＝最低到最高（同色霧面淡化），白針＝現價，點線＝平盤，兩端寫尺的幅度。
// 下面一行是數字，由小到大：跌停、低、開、高、漲停（指數期把兩端換成距低、距高點數），
// 取代看板右側的數字欄。尺度、位置的計算在 lib/day-range

import { useLayoutEffect, useRef, useState } from 'react';
import {
    dirVsOpen,
    railEndPcts,
    railChars,
    railPos,
    railScale,
    railTicks,
    railTitle,
    type DayRange,
} from '../lib/day-range';
import type { LimitState } from '../lib/limit-state';
import * as panel from './panel.css';
import * as styles from './quote-board.css';

interface RailProps {
    range: DayRange;
    fmt: (v: number) => string;
    // 尺的檔位（個股、個股期用 STOCK_SCALES，指數期用 INDEX_FUTURE_SCALES）
    scales: readonly number[];
    // 數字列兩端：limits＝跌停、漲停價（淡灰）；distance＝距低、距高點數（指數期，漲跌停幾乎碰不到）
    edges: 'limits' | 'distance';
    // 距低、距高點數的格式（依跳動價位的小數位）
    fmtPoints: (v: number) => string;
    // 現價鎖在漲停／跌停
    locked: LimitState;
    // 今天碰過漲停／跌停（停板端畫成實心）
    touched: { up: boolean; down: boolean };
}

// 兩端幅度字的字級（rem），和 railTag 樣式一致
const TAG_REM = 0.6;

export function DayRangeRail({ className, ...props }: RailProps & { className?: string }) {
    const { range: r, fmt, fmtPoints, scales, edges } = props;
    const ref = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ width: 0, rootPx: 16 });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        // 不在軌道階梯時整條隱藏、寬度是 0；切回來時 ResizeObserver 會帶新寬度重畫
        const update = () => {
            const rootPx =
                (typeof getComputedStyle === 'function' && parseFloat(getComputedStyle(document.documentElement).fontSize)) || 16;
            setBox((prev) =>
                prev.width === Math.floor(el.clientWidth) && prev.rootPx === rootPx
                    ? prev
                    : { width: Math.floor(el.clientWidth), rootPx },
            );
        };
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const scale = railScale(r, scales);
    const [leftPct, rightPct] = railEndPcts(r, scale);
    const tags = [`-${leftPct}%`, `+${rightPct}%`] as const;
    // 兩端字的寬度：等寬字每字 0.6em，再留 8px；數字列也從同一個位置開始，和軌道起點對齊
    const tagPx = TAG_REM * box.rootPx;
    const inset = Math.ceil(Math.max(...tags.map((t) => t.length * 0.6 * tagPx))) + 8;
    const title = railTitle(r, scale, fmt);
    const scaleText = scale === null ? '尺到漲跌停' : `尺 ±${scale}%`;
    const dirClass = (v: number) => {
        const d = dirVsOpen(v, r.open);
        return d ? panel.dirText[d] : undefined;
    };
    const item = (label: string, value: string, valueClass?: string, extra?: string) => (
        <span className={extra}>
            <span className={styles.railNumLabel}>{label}</span>
            <span className={valueClass}>{value}</span>
        </span>
    );
    return (
        <div className={className}>
            {/* 不加 cursor: help：軌道占看板大半面積，要保留看板拖曳把手的 grab 游標。
                提示（title）會被讀成描述，名稱就不再重複一次 */}
            <div ref={ref} className={styles.railGraphic} role="img" aria-label={`今日區間圖：現價 ${fmt(r.close)}，${scaleText}`} title={title}>
                {box.width > 0 && <RailSvg {...props} scale={scale} tags={tags} inset={inset} width={box.width} />}
            </div>
            {/* 數字列的各格一直在畫面上，由 CSS 依階梯與軌道寬度收起：階梯量測時 React 不會重繪，靠 CSS 結果判斷放不放得下 */}
            <div className={styles.railNumbers} style={{ paddingLeft: inset }}>
                {/* railMid、railLow 時這層當容器（寬度已扣掉左側留白），依低、開、高最長的字數決定留幾格 */}
                <div className={styles.railCells} data-chars={railChars([fmt(r.low), fmt(r.open), fmt(r.high)])}>
                    {edges === 'limits'
                        ? item('跌停', fmt(r.limitDown), styles.railNumMuted, styles.railEdge)
                        : item('距低', fmtPoints(r.close - r.low), undefined, styles.railEdge)}
                    {item('低', fmt(r.low), dirClass(r.low), styles.railHL)}
                    {item('開', fmt(r.open), undefined, styles.railOpen)}
                    {item('高', fmt(r.high), dirClass(r.high), styles.railHL)}
                    {edges === 'limits'
                        ? item('漲停', fmt(r.limitUp), styles.railNumMuted, styles.railEdge)
                        : item('距高', fmtPoints(r.high - r.close), undefined, styles.railEdge)}
                </div>
            </div>
        </div>
    );
}

// 中線 CY：▼ 頂端到針底共 15px，整張圖 17px 高
const CY = 11;

function RailSvg({
    range: r,
    locked,
    touched,
    scale,
    tags,
    inset,
    width: W,
}: Pick<RailProps, 'range' | 'locked' | 'touched'> & {
    scale: number | null;
    tags: readonly [string, string];
    inset: number;
    width: number;
}) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    // 對齊實體像素，1px 的線才不會糊成兩欄
    const snap = (x: number) => Math.round(x * dpr) / dpr;
    const x0 = snap(inset);
    const x1 = snap(W - inset);
    if (x1 - x0 < 40) return null;

    const X = (v: number) => snap(x0 + (x1 - x0) * railPos(v, r, scale));
    const dir = r.close >= r.open ? 'up' : 'down';
    const xClose = X(r.close);
    const xRef = X(r.reference);

    let b0 = X(Math.min(r.open, r.close));
    let b1 = X(Math.max(r.open, r.close));
    // 鎖在停板時實體停在停板塊內緣，中間留 1px 縫
    if (locked === 'up') b1 = Math.min(b1, x1 - 3);
    if (locked === 'down') b0 = Math.max(b0, x0 + 3);
    // 實體最短 6px，往開盤那一側延伸，才不會整個被現價針蓋住；開盤等於現價時不畫實體。
    // 延伸撞到兩端時整段平移回軌道內（開在停板、現價差一檔時不會蓋過停板端）
    if (b1 - b0 < 6) {
        if (dir === 'up') b0 = b1 - 6;
        else b1 = b0 + 6;
        if (b0 < x0 + 3) [b0, b1] = [x0 + 3, b1 + (x0 + 3 - b0)];
        if (b1 > x1 - 3) [b0, b1] = [b0 - (b1 - (x1 - 3)), x1 - 3];
    }
    // 鎖在停板時引線也停在內緣，保住實體和實心停板塊之間的縫
    const w0 = locked === 'down' ? Math.max(X(r.low), x0 + 3) : X(r.low);
    const w1 = locked === 'up' ? Math.min(X(r.high), x1 - 3) : X(r.high);

    // 停板端畫在實體、引線之後，才不會被蓋掉內側
    const cap = (x: number, side: 'up' | 'down') =>
        touched[side] || locked === side ? (
            <rect className={styles.railBody[side]} x={x - 2} y={CY - 6} width={4} height={12} shapeRendering="crispEdges" />
        ) : (
            <rect className={styles.railMark} x={x - 1} y={CY - 5} width={2} height={10} shapeRendering="crispEdges" />
        );

    return (
        <svg className={styles.railSvg} height={CY + 6} aria-hidden="true">
            {/* 兩端寫尺的幅度（-1%、+1%；用到漲跌停時是停板幅度），取代像翻頁鍵的箭頭 */}
            <text x={x0 - 6} y={CY + 3.5} textAnchor="end" className={styles.railTag}>
                {tags[0]}
            </text>
            <text x={x1 + 6} y={CY + 3.5} className={styles.railTag}>
                {tags[1]}
            </text>
            <rect className={styles.railTrack} x={x0} y={CY - 1} width={x1 - x0} height={2} shapeRendering="crispEdges" />
            {railTicks(r, scale).map((p) => (
                <rect key={p} className={styles.railNotch} x={X(p)} y={CY - 2} width={1} height={4} shapeRendering="crispEdges" />
            ))}
            <rect className={styles.railWick[dir]} x={w0} y={CY - 2} width={Math.max(0, w1 - w0)} height={4} shapeRendering="crispEdges" />
            {r.open !== r.close && (
                <rect className={styles.railBody[dir]} x={b0} y={CY - 4} width={b1 - b0} height={8} shapeRendering="crispEdges" />
            )}
            {scale === null && (
                <>
                    {cap(x0, 'down')}
                    {cap(x1, 'up')}
                </>
            )}
            {/* 平盤：點線、比刻度亮一階、比現價針長，兩側留縫，穿過實體時也看得見 */}
            <rect className={styles.railGap} x={xRef - 1} y={CY - 9} width={3} height={15} shapeRendering="crispEdges" />
            <line className={styles.railRef} x1={xRef + 0.5} y1={CY - 9} x2={xRef + 0.5} y2={CY + 6} />
            {/* 鎖在停板時不畫直針（會蓋住實心停板塊），只留 ▼ 指著停板端（現價就在停板端上） */}
            {!locked && <rect className={styles.railNeedle} x={xClose - 1} y={CY - 5} width={2} height={10} />}
            <path className={styles.railNeedle} d={`M${xClose - 5},${CY - 10} L${xClose + 5},${CY - 10} L${xClose},${CY - 5} Z`} />
        </svg>
    );
}
