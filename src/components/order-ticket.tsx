// src/components/order-ticket.tsx — buy/sell ticket with two-step EXECUTE.
// Stock vs futures aware; price autofills from the live quote.

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TICKET_ACTION_EVENT } from '../hooks/use-hotkeys';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import {
    type AllocPreset,
    allocateByRatio,
    deleteAllocPreset,
    loadAllocPresets,
    saveAllocPreset,
} from '../lib/allocation';
import { registerBracket } from '../lib/bracket';
import { usePickedPrice } from '../lib/price-sync';
import { maskAccountId, maskName, usePrivacyMode } from '../lib/privacy';
import { selectAccount, useAccounts } from '../lib/account-store';
import { checkOrderAllowed } from '../lib/risk';
import { fetchInfo, placeFuturesOrder, placeStockOrder } from '../lib/shioaji';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Account } from '../lib/types/portfolio';
import type {
    Action,
    FuturesOCType,
    OrderType,
    StockOrderCond,
    StockOrderLot,
} from '../lib/types/order';
import {
    contractMultiplier,
    futuresTaxRate,
    stockTaxRate,
} from '../lib/utils/contract-cost';
import { fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './order-ticket.css';

const acctKey = (a: Account) => `${a.broker_id}-${a.account_id}`;

export function OrderTicket({
    contract,
    onPlaced,
}: {
    contract: ContractInfo;
    onPlaced: () => void;
}) {
    const isFutures =
        contract.security_type === 'FUT' || contract.security_type === 'OPT';
    const quote = useQuote(contract.code);
    const live = useTradingLive();

    const [action, setAction] = useState<Action>('Buy');
    const [price, setPrice] = useState('');
    const [qty, setQty] = useState(1);
    const [priceType, setPriceType] = useState('LMT');
    const [orderType, setOrderType] = useState<OrderType>('ROD');
    const [orderLot, setOrderLot] = useState<StockOrderLot>('Common');
    const [orderCond, setOrderCond] = useState<StockOrderCond>('Cash');
    const [octype, setOctype] = useState<FuturesOCType>('Auto');
    const [daytradeShort, setDaytradeShort] = useState(false);
    const [armed, setArmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [bracketOn, setBracketOn] = useState(false);
    const [stopPrice, setStopPrice] = useState('');
    const [takePrice, setTakePrice] = useState('');
    const [feedback, setFeedback] = useState<{
        kind: 'ok' | 'err';
        text: string;
    } | null>(null);
    const priceTouched = useRef(false);

    // ---- multi-account: chip + split-order (分倉) state ----
    const [acctMenuOpen, setAcctMenuOpen] = useState(false);
    const chipRef = useRef<HTMLDivElement>(null);
    const [simulation, setSimulation] = useState<boolean | null>(null);
    const [splitOpen, setSplitOpen] = useState(false);
    const [splitMode, setSplitMode] = useState<'ratio' | 'fixed'>('ratio');
    const [ratios, setRatios] = useState<Record<string, string>>({});
    const [fixedQty, setFixedQty] = useState<Record<string, string>>({});
    const [splitArmed, setSplitArmed] = useState(false);
    const [splitBusy, setSplitBusy] = useState(false);
    const [presets, setPresets] = useState<AllocPreset[]>(() =>
        loadAllocPresets(),
    );
    const [presetSel, setPresetSel] = useState('');
    const [presetName, setPresetName] = useState('');

    // reset on symbol change — split state deliberately collapses too
    // (never persisted: a forgotten split from last time must not fire)
    useEffect(() => {
        setPrice('');
        priceTouched.current = false;
        setArmed(false);
        setFeedback(null);
        setPriceType('LMT');
        setOrderType('ROD');
        setOrderLot('Common');
        setOrderCond('Cash');
        setOctype('Auto');
        setDaytradeShort(false);
        setBracketOn(false);
        setStopPrice('');
        setTakePrice('');
        setSplitOpen(false);
        setSplitArmed(false);
        setAcctMenuOpen(false);
    }, [contract.code]);

    // 正式環境判斷：chip 上的 danger 視覺（下錯戶的最後防線）
    useEffect(() => {
        let alive = true;
        fetchInfo()
            .then((i) => {
                if (alive) setSimulation(i.simulation);
            })
            .catch(() => {
                if (alive) setSimulation(null);
            });
        return () => {
            alive = false;
        };
    }, []);

    // click outside closes the account menu
    useEffect(() => {
        if (!acctMenuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (!chipRef.current?.contains(e.target as Node)) {
                setAcctMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [acctMenuOpen]);

    // any order-parameter change de-arms the split confirm step.
    // `price` is deliberately NOT a dep: the live-quote autofill mutates it
    // every tick and would make the confirm step impossible to reach on an
    // active market — manual price edits de-arm via the input's onChange.
    useEffect(() => {
        setSplitArmed(false);
    }, [
        action,
        qty,
        priceType,
        orderType,
        orderLot,
        orderCond,
        octype,
        splitMode,
        ratios,
        fixedQty,
    ]);

    // B/S hotkeys switch action
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

    // 融券/借券類條件為賣出限定 — 切回買進時歸位
    useEffect(() => {
        if (
            action === 'Buy' &&
            orderCond !== 'Cash' &&
            orderCond !== 'MarginTrading'
        ) {
            setOrderCond('Cash');
        }
    }, [action, orderCond]);

    // autofill price from live quote until user edits it
    const liveClose = quote?.tick?.close;
    useEffect(() => {
        if (!priceTouched.current && liveClose) {
            setPrice(String(Number(liveClose)));
        }
    }, [liveClose]);

    // price picked from chart hover/click or depth ladder (same symbol only)
    const picked = usePickedPrice(contract.code);
    useEffect(() => {
        if (picked) {
            priceTouched.current = true;
            setPrice(String(picked.price));
            setArmed(false);
        }
    }, [picked]);

    const execute = async () => {
        if (!armed) {
            setArmed(true);
            setFeedback(null);
            return;
        }
        setArmed(false);
        setBusy(true);
        try {
            const blocked = checkOrderAllowed(qty);
            if (blocked) throw new Error(blocked);
            const p = priceType === 'LMT' ? Number(price) : 0;
            if (priceType === 'LMT' && (!Number.isFinite(p) || p <= 0)) {
                throw new Error('限價單需要有效價格');
            }
            const trade = isFutures
                ? await placeFuturesOrder(contract, {
                      action,
                      price: p,
                      quantity: qty,
                      price_type: priceType as 'LMT' | 'MKT' | 'MKP',
                      order_type: orderType,
                      octype,
                  })
                : await placeStockOrder(contract, {
                      action,
                      price: p,
                      quantity: qty,
                      price_type: priceType as 'LMT' | 'MKT',
                      order_type: orderType,
                      order_lot: orderLot,
                      order_cond:
                          orderCond !== 'Cash' ? orderCond : undefined,
                      daytrade_short:
                          action === 'Sell' &&
                          daytradeShort &&
                          orderCond === 'Cash'
                              ? true
                              : undefined,
                  });
            setFeedback({
                kind: 'ok',
                text: `▸ ${trade.status.status} #${trade.order.seqno || trade.order.id.slice(0, 8)}`,
            });
            if (bracketOn) {
                const sp = Number(stopPrice);
                const tp = Number(takePrice);
                registerBracket({
                    orderId: trade.order.id,
                    seqno: trade.order.seqno,
                    code: contract.code,
                    action,
                    quantity: qty,
                    stopPrice: Number.isFinite(sp) && sp > 0 ? sp : null,
                    takePrice: Number.isFinite(tp) && tp > 0 ? tp : null,
                    accountType: isFutures ? 'F' : 'S',
                });
            }
            onPlaced();
        } catch (e) {
            setFeedback({
                kind: 'err',
                text: `✕ ${e instanceof Error ? e.message : String(e)}`,
            });
        } finally {
            setBusy(false);
        }
    };

    const qtyUnit = isFutures ? '口' : orderLot === 'IntradayOdd' ? '股' : '張';
    const { accounts, selectedStock, selectedFutures } = useAccounts();
    const priv = usePrivacyMode();
    const activeAccount = isFutures ? selectedFutures : selectedStock;
    const acctTag = isFutures ? '[期]' : '[證]';
    // same-type SIGNED accounts are the routing candidates（未簽署不可下單）
    const routable = accounts.filter(
        (a) => a.signed && a.account_type === (isFutures ? 'F' : 'S'),
    );
    const multi = routable.length >= 2;
    const production = simulation === false;

    // ---- split allocation（比例＝largest remainder；固定＝直接數量）----
    const ratioSum = routable.reduce(
        (s, a) => s + (Number(ratios[acctKey(a)]) || 0),
        0,
    );
    let allocation: { account: Account; qty: number }[];
    let splitTotal: number;
    let splitValid: boolean;
    if (splitMode === 'ratio') {
        const weights = routable.map((a) => Number(ratios[acctKey(a)]) || 0);
        const qs = allocateByRatio(qty, weights);
        allocation = routable
            .map((account, i) => ({ account, qty: qs[i] ?? 0 }))
            .filter((e) => e.qty > 0);
        splitTotal = qty;
        splitValid =
            Math.abs(ratioSum - 100) < 1e-9 &&
            qty >= 1 &&
            allocation.length > 0;
    } else {
        allocation = routable
            .map((account) => {
                const v = Number(fixedQty[acctKey(account)]);
                return {
                    account,
                    qty: Number.isInteger(v) && v > 0 ? v : 0,
                };
            })
            .filter((e) => e.qty > 0);
        splitTotal = allocation.reduce((s, e) => s + e.qty, 0);
        splitValid = splitTotal >= 1;
    }

    const openSplit = () => {
        setSplitOpen((open) => {
            if (!open && routable.every((a) => !ratios[acctKey(a)])) {
                // first open: prefill an even整數 split summing to 100
                const base = Math.floor(100 / routable.length);
                const extra = 100 - base * routable.length;
                setRatios(
                    Object.fromEntries(
                        routable.map((a, i) => [
                            acctKey(a),
                            String(base + (i < extra ? 1 : 0)),
                        ]),
                    ),
                );
            }
            return !open;
        });
        setSplitArmed(false);
        setArmed(false);
    };

    const executeSplit = async () => {
        if (!splitArmed) {
            setSplitArmed(true);
            setFeedback(null);
            return;
        }
        setSplitArmed(false);
        setSplitBusy(true);
        try {
            if (!splitValid || allocation.length === 0) {
                throw new Error('分倉設定無效');
            }
            const p = priceType === 'LMT' ? Number(price) : 0;
            if (priceType === 'LMT' && (!Number.isFinite(p) || p <= 0)) {
                throw new Error('限價單需要有效價格');
            }
            const ok: string[] = [];
            const fail: string[] = [];
            // 逐戶送出（sequential — deterministic order, per-order risk）
            for (const { account, qty: q } of allocation) {
                const label = `${account.broker_id}-${maskAccountId(account.account_id, priv)}`;
                const blocked = checkOrderAllowed(q);
                if (blocked) {
                    fail.push(`${label}: ${blocked}`);
                    continue;
                }
                try {
                    const trade = isFutures
                        ? await placeFuturesOrder(
                              contract,
                              {
                                  action,
                                  price: p,
                                  quantity: q,
                                  price_type: priceType as
                                      | 'LMT'
                                      | 'MKT'
                                      | 'MKP',
                                  order_type: orderType,
                                  octype,
                              },
                              account,
                          )
                        : await placeStockOrder(
                              contract,
                              {
                                  action,
                                  price: p,
                                  quantity: q,
                                  price_type: priceType as 'LMT' | 'MKT',
                                  order_type: orderType,
                                  order_lot: orderLot,
                                  order_cond:
                                      orderCond !== 'Cash'
                                          ? orderCond
                                          : undefined,
                                  daytrade_short:
                                      action === 'Sell' &&
                                      daytradeShort &&
                                      orderCond === 'Cash'
                                          ? true
                                          : undefined,
                              },
                              account,
                          );
                    ok.push(
                        `${label} ${q}${qtyUnit} #${trade.order.seqno || trade.order.id.slice(0, 8)}`,
                    );
                } catch (e) {
                    fail.push(
                        `${label}: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
            notify({
                kind: fail.length === 0 ? 'ok' : 'err',
                title: `分倉${action === 'Buy' ? '買進' : '賣出'} ${contract.code}`,
                body:
                    `成功 ${ok.length}/${allocation.length} 戶` +
                    (fail.length ? `\n${fail.join('\n')}` : ''),
            });
            setFeedback(
                fail.length === 0
                    ? {
                          kind: 'ok',
                          text: `▸ 分倉完成 ${ok.length}/${allocation.length} 戶`,
                      }
                    : {
                          kind: 'err',
                          text: `✕ 分倉 成功 ${ok.length}/${allocation.length} 戶\n${fail.join('\n')}`,
                      },
            );
            if (ok.length > 0) onPlaced();
        } catch (e) {
            setFeedback({
                kind: 'err',
                text: `✕ ${e instanceof Error ? e.message : String(e)}`,
            });
        } finally {
            setSplitBusy(false);
        }
    };

    if (contract.security_type === 'IND') {
        return (
            <div className={styles.body}>
                <span className={styles.costRow}>
                    指數商品僅提供即時行情與分析，不支援下單
                </span>
            </div>
        );
    }

    return (
        <div className={styles.body}>
                {activeAccount && (
                    <div className={styles.chipRow} ref={chipRef}>
                        <button
                            className={
                                styles.acctChip[
                                    production
                                        ? multi
                                            ? 'dangerMulti'
                                            : 'dangerSingle'
                                        : multi
                                          ? 'multi'
                                          : 'single'
                                ]
                            }
                            onClick={
                                multi
                                    ? () => setAcctMenuOpen((v) => !v)
                                    : undefined
                            }
                            title={`下單帳號 ${maskName(activeAccount.username, priv)}${
                                production ? '（正式環境）' : ''
                            }${multi ? ' — 點擊切換（與帳務查詢同步）' : ''}`}
                        >
                            {acctTag} {activeAccount.broker_id}-
                            {maskAccountId(activeAccount.account_id, priv)}
                            {multi && <ChevronDown size={11} />}
                        </button>
                        {production && (
                            <span className={styles.prodTag}>正式</span>
                        )}
                        {acctMenuOpen && (
                            <div className={styles.acctMenu}>
                                {routable.map((a) => {
                                    const on =
                                        acctKey(a) === acctKey(activeAccount);
                                    return (
                                        <button
                                            key={acctKey(a)}
                                            className={
                                                styles.acctMenuItem[
                                                    on ? 'on' : 'off'
                                                ]
                                            }
                                            onClick={() => {
                                                // 全域切換 — dock/帳務同步
                                                selectAccount(a);
                                                setAcctMenuOpen(false);
                                                setArmed(false);
                                            }}
                                        >
                                            {on ? (
                                                <Check size={11} />
                                            ) : (
                                                <span
                                                    style={{ width: 11 }}
                                                />
                                            )}
                                            {acctTag} {a.broker_id}-
                                            {maskAccountId(a.account_id, priv)}
                                            （{maskName(a.username, priv)}）
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                <div className={styles.sideTabs}>
                    <button
                        className={styles.buyTab[action === 'Buy' ? 'on' : 'off']}
                        onClick={() => {
                            setAction('Buy');
                            setArmed(false);
                        }}
                    >
                        買進 Buy
                    </button>
                    <button
                        className={
                            styles.sellTab[action === 'Sell' ? 'on' : 'off']
                        }
                        onClick={() => {
                            setAction('Sell');
                            setArmed(false);
                        }}
                    >
                        賣出 Sell
                    </button>
                </div>

                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>價格</span>
                    <button
                        className={styles.stepBtn}
                        onClick={() => {
                            priceTouched.current = true;
                            setPrice((p) =>
                                String(
                                    Math.max(0, Number(p || 0) - 1),
                                ),
                            );
                        }}
                    >
                        −
                    </button>
                    <input
                        className={styles.numInput}
                        value={priceType === 'LMT' ? price : 'MKT'}
                        disabled={priceType !== 'LMT'}
                        onChange={(e) => {
                            priceTouched.current = true;
                            setPrice(e.target.value);
                            setArmed(false);
                            setSplitArmed(false);
                        }}
                        inputMode='decimal'
                    />
                    <button
                        className={styles.stepBtn}
                        onClick={() => {
                            priceTouched.current = true;
                            setPrice((p) => String(Number(p || 0) + 1));
                        }}
                    >
                        +
                    </button>
                </div>

                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>數量{qtyUnit}</span>
                    <button
                        className={styles.stepBtn}
                        onClick={() => setQty((q) => Math.max(1, q - 1))}
                    >
                        −
                    </button>
                    <input
                        className={styles.numInput}
                        value={qty}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 0) setQty(v);
                        }}
                        inputMode='numeric'
                    />
                    <button
                        className={styles.stepBtn}
                        onClick={() => setQty((q) => q + 1)}
                    >
                        +
                    </button>
                </div>

                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>價別</span>
                    <div className={styles.segGroup}>
                        {(isFutures
                            ? ['LMT', 'MKT', 'MKP']
                            : ['LMT', 'MKT']
                        ).map((pt) => (
                            <button
                                key={pt}
                                className={
                                    styles.seg[priceType === pt ? 'on' : 'off']
                                }
                                onClick={() => {
                                    setPriceType(pt);
                                    setArmed(false);
                                    if (pt !== 'LMT') setOrderType('IOC');
                                    else setOrderType('ROD');
                                }}
                            >
                                {pt}
                            </button>
                        ))}
                    </div>
                </div>

                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>效期</span>
                    <div className={styles.segGroup}>
                        {(['ROD', 'IOC', 'FOK'] as OrderType[]).map((ot) => (
                            <button
                                key={ot}
                                className={
                                    styles.seg[orderType === ot ? 'on' : 'off']
                                }
                                onClick={() => {
                                    setOrderType(ot);
                                    setArmed(false);
                                }}
                            >
                                {ot}
                            </button>
                        ))}
                    </div>
                </div>

                {isFutures ? (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>倉別</span>
                        <div className={styles.segGroup}>
                            {(
                                [
                                    ['Auto', '自動'],
                                    ['New', '新倉'],
                                    ['Cover', '平倉'],
                                    ['DayTrade', '當沖'],
                                ] as [FuturesOCType, string][]
                            ).map(([oc, label]) => (
                                <button
                                    key={oc}
                                    className={
                                        styles.seg[octype === oc ? 'on' : 'off']
                                    }
                                    onClick={() => {
                                        setOctype(oc);
                                        setArmed(false);
                                    }}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>單位</span>
                        <div className={styles.segGroup}>
                            {(
                                [
                                    ['Common', '整股'],
                                    ['IntradayOdd', '零股'],
                                ] as [StockOrderLot, string][]
                            ).map(([lot, label]) => (
                                <button
                                    key={lot}
                                    className={
                                        styles.seg[
                                            orderLot === lot ? 'on' : 'off'
                                        ]
                                    }
                                    onClick={() => {
                                        setOrderLot(lot);
                                        setArmed(false);
                                    }}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {!isFutures && orderLot === 'Common' && (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>信用</span>
                        <div className={styles.segGroup}>
                            {(
                                [
                                    { value: 'Cash', label: '現股' },
                                    { value: 'MarginTrading', label: '融資' },
                                    { value: 'ShortSelling', label: '融券' },
                                    { value: 'SBLShort', label: '借券' },
                                    {
                                        value: 'SBLShortPriceExempt',
                                        label: '借券豁免',
                                    },
                                ] as {
                                    value: StockOrderCond;
                                    label: string;
                                }[]
                            )
                                .filter(
                                    (item) =>
                                        action === 'Sell' ||
                                        item.value === 'Cash' ||
                                        item.value === 'MarginTrading',
                                )
                                .map((item) => (
                                    <button
                                        key={item.value}
                                        className={
                                            styles.seg[
                                                orderCond === item.value
                                                    ? 'on'
                                                    : 'off'
                                            ]
                                        }
                                        title={
                                            item.value === 'SBLShort'
                                                ? '一般借券賣出（委託類別5）'
                                                : item.value ===
                                                    'SBLShortPriceExempt'
                                                  ? '價格豁免借券賣出（委託類別6，特殊金融商品適用）'
                                                  : undefined
                                        }
                                        onClick={() => {
                                            setOrderCond(item.value);
                                            if (item.value !== 'Cash') {
                                                setDaytradeShort(false);
                                            }
                                            setArmed(false);
                                        }}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                        </div>
                    </div>
                )}

                {!isFutures &&
                    action === 'Sell' &&
                    orderLot === 'Common' &&
                    orderCond === 'Cash' &&
                    contract.day_trade === 'Yes' && (
                        <div className={styles.fieldRow}>
                            <span className={styles.fieldLabel}>沖賣</span>
                            <div className={styles.segGroup}>
                                <button
                                    className={
                                        styles.seg[daytradeShort ? 'on' : 'off']
                                    }
                                    title='現股當沖先賣（無券先賣，當日需回補）'
                                    onClick={() => {
                                        setDaytradeShort((v) => !v);
                                        setArmed(false);
                                    }}
                                >
                                    {daytradeShort
                                        ? '✓ 現沖先賣（當日回補）'
                                        : '現股當沖先賣'}
                                </button>
                            </div>
                        </div>
                    )}

                {!splitOpen && (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>括號單</span>
                        <div className={styles.segGroup}>
                            <button
                                className={styles.seg[bracketOn ? 'on' : 'off']}
                                onClick={() => setBracketOn((b) => !b)}
                                title='進場成交後自動掛 OCO 停損/停利'
                            >
                                {bracketOn
                                    ? '✓ 成交後自動掛保護'
                                    : '停損停利保護'}
                            </button>
                        </div>
                    </div>
                )}
                {!splitOpen && bracketOn && (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>損/利</span>
                        <input
                            className={styles.numInput}
                            placeholder='停損價'
                            value={stopPrice}
                            inputMode='decimal'
                            onChange={(e) => setStopPrice(e.target.value)}
                        />
                        <input
                            className={styles.numInput}
                            placeholder='停利價'
                            value={takePrice}
                            inputMode='decimal'
                            onChange={(e) => setTakePrice(e.target.value)}
                        />
                    </div>
                )}

                {multi && (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>分倉</span>
                        <div className={styles.segGroup}>
                            <button
                                className={styles.seg[splitOpen ? 'on' : 'off']}
                                onClick={openSplit}
                                title='將同一筆單拆到多個帳戶送出'
                            >
                                {splitOpen ? '✓ 分倉下單' : '多帳戶分倉'}
                            </button>
                        </div>
                    </div>
                )}

                {splitOpen && (
                    <div className={styles.splitBox}>
                        <div className={styles.fieldRow}>
                            <span className={styles.fieldLabel}>模式</span>
                            <div className={styles.segGroup}>
                                <button
                                    className={
                                        styles.seg[
                                            splitMode === 'ratio'
                                                ? 'on'
                                                : 'off'
                                        ]
                                    }
                                    onClick={() => setSplitMode('ratio')}
                                    title='每戶填 %，總量取上方數量欄'
                                >
                                    比例
                                </button>
                                <button
                                    className={
                                        styles.seg[
                                            splitMode === 'fixed'
                                                ? 'on'
                                                : 'off'
                                        ]
                                    }
                                    onClick={() => setSplitMode('fixed')}
                                    title='每戶直接填數量，總量＝各戶合計'
                                >
                                    固定
                                </button>
                            </div>
                        </div>

                        {routable.map((a) => (
                            <div key={acctKey(a)} className={styles.fieldRow}>
                                <span
                                    className={styles.splitAcctLabel}
                                    title={maskName(a.username, priv)}
                                >
                                    {acctTag} {a.broker_id}-
                                    {maskAccountId(a.account_id, priv)}
                                </span>
                                {splitMode === 'ratio' ? (
                                    <>
                                        <input
                                            className={styles.splitInput}
                                            value={ratios[acctKey(a)] ?? ''}
                                            inputMode='decimal'
                                            placeholder='0'
                                            onChange={(e) =>
                                                setRatios((r) => ({
                                                    ...r,
                                                    [acctKey(a)]:
                                                        e.target.value,
                                                }))
                                            }
                                        />
                                        <span className={styles.splitUnit}>
                                            %
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <input
                                            className={styles.splitInput}
                                            value={fixedQty[acctKey(a)] ?? ''}
                                            inputMode='numeric'
                                            placeholder='0'
                                            onChange={(e) =>
                                                setFixedQty((f) => ({
                                                    ...f,
                                                    [acctKey(a)]:
                                                        e.target.value,
                                                }))
                                            }
                                        />
                                        <span className={styles.splitUnit}>
                                            {qtyUnit}
                                        </span>
                                    </>
                                )}
                            </div>
                        ))}

                        {splitMode === 'ratio' &&
                            (Math.abs(ratioSum - 100) < 1e-9 ? (
                                <span className={styles.splitHint}>
                                    比例總和 100% · 總量 {qty}
                                    {qtyUnit}（取上方數量欄）
                                </span>
                            ) : (
                                <span className={styles.splitError}>
                                    比例總和 {+ratioSum.toFixed(2)}%（需
                                    100%，
                                    {ratioSum < 100 ? '不足' : '超過'}{' '}
                                    {+Math.abs(100 - ratioSum).toFixed(2)}%）
                                </span>
                            ))}

                        {splitMode === 'ratio' && (
                            <div className={styles.presetRow}>
                                <select
                                    className={styles.presetSelect}
                                    value={presetSel}
                                    onChange={(e) => {
                                        const name = e.target.value;
                                        setPresetSel(name);
                                        const p = presets.find(
                                            (x) => x.name === name,
                                        );
                                        if (p) {
                                            setRatios(
                                                Object.fromEntries(
                                                    routable.map((a) => [
                                                        acctKey(a),
                                                        String(
                                                            p.ratios[
                                                                acctKey(a)
                                                            ] ?? 0,
                                                        ),
                                                    ]),
                                                ),
                                            );
                                        }
                                    }}
                                >
                                    <option value=''>套用分配 preset…</option>
                                    {presets.map((p) => (
                                        <option key={p.name} value={p.name}>
                                            {p.name}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    className={styles.presetBtn}
                                    disabled={!presetSel}
                                    onClick={() => {
                                        setPresets(
                                            deleteAllocPreset(presetSel),
                                        );
                                        setPresetSel('');
                                    }}
                                >
                                    刪除
                                </button>
                                <input
                                    className={styles.presetInput}
                                    placeholder='preset 名稱'
                                    value={presetName}
                                    onChange={(e) =>
                                        setPresetName(e.target.value)
                                    }
                                />
                                <button
                                    className={styles.presetBtn}
                                    disabled={!presetName.trim()}
                                    onClick={() => {
                                        const name = presetName.trim();
                                        setPresets(
                                            saveAllocPreset({
                                                name,
                                                ratios: Object.fromEntries(
                                                    routable.map((a) => [
                                                        acctKey(a),
                                                        Number(
                                                            ratios[
                                                                acctKey(a)
                                                            ],
                                                        ) || 0,
                                                    ]),
                                                ),
                                            }),
                                        );
                                        setPresetSel(name);
                                        setPresetName('');
                                    }}
                                >
                                    儲存
                                </button>
                            </div>
                        )}

                        <div className={styles.previewTable}>
                            {allocation.length === 0 ? (
                                <span className={styles.splitHint}>
                                    尚無可送出的帳戶（數量為 0 自動略過）
                                </span>
                            ) : (
                                <>
                                    {allocation.map((e) => (
                                        <span
                                            key={acctKey(e.account)}
                                            className={styles.previewRow}
                                        >
                                            <span>
                                                {acctTag}{' '}
                                                {e.account.broker_id}-
                                                {maskAccountId(
                                                    e.account.account_id,
                                                    priv,
                                                )}
                                            </span>
                                            <span>
                                                {e.qty}
                                                {qtyUnit}
                                            </span>
                                        </span>
                                    ))}
                                    <span className={styles.previewTotal}>
                                        <span>
                                            合計 {allocation.length} 戶
                                        </span>
                                        <span>
                                            {splitTotal}
                                            {qtyUnit}
                                        </span>
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                )}

                <CostEstimate
                    contract={contract}
                    action={action}
                    price={priceType === 'LMT' ? Number(price) : null}
                    qty={splitOpen && splitMode === 'fixed' ? splitTotal : qty}
                    odd={!isFutures && orderLot === 'IntradayOdd'}
                    daytrade={!isFutures && daytradeShort}
                />

                {splitOpen ? (
                    <button
                        className={
                            styles.execBtn[
                                splitArmed
                                    ? 'armed'
                                    : action === 'Buy'
                                      ? 'buy'
                                      : 'sell'
                            ]
                        }
                        onClick={executeSplit}
                        disabled={splitBusy || !live || !splitValid}
                    >
                        {!live
                            ? '⚠ 行情未連線，暫停下單'
                            : splitBusy
                              ? '傳送中…'
                              : splitArmed
                                ? `確認分倉${action === 'Buy' ? '買進' : '賣出'} ${splitTotal}${qtyUnit}／${allocation.length} 戶`
                                : `分倉${action === 'Buy' ? '買進' : '賣出'}（${allocation.length} 戶）`}
                    </button>
                ) : (
                    <button
                        className={
                            styles.execBtn[
                                armed
                                    ? 'armed'
                                    : action === 'Buy'
                                      ? 'buy'
                                      : 'sell'
                            ]
                        }
                        onClick={execute}
                        disabled={busy || qty < 1 || !live}
                    >
                        {!live
                            ? '⚠ 行情未連線，暫停下單'
                            : busy
                              ? '傳送中…'
                              : armed
                                ? `確認${action === 'Buy' ? '買進' : '賣出'} ${qty}${qtyUnit} @ ${priceType === 'LMT' ? fmtPrice(Number(price)) : priceType}`
                                : action === 'Buy'
                                  ? '買進下單'
                                  : '賣出下單'}
                    </button>
                )}

            {feedback && (
                <span
                    className={`${styles.feedback} ${
                        panel.dirText[feedback.kind === 'ok' ? 'down' : 'up']
                    }`}
                >
                    {feedback.text}
                </span>
            )}
        </div>
    );
}

function CostEstimate({
    contract,
    action,
    price,
    qty,
    odd,
    daytrade,
}: {
    contract: ContractInfo;
    action: Action;
    price: number | null;
    qty: number;
    odd: boolean;
    daytrade: boolean;
}) {
    if (!price || !Number.isFinite(price) || price <= 0 || qty <= 0) {
        return null;
    }
    const mult = contractMultiplier(contract);
    if (contract.security_type === 'OPT') {
        // options: premium × multiplier; 期交稅 0.1% of premium value
        const premium = price * mult * qty;
        const tax = Math.max(1, Math.round(premium * 0.001));
        return (
            <span className={styles.costRow}>
                權利金 ≈ {fmtPrice(premium, 0)} · 期交稅 ≈ {tax}/邊
            </span>
        );
    }
    if (contract.security_type === 'FUT') {
        const notional = price * mult * qty;
        const tax = Math.max(
            1,
            Math.round(notional * futuresTaxRate(contract)),
        );
        return (
            <span className={styles.costRow}>
                契約值 ≈ {fmtPrice(notional, 0)}（乘數 {mult}）· 期交稅 ≈{' '}
                {tax}/邊
            </span>
        );
    }
    const shares = odd ? qty : qty * 1000;
    const notional = price * shares;
    const fee = Math.max(odd ? 1 : 20, Math.round(notional * 0.001425));
    const baseTaxRate = stockTaxRate(contract);
    // 一般股票當沖賣出減半；ETF 與權證固定 0.1%。
    const taxRate =
        baseTaxRate === 0.003 && daytrade ? 0.0015 : baseTaxRate;
    const tax = action === 'Sell' ? Math.round(notional * taxRate) : 0;
    return (
        <span className={styles.costRow}>
            金額 {fmtPrice(notional, 0)} · 手續費 ≈ {fee}
            {action === 'Sell' ? ` · 證交稅 ≈ ${tax}` : ''}（牌告價估算）
        </span>
    );
}
