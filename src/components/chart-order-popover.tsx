// src/components/chart-order-popover.tsx — 下單設定按鈕與彈出面板（#204）
// K 線圖與閃電下單共用：OrderSettingsButton 是通用的按鈕＋面板，只列該面板
// 真的會用到、且這個商品適用的選項（不做灰掉的選項），底部一句話說明
// 點下去會送什麼。ChartOrderButton 是 K 線圖的組態（按鈕顯示數量＋單位：
// 「500 股」＝盤中零股、「1 張」＝整股、「2 口」＝期貨）。

import { Ban, Settings2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from 'react';
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
import { CASH_CREDIT, flashAccountKey, type FlashCond } from '../lib/flash-account';
import { ODD_LOT_MAX_SHARES } from '../lib/odd-lot';
import { clipAncestors, fitPopover, visibleClipRect, type PopoverFit } from '../lib/popover-fit';
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
    /** 自動/新倉/平倉/當沖 row (futures) */
    octype: boolean;
    /** 信用條件＋現股當沖先賣 rows (K 線圖股票)；零股時停用並說明 */
    credit?: {
        /** why the rows are disabled now (零股), else null */
        suspended: string | null;
        /** contract.day_trade === 'Yes' */
        dayTradeOk: boolean;
        /** 可否融資券 / 不可當沖 狀態一句話（停用時 bad） */
        status?: { text: string; bad: boolean };
    };
    /** read-only 停損停利 behaviour row */
    exitText?: string;
    /** tooltip of 設為預設 */
    defaultNote: string;
    /** accessible name prefix of the quantity input */
    qtyLabel: string;
    /** rows shown first (閃電：對應商品／規格／月份／價差對照) */
    extraRows?: ReactNode;
    /** 記住數量 row (flash panels): on/off + what is remembered, with units */
    rememberQty?: { on: boolean; text: string; note: string; onToggle: (on: boolean) => void };
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
    hideTrigger = false,
    openRef,
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
    /** the host opens the popover from its own control (閃電整股面板：單位
     *按鈕的「更多設定…」) — the gear button is kept but not shown */
    hideTrigger?: boolean;
    /** receives a function that opens the popover (optionally at `top`) */
    openRef?: MutableRefObject<((top?: number) => void) | null>;
}) {
    const [open, setOpenState] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [panelTop, setPanelTop] = useState<number | undefined>(undefined);
    const setOpen = (next: boolean | ((v: boolean) => boolean)) => setOpenState(prev => {
        const value = typeof next === 'function' ? next(prev) : next;
        if (value !== prev) onOpenChange?.(value);
        return value;
    });
    if (openRef) openRef.current = (top) => { if (top !== undefined) setPanelTop(top); setOpen(true); };
    // 掛在按鈕下方的面板（K 線工具列）：窄面板裡從按鈕往右長會被面板右緣
    // 裁掉 — 依可見範圍往左收、必要時縮寬／限高捲動。開啟時先以原尺寸
    // 量一次（fit 為 null）；之後彈出層內容高度（縮寬後換行）、按鈕位置、
    // 面板大小、視窗縮放或捲動變了都依原寬重算（結果相同就不重繪）
    const popRef = useRef<HTMLDivElement>(null);
    const naturalWidth = useRef(0);
    const [fit, setFit] = useState<PopoverFit | null>(null);
    useLayoutEffect(() => {
        if (!open || align !== 'start') {
            setFit(null);
            naturalWidth.current = 0;
            return;
        }
        const pop = popRef.current;
        const anchorEl = buttonRef.current?.parentElement;
        const win = anchorEl?.ownerDocument?.defaultView;
        if (!pop || !anchorEl || !win || typeof anchorEl.getBoundingClientRect !== 'function') return;
        const place = () => {
            if (!naturalWidth.current) naturalWidth.current = pop.offsetWidth;
            const a = anchorEl.getBoundingClientRect();
            const next = fitPopover(
                { left: a.left, bottom: a.bottom },
                { width: naturalWidth.current, height: pop.scrollHeight },
                visibleClipRect(anchorEl),
            );
            setFit(prev => (prev && prev.left === next.left && prev.maxWidth === next.maxWidth && prev.maxHeight === next.maxHeight ? prev : next));
        };
        place();
        win.addEventListener('resize', place);
        win.addEventListener('scroll', place, true);
        const RO = (win as typeof window).ResizeObserver;
        const ro = RO ? new RO(place) : null;
        if (ro) for (const el of [pop, anchorEl, ...clipAncestors(anchorEl)]) ro.observe(el);
        return () => {
            win.removeEventListener('resize', place);
            win.removeEventListener('scroll', place, true);
            ro?.disconnect();
        };
    }, [open, align]);
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
                hidden={hideTrigger}
                // the chip class sets display, which would override [hidden]
                style={hideTrigger ? { display: 'none' } : undefined}
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
                        popRef={popRef}
                        fit={fit}
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
    credit,
    disabled,
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    account: ChartOrderAccountView;
    contractLabel: string;
    credit?: OrderSettingsLayout['credit'];
    /** chip flagged when a condition currently blocks a side */
    disabled?: boolean;
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
            chip={disabled ? <>{label}<Ban size={10} aria-hidden /></> : label}
            ariaLabel={`圖表下單設定：${label}`}
            layout={{
                title: '圖表下單設定',
                scope: '只影響這張圖',
                account,
                unit: rows.unit,
                orderType: rows.orderType,
                octype: rows.octype,
                exitText: chartExitText(settings, market),
                ...(credit ? { credit } : {}),
                defaultNote: `新開的${market === 'F' ? '期貨' : '股票'}圖表使用這組設定（不含帳號）`,
                qtyLabel: '圖表下單數量',
            }}
        />
    );
}

function fitStyle(fit: PopoverFit | null | undefined): CSSProperties | undefined {
    if (!fit) return undefined;
    return {
        left: fit.left,
        ...(fit.maxWidth !== undefined ? { width: fit.maxWidth } : {}),
        ...(fit.maxHeight !== undefined ? { maxHeight: fit.maxHeight, overflowY: 'auto' } : {}),
    };
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
    popRef,
    fit,
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    onClose: () => void;
    align?: 'start' | 'panel';
    top?: number;
    popRef?: RefObject<HTMLDivElement | null>;
    /** button-anchored popover kept inside the visible area (see fitPopover) */
    fit?: PopoverFit | null;
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
        <div ref={popRef} className={align === 'panel' ? `${styles.pop} ${styles.popPanel}` : styles.pop}
            style={align === 'panel' ? (top !== undefined ? { top } : undefined) : fitStyle(fit)}
            role='dialog' aria-label={layout.title}>
            <div className={styles.head}>
                <span className={styles.headTitle}>{layout.title}</span>
                <span className={styles.headNote} title={contractLabel}>{contractLabel} · {layout.scope}</span>
            </div>
            {layout.extraRows}
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
            {layout.rememberQty && (
                <div className={styles.row}>
                    <span className={styles.label}>記住數量</span>
                    <div className={styles.seg} role='group' aria-label='記住數量' title={layout.rememberQty.note}>
                        {([[true, '開'], [false, '關']] as const).map(([on, text]) => (
                            <button key={text} type='button' className={styles.segBtn[layout.rememberQty!.on === on ? 'on' : 'off']}
                                aria-pressed={layout.rememberQty!.on === on}
                                onClick={() => { if (layout.rememberQty!.on !== on) layout.rememberQty!.onToggle(on); }}>
                                {text}
                            </button>
                        ))}
                    </div>
                    <span className={styles.rowNote} data-testid='remember-qty-text'>{layout.rememberQty.text}</span>
                </div>
            )}
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
            {layout.credit && (
                <CreditRows
                    credit={settings.credit ?? CASH_CREDIT}
                    view={layout.credit}
                    onChange={credit => set({ credit })}
                />
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

// 信用條件（同下單面板與閃電的清單與文案）
const CREDIT_ITEMS: readonly [FlashCond, string, string][] = [
    ['Cash', '現股', '預設'],
    ['MarginTrading', '融資', '買／賣'],
    ['ShortSelling', '融券', '只能賣'],
    ['SBLShort', '借券', '只能賣：一般借券賣出（委託類別5）'],
    ['SBLShortPriceExempt', '借券豁免', '只能賣：價格豁免借券賣出（委託類別6，特殊金融商品適用）'],
];

function CreditRows({ credit, view, onChange }: {
    credit: { cond: FlashCond; daytradeShort: boolean };
    view: NonNullable<OrderSettingsLayout['credit']>;
    onChange: (c: { cond: FlashCond; daytradeShort: boolean }) => void;
}) {
    const off = view.suspended !== null;
    return (
        <>
            <div className={styles.row}>
                <span className={styles.label}>信用</span>
                <div className={`${styles.seg} ${styles.segWrap}`} role='group' aria-label='信用條件'>
                    {CREDIT_ITEMS.map(([cond, text, sub]) => {
                        const on = !off && credit.cond === cond;
                        return (
                            <button key={cond} type='button' className={`${styles.segBtn[on ? 'on' : 'off']} ${styles.segFit}`} aria-pressed={on}
                                disabled={off} title={off ? view.suspended! : sub}
                                onClick={() => { if (!off && credit.cond !== cond) onChange({ cond, daytradeShort: false }); }}>
                                {text}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>當沖</span>
                <div className={styles.seg} role='group' aria-label='現股當沖先賣'>
                    <button type='button' className={styles.segBtn[!off && credit.daytradeShort ? 'on' : 'off']}
                        aria-pressed={!off && credit.daytradeShort} disabled={off}
                        title={off ? view.suspended! : view.dayTradeOk ? '現股當沖先賣：點價賣為現沖賣出，當日需回補（只限現股）' : '此股票目前不可現沖先賣；設定保留，換到可當沖的股票時生效'}
                        // 只限現股：勾選時信用條件一起改回現股
                        onClick={() => { if (!off) onChange({ cond: 'Cash', daytradeShort: !credit.daytradeShort }); }}>
                        現股當沖先賣
                    </button>
                </div>
            </div>
            {(off || view.status) && (
                <div className={styles.creditNote[view.status?.bad && !off ? 'bad' : 'ok']} data-testid='chart-credit-note'>
                    {off ? view.suspended : view.status!.text}
                </div>
            )}
        </>
    );
}

/** 設定面板的一列分段按鈕（閃電的對應商品、規格、月份、價差對照） */
export function SettingsSegRow<T extends string>({ label, value, options, onPick, note, extra }: {
    label: string;
    value: T;
    options: readonly (readonly [T, string, string?])[];
    onPick: (v: T) => void;
    note?: string;
    /** 分段按鈕後面的控制項（例：指定月份的下拉） */
    extra?: ReactNode;
}) {
    return (
        <div className={styles.row}>
            <span className={styles.label}>{label}</span>
            <div className={styles.seg} role='group' aria-label={label}>
                {options.map(([v, text, sub]) => (
                    <button key={v} type='button' className={styles.segBtn[value === v ? 'on' : 'off']} aria-pressed={value === v}
                        title={sub} onClick={() => { if (value !== v) onPick(v); }}>
                        {text}
                    </button>
                ))}
                {extra}
            </div>
            {note && <span className={styles.rowNote}>{note}</span>}
        </div>
    );
}

export function SettingsInfoRow({ label, text }: { label: string; text: string }) {
    return (
        <div className={styles.row}>
            <span className={styles.label}>{label}</span>
            <span className={styles.info}>{text}</span>
        </div>
    );
}

export const settingsSelectClass = styles.select;
