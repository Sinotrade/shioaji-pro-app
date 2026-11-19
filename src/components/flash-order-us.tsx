// src/components/flash-order-us.tsx — 閃電下單的美股分支（FlashOrder 遇到美股合約時改畫這個）
//
// 和台股同一個閃電面板、同一套梯形樣式，但規則不同：
// - 只用 H（複委託）帳戶；只能整股（單位：股），點價＝限價 LMT、時效 DAY。
// - 沒有市價、零股、信用、當沖、觸價、停損停利、平倉（美股不提供）。
// - 價格是 decimal 字串（級距見 lib/us/us-tick.ts 的假設），不套用台股漲跌停。
// - 行情只有成交價與最佳一檔買賣（SDK 1.8.0b1）；第一筆行情前以前一日參考價置中。
// - 風控只看 Kill Switch（checkUsOrderAllowed），送單前與送出前一刻各查一次。

import { usHaltLabel, useUsHalt } from '../lib/us/us-halts';
import { ChevronDown, Locate, LocateFixed, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import { pickUsReference, useUsSnapshot } from '../hooks/use-us-snapshot';
import { useAccounts } from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import { contractLinkKey } from '../lib/contract-key';
import { accountConfirmLabel, requestOrderConfirm } from '../lib/order-confirm';
import { maskAccountId, maskName, usePrivacyMode } from '../lib/privacy';
import { checkUsOrderAllowed, getRiskSettings } from '../lib/risk';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE } from '../lib/server-info-store';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Action } from '../lib/types/order';
import type { Account } from '../lib/types/portfolio';
import type { AccountedUsTrade } from '../lib/types/us';
import { decAdd, decCompare, decIsPositive, decNormalize, fmtDec, fmtUsPrice } from '../lib/us/decimal';
import { placeUsOrder, usErrorText } from '../lib/us/us-api';
import { cancelUsTrade, UsCancelTooEarlyError } from '../lib/us/us-order-actions';
import { buildUsOrderReq, usOrderProblem } from '../lib/us/us-order-rules';
import { usRoundToTick, usStepPrice } from '../lib/us/us-tick';
import { observeUsTrade, useUsTradingState, usIsWorking, usRemaining } from '../lib/us/us-trading-state';
import { fmtCompactInt, fmtInt } from '../lib/utils/format';
import * as styles from './flash-order.css';
import * as us from './flash-order-us.css';

const ROW_H = 22; // 與 flash-order.css.ts 的列高一致
const EDGE = 2; // 成交價離視窗邊緣這麼近就重新置中
const DEFAULT_ROWS = 15;

const acctKey = (a: Pick<Account, 'broker_id' | 'account_id'>) => `${a.broker_id}-${a.account_id}`;
/** 合法正數價格 → 標準化字串，否則 null */
const priceOf = (v: string | null | undefined) => (v && decIsPositive(v) ? decNormalize(v) : null);

interface Working { buy: string; sell: string; buyRows: AccountedUsTrade[]; sellRows: AccountedUsTrade[] }

export interface UsFlashOrderProps {
    contract: ContractInfo;
    linkKey?: string;
    symbolExtra?: ReactNode;
    settingsRows?: ReactNode;
    paused?: string;
}

export function UsFlashOrder({ contract, linkKey = '', symbolExtra, paused }: UsFlashOrderProps) {
    const live = useTradingLive();
    const priv = usePrivacyMode();
    const accountState = useAccounts();
    const intl = useMemo(() => accountState.accounts.filter(a => a.account_type === 'H' && canTrade(a)), [accountState.accounts]);
    const [pickedKey, setPickedKey] = useState('');
    const selected = accountState.selectedIntl && intl.some(a => acctKey(a) === acctKey(accountState.selectedIntl!)) ? accountState.selectedIntl : null;
    const account: Account | null = intl.find(a => acctKey(a) === pickedKey) ?? selected ?? intl[0] ?? null;
    const accountKey = account ? acctKey(account) : '';

    const key = contractLinkKey(contract);
    const quote = useQuote(key);
    const last = priceOf(quote?.tick?.close);
    const lastVol = quote?.tick?.volume ?? 0;
    const bidPrice = priceOf(quote?.bidask?.bid_price?.[0]);
    const askPrice = priceOf(quote?.bidask?.ask_price?.[0]);
    const bidVol = bidPrice ? quote?.bidask?.bid_volume?.[0] ?? 0 : 0;
    const askVol = askPrice ? quote?.bidask?.ask_volume?.[0] ?? 0 : 0;
    // 參考價跟報價板同一條規則（快照優先於可能落後一天的合約檔）
    const snap = useUsSnapshot(contract, !last);
    const { price: refPrice, date: referenceDate } = pickUsReference(last ? quote?.tick : undefined, snap, contract);
    const reference = priceOf(refPrice);
    const center = usRoundToTick(last ?? reference ?? '') ?? null;
    const centerFrom: 'last' | 'ref' | null = last ? 'last' : reference ? 'ref' : null;

    const [qty, setQty] = useState('1');
    // 啟用綁定這組條件：連動、商品、帳戶任何一個變了，同一次 render 就解除
    const armKey = `${linkKey}|${key}|${accountKey}`;
    const [armedFor, setArmedFor] = useState<string | null>(null);
    const armed = armedFor === armKey && !paused;
    const armKeyRef = useRef(armKey);
    armKeyRef.current = armKey;
    // 換商品、換帳戶、換連動或交易連線中斷：一律重新上鎖（之後換回來也不會自動恢復）
    useEffect(() => { setArmedFor(null); }, [armKey]);
    useEffect(() => { if (!live) setArmedFor(null); }, [live]);

    useEffect(() => {
        if (!armed) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setArmedFor(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [armed]);

    // ---- 梯形視窗 ----
    const [rowCount, setRowCount] = useState(DEFAULT_ROWS);
    const [anchor, setAnchor] = useState<string | null>(null);
    const anchorFrom = useRef<'last' | 'ref' | null>(null);
    const [follow, setFollow] = useState(true);
    const hoverRef = useRef(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => setRowCount(Math.max(7, Math.floor(el.clientHeight / ROW_H))));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // 換商品：重新置中
    useEffect(() => { setAnchor(null); anchorFrom.current = null; setFollow(true); }, [key]);

    const rows = useMemo(() => {
        if (anchor === null) return [] as string[];
        const half = Math.floor(rowCount / 2);
        const ups: string[] = [];
        let p: string | null = anchor;
        for (let i = 0; i < half && p; i++) { p = usStepPrice(p, 1); if (p) ups.push(p); }
        const downs: string[] = [];
        p = anchor;
        for (let i = 0; i < rowCount - 1 - ups.length && p; i++) { p = usStepPrice(p, -1); if (p) downs.push(p); }
        return [...ups.reverse(), anchor, ...downs];
    }, [anchor, rowCount]);
    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    // 自動跟隨：第一次置中、參考價換成第一筆成交價、成交價接近邊緣時重新置中；游標在梯形內不動
    useEffect(() => {
        if (center === null || !follow || hoverRef.current) return;
        const rws = rowsRef.current;
        const idx = rws.indexOf(center);
        if (anchor === null || anchorFrom.current !== centerFrom || idx === -1 || idx < EDGE || idx > rws.length - 1 - EDGE) {
            anchorFrom.current = centerFrom;
            setAnchor(center);
        }
    }, [center, centerFrom, follow, anchor, rows]);

    const recenter = useCallback(() => {
        setFollow(true);
        if (center !== null) { anchorFrom.current = centerFrom; setAnchor(center); }
    }, [center, centerFrom]);

    const wheelAccum = useRef(0);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            wheelAccum.current += e.deltaMode === 1 ? e.deltaY * ROW_H : e.deltaY;
            const ticks = Math.trunc(wheelAccum.current / ROW_H);
            if (ticks === 0) return;
            wheelAccum.current -= ticks * ROW_H;
            setFollow(false);
            setAnchor(a => (a === null ? a : usStepPrice(a, -ticks) ?? a));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // ---- 這個帳戶在這檔的未完成委託 ----
    const { trades } = useUsTradingState();
    const working = useMemo(() => {
        const map = new Map<string, Working>();
        if (!account) return map;
        for (const t of trades) {
            if (t.contract.code !== contract.code || (t.contract.region && t.contract.region !== 'US')) continue;
            if (contract.exchange && t.contract.exchange && t.contract.exchange !== contract.exchange) continue;
            if (t.account.broker_id !== account.broker_id || t.account.account_id !== account.account_id) continue;
            if (!usIsWorking(t)) continue;
            const price = priceOf(String(t.order.price));
            if (!price) continue;
            const w = map.get(price) ?? { buy: '0', sell: '0', buyRows: [], sellRows: [] };
            const left = usRemaining(t);
            if (t.order.action === 'Buy') { w.buy = decAdd(w.buy, left) ?? w.buy; w.buyRows.push(t); }
            else if (t.order.action === 'Sell') { w.sell = decAdd(w.sell, left) ?? w.sell; w.sellRows.push(t); }
            map.set(price, w);
        }
        return map;
    }, [trades, contract.code, contract.exchange, account]);

    const halt = useUsHalt(contract);

    // ---- 送單 ----
    const blockReason = paused ?? (!live ? '行情或交易狀態未連線'
        : contract.trading_suspended ? `${contract.code} 暫停交易`
        : !account ? '沒有可交易的複委託（H）帳戶'
        : !contract.exchange ? '缺少美股交易所，無法下單' : null);

    // 同一價位同一方向送單中：擋連點（確認視窗關閉時雙擊會送兩筆）
    const inflightRef = useRef(new Set<string>());
    const send = useCallback(async (action: Action, price: string) => {
        if (!armed || blockReason || !account) return;
        const flightKey = `${action}:${price}`;
        if (inflightRef.current.has(flightKey)) return;
        inflightRef.current.add(flightKey);
        try { await sendOnce(action, price); } finally { inflightRef.current.delete(flightKey); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [armed, blockReason, account, qty, contract.code, contract.name, contract.exchange]);

    const sendOnce = async (action: Action, price: string) => {
        if (!account) return;
        const startKey = armKeyRef.current;
        const sameServerMode = captureServerMode();
        const orderAccount = account;
        const side = action === 'Buy' ? '買' : '賣';
        try {
            const locked = checkUsOrderAllowed();
            if (locked) throw new Error(locked);
            const draft = { action, quantity: qty, priceType: 'LMT' as const, timeInForce: 'DAY' as const, price };
            const problem = usOrderProblem(draft);
            if (problem) throw new Error(problem);
            const order = buildUsOrderReq(draft);
            if (getRiskSettings().confirmManualOrders) {
                const approved = await requestOrderConfirm({
                    code: contract.code,
                    name: contract.name,
                    action,
                    price: Number(order.price),
                    priceLabel: `${order.price} USD`,
                    quantity: order.quantity,
                    unit: '股',
                    note: '美股・閃電・DAY 當日有效・限價',
                    accountLabel: `${accountConfirmLabel(orderAccount)}（複委託）`,
                }, { serverMode: sameServerMode });
                if (!approved) return;
            }
            const gate = () => {
                if (armKeyRef.current !== startKey) throw Object.assign(new Error('連動、商品或帳戶已變更，這筆沒有送出'), { tradingGateRejected: true });
                if (!sameServerMode()) throw Object.assign(new Error(SERVER_MODE_CHANGED_MESSAGE), { tradingGateRejected: true });
                // 確認視窗期間可能啟動了 Kill Switch：送出前一刻再查一次
                const lockedNow = checkUsOrderAllowed();
                if (lockedNow) throw Object.assign(new Error(lockedNow), { tradingGateRejected: true });
            };
            gate();
            const trade = await placeUsOrder({ code: contract.code, exchange: contract.exchange }, order, orderAccount, { beforeDispatch: gate });
            observeUsTrade(trade, orderAccount);
            notify({ kind: 'ok', title: `⚡ 美股限價${side}`, body: `${contract.code} ${order.quantity} 股 @ ${order.price} USD（DAY）` });
        } catch (e) {
            notify({ kind: 'err', title: `⚡ 美股委託失敗 ${contract.code}`, body: usErrorText(e) });
        }
    };

    const cancelAt = useCallback(async (side: 'buy' | 'sell', price: string) => {
        const w = working.get(price);
        const targets = side === 'buy' ? w?.buyRows ?? [] : w?.sellRows ?? [];
        if (targets.length === 0) {
            notify({ kind: 'err', title: '⚡ 美股刪單', body: `${contract.code} @ ${fmtUsPrice(price)}：找不到這個價位可刪的委託，沒有送出` });
            return;
        }
        for (const row of targets) {
            try {
                const r = await cancelUsTrade(row);
                notify(r.filled
                    ? { kind: 'info', title: '⚡ 美股刪單', body: `${contract.code} @ ${fmtUsPrice(price)}：刪單前已全部成交` }
                    : r.confirmed
                        ? { kind: 'ok', title: '⚡ 美股刪單', body: `${contract.code} @ ${fmtUsPrice(price)}：已刪 ${fmtDec(r.cancelled ?? '0')} 股` }
                        : { kind: 'info', title: '⚡ 美股刪單', body: `${contract.code} @ ${fmtUsPrice(price)}：已送出刪單，結果待確認，請到委託分頁核對` });
            } catch (e) {
                const body = e instanceof UsCancelTooEarlyError ? e.message : usErrorText(e);
                notify({ kind: 'err', title: '⚡ 美股刪單失敗', body: `${contract.code} @ ${fmtUsPrice(price)}：${body}` });
            }
        }
    }, [working, contract.code]);

    const maxVol = Math.max(bidVol, askVol, 1);
    const lastIdx = last ? rows.indexOf(usRoundToTick(last) ?? '') : -1;
    const lastAbove = last !== null && rows.length > 0 && lastIdx === -1 && decCompare(last, rows[0]!) > 0;
    const name = contract.name && contract.name !== contract.code ? `${contract.code} ${contract.name}` : contract.code;
    const cellOk = armed && !blockReason;
    const vol = (v: number) => (v >= 10_000 ? fmtCompactInt(v) : fmtInt(v));

    return (
        <div className={styles.wrap} data-testid='flash-us'>
            {paused ? (
                <div className={styles.symbolRow}><span className={styles.symbolName}>{paused}</span></div>
            ) : (
                <div className={styles.symbolRow} title={`${name}（美股・${contract.exchange ?? '—'}・USD）`}>
                    <span className={styles.kindTag} data-testid='flash-kind'><b>美股</b><i>股</i></span>
                    <span className={styles.symbolName}>{name}</span>
                    {symbolExtra}
                    <span className={styles.symbolMeta}>{[contract.exchange, 'USD'].filter(Boolean).join(' · ')}</span>
                </div>
            )}
            {!paused && !last && (
                <div className={us.refNote} data-testid='flash-us-ref'>
                    {reference ? `參考 ${fmtUsPrice(reference)}${referenceDate ? `（${referenceDate}）` : ''}・尚無即時報價` : '尚無參考價與即時報價'}
                </div>
            )}
            {!paused && contract.trading_suspended && <div className={`${us.refNote} ${us.warn}`}>{contract.code} 暫停交易</div>}
            {!paused && halt && <div className={`${us.refNote} ${us.warn}`} data-testid='flash-us-halt'>{contract.code} {usHaltLabel(halt)}</div>}
            <div className={styles.controls}>
                <label className={styles.accountPick}>
                    <span className={styles.accountText}>{account ? `${account.broker_id}-${maskAccountId(account.account_id, priv)}` : '無複委託帳戶'}</span>
                    <ChevronDown size={10} aria-hidden />
                    <select
                        className={styles.accountSelect}
                        aria-label='美股閃電下單帳戶'
                        title='美股只用複委託（H）帳戶'
                        value={accountKey}
                        onChange={e => { setArmedFor(null); setPickedKey(e.target.value); }}
                    >
                        {!account && <option value=''>無複委託帳戶</option>}
                        {intl.map(a => (
                            <option key={acctKey(a)} value={acctKey(a)}>
                                {`${a.broker_id}-${maskAccountId(a.account_id, priv)}${a.username ? ` ${maskName(a.username, priv)}` : ''}（複委託）`}
                            </option>
                        ))}
                    </select>
                </label>
                <button className={styles.stepBtn} aria-label='減少 1 股' onClick={() => setQty(q => String(Math.max(1, (Number(q) || 1) - 1)))}>−</button>
                <input
                    className={styles.qtyInput}
                    aria-label='數量（股）'
                    title='美股只能整股，單位：股'
                    value={qty}
                    inputMode='numeric'
                    onChange={e => setQty(e.target.value.replace(/\D/g, ''))}
                />
                <button className={styles.stepBtn} aria-label='增加 1 股' onClick={() => setQty(q => String((Number(q) || 0) + 1))}>＋</button>
                <span className={styles.qtyUnit}>股</span>
                <span className={styles.rowBreak} aria-hidden />
                <button
                    className={styles.armBtn[armed ? 'on' : 'off']}
                    disabled={!!blockReason}
                    title={blockReason ?? undefined}
                    onClick={() => setArmedFor(armed ? null : armKey)}
                >
                    {!live ? '⚠ 行情或交易狀態未連線'
                        : armed ? <><Zap size={10} style={{ verticalAlign: '-1px' }} /> 點價即下單</>
                        : '啟用閃電下單'}
                </button>
            </div>
            <div className={styles.headRow}>
                <span>買單</span>
                <span>買量</span>
                <button
                    type='button'
                    className={styles.headPrice[follow ? 'on' : 'off']}
                    title={follow ? '自動跟隨現價中 — 點擊固定' : '已固定 — 點擊恢復跟隨'}
                    onClick={() => { if (follow) setFollow(false); else recenter(); }}
                >
                    {follow ? <LocateFixed size={10} aria-hidden /> : <Locate size={10} aria-hidden />}價格
                </button>
                <span>賣量</span>
                <span>賣單</span>
            </div>
            <div
                ref={bodyRef}
                className={styles.ladderBody}
                onMouseEnter={() => { hoverRef.current = true; }}
                onMouseLeave={() => { hoverRef.current = false; }}
                onDoubleClick={recenter}
            >
                {(rows.length === 0 || paused) && <div className={styles.waiting}>{paused ?? '等待報價…'}</div>}
                {!paused && rows.map(price => {
                    const isLast = lastIdx !== -1 && rows[lastIdx] === price;
                    const bid = bidPrice === price ? bidVol : undefined;
                    const ask = askPrice === price ? askVol : undefined;
                    const w = working.get(price);
                    const text = fmtUsPrice(price);
                    return (
                        <div key={price} data-price={price}
                            className={`${styles.row[isLast ? 'last' : 'normal']} ${bid !== undefined ? us.bestBid : ''} ${ask !== undefined ? us.bestAsk : ''}`}>
                            <div className={styles.chipCell}>
                                {w && decIsPositive(w.buy) && (
                                    <button className={styles.orderChip.buy} data-testid='flash-us-chip-buy'
                                        title={`刪除 ${text} 買單 ${fmtDec(w.buy)} 股`} onClick={() => void cancelAt('buy', price)}>
                                        {fmtDec(w.buy)}
                                    </button>
                                )}
                            </div>
                            <div
                                className={`${styles.buyCell} ${cellOk ? '' : styles.disabledCell}`}
                                data-side='buy'
                                title={blockReason ?? (!armed ? '先啟用閃電下單' : `限價買 ${text}（DAY）`)}
                                onClick={() => void send('Buy', price)}
                            >
                                {bid !== undefined && <div className={styles.volBarBid} style={{ width: `${(bid / maxVol) * 90}%` }} />}
                                <span className={styles.cellText}>{bid !== undefined ? vol(bid) : ''}</span>
                            </div>
                            <div className={styles.priceCell}>
                                {text}
                                {isLast && lastVol > 0 && <span className={styles.lastVol}>×{vol(lastVol)}</span>}
                            </div>
                            <div
                                className={`${styles.sellCell} ${cellOk ? '' : styles.disabledCell}`}
                                data-side='sell'
                                title={blockReason ?? (!armed ? '先啟用閃電下單' : `限價賣 ${text}（DAY）`)}
                                onClick={() => void send('Sell', price)}
                            >
                                {ask !== undefined && <div className={styles.volBarAsk} style={{ width: `${(ask / maxVol) * 90}%` }} />}
                                <span className={styles.cellText}>{ask !== undefined ? vol(ask) : ''}</span>
                            </div>
                            <div className={styles.chipCell}>
                                {w && decIsPositive(w.sell) && (
                                    <button className={styles.orderChip.sell} data-testid='flash-us-chip-sell'
                                        title={`刪除 ${text} 賣單 ${fmtDec(w.sell)} 股`} onClick={() => void cancelAt('sell', price)}>
                                        {fmtDec(w.sell)}
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
                {!paused && last !== null && lastIdx === -1 && rows.length > 0 && (
                    <button className={styles.jumpBtn[lastAbove ? 'top' : 'bottom']} onClick={recenter}>
                        {lastAbove ? '▲' : '▼'} 現價 {fmtUsPrice(last)}
                    </button>
                )}
            </div>
            <div className={styles.hint}>
                {armed
                    ? `點買量=限價買 ${qty || 0} 股（DAY） · 點賣量=限價賣 · 點單量=刪單 · Esc 鎖定`
                    : '安全鎖定中 — 點「啟用閃電下單」解鎖 · 美股只限價整股 · 滾輪捲動 · 雙擊置中'}
            </div>
        </div>
    );
}
