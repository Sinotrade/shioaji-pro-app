// src/components/chart-order-popover.tsx — 下單設定按鈕與彈出面板（#204）
// K 線圖與閃電下單共用：OrderSettingsButton 是通用的按鈕＋面板，只列該面板
// 真的會用到、且這個商品適用的選項（不做灰掉的選項），底部一句話說明
// 點下去會送什麼。ChartOrderButton 是 K 線圖的組態（按鈕顯示數量＋單位：
// 「500 股」＝盤中零股、「1 張」＝整股、「2 口」＝期貨）。

import { Settings2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    chartOrderChipLabel,
    chartOrderRows,
    chartOrderSummary,
    chartOrderUnit,
    chartExitText,
    normalizeChartOrder,
    OCTYPES,
    ORDER_TYPES,
    QTY_PRESETS,
    type ChartOrderMarket,
    type ChartOrderSettings,
} from '../lib/chart-order-settings';
import { flashAccountKey } from '../lib/flash-account';
import { ODD_LOT_MAX_SHARES } from '../lib/odd-lot';
import type { Account } from '../lib/types/portfolio';
import * as styles from './chart-order-popover.css';

const FOLLOW = '__follow__';

export interface ChartOrderAccountView {
    eligible: Account[];
    /** the account a click would use now (undefined = none available) */
    active: Account | undefined;
    following: boolean;
    missing: boolean;
    short: (a: Account) => string;
    long: (a: Account) => string;
}

export function chartAccountLabel(view: ChartOrderAccountView): string {
    if (view.missing) return '（固定帳戶已不可用）';
    if (!view.active) return '（無可用帳戶）';
    return view.following ? `跟隨主畫面 ${view.short(view.active)}` : view.short(view.active);
}

/** Which rows a settings popover shows — only what the panel actually sends. */
export interface OrderSettingsLayout {
    /** '圖表下單設定' / '閃電下單設定' */
    title: string;
    /** '只影響這張圖' / '只影響這個面板' */
    scope: string;
    /** account row (the flash panel keeps its account picker in its top row) */
    account?: ChartOrderAccountView;
    /** 單位 row (stocks) */
    unit: boolean;
    /** ROD/IOC/FOK row */
    orderType: boolean;
    /** 自動/新倉/平倉 row (futures) */
    octype: boolean;
    /** read-only 停損停利 behaviour row */
    exitText?: string;
    /** tooltip of 設為預設 */
    defaultNote: string;
    /** accessible name prefix of the quantity input */
    qtyLabel: string;
}

export function OrderSettingsButton({
    market,
    settings,
    onChange,
    onSaveDefault,
    layout,
    contractLabel,
    summary,
    chip,
    ariaLabel,
    className,
    onOpenChange,
    align = 'start',
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    layout: OrderSettingsLayout;
    contractLabel: string;
    summary: string;
    /** button content next to the gear icon (nothing = icon only) */
    chip?: ReactNode;
    ariaLabel: string;
    className?: string;
    /** lets the host panel suspend its own hotkeys while the popover is open */
    onOpenChange?: (open: boolean) => void;
    /** 'panel': span the host row (its nearest positioned ancestor) — for
     * narrow panels where a button-anchored popover would be clipped */
    align?: 'start' | 'panel';
}) {
    const [open, setOpenState] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [panelTop, setPanelTop] = useState<number | undefined>(undefined);
    const setOpen = (next: boolean | ((v: boolean) => boolean)) => setOpenState(prev => {
        const value = typeof next === 'function' ? next(prev) : next;
        if (value !== prev) onOpenChange?.(value);
        return value;
    });
    // Esc closes the popover and nothing else (a panel's own Esc hotkey must
    // not also fire); nothing is listened to while closed
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open]);
    return (
        <span className={`${styles.anchor}${align === 'panel' ? ` ${styles.anchorStatic}` : ''}${className ? ` ${className}` : ''}`}>
            <button
                ref={buttonRef}
                type='button'
                className={styles.chip[open ? 'open' : 'closed']}
                title={`${layout.title}\n${summary}`}
                aria-label={ariaLabel}
                aria-haspopup='dialog'
                aria-expanded={open}
                onClick={() => {
                    const b = buttonRef.current;
                    if (align === 'panel' && b && Number.isFinite(b.offsetTop)) setPanelTop(b.offsetTop + b.offsetHeight + 4);
                    setOpen(v => !v);
                }}
            >
                <Settings2 size={11} aria-hidden />
                {chip !== undefined && <span className={styles.chipQty}>{chip}</span>}
            </button>
            {open && (
                <>
                    <div className={styles.backdrop} onClick={() => setOpen(false)} />
                    <OrderSettingsPanel
                        market={market}
                        settings={settings}
                        onChange={onChange}
                        onSaveDefault={onSaveDefault}
                        onClose={() => setOpen(false)}
                        align={align}
                        top={panelTop}
                        layout={layout}
                        contractLabel={contractLabel}
                        summary={summary}
                    />
                </>
            )}
        </span>
    );
}

export function ChartOrderButton({
    market,
    settings,
    onChange,
    onSaveDefault,
    account,
    contractLabel,
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    account: ChartOrderAccountView;
    contractLabel: string;
}) {
    const rows = chartOrderRows(market, settings.lot);
    const label = chartOrderChipLabel(settings, market);
    return (
        <OrderSettingsButton
            market={market}
            settings={settings}
            onChange={onChange}
            onSaveDefault={onSaveDefault}
            contractLabel={contractLabel}
            summary={chartOrderSummary(settings, market, chartAccountLabel(account))}
            chip={label}
            ariaLabel={`圖表下單設定：${label}`}
            layout={{
                title: '圖表下單設定',
                scope: '只影響這張圖',
                account,
                unit: rows.unit,
                orderType: rows.orderType,
                octype: rows.octype,
                exitText: chartExitText(settings, market),
                defaultNote: `新開的${market === 'F' ? '期貨' : '股票'}圖表使用這組設定（不含帳號）`,
                qtyLabel: '圖表下單數量',
            }}
        />
    );
}

export function OrderSettingsPanel({
    market,
    settings,
    onChange,
    onSaveDefault,
    onClose,
    layout,
    contractLabel,
    summary,
    align = 'start',
    top,
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    onClose: () => void;
    align?: 'start' | 'panel';
    top?: number;
    layout: OrderSettingsLayout;
    contractLabel: string;
    summary: string;
}) {
    const unit = chartOrderUnit(market, settings.lot);
    const odd = market === 'S' && settings.lot === 'IntradayOdd';
    const set = (patch: Partial<ChartOrderSettings>) => onChange(normalizeChartOrder({ ...settings, ...patch }, market));
    const [qtyText, setQtyText] = useState(String(settings.qty));
    useEffect(() => setQtyText(String(settings.qty)), [settings.qty]);
    const max = odd ? ODD_LOT_MAX_SHARES : 9999;
    const account = layout.account;
    return (
        <div className={align === 'panel' ? `${styles.pop} ${styles.popPanel}` : styles.pop}
            style={align === 'panel' && top !== undefined ? { top } : undefined}
            role='dialog' aria-label={layout.title}>
            <div className={styles.head}>
                <span className={styles.headTitle}>{layout.title}</span>
                <span className={styles.headNote} title={contractLabel}>{contractLabel} · {layout.scope}</span>
            </div>
            {account && (
                <div className={styles.row}>
                    <span className={styles.label}>帳號</span>
                    <select
                        className={styles.select}
                        aria-label={`${layout.title.replace('設定', '')}帳號`}
                        value={settings.accountKey ?? FOLLOW}
                        onChange={e => set({ accountKey: e.target.value === FOLLOW ? undefined : e.target.value })}
                    >
                        <option value={FOLLOW}>
                            {account.following && account.active ? `跟隨主畫面 ${account.short(account.active)}` : '跟隨主畫面'}
                        </option>
                        {account.missing && settings.accountKey && <option value={settings.accountKey}>帳戶不可用</option>}
                        {account.eligible.map(a => (
                            <option key={flashAccountKey(a)} value={flashAccountKey(a)}>{account.long(a)}</option>
                        ))}
                    </select>
                </div>
            )}
            {layout.unit && (
                <div className={styles.row}>
                    <span className={styles.label}>單位</span>
                    <div className={styles.seg} role='group' aria-label='單位'>
                        {([['Common', '整股（張）'], ['IntradayOdd', '盤中零股（股）']] as const).map(([lot, text]) => (
                            <button
                                key={lot}
                                type='button'
                                className={styles.segBtn[settings.lot === lot ? 'on' : 'off']}
                                aria-pressed={settings.lot === lot}
                                // 換單位時數量回 1：股數不能沿用成張數
                                onClick={() => { if (settings.lot !== lot) set({ lot, qty: 1 }); }}
                            >
                                {text}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <div className={styles.row}>
                <span className={styles.label}>數量</span>
                <div className={styles.qtyRow}>
                    <input
                        className={styles.qtyInput}
                        aria-label={`${layout.qtyLabel}（${unit}）`}
                        inputMode='numeric'
                        value={qtyText}
                        onChange={e => {
                            setQtyText(e.target.value);
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 1 && v <= max) set({ qty: v });
                        }}
                        onBlur={() => setQtyText(String(settings.qty))}
                    />
                    <span>{unit}</span>
                    {QTY_PRESETS[unit].map(n => (
                        <button key={n} type='button' className={styles.preset[settings.qty === n ? 'on' : 'off']} onClick={() => set({ qty: n })}>
                            {n}
                        </button>
                    ))}
                </div>
            </div>
            {layout.orderType && (
                <div className={styles.row}>
                    <span className={styles.label}>委託</span>
                    <div className={styles.seg} role='group' aria-label='委託條件'>
                        {ORDER_TYPES.map(t => (
                            <button key={t} type='button' className={styles.segBtn[settings.orderType === t ? 'on' : 'off']}
                                aria-pressed={settings.orderType === t} title='點價買賣的限價委託條件' onClick={() => set({ orderType: t })}>
                                {t}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {layout.octype && (
                <div className={styles.row}>
                    <span className={styles.label}>類別</span>
                    <div className={styles.seg} role='group' aria-label='開平倉'>
                        {OCTYPES.map(o => (
                            <button key={o.value} type='button' className={styles.segBtn[settings.octype === o.value ? 'on' : 'off']}
                                aria-pressed={settings.octype === o.value} onClick={() => set({ octype: o.value })}>
                                {o.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {layout.exitText && (
                <div className={styles.row}>
                    <span className={styles.label}>停損停利</span>
                    <span className={styles.info}>{layout.exitText}</span>
                </div>
            )}
            <div className={styles.summary} data-testid='order-settings-summary'>{summary}</div>
            <div className={styles.foot}>
                <button type='button' className={styles.footBtn.normal} title={layout.defaultNote} onClick={onSaveDefault}>
                    設為預設
                </button>
                <button type='button' className={styles.footBtn.primary} onClick={onClose}>完成</button>
            </div>
        </div>
    );
}
