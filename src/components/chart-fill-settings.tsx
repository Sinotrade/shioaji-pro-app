// src/components/chart-fill-settings.tsx — 圖表設定的「成交標記」頁：標記（不畫／三角形／買賣／價格）、顏色、帳戶範圍
//
// 不畫只關這張圖（存在面板設定，工具列「成交」鈕是同一個開關）；樣式、顏色與帳戶範圍是全域偏好，
// 所有 K 線圖（含彈出視窗）一起換。外觀沿用圖表下單設定的列（chart-order-popover）。

import type { FillMarkStyle } from '../lib/chart-fill-marks';
import { setChartFillColor, setChartFillScope, setChartFillStyle, type ChartFillColor, type ChartFillScope } from '../lib/chart-fill-prefs';
import { SettingsSegRow } from './chart-order-popover';
import * as popStyles from './chart-order-popover.css';

type Mark = FillMarkStyle | 'none';
const MARKS: readonly (readonly [Mark, string, string])[] = [
    ['none', '不畫', '這張圖不畫成交標記，也不列明細'],
    ['dot', '三角形', '三角形不標文字：▲ 買、▼ 賣，尖端在成交價；同一根 K 棒同方向有多個價位時仍畫區間線與刻度'],
    ['side', '買賣', '三角形旁標「買」「賣」；同一根 K 棒同方向有多個價位時畫成一組（區間線＋每個價位一條刻度），標合計，例如「買 22口」'],
    ['price', '價格', '三角形旁標成交價；同一根 K 棒同方向有多個價位時畫成一組（區間線＋每個價位一條刻度），標均價與合計，例如「均 46,464.4 22口」'],
];
const COLORS: readonly (readonly [ChartFillColor, string, string])[] = [
    ['distinct', '藍買橘賣', '和 K 棒的紅綠分得開'],
    ['candle', '同 K 棒', '買用漲色、賣用跌色（和 K 棒同色）'],
];
const SCOPES: readonly (readonly [ChartFillScope, string, string])[] = [
    ['active', '目前帳戶', '只顯示這張圖下單帳戶的成交'],
    ['all', '全部帳戶', '合併顯示同一市場所有帳戶的成交；明細逐筆列出帳戶'],
];

export function ChartFillSettings({ show, onShowChange, style, color, scope, onClose }: {
    show: boolean;
    onShowChange: (show: boolean) => void;
    style: FillMarkStyle;
    color: ChartFillColor;
    scope: ChartFillScope;
    onClose: () => void;
}) {
    return (
        <>
            <div className={popStyles.head}>
                <span className={popStyles.headTitle}>成交標記</span>
                <span className={popStyles.headNote}>樣式、顏色、帳戶：所有 K 線圖共用</span>
            </div>
            <SettingsSegRow label='標記' value={show ? style : 'none'} options={MARKS} onPick={(v) => {
                if (v === 'none') onShowChange(false);
                else {
                    setChartFillStyle(v);
                    if (!show) onShowChange(true);
                }
            }} />
            <SettingsSegRow label='顏色' value={color} options={COLORS} onPick={setChartFillColor} />
            <SettingsSegRow label='帳戶' value={scope} options={SCOPES} onPick={setChartFillScope} />
            <div className={popStyles.foot}>
                <button type='button' className={popStyles.footBtn.primary} onClick={onClose}>完成</button>
            </div>
        </>
    );
}
