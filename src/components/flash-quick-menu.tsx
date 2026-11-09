// src/components/flash-quick-menu.tsx — 閃電下單數量旁的「張·融資」／「口·新倉」
// 快速下拉：常用的委託條件（信用、效期、期貨倉別與市價鈕）、單位與「更多設定…」。
// 清單與停用規則來自下單面板共用的 order-conditions；選了什麼由閃電面板保存。

import { Check, Settings2, ShieldCheck } from 'lucide-react';
import type { FlashCond, FlashCredit, FlashLot, FlashOrderOpts } from '../lib/flash-account';
import { TRIGGER_LIMIT_MAX_TICKS, type FlashTriggerSend } from '../lib/flash-trigger';
import { FUTURES_OCTYPES, ORDER_TYPES, orderTypeDisabledReason } from '../lib/order-conditions';
import { WARRANT_FLASH_TEXT } from '../lib/warrant-rules';
import * as styles from './flash-order.css';

const CREDIT_ITEMS: [FlashCond, string, string][] = [
    ['Cash', '現股', '預設'],
    ['MarginTrading', '融資', '買／賣'],
    ['ShortSelling', '融券', '只能賣'],
    ['SBLShort', '借券', '只能賣'],
    ['SBLShortPriceExempt', '借券豁免', '只能賣'],
];

function Seg<T extends string>({ label, items, value, disabled, onPick }: {
    label: string;
    items: readonly { value: T; label: string; title?: string; disabled?: boolean }[];
    value: T;
    disabled?: string | null;
    onPick: (v: T) => void;
}) {
    return (
        <div className={styles.menuSegRow} role='group' aria-label={label}>
            <span className={styles.menuSegLabel}>{label}</span>
            {items.map(it => (
                <button
                    key={it.value}
                    type='button'
                    role='menuitemradio'
                    aria-checked={value === it.value}
                    disabled={it.disabled}
                    title={it.title ?? (it.disabled ? disabled ?? undefined : undefined)}
                    className={styles.menuSegBtn[value === it.value ? 'on' : 'off']}
                    onClick={() => { if (!it.disabled) onPick(it.value); }}
                >
                    {it.label}
                </button>
            ))}
        </div>
    );
}

export function FlashQuickMenu({ market, odd, warrant = false, lot, credit, order, dayTradeOk, top, onCredit, onLot, onOrder, onMore, onClose, triggerSend, onTriggerSend, triggerLayout, onTriggerLayout, onProtect }: {
    market: 'S' | 'F';
    odd: boolean;
    /** 權證：只有整張現股，不顯示信用與零股選項 */
    warrant?: boolean;
    lot: FlashLot;
    /** the panel's saved credit (shown even while odd lots suspend it) */
    credit: FlashCredit;
    /** the panel's saved order conditions */
    order: FlashOrderOpts;
    dayTradeOk: boolean;
    top?: number;
    onCredit: (c: FlashCredit) => void;
    onLot: (l: FlashLot) => void;
    onOrder: (o: FlashOrderOpts) => void;
    onMore: () => void;
    onClose: () => void;
    /** #216 觸價單觸發後的送出方式 */
    triggerSend?: FlashTriggerSend;
    onTriggerSend?: (s: FlashTriggerSend) => void;
    /** #216 觸價單的點法 */
    triggerLayout?: 'columns' | 'modifier';
    onTriggerLayout?: (l: 'columns' | 'modifier') => void;
    /** opens the 自動停損停利 editor */
    onProtect?: () => void;
}) {
    const pick = (fn: () => void) => () => { fn(); onClose(); };
    const oddOrderType = orderTypeDisabledReason('IOC', odd);
    return (
        <>
            <div className={styles.menuBackdrop} onClick={onClose} />
            <div className={styles.unitMenu} role='menu' aria-label='單位與委託條件' style={top !== undefined ? { top } : undefined}>
                {market === 'S' && warrant && (
                    <>
                        <div className={styles.menuNote} data-testid='flash-warrant-note'>權證只能以整張（1 張 = 1,000 單位）現股買賣：不得零股交易，不適用融資、融券或現股當沖先賣。</div>
                        <div className={styles.menuSep} />
                    </>
                )}
                {market === 'S' && !warrant && (
                    <>
                        {CREDIT_ITEMS.map(([cond, name, desc]) => {
                            const on = !odd && credit.cond === cond && !(cond === 'Cash' && credit.daytradeShort);
                            return (
                                <button
                                    key={cond}
                                    type='button'
                                    role='menuitemradio'
                                    aria-checked={on}
                                    disabled={odd}
                                    title={cond === 'SBLShort' ? '一般借券賣出（委託類別5）' : cond === 'SBLShortPriceExempt' ? '價格豁免借券賣出（委託類別6，特殊金融商品適用）' : undefined}
                                    className={styles.menuItem[on ? 'on' : 'off']}
                                    onClick={() => { if (odd) return; onCredit({ cond, daytradeShort: false }); onClose(); }}
                                >
                                    {name}<span className={styles.menuDesc}>{desc}</span>
                                    {on && <Check size={11} aria-hidden />}
                                </button>
                            );
                        })}
                        <div className={styles.menuSep} />
                        <button
                            type='button'
                            role='menuitemcheckbox'
                            aria-checked={!odd && credit.daytradeShort}
                            disabled={odd}
                            className={styles.menuItem[!odd && credit.daytradeShort ? 'on' : 'off']}
                            title={dayTradeOk ? '現股當沖先賣：點賣為現沖賣出，當日需回補' : '此股票目前不可現沖先賣；設定保留，換到可當沖的股票時生效'}
                            // 只限現股：勾選時信用條件一起改回現股
                            onClick={() => { if (odd) return; onCredit({ cond: 'Cash', daytradeShort: !credit.daytradeShort }); onClose(); }}
                        >
                            現股當沖先賣<span className={styles.menuDesc}>只限現股</span>
                            {!odd && credit.daytradeShort && <Check size={11} aria-hidden />}
                        </button>
                        {odd && <div className={styles.menuNote}>零股只能以現股買賣，不能融資、融券或當沖；切回整股時恢復這個面板的信用設定。</div>}
                        <div className={styles.menuSep} />
                    </>
                )}
                <Seg
                    label='效期'
                    items={ORDER_TYPES.map(t => ({ value: t, label: t, disabled: !!orderTypeDisabledReason(t, odd) }))}
                    value={odd ? 'ROD' : order.orderType}
                    disabled={oddOrderType}
                    onPick={orderType => { onOrder({ ...order, orderType }); onClose(); }}
                />
                {odd && <div className={styles.menuNote}>{oddOrderType}；切回整股時恢復。</div>}
                {market === 'F' && (
                    <>
                        <Seg
                            label='倉別'
                            items={FUTURES_OCTYPES}
                            value={order.octype}
                            onPick={octype => { onOrder({ ...order, octype }); onClose(); }}
                        />
                        <Seg
                            label='市價鈕'
                            items={[{ value: 'MKT', label: '市價' }, { value: 'MKP', label: '範圍市價', title: '一定範圍市價（MKP），IOC' }] as const}
                            value={order.futuresPriceType}
                            onPick={futuresPriceType => { onOrder({ ...order, futuresPriceType }); onClose(); }}
                        />
                    </>
                )}
                <div className={styles.menuNote}>效期用於點價的限價單；市價鈕一律 IOC。</div>
                {triggerSend && onTriggerSend && (
                    <>
                        <Seg
                            label='觸價後'
                            items={[
                                { value: 'MKT', label: market === 'F' && order.futuresPriceType === 'MKP' ? '範圍市價' : '市價', disabled: odd },
                                { value: 'LMT', label: '限價', disabled: odd, title: '觸發價往成交方向 N 檔的限價（買＋N、賣－N），ROD' },
                            ] as const}
                            value={triggerSend.type}
                            disabled={odd ? '零股觸價單以漲跌停價限價送出' : null}
                            onPick={type => onTriggerSend(type === 'LMT' ? { type: 'LMT', ticks: triggerSend.type === 'LMT' ? triggerSend.ticks : 2 } : { type: 'MKT' })}
                        />
                        {triggerSend.type === 'LMT' && !odd && (
                            <div className={styles.menuSegRow} role='group' aria-label='觸價後限價檔數'>
                                <span className={styles.menuSegLabel}>檔數</span>
                                <button type='button' className={styles.menuSegBtn.off} aria-label='減一檔'
                                    disabled={triggerSend.ticks <= 0} onClick={() => onTriggerSend({ type: 'LMT', ticks: Math.max(0, triggerSend.ticks - 1) })}>−</button>
                                <span className={styles.menuDesc}>觸發價 ± {triggerSend.ticks} 檔</span>
                                <button type='button' className={styles.menuSegBtn.off} aria-label='加一檔'
                                    disabled={triggerSend.ticks >= TRIGGER_LIMIT_MAX_TICKS} onClick={() => onTriggerSend({ type: 'LMT', ticks: Math.min(TRIGGER_LIMIT_MAX_TICKS, triggerSend.ticks + 1) })}>＋</button>
                            </div>
                        )}
                        {triggerLayout && onTriggerLayout && (
                            <Seg
                                label='觸價點法'
                                items={[
                                    { value: 'columns', label: '觸價欄', title: '梯形最外側多兩欄「觸買／觸賣」，點那一欄掛觸價單' },
                                    { value: 'modifier', label: 'Alt＋點', title: '不加欄位（窄面板適用）：按住 Alt（Option）點買量／賣量掛觸價單' },
                                ] as const}
                                value={triggerLayout}
                                onPick={l => { onTriggerLayout(l); onClose(); }}
                            />
                        )}
                        <div className={styles.menuNote}>{odd ? '零股觸價單以漲跌停價限價送出。' : '觸價單觸發後的送出方式；點買量／賣量照常是限價。'}</div>
                    </>
                )}
                {market === 'S' && warrant && (
                    <div className={styles.menuNote} data-testid='flash-warrant-trigger-note'>{WARRANT_FLASH_TEXT.menu}。</div>
                )}
                {onProtect && (
                    <>
                        <div className={styles.menuSep} />
                        <button type='button' role='menuitem' className={styles.menuItem.off} onClick={() => { onClose(); onProtect(); }}>
                            <ShieldCheck size={11} aria-hidden />自動停損停利…
                        </button>
                    </>
                )}
                {market === 'S' && !warrant && (
                    <>
                        <div className={styles.menuSep} />
                        {([['Common', '張（整股）'], ['IntradayOdd', '股（盤中零股）']] as [FlashLot, string][]).map(([l, name]) => (
                            <button
                                key={l}
                                type='button'
                                role='menuitemradio'
                                aria-checked={lot === l}
                                className={styles.menuItem[lot === l ? 'on' : 'off']}
                                onClick={pick(() => { if (l !== lot) onLot(l); })}
                            >
                                {name}
                                {lot === l && <Check size={11} aria-hidden />}
                            </button>
                        ))}
                    </>
                )}
                <div className={styles.menuSep} />
                <button type='button' role='menuitem' className={styles.menuItem.off} onClick={pick(onMore)}>
                    <Settings2 size={11} aria-hidden />更多設定…
                </button>
                <div className={styles.menuNote}>切換後自動解除「點價即下單」。</div>
            </div>
        </>
    );
}
