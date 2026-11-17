// src/components/chart-fill-settings.tsx — 成交標記的設定面板（圖例列「成交」或「指標」裡的「成交標記」打開）：形狀、標籤、顏色、帳戶範圍
//
// 形狀、標籤、顏色與帳戶範圍是全域偏好，所有 K 線圖（含彈出視窗）一起換，點了就生效；這張圖要不要畫
// （顯示／隱藏／移除）在圖例列。外觀沿用圖表下單設定的列（chart-order-popover）與畫圖工具的色盤。

import { useEffect, useRef, useState } from 'react';
import { DRAWING_PALETTE } from '../lib/chart-drawings';
import type { FillMarkShape, FillMarkStyle } from '../lib/chart-fill-marks';
import {
    CHART_FILL_SHAPES, setChartFillBuy, setChartFillColor, setChartFillScope, setChartFillSell, setChartFillShape, setChartFillStyle,
    type ChartFillColor, type ChartFillScope,
} from '../lib/chart-fill-prefs';
import * as drawStyles from './chart-drawing-tools.css';
import * as styles from './chart-fill-details.css';
import * as popStyles from './chart-order-popover.css';

/** 形狀的示意字元與名稱：[買, 賣, 名稱]（圖例列與設定面板共用） */
export const FILL_SHAPE_GLYPH: Record<FillMarkShape, readonly [string, string, string]> = {
    triangle: ['▲', '▼', '三角形'],
    arrow: ['↑', '↓', '箭頭'],
    circle: ['●', '○', '圓點'], // 沒有方向的形狀：賣畫空心（圖上也是）
    diamond: ['◆', '◇', '菱形'],
};
// [值, 名稱, 示意標籤, 說明]
const STYLES: readonly (readonly [FillMarkStyle, string, string, string])[] = [
    ['dot', '不標', '', '只畫標記，不標文字'],
    ['side', '買賣', '買', '標記旁標「買」「賣」與合計，例如「買 22口」'],
    ['price', '價格', '962', '標記旁標成交價；同一根有多個價位時標均價，例如「均 46,464.4 22口」'],
];
const SIDES = [['buy', '買'], ['sell', '賣']] as const;

export function ChartFillSettings({ shape, style, color, scope, colors, custom, account }: {
    shape: FillMarkShape;
    style: FillMarkStyle;
    color: ChartFillColor;
    scope: ChartFillScope;
    /** 圖上現在用的買／賣色（自選色、依主題的預設色，或 K 棒的漲跌色） */
    colors: { buy: string; sell: string };
    /** 自選的買／賣色（空字串＝預設色） */
    custom: { buy: string; sell: string };
    /** 這張圖的帳戶名稱（已套隱私遮罩） */
    account: string;
}) {
    // 正在換哪一邊的顏色（色盤展開在顏色列下面）
    const [picking, setPicking] = useState<'buy' | 'sell' | null>(null);
    // 打開時焦點移到選中的形狀，只用鍵盤也進得來（彈出層第一次渲染還是隱藏的，等一幀）。
    // 關閉時焦點若跟著面板消失（Esc、點選項後關閉）就還給原本的地方；點了圖表等別處就留在那裡
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (typeof requestAnimationFrame !== 'function') return; // 測試環境（沒有 DOM）
        const doc = rootRef.current?.ownerDocument;
        const back = doc?.activeElement as HTMLElement | null | undefined;
        const raf = requestAnimationFrame(() => rootRef.current?.querySelector?.<HTMLElement>('[aria-pressed="true"]')?.focus?.({ preventScroll: true }));
        return () => {
            cancelAnimationFrame(raf);
            if (!doc?.activeElement || doc.activeElement === doc.body) back?.focus?.({ preventScroll: true });
        };
    }, []);
    // 換色就是要用自己的買賣色：原本是同 K 棒也一併切回來
    const pick = (c: string) => {
        (picking === 'buy' ? setChartFillBuy : setChartFillSell)(c);
        if (color !== 'distinct') setChartFillColor('distinct');
    };
    return (
        <div ref={rootRef} className={styles.settings}>
            <div className={popStyles.head}>
                <span className={popStyles.headTitle}>成交標記</span>
                <span className={popStyles.headNote}>所有 K 線圖共用</span>
            </div>
            <div className={popStyles.row}>
                <span className={popStyles.label}>形狀</span>
                <div className={popStyles.seg} role='group' aria-label='形狀'>
                    {CHART_FILL_SHAPES.map((v) => (
                        <button key={v} type='button' className={popStyles.segBtn[shape === v ? 'on' : 'off']} aria-pressed={shape === v}
                            title='買畫在成交價下方、賣畫在上方' onClick={() => setChartFillShape(v)}>
                            <span aria-hidden style={{ color: colors.buy }}>{FILL_SHAPE_GLYPH[v][0]}</span> {FILL_SHAPE_GLYPH[v][2]}
                        </button>
                    ))}
                </div>
            </div>
            <div className={popStyles.row}>
                <span className={popStyles.label}>標籤</span>
                <div className={popStyles.seg} role='group' aria-label='標籤'>
                    {STYLES.map(([v, text, sample, tip]) => (
                        <button key={v} type='button' className={popStyles.segBtn[style === v ? 'on' : 'off']} aria-pressed={style === v} title={tip}
                            onClick={() => setChartFillStyle(v)}>
                            {sample && <span aria-hidden className={styles.sample}>{sample}</span>} {text}
                        </button>
                    ))}
                </div>
            </div>
            <div className={popStyles.row}>
                <span className={popStyles.label}>顏色</span>
                {/* 買、賣各一顆色鈕（點了展開色盤）；跟 K 棒同色是另一種東西，用勾選框，不和色鈕擠在同一個分段裡 */}
                <div className={styles.picker} role='group' aria-label='顏色'>
                    {SIDES.map(([side, text]) => (
                        <button key={side} type='button' className={popStyles.footBtn.normal}
                            aria-label={`${text}的顏色`} aria-expanded={picking === side} title={`換${text}的顏色`}
                            onClick={() => setPicking(picking === side ? null : side)}>
                            {text}<span aria-hidden className={styles.chip} style={{ background: colors[side] }} />
                            <span aria-hidden className={styles.caret}>{picking === side ? '▴' : '▾'}</span>
                        </button>
                    ))}
                    <label className={styles.check} title='買用漲色、賣用跌色'>
                        <input type='checkbox' checked={color === 'candle'}
                            onChange={(e) => { setPicking(null); setChartFillColor(e.target.checked ? 'candle' : 'distinct'); }} />
                        跟 K 棒同色
                    </label>
                </div>
                {picking && (
                    <div className={styles.picker} role='group' aria-label={`${picking === 'buy' ? '買' : '賣'}的顏色`}>
                        <span className={popStyles.label}>{picking === 'buy' ? '買' : '賣'}</span>
                        <span className={drawStyles.palette}>
                            {DRAWING_PALETTE.map((c) => (
                                <button key={c} type='button' aria-label={`顏色 ${c}`} style={{ background: c }}
                                    aria-pressed={color === 'distinct' && custom[picking] === c}
                                    className={drawStyles.swatch[color === 'distinct' && custom[picking] === c ? 'active' : 'normal']}
                                    onClick={() => pick(c)} />
                            ))}
                        </span>
                        <button type='button' className={popStyles.footBtn[color === 'distinct' && !custom[picking] ? 'primary' : 'normal']}
                            aria-pressed={color === 'distinct' && !custom[picking]} title={`換回預設的${picking === 'buy' ? '買' : '賣'}色`}
                            onClick={() => pick('')}>預設色</button>
                    </div>
                )}
            </div>
            <div className={`${popStyles.summary} ${styles.scopeLine}`}>
                <span>帳戶：{scope === 'all' ? '全部帳戶' : account}</span>
                <button type='button' className={styles.link}
                    title={scope === 'all' ? '只顯示這張圖下單帳戶的成交' : '合併顯示同一市場所有帳戶的成交；明細逐筆列出帳戶'}
                    onClick={() => setChartFillScope(scope === 'all' ? 'active' : 'all')}>
                    {scope === 'all' ? '改成目前帳戶' : '改成全部帳戶'}
                </button>
            </div>
        </div>
    );
}
