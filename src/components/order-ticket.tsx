import { canTrade } from '../lib/account-tradable';
// src/components/order-ticket.tsx — buy/sell ticket with two-step EXECUTE.
// Stock vs futures aware; price autofills from the live quote.

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ORDER_CONTEXT_CHANGED_MESSAGE, useOrderContext } from '../hooks/use-order-context';
import { TICKET_ACTION_EVENT } from '../hooks/use-hotkeys';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import {
    type AllocPreset,
    allocateByRatio,
    deleteAllocPreset,
    loadAllocPresets,
    saveAllocPreset,
} from '../lib/allocation';
import {
    ensureBracketHost,
    registerBracket,
    registrationFailureText,
    validateBracketRequest,
} from '../lib/bracket';
import { BracketStatusList } from './bracket-status';
import { BackgroundBracketList } from './background-bracket-status';
import { backgroundOwnerForNew, createBackgroundBracket } from '../lib/execution/background';
import { backgroundBracketEligible, bracketRequestFor } from '../lib/execution/background-bracket';
import { usePickedPrice } from '../lib/price-sync';
import { maskAccountId, maskName, usePrivacyMode } from '../lib/privacy';
import {
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import { accountConfirmLabel, requestOrderConfirm } from '../lib/order-confirm';
import {
    ACCOUNT_CHANGED_MESSAGE,
    captureSelectedAccount,
    isAccountAvailable,
    isSelectedAccountUnchanged,
} from '../lib/order-account';
import { checkOrderAllowed, getRiskSettings } from '../lib/risk';
import { clampLotQuantity, isOddLot, lotLabel, ODD_LOT_MAX_SHARES, ODD_LOT_TEXT, ODD_LOT_WAITING, oddLotReferencePrice, orderQtyUnit, stockOrderProblem, CREDIT_TEXT } from '../lib/odd-lot';
import { currentProtectionEnv } from '../lib/protection-env';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE } from '../lib/server-info-store';
import { loadOrderLotPreference, saveOrderLotPreference, TICKET_LOTS } from '../lib/order-lot-preference';
import { defaultOrderTypeFor, FUTURES_OCTYPES, futuresOrderProblem, ORDER_TYPES, orderTypeDisabledReason, priceTypeDisabledReason, priceTypesFor } from '../lib/order-conditions';
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
    priceCents,
    stockSellTax,
    stockTaxRate,
    stockTradeFee,
} from '../lib/utils/contract-cost';
import { fmtPrice } from '../lib/utils/format';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import * as panel from './panel.css';
import * as styles from './order-ticket.css';

const acctKey = (a: Account) => `${a.broker_id}-${a.account_id}`;

const UNIT_CHANGED_MESSAGE = '確認期間單位已變更（整股／零股），未送出，請重新確認';

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
    const [orderLot, setOrderLot] = useState<StockOrderLot>(() => loadOrderLotPreference('ticket', contract, TICKET_LOTS, 'Common'));
    const lotPreferences = useRef(new Map<string, StockOrderLot>());
    const [orderCond, setOrderCond] = useState<StockOrderCond>('Cash');
    // 盤中零股：帶價與括號單參考價只看零股行情（另一個撮合市場，#204）—
    // 零股成交價，否則零股最佳買賣中價／單邊；沒有零股行情就不帶價，
    // 絕不以整股價格帶入零股限價。盤後零股沒有即時行情，沿用整股。
    const intradayOdd = !isFutures && orderLot === 'IntradayOdd';
    const oddQuote = useQuote(intradayOdd ? contract.code : null, { oddLot: true });
    const oddReference = intradayOdd ? oddLotReferencePrice(oddQuote, p => roundToTick(contract, p)) : null;
    const lastClose: string | number | undefined = intradayOdd ? (oddReference ?? undefined) : quote?.tick?.close;
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
    const orderLotRef = useRef(orderLot);
    orderLotRef.current = orderLot;
    // 確認期間換買賣方向或信用條件（例如快捷鍵）也算換了，舊確認不送
    const captureContext = useOrderContext(contract, `${orderLot}:${action}:${orderCond}:${daytradeShort}`);

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

    const unitClassRef = useRef(isFutures);
    // reset on symbol change — split state deliberately collapses too
    // (never persisted: a forgotten split from last time must not fire)
    useEffect(() => {
        setPrice('');
        priceTouched.current = false;
        setArmed(false);
        setFeedback(null);
        setPriceType('LMT');
        setOrderType('ROD');
        // 數量只在輸入時的單位有效：原本是零股（股數），或商品類別（股票／
        // 期貨）變了，都歸 1 — 股數不會被當成張數或口數（#204）
        const classChanged = unitClassRef.current !== isFutures;
        unitClassRef.current = isFutures;
        const nextLot = isFutures ? 'Common' : lotPreferences.current.get(contract.code) ?? loadOrderLotPreference('ticket', contract, TICKET_LOTS, 'Common');
        if (orderLotRef.current !== 'Common' || orderLotRef.current !== nextLot || classChanged) setQty(1);
        setOrderLot(nextLot);
        setFixedQty({});
        setOrderCond('Cash');
        setOctype('Auto');
        setDaytradeShort(false);
        setBracketOn(false);
        setStopPrice('');
        setTakePrice('');
        setSplitOpen(false);
        setSplitArmed(false);
        setAcctMenuOpen(false);
    }, [contract.code, isFutures]);

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
    const liveClose = lastClose;
    useEffect(() => {
        if (priceTouched.current) return;
        if (liveClose) setPrice(String(Number(liveClose)));
        // 切到盤中零股但還沒有零股行情：清掉先前以整股價格帶入的價格
        else if (intradayOdd) setPrice('');
    }, [liveClose, intradayOdd]);

    // price picked from chart hover/click or depth ladder (same symbol only)
    const picked = usePickedPrice(contract.code);
    useEffect(() => {
        if (picked) {
            priceTouched.current = true;
            setPrice(String(picked.price));
            setArmed(false);
        }
    }, [picked]);

    // 確認期間同一檔合約更新成不可當沖：現沖賣就不送（照最新合約再檢查）
    const latestContractRef = useRef(contract);
    latestContractRef.current = contract;
    const assertDayTradeStillAllowed = () => {
        if (!isFutures && action === 'Sell' && daytradeShort && orderCond === 'Cash' && latestContractRef.current.day_trade !== 'Yes') {
            throw Object.assign(new Error(CREDIT_TEXT.daytradeStock), { tradingGateRejected: true });
        }
    };

    const execute = async () => {
        if (!armed) {
            setArmed(true);
            setFeedback(null);
            return;
        }
        setArmed(false);
        setBusy(true);
        const isContextCurrent = captureContext();
        // 伺服器模式代次：確認期間模擬 sidecar 重啟成正式（同一位址）也不送
        const sameServerMode = captureServerMode();
        try {
            const blocked = checkOrderAllowed(qty, isFutures ? undefined : orderLot);
            if (blocked) throw new Error(blocked);
            if (isFutures) {
                const problem = futuresOrderProblem({ price_type: priceType, order_type: orderType, octype });
                if (problem) throw new Error(problem);
            }
            if (!isFutures) {
                const problem = stockOrderProblem({ quantity: qty, price_type: priceType, order_type: orderType, order_lot: orderLot, order_cond: orderCond, daytrade_short: action === 'Sell' && daytradeShort, action, day_trade: contract.day_trade });
                if (problem) throw new Error(problem);
            }
            const p = priceType === 'LMT' ? Number(price) : 0;
            if (priceType === 'LMT' && (!Number.isFinite(p) || p <= 0)) {
                throw new Error('限價單需要有效價格');
            }
            // 括號單 (#102)：送進場單前先驗證方向／條件、固定帳戶，並確認主視窗
            // 能追蹤保護 — 任一不成立就不送進場單
            const sp = Number(stopPrice);
            const tp = Number(takePrice);
            const bracketStop = bracketOn && stopPrice.trim() !== '' ? sp : null;
            const bracketTake = bracketOn && takePrice.trim() !== '' ? tp : null;
            let entryAccount: Account | undefined;
            let bracketEnv: string | null = null;
            // who protects it, decided before the entry is sent (#201 ②):
            // the setting off → this window, exactly as before
            let bracketOwner: 'window' | 'background' = 'window';
            if (bracketOn) {
                // 零股括號單以零股市場判斷方向：沒有零股行情時不能確認
                if (intradayOdd && oddReference === null) {
                    throw new Error(`${ODD_LOT_WAITING}：尚未收到盤中零股行情，無法確認停損停利方向`);
                }
                const invalid = validateBracketRequest({
                    isFutures,
                    action,
                    referencePrice:
                        priceType === 'LMT'
                            ? p
                            : Number(lastClose) || null,
                    stopPrice: bracketStop,
                    takePrice: bracketTake,
                    orderLot,
                    orderCond,
                    octype,
                });
                if (invalid) throw new Error(invalid);
                entryAccount = captureSelectedAccount(isFutures ? 'F' : 'S');
                if (!entryAccount) {
                    throw new Error('括號單需要有效的下單帳戶');
                }
                bracketEnv = currentProtectionEnv();
                if (!bracketEnv) {
                    throw new Error('伺服器模式（模擬／正式）尚未確認，括號單未送出');
                }
                if (backgroundBracketEligible(isFutures, contract.security_type)) {
                    const owner = await backgroundOwnerForNew({ liveOn: bracketEnv });
                    if (typeof owner === 'object') throw new Error(`${owner.refused}；進場單未送出`);
                    bracketOwner = owner;
                }
                if (bracketOwner === 'window') await ensureBracketHost();
            }
            // 送單帳戶在確認前固定（#139）：確認視窗開著時，本視窗其他面板
            // 仍可改選帳戶 — 送出時不再重新解析，改為比對後中止
            const orderAccount =
                entryAccount ?? captureSelectedAccount(isFutures ? 'F' : 'S');
            if (!orderAccount) {
                throw new Error('缺少有效的下單帳戶，請重新選擇帳戶');
            }
            if (getRiskSettings().confirmManualOrders) {
                const approved = await requestOrderConfirm({
                    code: contract.code,
                    name: contract.name,
                    action,
                    price: priceType === 'LMT' ? p : null,
                    quantity: qty,
                    unit: orderQtyUnit(isFutures, orderLot),
                    note: `${orderType}${!isFutures && orderLot !== 'Common' ? `・${lotLabel(orderLot)}` : ''}${
                        !isFutures && orderCond !== 'Cash'
                            ? `・${orderCond === 'MarginTrading' ? '融資' : '融券'}`
                            : ''
                    }${!isFutures && daytradeShort && action === 'Sell' ? '・現股當沖' : ''}${
                        bracketOwner === 'background' ? '・括號單由背景執行保護（成交後才盯停損停利，只平倉已成交口數）' : ''}`,
                    accountLabel: accountConfirmLabel(orderAccount),
                }, { serverMode: sameServerMode });
                if (!approved) throw new Error('已取消下單');
            }
            if (!sameServerMode()) throw new Error(SERVER_MODE_CHANGED_MESSAGE);
            // 確認期間切換了單位：股數與張數不能混用，整筆不送（#204）
            if (orderLotRef.current !== orderLot) {
                throw new Error(UNIT_CHANGED_MESSAGE);
            }
            if (!isSelectedAccountUnchanged(orderAccount)) {
                throw new Error(ACCOUNT_CHANGED_MESSAGE);
            }
            const dispatch = { beforeDispatch: () => {
                if (!isContextCurrent()) throw Object.assign(new Error(ORDER_CONTEXT_CHANGED_MESSAGE), { tradingGateRejected: true });
                if (!sameServerMode()) throw Object.assign(new Error(SERVER_MODE_CHANGED_MESSAGE), { tradingGateRejected: true });
                assertDayTradeStillAllowed();
                if (!isSelectedAccountUnchanged(orderAccount)) throw Object.assign(new Error(ACCOUNT_CHANGED_MESSAGE), { tradingGateRejected: true });
            } };
            dispatch.beforeDispatch();
            const trade = isFutures
                ? await placeFuturesOrder(contract, {
                      action,
                      price: p,
                      quantity: qty,
                      price_type: priceType as 'LMT' | 'MKT' | 'MKP',
                      order_type: orderType,
                      octype,
                  }, orderAccount, dispatch)
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
                  }, orderAccount, dispatch);
            setFeedback({
                kind: 'ok',
                text: `▸ ${trade.status.status} #${trade.order.seqno || trade.order.id.slice(0, 8)}`,
            });
            if (bracketOn && entryAccount && bracketEnv && bracketOwner === 'background') {
                const seq = trade.order.seqno || trade.order.id.slice(0, 8);
                const request = bracketRequestFor({
                    env: bracketEnv,
                    account: { account_type: 'F', broker_id: entryAccount.broker_id, account_id: entryAccount.account_id },
                    quoteCode: contract.code,
                    orderCode: trade.contract?.target_code || trade.contract?.code || contract.target_code || contract.code,
                    securityType: contract.security_type === 'OPT' ? 'OPT' : 'FUT',
                    action,
                    quantity: qty,
                    stopPrice: bracketStop,
                    takePrice: bracketTake,
                    tradeId: trade.order.id,
                    seqno: trade.order.seqno ?? null,
                    ordno: trade.order.ordno ?? null,
                });
                const created = request ? await createBackgroundBracket(request)
                    : { refused: '進場單沒有委託編號（送出結果可能尚未確認）' };
                if (created !== 'created') {
                    // 進場單已送出：保護未建立或結果未確認都明示；不自動重送，
                    // 也不建議另掛停損（可能晚到生效 → 重複出場）
                    const text = 'refused' in created
                        ? `背景括號單未建立（${created.refused}）。請到委託／持倉確認後自行處理出場；系統不會自動補送`
                        : `背景括號單建立結果未確認（${created.unconfirmed}）。請先查看括號單清單確認是否已建立；確認前不要另外設定停損或出場單`;
                    setFeedback({ kind: 'err', text: `✕ 進場單已送出 #${seq}；${text}` });
                    notify({ kind: 'err', title: '括號單保護未確認', body: `${contract.code} 進場單已送出；${text}` });
                }
            } else if (bracketOn && entryAccount && bracketEnv) {
                try {
                    await registerBracket({
                        env: bracketEnv,
                        account: {
                            account_type: isFutures ? 'F' : 'S',
                            broker_id: entryAccount.broker_id,
                            account_id: entryAccount.account_id,
                        },
                        orderId: trade.order.id,
                        seqno: trade.order.seqno,
                        quoteCode: contract.code,
                        orderCode:
                            trade.contract?.target_code ||
                            trade.contract?.code ||
                            contract.target_code ||
                            contract.code,
                        securityType: contract.security_type as
                            | 'STK'
                            | 'FUT'
                            | 'OPT',
                        exchange: contract.exchange ?? '',
                        action,
                        quantity: qty,
                        orderLot: isFutures ? undefined : orderLot,
                        stopPrice: bracketStop,
                        takePrice: bracketTake,
                    });
                } catch (err) {
                    // 進場單已送出：保護登記結果必須明示，不自動重送任何單，
                    // 也不建議另掛停損（登記可能晚到生效 → 重複出場）
                    const text = registrationFailureText(err);
                    setFeedback({
                        kind: 'err',
                        text: `✕ 進場單已送出 #${trade.order.seqno || trade.order.id.slice(0, 8)}；${text}`,
                    });
                    notify({
                        kind: 'err',
                        title: '括號單保護未確認',
                        body: `${contract.code} 進場單已送出；${text}`,
                    });
                }
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

    const qtyUnit = orderQtyUnit(isFutures, orderLot);
    const odd = !isFutures && isOddLot(orderLot);
    const { accounts, selectedStock, selectedFutures } = useAccounts();
    const priv = usePrivacyMode();
    const activeAccount = isFutures ? selectedFutures : selectedStock;
    // any selection change in this window (this ticket's menu or another
    // panel's) disarms the ticket so a pending second click can't route
    // elsewhere
    const activeAccountKey = activeAccount ? acctKey(activeAccount) : '';
    useEffect(() => {
        setArmed(false);
        setSplitArmed(false);
    }, [activeAccountKey]);
    const acctTag = isFutures ? '[期]' : '[證]';
    // 同市場的可交易帳戶可分倉；模擬模式允許未簽署帳戶。
    const routable = accounts.filter(
        (a) => canTrade(a) && a.account_type === (isFutures ? 'F' : 'S'),
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
        const isContextCurrent = captureContext();
        const sameServerMode = captureServerMode();
        const beforeDispatch = () => {
            if (!isContextCurrent()) throw Object.assign(new Error(ORDER_CONTEXT_CHANGED_MESSAGE), { tradingGateRejected: true });
            if (!sameServerMode()) throw Object.assign(new Error(SERVER_MODE_CHANGED_MESSAGE), { tradingGateRejected: true });
            assertDayTradeStillAllowed();
        };
        try {
            if (!splitValid || allocation.length === 0) {
                throw new Error('分倉設定無效');
            }
            if (isFutures) {
                const problem = futuresOrderProblem({ price_type: priceType, order_type: orderType, octype });
                if (problem) throw new Error(problem);
            }
            if (!isFutures) {
                for (const e of allocation) {
                    const problem = stockOrderProblem({ quantity: e.qty, price_type: priceType, order_type: orderType, order_lot: orderLot, order_cond: orderCond, daytrade_short: action === 'Sell' && daytradeShort, action, day_trade: contract.day_trade });
                    if (problem) throw new Error(problem);
                }
            }
            const p = priceType === 'LMT' ? Number(price) : 0;
            if (priceType === 'LMT' && (!Number.isFinite(p) || p <= 0)) {
                throw new Error('限價單需要有效價格');
            }
            // 分倉整批確認一次（逐戶迴圈內不再問）
            if (getRiskSettings().confirmManualOrders) {
                const approved = await requestOrderConfirm({
                    code: contract.code,
                    name: contract.name,
                    action,
                    price: priceType === 'LMT' ? p : null,
                    quantity: splitTotal,
                    unit: qtyUnit,
                    note: `分倉送出 ${allocation.length} 個帳戶${odd ? `・${lotLabel(orderLot)}` : ''}`,
                    accountLabel: `分倉 ${allocation.length} 戶：${allocation
                        .map((e) => `${accountConfirmLabel(e.account)}×${e.qty}`)
                        .join('、')}`,
                }, { serverMode: sameServerMode });
                if (!approved) throw new Error('已取消下單');
            }
            if (!sameServerMode()) throw new Error(SERVER_MODE_CHANGED_MESSAGE);
            // 確認期間切換了單位：股數與張數不能混用，整筆不送（#204）
            if (orderLotRef.current !== orderLot) {
                throw new Error(UNIT_CHANGED_MESSAGE);
            }
            // 分倉帳戶是明確指定的；確認期間任一帳戶不可用就整批不送
            if (allocation.some((e) => !isAccountAvailable(e.account))) {
                throw new Error(ACCOUNT_CHANGED_MESSAGE);
            }
            const ok: string[] = [];
            const fail: string[] = [];
            // 逐戶送出（sequential — deterministic order, per-order risk）
            for (const { account, qty: q } of allocation) {
                const label = `${account.broker_id}-${maskAccountId(account.account_id, priv)}`;
                if (!isContextCurrent()) {
                    fail.push(`${label}: ${ORDER_CONTEXT_CHANGED_MESSAGE}`);
                    break;
                }
                if (!canTrade(account) || !isAccountAvailable(account)) {
                    fail.push(`${label}: ${ACCOUNT_CHANGED_MESSAGE}；已停止後續分倉`);
                    break;
                }
                const blocked = checkOrderAllowed(q, isFutures ? undefined : orderLot);
                if (blocked) {
                    fail.push(`${label}: ${blocked}`);
                    continue;
                }
                try {
                    const dispatch = { beforeDispatch: () => {
                        beforeDispatch();
                        if (!canTrade(account) || !isAccountAvailable(account)) throw Object.assign(new Error(ACCOUNT_CHANGED_MESSAGE), { tradingGateRejected: true });
                    } };
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
                              dispatch,
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
                              dispatch,
                          );
                    ok.push(
                        `${label} ${q}${qtyUnit} #${trade.order.seqno || trade.order.id.slice(0, 8)}`,
                    );
                } catch (e) {
                    fail.push(
                        `${label}: ${e instanceof Error ? e.message : String(e)}`,
                    );
                    if ((e as { tradingGateRejected?: boolean })?.tradingGateRejected) break;
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
                                    Math.max(
                                        0,
                                        stepPrice(
                                            contract,
                                            Number(p || 0),
                                            -1,
                                        ),
                                    ),
                                ),
                            );
                            // stepper is a manual price edit — de-arm like
                            // typing does (live-tick autofill must not)
                            setArmed(false);
                            setSplitArmed(false);
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
                            setPrice((p) =>
                                String(
                                    stepPrice(contract, Number(p || 0), 1),
                                ),
                            );
                            setArmed(false);
                            setSplitArmed(false);
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
                        aria-label={`數量（${qtyUnit}）`}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 0 && (!odd || v <= ODD_LOT_MAX_SHARES)) setQty(v);
                        }}
                        inputMode='numeric'
                    />
                    <button
                        className={styles.stepBtn}
                        onClick={() => setQty((q) => (odd ? clampLotQuantity(q + 1, orderLot) : q + 1))}
                    >
                        +
                    </button>
                </div>

                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>價別</span>
                    <div className={styles.segGroup}>
                        {priceTypesFor(isFutures).map((pt) => (
                            <button
                                key={pt}
                                className={
                                    styles.seg[priceType === pt ? 'on' : 'off']
                                }
                                disabled={!!priceTypeDisabledReason(pt, odd)}
                                title={priceTypeDisabledReason(pt, odd) ?? undefined}
                                onClick={() => {
                                    setPriceType(pt);
                                    setArmed(false);
                                    setOrderType(defaultOrderTypeFor(pt));
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
                        {ORDER_TYPES.map((ot) => (
                            <button
                                key={ot}
                                className={
                                    styles.seg[orderType === ot ? 'on' : 'off']
                                }
                                disabled={!!orderTypeDisabledReason(ot, odd)}
                                title={orderTypeDisabledReason(ot, odd) ?? undefined}
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
                            {FUTURES_OCTYPES.map(({ value: oc, label }) => (
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
                                    ['IntradayOdd', '盤中零股'],
                                    ['Odd', '盤後零股'],
                                ] as const
                            ).map(([lot, label]) => (
                                <button
                                    key={lot}
                                    className={
                                        styles.seg[
                                            orderLot === lot ? 'on' : 'off'
                                        ]
                                    }
                                    title={
                                        lot === 'IntradayOdd'
                                            ? '盤中零股 09:00–13:30，以股計（1～999 股），限價 ROD'
                                            : lot === 'Odd'
                                              ? '盤後零股 13:40–14:30 收單、14:30 一次撮合，以股計（1～999 股），限價 ROD'
                                              : '整股以張計（1 張 = 1,000 股）'
                                    }
                                    onClick={() => {
                                        if (lot === orderLot) return;
                                        lotPreferences.current.set(contract.code, lot);
                                        saveOrderLotPreference('ticket', contract, lot);
                                        setOrderLot(lot);
                                        // 單位改變時數量歸 1，避免 500 股變成 500 張；
                                        // 分倉固定量同理清空，確認步驟全部解除
                                        setQty(1);
                                        setFixedQty({});
                                        setArmed(false);
                                        setSplitArmed(false);
                                        if (isOddLot(lot)) {
                                            // 零股只能現股限價 ROD（#204）
                                            setPriceType('LMT');
                                            setOrderType('ROD');
                                            setOrderCond('Cash');
                                            setDaytradeShort(false);
                                            if (lot === 'Odd') setBracketOn(false);
                                        }
                                        setArmed(false);
                                    }}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {odd && (
                    <span className={styles.costRow}>
                        {lotLabel(orderLot)}：以股計（1～{ODD_LOT_MAX_SHARES} 股）· 限價 ROD · 僅現股，不可融資券或當沖
                        {orderLot === 'Odd' ? ' · 13:40–14:30 收單，14:30 一次撮合' : ''}
                        {intradayOdd && oddReference === null ? ` · ${ODD_LOT_WAITING}（不自動帶價）` : ''}
                    </span>
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
                    // 已勾選但此股票已不可當沖時仍顯示，讓使用者能取消（送單會被擋下）
                    (contract.day_trade === 'Yes' || daytradeShort) && (
                        <div className={styles.fieldRow}>
                            <span className={styles.fieldLabel}>沖賣</span>
                            <div className={styles.segGroup}>
                                <button
                                    className={
                                        styles.seg[daytradeShort ? 'on' : 'off']
                                    }
                                    title={contract.day_trade === 'Yes' ? '現股當沖先賣（無券先賣，當日需回補）' : '此股票目前不可現股當沖先賣，請取消'}
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

                {!splitOpen && orderLot !== 'Odd' && (
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
                {!splitOpen && bracketOn && orderLot !== 'Odd' && (
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>損/利</span>
                        <div className={styles.bracketInputs}>
                            <input
                                className={styles.bracketInput}
                                placeholder='停損價'
                                value={stopPrice}
                                inputMode='decimal'
                                onChange={(e) => setStopPrice(e.target.value)}
                            />
                            <input
                                className={styles.bracketInput}
                                placeholder='停利價'
                                value={takePrice}
                                inputMode='decimal'
                                onChange={(e) => setTakePrice(e.target.value)}
                            />
                        </div>
                    </div>
                )}
                <BracketStatusList code={contract.code} />
                <BackgroundBracketList code={contract.code} />

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
                    odd={odd}
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
                            ? '⚠ 行情或交易狀態未連線，暫停下單'
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
                            ? '⚠ 行情或交易狀態未連線，暫停下單'
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
    const cents = priceCents(price) * shares;
    const fee = stockTradeFee(cents, { odd });
    const baseTaxRate = stockTaxRate(contract);
    // 一般股票當沖賣出減半；ETF 與權證固定 0.1%。
    const taxRate =
        baseTaxRate === 0.003 && daytrade ? 0.0015 : baseTaxRate;
    const tax = action === 'Sell' ? stockSellTax(cents, taxRate) : 0;
    return (
        <span className={styles.costRow}>
            金額 {fmtPrice(notional, 0)} · 手續費 ≈ {fee}
            {action === 'Sell' ? ` · 證交稅 ≈ ${tax}` : ''}（牌告價估算）
        </span>
    );
}
