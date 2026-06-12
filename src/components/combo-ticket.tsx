// src/components/combo-ticket.tsx — 期貨/選擇權組合單 (spread/straddle).
// Two legs with live synthetic pricing from each leg's book (issue #1):
// buying the combo lifts the Buy legs' asks and hits the Sell legs' bids,
// so 合成買價 = Σ(±bid/ask) accordingly. Working combos listed with cancel.

import { Crosshair, Link2, Lock, Unlock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TICKET_ACTION_EVENT } from '../hooks/use-hotkeys';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import { usePoll } from '../hooks/use-poll';
import { ensureContract } from '../lib/contracts-cache';
import { useOptionLegPick } from '../lib/option-pick';
import {
    cancelComboOrder,
    fetchComboTrades,
    placeComboOrder,
    subscribeQuote,
    type ComboLeg,
    type ComboTrade,
} from '../lib/shioaji';
import { assertTradingLive, notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './order-ticket.css';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';

interface LegState {
    input: string;
    contract: ContractInfo | null;
    action: 'Buy' | 'Sell';
    error: boolean;
    locked: boolean; // 連動模式下鎖定的腳不被 T 字點擊覆寫
}

const EMPTY_LEG: LegState = {
    input: '',
    contract: null,
    action: 'Buy',
    error: false,
    locked: false,
};

function LegQuote({
    contract,
    action,
}: {
    contract: ContractInfo;
    action: 'Buy' | 'Sell';
}) {
    const quote = useQuote(contract.code);
    const ba = quote?.bidask;
    const bid = ba ? Number(ba.bid_price[0]) : undefined;
    const ask = ba ? Number(ba.ask_price[0]) : undefined;
    return (
        <span className={styles.costRow}>
            {contract.name}｜買 {fmtPrice(bid)}／賣 {fmtPrice(ask)}
            {action === 'Buy' ? '（付賣價）' : '（收買價）'}
        </span>
    );
}

// net synthetic level-1 for the combo from both legs' books
function useSynthetic(legs: LegState[]) {
    const q0 = useQuote(legs[0]?.contract?.code ?? null);
    const q1 = useQuote(legs[1]?.contract?.code ?? null);
    const quotes = [q0, q1];
    let bid = 0;
    let ask = 0;
    let complete = true;
    legs.forEach((leg, i) => {
        const ba = quotes[i]?.bidask;
        const b = ba ? Number(ba.bid_price[0]) : NaN;
        const a = ba ? Number(ba.ask_price[0]) : NaN;
        if (!leg.contract || !Number.isFinite(b) || !Number.isFinite(a)) {
            complete = false;
            return;
        }
        if (leg.action === 'Buy') {
            ask += a; // buying the combo pays this leg's ask
            bid += b;
        } else {
            ask -= b; // selling leg receives its bid
            bid -= a;
        }
    });
    return complete
        ? { bid: Number(bid.toFixed(2)), ask: Number(ask.toFixed(2)) }
        : null;
}

const ACTIVE_COMBO = new Set(['PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled']);

export function ComboTicket() {
    const [legs, setLegs] = useState<LegState[]>([
        { ...EMPTY_LEG },
        { ...EMPTY_LEG, action: 'Sell' },
    ]);
    const [action, setAction] = useState<'Buy' | 'Sell'>('Buy');
    const [price, setPrice] = useState('');
    const [qty, setQty] = useState(1);
    const [armed, setArmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [orderType, setOrderType] = useState<'IOC' | 'FOK' | 'ROD'>('IOC');
    const [linkChain, setLinkChain] = useState(false); // 連動 T 字
    const live = useTradingLive();
    const optPick = useOptionLegPick();

    const tradesPoll = usePoll<ComboTrade[]>(
        useCallback(() => fetchComboTrades().catch(() => []), []),
        10000,
    );

    // 到價監控 (issue #2): combos only fill IOC, so watch the synthetic
    // book and fire when it crosses the target — bounded attempts +
    // cooldown so a flickering quote can't machine-gun orders
    const [watchOn, setWatchOn] = useState(false);
    const [watchPrice, setWatchPrice] = useState('');
    const [attempts, setAttempts] = useState(0);
    const watchRef = useRef({ lastFire: 0, firing: false });
    const MAX_ATTEMPTS = 3;
    const COOLDOWN_MS = 5000;

    const setLeg = (i: number, patch: Partial<LegState>) =>
        setLegs((prev) =>
            prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
        );

    const resolveCode = async (i: number, raw: string) => {
        const code = raw.trim().toUpperCase();
        if (!code) return;
        try {
            const c = await ensureContract(code);
            if (c.security_type !== 'FUT' && c.security_type !== 'OPT') {
                throw new Error('組合單只支援期貨/選擇權');
            }
            setLeg(i, { contract: c, error: false, input: c.code });
            await Promise.allSettled([
                subscribeQuote(c, 'Tick'),
                subscribeQuote(c, 'BidAsk'),
            ]);
        } catch {
            setLeg(i, { contract: null, error: true });
        }
    };
    const resolveLeg = (i: number) => resolveCode(i, legs[i]!.input);

    // 連動 T 字 (issue #1): a click in the 選擇權 T 字 fills the next
    // unlocked leg, alternating — lock a leg to pin it while you pick the
    // other. Refs avoid re-subscribing the picker on every leg edit.
    const legsRef = useRef(legs);
    legsRef.current = legs;
    useEffect(() => {
        if (!linkChain || !optPick) return;
        const cur = legsRef.current;
        // prefer an empty unlocked leg, else the first unlocked leg
        let target = cur.findIndex((l) => !l.locked && !l.contract);
        if (target < 0) target = cur.findIndex((l) => !l.locked);
        if (target < 0) return; // both locked
        void resolveCode(target, optPick.code);
        setArmed(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [optPick?.seq, linkChain]);

    const synth = useSynthetic(legs);
    // autofill price from synthetic mid until the user edits it
    const [priceTouched, setPriceTouched] = useState(false);
    useEffect(() => {
        if (!priceTouched && synth) {
            setPrice(((synth.bid + synth.ask) / 2).toFixed(0));
        }
    }, [synth, priceTouched]);

    const ready = legs.every((l) => l.contract);
    const hasOpt = legs.some((l) => l.contract?.security_type === 'OPT');
    const allFut =
        ready && legs.every((l) => l.contract?.security_type === 'FUT');
    // FOK valid for any TAIFEX combo; ROD (resting / 芭樂價) only for futures
    const orderTypes: ('IOC' | 'FOK' | 'ROD')[] = allFut
        ? ['IOC', 'FOK', 'ROD']
        : ['IOC', 'FOK'];
    // keep the selected order type valid as legs change
    useEffect(() => {
        if (!orderTypes.includes(orderType)) setOrderType('IOC');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allFut, hasOpt]);

    // B/S hotkeys switch the combo direction (issue #1 — was inert here)
    useEffect(() => {
        const onAction = (e: Event) => {
            const a = (e as CustomEvent).detail?.action;
            if (a === 'Buy' || a === 'Sell') {
                setAction(a);
                setArmed(false);
            }
        };
        window.addEventListener(TICKET_ACTION_EVENT, onAction);
        return () => window.removeEventListener(TICKET_ACTION_EVENT, onAction);
    }, []);

    // watcher: buy when the synthetic ASK drops to target; sell when the
    // synthetic BID rises to target
    useEffect(() => {
        if (!watchOn || !synth || !ready) return;
        const target = Number(watchPrice);
        if (!Number.isFinite(target)) return;
        const hit =
            action === 'Buy' ? synth.ask <= target : synth.bid >= target;
        if (!hit) return;
        const w = watchRef.current;
        if (w.firing || Date.now() - w.lastFire < COOLDOWN_MS) return;
        if (attempts >= MAX_ATTEMPTS) {
            setWatchOn(false);
            notify({
                kind: 'info',
                title: '🎯 到價監控停止',
                body: `已達 ${MAX_ATTEMPTS} 次嘗試上限，請確認成交狀況`,
            });
            return;
        }
        w.firing = true;
        w.lastFire = Date.now();
        setAttempts((a) => a + 1);
        (async () => {
            try {
                const legReqs: ComboLeg[] = legs.map((l) => ({
                    action: l.action,
                    security_type: l.contract!.security_type,
                    exchange: l.contract!.exchange,
                    code: l.contract!.code,
                    target_code: l.contract!.target_code ?? null,
                }));
                const trade = await placeComboOrder(legReqs, {
                    action,
                    price: target,
                    quantity: qty,
                    price_type: 'LMT',
                    order_type: 'IOC',
                    octype: 'Auto',
                });
                notify({
                    kind: 'ok',
                    title: `🎯 到價觸發第 ${attempts + 1} 次`,
                    body: `組合 ${action === 'Buy' ? '買' : '賣'} ${qty} @ ${target}（${trade.status.status}）— 請確認成交，避免重複下單`,
                });
                tradesPoll.refresh();
            } catch (e) {
                notify({
                    kind: 'err',
                    title: '到價下單失敗',
                    body: e instanceof Error ? e.message : String(e),
                });
            } finally {
                watchRef.current.firing = false;
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [synth, watchOn, watchPrice, action, qty, ready, attempts]);

    // disarm the watcher when legs change
    useEffect(() => {
        setWatchOn(false);
        setAttempts(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [legs.map((l) => `${l.action}${l.contract?.code}`).join('|')]);

    const execute = async () => {
        if (!armed) {
            setArmed(true);
            return;
        }
        setArmed(false);
        if (!ready) return;
        setBusy(true);
        try {
            assertTradingLive();
            const legReqs: ComboLeg[] = legs.map((l) => ({
                action: l.action,
                security_type: l.contract!.security_type,
                exchange: l.contract!.exchange,
                code: l.contract!.code,
                target_code: l.contract!.target_code ?? null,
            }));
            const p = Number(price);
            const trade = await placeComboOrder(legReqs, {
                action,
                price: Number.isFinite(p) ? p : 0,
                quantity: qty,
                price_type: 'LMT',
                order_type: orderType,
                octype: 'Auto',
            });
            notify({
                kind: 'ok',
                title: '🧩 組合單已送出',
                body: `${trade.status.status} #${trade.order.seqno || trade.order.id.slice(0, 8)}`,
            });
            tradesPoll.refresh();
        } catch (e) {
            notify({
                kind: 'err',
                title: '組合單失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        } finally {
            setBusy(false);
        }
    };

    const doCancel = async (t: ComboTrade) => {
        try {
            await cancelComboOrder(t.order.id);
            notify({ kind: 'ok', title: '🗑 組合刪單已送出', body: t.order.id });
        } catch (e) {
            notify({
                kind: 'err',
                title: '組合刪單失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        }
        tradesPoll.refresh();
    };

    const working = (tradesPoll.data ?? []).filter((t) =>
        ACTIVE_COMBO.has(t.status.status),
    );

    return (
        <div className={styles.body}>
            <div className={styles.fieldRow}>
                <button
                    className={styles.iconToggle[linkChain ? 'on' : 'off']}
                    title='連動選擇權 T 字：點 T 字報價自動填入未鎖定的腳'
                    onClick={() => setLinkChain((v) => !v)}
                    style={{ width: 'auto', padding: '2px 8px', gap: '4px' }}
                >
                    <Link2 size={11} /> 連動 T 字
                </button>
                {linkChain && (
                    <span className={styles.costRow} style={{ margin: 0 }}>
                        點 T 字填入未鎖定的腳，交替填兩腳
                    </span>
                )}
            </div>
            {legs.map((leg, i) => (
                <div key={i}>
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>腳 {i + 1}</span>
                        <div className={styles.segGroup} style={{ flex: '0 0 auto' }}>
                            {(['Buy', 'Sell'] as const).map((a) => (
                                <button
                                    key={a}
                                    className={styles.seg[leg.action === a ? 'on' : 'off']}
                                    onClick={() => {
                                        setLeg(i, { action: a });
                                        setArmed(false);
                                    }}
                                >
                                    {a === 'Buy' ? '買' : '賣'}
                                </button>
                            ))}
                        </div>
                        <input
                            className={styles.numInput}
                            placeholder='代碼 如 TXFF6 / TX417000C6'
                            value={leg.input}
                            style={leg.error ? { borderColor: 'var(--danger, #f23645)' } : undefined}
                            onChange={(e) => setLeg(i, { input: e.target.value, contract: null })}
                            onKeyDown={(e) => e.key === 'Enter' && resolveLeg(i)}
                            onBlur={() => resolveLeg(i)}
                        />
                        {linkChain && (
                            <button
                                className={styles.iconToggle[leg.locked ? 'on' : 'off']}
                                title={leg.locked ? '已鎖定（T 字點擊不覆寫）' : '鎖定此腳'}
                                onClick={() => setLeg(i, { locked: !leg.locked })}
                            >
                                {leg.locked ? (
                                    <Lock size={11} />
                                ) : (
                                    <Unlock size={11} />
                                )}
                            </button>
                        )}
                    </div>
                    {leg.contract && (
                        <LegQuote contract={leg.contract} action={leg.action} />
                    )}
                </div>
            ))}

            {synth && (
                <span className={styles.costRow}>
                    合成報價｜
                    <span className={panel.dirText.up}>
                        {' '}買 {fmtPrice(synth.bid)}{' '}
                    </span>
                    ／
                    <span className={panel.dirText.down}>
                        {' '}賣 {fmtPrice(synth.ask)}{' '}
                    </span>
                    ｜中價 {fmtPrice((synth.bid + synth.ask) / 2)}
                </span>
            )}

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>組合</span>
                <div className={styles.segGroup}>
                    {(['Buy', 'Sell'] as const).map((a) => (
                        <button
                            key={a}
                            className={styles.seg[action === a ? 'on' : 'off']}
                            onClick={() => {
                                setAction(a);
                                setArmed(false);
                            }}
                        >
                            {a === 'Buy' ? '買進組合' : '賣出組合'}
                        </button>
                    ))}
                </div>
            </div>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>淨價</span>
                <input
                    className={styles.numInput}
                    value={price}
                    inputMode='decimal'
                    onChange={(e) => {
                        setPriceTouched(true);
                        setPrice(e.target.value);
                        setArmed(false);
                    }}
                />
                <span className={styles.fieldLabel}>量</span>
                <input
                    className={styles.numInput}
                    value={qty}
                    inputMode='numeric'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 1) setQty(v);
                    }}
                />
            </div>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>條件</span>
                <div className={styles.segGroup}>
                    {orderTypes.map((ot) => (
                        <button
                            key={ot}
                            className={styles.seg[orderType === ot ? 'on' : 'off']}
                            onClick={() => {
                                setOrderType(ot);
                                setArmed(false);
                            }}
                            title={
                                ot === 'IOC'
                                    ? '立即成交否則取消'
                                    : ot === 'FOK'
                                      ? '全部成交否則取消'
                                      : '掛單等候（可掛芭樂價）'
                            }
                        >
                            {ot}
                        </button>
                    ))}
                </div>
            </div>

            <button
                className={styles.execBtn[armed ? 'armed' : action === 'Buy' ? 'buy' : 'sell']}
                disabled={busy || !ready || !live}
                onClick={execute}
            >
                {!live
                    ? '⚠ 行情未連線，暫停下單'
                    : busy
                      ? '傳送中…'
                      : armed
                        ? `確認${action === 'Buy' ? '買進' : '賣出'}組合 ${qty} @ ${price}（LMT/${orderType}）`
                        : ready
                          ? `${action === 'Buy' ? '買進' : '賣出'}組合下單`
                          : '先輸入兩腳合約代碼'}
            </button>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>到價</span>
                <input
                    className={styles.numInput}
                    placeholder='目標淨價'
                    value={watchPrice}
                    inputMode='decimal'
                    disabled={watchOn}
                    onChange={(e) => setWatchPrice(e.target.value)}
                />
                <button
                    className={styles.seg[watchOn ? 'on' : 'off']}
                    disabled={!ready || !watchPrice}
                    title={`合成${action === 'Buy' ? '賣價跌至' : '買價漲至'}目標時自動送 IOC（最多 ${MAX_ATTEMPTS} 次，間隔 ${COOLDOWN_MS / 1000}s）`}
                    onClick={() => {
                        setAttempts(0);
                        setWatchOn((v) => !v);
                    }}
                >
                    {watchOn ? (
                        <>
                            <Crosshair size={10} style={{ verticalAlign: '-1px' }} />{' '}
                            監控中 {attempts}/{MAX_ATTEMPTS}
                        </>
                    ) : (
                        '啟動監控'
                    )}
                </button>
            </div>
            {watchOn && (
                <span className={styles.costRow}>
                    <span className={panel.dirText.up}>
                        ⚠ 到價會自動送單：IOC 可能部分成交後再次觸發，請盯緊成交回報避免重複部位
                    </span>
                </span>
            )}

            {working.length > 0 && (
                <>
                    <span className={styles.fieldLabel}>在途組合單</span>
                    {working.map((t) => (
                        <span key={t.order.id} className={styles.costRow}>
                            {t.order.action === 'Buy' ? '買' : '賣'}{' '}
                            {t.contract.legs
                                .map((l) => `${l.action === 'Buy' ? '+' : '−'}${l.code}`)
                                .join(' ')}{' '}
                            {t.order.quantity} @ {fmtPrice(t.order.price)}（
                            {t.status.status}）{' '}
                            <button
                                className={dock.cancelBtn}
                                onClick={() => void doCancel(t)}
                            >
                                刪單
                            </button>
                        </span>
                    ))}
                </>
            )}
        </div>
    );
}
