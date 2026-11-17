// src/components/us-ticket-body.tsx — 下單面板（OrderTicket）的美股分支
//
// 台股、期貨、美股共用同一個下單面板：商品從自選股／連動／指令面板帶進來，
// 美股合約（region=US）由 OrderTicket 轉到這裡。只走美股路徑：
// H 帳戶、DAY／ATC、限價／市價（ATC 只能限價）、整股、Decimal 價格（最多 4 位），
// 不碰台股的 placeStockOrder／checkOrderAllowed／零股／信用／當沖。
// 送單規則見 lib/us/us-order-rules.ts；Kill Switch 是美股唯一的風控檢查。

import { AlertTriangle, Globe, Info } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import { useAccounts } from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import { contractLinkKey } from '../lib/contract-key';
import { accountConfirmLabel, requestOrderConfirm } from '../lib/order-confirm';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { checkUsOrderAllowed, getRiskSettings } from '../lib/risk';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE } from '../lib/server-info-store';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Action } from '../lib/types/order';
import type { Account } from '../lib/types/portfolio';
import type { UsPriceType, UsTimeInForce } from '../lib/types/us';
import { decMul, decNormalize, decRound, fmtDec, fmtUsPrice } from '../lib/us/decimal';
import { placeUsOrder, usErrorText } from '../lib/us/us-api';
import { getUsTickMeta, US_SESSION_LABEL } from '../lib/us/us-quotes';
import {
    buildUsOrderReq,
    US_PRICE_MAX_DECIMALS,
    US_PRICE_TYPE_LABEL,
    US_PRICE_TYPES,
    US_TIME_IN_FORCE_ENABLED,
    US_TIME_IN_FORCE_LABEL,
    usOrderProblem,
    usPriceTypeAllowed,
} from '../lib/us/us-order-rules';
import { observeUsTrade } from '../lib/us/us-trading-state';
import * as panel from './panel.css';
import * as ticket from './order-ticket.css';
import * as styles from './us-ticket.css';

const acctKey = (a: Account) => `${a.broker_id}-${a.account_id}`;

function accountLabel(a: Account, priv: boolean) {
    return `${a.broker_id}-${maskAccountId(a.account_id, priv)}${a.username ? ` ${a.username}` : ''}`;
}

/** 價格輸入：只留數字與一個小數點，小數最多 4 位 */
export function sanitizeUsPriceInput(raw: string): string {
    const s = raw.replace(/[^\d.]/g, '');
    const dot = s.indexOf('.');
    if (dot < 0) return s;
    const int = s.slice(0, dot);
    const frac = s.slice(dot + 1).replace(/\./g, '').slice(0, US_PRICE_MAX_DECIMALS);
    return `${int}.${frac}`;
}

function UsBadge() {
    return (
        <span className={styles.marketBadge} title='美國股市（複委託）'>
            <Globe size={11} aria-hidden />
            美股
        </span>
    );
}

export function UsTicketBody({
    contract,
    onPlaced,
}: {
    contract: ContractInfo;
    onPlaced?: () => void;
}) {
    const code = contract.code;
    const exchange = contract.exchange;
    const linkKey = contractLinkKey(contract);
    const accounts = useAccounts();
    const priv = usePrivacyMode();
    const live = useTradingLive();
    const quote = useQuote(linkKey);
    const intlAccounts = useMemo(
        () => accounts.accounts.filter(a => a.account_type === 'H' && canTrade(a)),
        [accounts.accounts],
    );
    const [accountKey, setAccountKey] = useState('');
    const account = intlAccounts.find(a => acctKey(a) === accountKey)
        ?? (accounts.selectedIntl && intlAccounts.some(a => acctKey(a) === acctKey(accounts.selectedIntl!)) ? accounts.selectedIntl : null)
        ?? intlAccounts[0]
        ?? null;

    const [action, setAction] = useState<Action>('Buy');
    const [tif, setTif] = useState<UsTimeInForce>('DAY');
    const [priceType, setPriceType] = useState<UsPriceType>('LMT');
    const [price, setPrice] = useState('');
    const [qty, setQty] = useState('1');
    const [armed, setArmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    useEffect(() => {
        if (!usPriceTypeAllowed(tif, priceType)) setPriceType('LMT');
    }, [tif, priceType]);

    // 方向、時效、價別、價量、帳戶任一變動都要重新確認
    useEffect(() => { setArmed(false); }, [action, tif, priceType, price, qty, account ? acctKey(account) : '']);

    // 即時報價（美股只有最佳一檔）；第一筆 tick 前顯示前一日參考價
    const lastRaw = quote?.tick?.close;
    const last = lastRaw !== undefined && lastRaw !== null && String(lastRaw) !== '' ? decNormalize(String(lastRaw)) : null;
    const bid = quote?.bidask?.bid_price?.[0];
    const ask = quote?.bidask?.ask_price?.[0];
    const meta = last ? getUsTickMeta(linkKey) : undefined;
    const sessionLabel = meta ? US_SESSION_LABEL[meta.session] : '';
    const reference = contract.us_reference ?? null;
    const fillPrice = last ?? (reference ? decNormalize(reference) : null);
    const suspended = !!contract.trading_suspended;

    const draft = { action, quantity: qty, priceType, timeInForce: tif, price };
    const problem = usOrderProblem(draft);
    const estimate = priceType === 'LMT' && !problem ? decMul(price.trim(), qty.trim()) : null;

    const execute = async () => {
        if (!account) return;
        if (!armed) { setArmed(true); setFeedback(null); return; }
        setArmed(false);
        setBusy(true);
        const sameServerMode = captureServerMode();
        const orderAccount = account;
        try {
            const blocked = checkUsOrderAllowed();
            if (blocked) throw new Error(blocked);
            if (problem) throw new Error(problem);
            if (!exchange) throw new Error('尚未取得這檔的交易所，請稍候再試');
            if (suspended) throw new Error(`${code} 暫停交易`);
            const order = buildUsOrderReq(draft);
            if (getRiskSettings().confirmManualOrders) {
                const approved = await requestOrderConfirm({
                    code,
                    name: contract.name,
                    action,
                    price: priceType === 'LMT' ? Number(order.price) : null,
                    priceLabel: priceType === 'LMT' ? `${order.price} USD` : undefined,
                    quantity: order.quantity,
                    unit: '股',
                    note: `美股・${US_TIME_IN_FORCE_LABEL[tif]}・${US_PRICE_TYPE_LABEL[priceType]}`,
                    accountLabel: `${accountConfirmLabel(orderAccount)}（複委託）`,
                }, { serverMode: sameServerMode });
                if (!approved) throw new Error('已取消下單');
            }
            if (!sameServerMode()) throw new Error(SERVER_MODE_CHANGED_MESSAGE);
            const trade = await placeUsOrder({ code, exchange }, order, orderAccount, {
                beforeDispatch: () => {
                    if (!sameServerMode()) throw Object.assign(new Error(SERVER_MODE_CHANGED_MESSAGE), { tradingGateRejected: true });
                    // 確認視窗期間可能啟動了 Kill Switch：送出前一刻再查一次
                    const lockedNow = checkUsOrderAllowed();
                    if (lockedNow) throw Object.assign(new Error(lockedNow), { tradingGateRejected: true });
                },
            });
            observeUsTrade(trade, orderAccount);
            setFeedback({ kind: 'ok', text: `委託已送出：${action === 'Buy' ? '買進' : '賣出'} ${code} ${order.quantity} 股 ${priceType === 'MKT' ? '市價' : `@ ${order.price}`}（${tif}）` });
            onPlaced?.();
        } catch (e) {
            const text = usErrorText(e);
            setFeedback({ kind: 'err', text });
            if (text !== '已取消下單') notify({ kind: 'err', title: `美股委託失敗 ${code}`, body: text });
        } finally {
            setBusy(false);
        }
    };

    const header = (
        <div className={styles.infoCard} aria-label='美股商品資訊'>
            <span className={styles.infoName}>{code}{contract.name && contract.name !== code ? ` ${contract.name}` : ''}</span>
            <span className={styles.header}><UsBadge /></span>
            <span className={styles.infoMeta}>{[exchange, contract.currency || 'USD'].filter(Boolean).join(' · ')}</span>
            {suspended ? <span className={`${styles.infoMeta} ${styles.warn}`} style={{ textAlign: 'right' }}>暫停交易</span> : <span />}
            <div className={styles.priceLine} aria-label='美股報價'>
                {last ? (
                    <>
                        <span className={styles.refValue}>{fmtUsPrice(last)}</span>
                        <span className={styles.quoteMeta}>
                            {[
                                sessionLabel,
                                bid || ask ? `買 ${bid ? fmtUsPrice(bid) : '—'} / 賣 ${ask ? fmtUsPrice(ask) : '—'}` : '',
                            ].filter(Boolean).join(' · ')}
                        </span>
                    </>
                ) : reference ? (
                    <span className={styles.refLabel}>參考 {fmtUsPrice(reference)}{contract.reference_date ? `（${contract.reference_date}）` : ''}</span>
                ) : (
                    <span className={styles.refLabel}>尚無報價</span>
                )}
            </div>
        </div>
    );

    if (!intlAccounts.length) {
        return (
            <div className={ticket.body}>
                {header}
                <div className={styles.notice}><Info size={14} aria-hidden />沒有可交易的複委託（H）帳戶。開通美股複委託並簽署後，重新整理帳號即可使用。</div>
            </div>
        );
    }

    const stepQty = (d: number) => setQty(q => String(Math.max(1, (Number(q) || (d > 0 ? 0 : 1)) + d)));

    return (
        <div className={ticket.body}>
            {header}

            <div className={ticket.fieldRow}>
                <span className={ticket.fieldLabel}>帳戶</span>
                {intlAccounts.length > 1 ? (
                    <select
                        className={styles.accountSelect}
                        aria-label='複委託帳戶'
                        value={account ? acctKey(account) : ''}
                        onChange={e => setAccountKey(e.target.value)}
                    >
                        {intlAccounts.map(a => (
                            <option key={acctKey(a)} value={acctKey(a)}>{accountLabel(a, priv)}</option>
                        ))}
                    </select>
                ) : account && <span className={styles.infoMeta}>{accountLabel(account, priv)}（複委託）</span>}
            </div>

            <div className={ticket.sideTabs}>
                <button className={ticket.buyTab[action === 'Buy' ? 'on' : 'off']} onClick={() => setAction('Buy')}>買進</button>
                <button className={ticket.sellTab[action === 'Sell' ? 'on' : 'off']} onClick={() => setAction('Sell')}>賣出</button>
            </div>

            <div className={ticket.fieldRow}>
                <span className={ticket.fieldLabel}>時效</span>
                <div className={ticket.segGroup}>
                    {US_TIME_IN_FORCE_ENABLED.map(t => (
                        <button key={t} className={ticket.seg[tif === t ? 'on' : 'off']} onClick={() => setTif(t)} title={US_TIME_IN_FORCE_LABEL[t]}>
                            {t}
                        </button>
                    ))}
                </div>
            </div>

            <div className={ticket.fieldRow}>
                <span className={ticket.fieldLabel}>價別</span>
                <div className={ticket.segGroup}>
                    {US_PRICE_TYPES.map(p => {
                        const allowed = usPriceTypeAllowed(tif, p);
                        return (
                            <button
                                key={p}
                                className={ticket.seg[priceType === p ? 'on' : 'off']}
                                disabled={!allowed}
                                title={allowed ? undefined : 'ATC 只能限價'}
                                onClick={() => setPriceType(p)}
                            >
                                {US_PRICE_TYPE_LABEL[p]}
                            </button>
                        );
                    })}
                </div>
            </div>

            {priceType === 'LMT' && (
                <div className={ticket.fieldRow}>
                    <span className={ticket.fieldLabel}>價格</span>
                    <input
                        className={ticket.numInput}
                        inputMode='decimal'
                        aria-label='價格（USD）'
                        placeholder={fillPrice ? `${last ? '市價' : '參考'} ${fmtUsPrice(fillPrice)}` : 'USD'}
                        value={price}
                        onChange={e => setPrice(sanitizeUsPriceInput(e.target.value))}
                    />
                    {fillPrice && (
                        <button
                            className={styles.smallBtn}
                            onClick={() => setPrice(fillPrice)}
                            title={last ? '帶入最新成交價' : '帶入前一日參考價'}
                        >
                            {last ? '市價帶入' : '參考價'}
                        </button>
                    )}
                    <span className={styles.unit}>USD</span>
                </div>
            )}

            <div className={ticket.fieldRow}>
                <span className={ticket.fieldLabel}>數量</span>
                <button className={ticket.stepBtn} aria-label='減少 1 股' onClick={() => stepQty(-1)}>-</button>
                <input
                    className={ticket.numInput}
                    inputMode='numeric'
                    aria-label='數量（股）'
                    value={qty}
                    onChange={e => setQty(e.target.value.replace(/\D/g, ''))}
                />
                <button className={ticket.stepBtn} aria-label='增加 1 股' onClick={() => stepQty(1)}>+</button>
                <span className={styles.unit}>股</span>
            </div>

            <div className={ticket.costRow}>
                {estimate ? `預估金額 ${fmtDec(decRound(estimate, 2), { minFraction: 2 })} USD（不含手續費）` : priceType === 'MKT' ? '市價單以成交價計算' : ' '}
            </div>

            <div className={styles.notice}>
                <AlertTriangle size={14} aria-hidden className={styles.warn} />
                美股 Beta：只能整股、限價或市價，ATC 只能限價；改價會先刪單再重下。
            </div>

            <button
                className={ticket.execBtn[armed ? 'armed' : action === 'Buy' ? 'buy' : 'sell']}
                onClick={execute}
                disabled={busy || !live || !account || !!problem || suspended || !exchange}
                title={problem ?? undefined}
            >
                {!live
                    ? '交易連線中斷，暫停下單'
                    : busy
                      ? '傳送中…'
                      : suspended
                        ? `${code} 暫停交易`
                        : armed
                          ? `確認${action === 'Buy' ? '買進' : '賣出'} ${code} ${qty} 股 ${priceType === 'MKT' ? '市價' : `@ ${price}`}`
                          : `${action === 'Buy' ? '買進' : '賣出'}下單`}
            </button>
            {problem && (price.trim() !== '' || priceType === 'MKT') && <span className={`${ticket.feedback} ${panel.statusText.err}`}>{problem}</span>}
            {feedback && <span className={`${ticket.feedback} ${panel.statusText[feedback.kind]}`}>{feedback.text}</span>}
        </div>
    );
}
