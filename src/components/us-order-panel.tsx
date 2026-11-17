// src/components/us-order-panel.tsx — 美股下單面板（closed beta）
//
// 自帶美股商品搜尋，不跟隨台股的全域選股：美股商品永遠不會流進 K 線、
// 五檔、閃電、grid、括號單、觸價等台股面板。這版沒有美股即時報價，
// 只顯示 info 的前一日參考價。
//
// 送單規則見 lib/us/us-order-rules.ts；帳戶只用 H，一律明確帶 account_type。

import { AlertTriangle, Globe, Info } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccounts } from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import { useTradingLive } from '../hooks/use-stream';
import { useUsCatalog } from '../hooks/use-us-contracts';
import { accountConfirmLabel, requestOrderConfirm } from '../lib/order-confirm';
import { usePrivacyMode, maskAccountId } from '../lib/privacy';
import { checkUsOrderAllowed, getRiskSettings } from '../lib/risk';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE } from '../lib/server-info-store';
import { notify } from '../lib/trade';
import type { Action } from '../lib/types/order';
import type { Account } from '../lib/types/portfolio';
import type { UsPriceType, UsTimeInForce } from '../lib/types/us';
import { decMul, decRound, fmtDec } from '../lib/us/decimal';
import { placeUsOrder, usErrorText } from '../lib/us/us-api';
import { cachedUsInfo, getUsContractRecord, loadUsInfo, searchUsCodes, usContractName } from '../lib/us/us-contracts';
import { buildUsOrderReq, US_PRICE_TYPE_LABEL, US_PRICE_TYPES, US_TIME_IN_FORCE_ENABLED, US_TIME_IN_FORCE_LABEL, usOrderProblem, usPriceTypeAllowed } from '../lib/us/us-order-rules';
import { observeUsTrade } from '../lib/us/us-trading-state';
import * as panel from './panel.css';
import * as ticket from './order-ticket.css';
import * as styles from './us-order-panel.css';

const VISIBLE_SUGGESTIONS = 8;

export function UsMarketBadge() {
    return (
        <span className={styles.marketBadge} title='美國股市（複委託）'>
            <Globe size={11} aria-hidden />
            美股
        </span>
    );
}

function accountLabel(a: Account, priv: boolean) {
    return `${a.broker_id}-${maskAccountId(a.account_id, priv)}${a.username ? ` ${a.username}` : ''}`;
}

export function UsOrderPanel() {
    const accounts = useAccounts();
    const priv = usePrivacyMode();
    const live = useTradingLive();
    const { status: catalog } = useUsCatalog();
    const intlAccounts = useMemo(() => accounts.accounts.filter(a => a.account_type === 'H' && canTrade(a)), [accounts.accounts]);
    const [accountKey, setAccountKey] = useState<string>('');
    const account = intlAccounts.find(a => `${a.broker_id}-${a.account_id}` === accountKey)
        ?? accounts.selectedIntl ?? intlAccounts[0] ?? null;

    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const [code, setCode] = useState<string | null>(null);
    const [infoError, setInfoError] = useState<string | null>(null);

    const [action, setAction] = useState<Action>('Buy');
    const [tif, setTif] = useState<UsTimeInForce>('DAY');
    const [priceType, setPriceType] = useState<UsPriceType>('LMT');
    const [price, setPrice] = useState('');
    const [qty, setQty] = useState('1');
    const [armed, setArmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const hits = useMemo(() => (open ? searchUsCodes(query, VISIBLE_SUGGESTIONS) : []), [open, query, catalog]);
    // 只對看得到的幾筆查名稱（限流與每日快取在 us-contracts）
    useEffect(() => {
        for (const h of hits) void loadUsInfo(h.code).catch(() => undefined);
    }, [hits]);

    // 選取時重查一次參考價（force），名稱與交易所也以 info 為準
    useEffect(() => {
        if (!code) return;
        setInfoError(null);
        let alive = true;
        loadUsInfo(code, { force: !cachedUsInfo(code) }).catch(e => {
            if (alive) setInfoError(`查不到 ${code} 的商品資訊：${usErrorText(e)}`);
        });
        return () => { alive = false; };
    }, [code]);

    useEffect(() => {
        if (!usPriceTypeAllowed(tif, priceType)) setPriceType('LMT');
    }, [tif, priceType]);

    // 換商品、方向、帳戶都要重新確認
    useEffect(() => { setArmed(false); }, [code, action, tif, priceType, price, qty, account?.account_id]);

    const info = code ? cachedUsInfo(code) : undefined;
    const record = code ? getUsContractRecord(code) : undefined;
    const exchange = info?.exchange ?? record?.exchange ?? null;
    const name = code ? usContractName(code) : undefined;

    const pick = (next: string) => {
        setCode(next);
        setQuery(next);
        setOpen(false);
        setPrice('');
        setFeedback(null);
    };

    const draft = { action, quantity: qty, priceType, timeInForce: tif, price };
    const problem = usOrderProblem(draft);
    const estimate = priceType === 'LMT' && !problem ? decMul(price.trim(), qty.trim()) : null;

    const execute = async () => {
        if (!account || !code) return;
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
            if (info?.tradingSuspended) throw new Error(`${code} 暫停交易`);
            const order = buildUsOrderReq(draft);
            if (getRiskSettings().confirmManualOrders) {
                const approved = await requestOrderConfirm({
                    code,
                    name,
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
                },
            });
            observeUsTrade(trade, orderAccount);
            setFeedback({ kind: 'ok', text: `委託已送出：${action === 'Buy' ? '買進' : '賣出'} ${code} ${order.quantity} 股 ${priceType === 'MKT' ? '市價' : `@ ${order.price}`}（${tif}）` });
        } catch (e) {
            const text = usErrorText(e);
            setFeedback({ kind: 'err', text });
            if (text !== '已取消下單') notify({ kind: 'err', title: `美股委託失敗 ${code}`, body: text });
        } finally {
            setBusy(false);
        }
    };

    if (!intlAccounts.length) {
        return (
            <div className={ticket.body}>
                <div className={styles.header}><UsMarketBadge /></div>
                <div className={styles.notice}><Info size={14} aria-hidden />沒有可交易的複委託（H）帳戶。開通美股複委託並簽署後，重新整理帳號即可使用。</div>
            </div>
        );
    }
    if (catalog === 'unsupported') {
        return (
            <div className={ticket.body}>
                <div className={styles.header}><UsMarketBadge /></div>
                <div className={styles.notice}><Info size={14} aria-hidden />目前的交易伺服器版本尚未提供美股商品，請更新到支援美股的版本。</div>
            </div>
        );
    }

    return (
        <div className={ticket.body}>
            <div className={styles.header}>
                <UsMarketBadge />
                {intlAccounts.length > 1 ? (
                    <select
                        className={styles.accountSelect}
                        aria-label='複委託帳戶'
                        value={account ? `${account.broker_id}-${account.account_id}` : ''}
                        onChange={e => setAccountKey(e.target.value)}
                    >
                        {intlAccounts.map(a => (
                            <option key={`${a.broker_id}-${a.account_id}`} value={`${a.broker_id}-${a.account_id}`}>{accountLabel(a, priv)}</option>
                        ))}
                    </select>
                ) : account && <span className={styles.infoMeta}>{accountLabel(account, priv)}（複委託）</span>}
            </div>

            <div className={ticket.fieldRow}>
                <span className={ticket.fieldLabel}>商品</span>
                <div className={styles.searchWrap}>
                    <input
                        className={styles.searchInput}
                        value={query}
                        placeholder={catalog === 'ready' ? '輸入美股代碼，如 AAPL' : '載入美股清單中…'}
                        disabled={catalog !== 'ready'}
                        aria-label='美股代碼'
                        spellCheck={false}
                        onChange={e => { setQuery(e.target.value.toUpperCase()); setOpen(true); setHighlight(0); }}
                        onFocus={() => setOpen(true)}
                        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
                        onKeyDown={e => {
                            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, hits.length - 1)); }
                            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
                            else if (e.key === 'Enter' && hits[highlight]) { e.preventDefault(); pick(hits[highlight]!.code); }
                            else if (e.key === 'Escape') setOpen(false);
                        }}
                    />
                    {open && hits.length > 0 && (
                        <ul className={styles.suggestions} role='listbox' aria-label='美股代碼建議'>
                            {hits.map((h, i) => (
                                <li key={h.code}>
                                    <button
                                        type='button'
                                        role='option'
                                        aria-selected={i === highlight}
                                        className={styles.suggestion[i === highlight ? 'on' : 'off']}
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() => { if (blurTimer.current) clearTimeout(blurTimer.current); pick(h.code); }}
                                    >
                                        <span className={styles.suggestionCode}>{h.code}</span>
                                        <span className={styles.suggestionName}>{usContractName(h.code) ?? ''}</span>
                                        <span className={styles.suggestionExchange}>{h.exchange}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {code && (
                <div className={styles.infoCard} aria-label='美股商品資訊'>
                    <span className={styles.infoName}>{code}{name ? ` ${name}` : ''}</span>
                    <span className={styles.refLabel}>參考價（前一日）</span>
                    <span className={styles.infoMeta}>{[exchange, info?.currency ?? 'USD'].filter(Boolean).join(' · ')}</span>
                    <span className={styles.refValue}>{info?.reference ? fmtDec(info.reference, { minFraction: 2 }) : '—'}</span>
                    {info?.referenceDate && <span className={styles.infoMeta} style={{ gridColumn: '1 / -1', textAlign: 'right' }}>{info.referenceDate}</span>}
                    {info?.tradingSuspended && <span className={`${styles.infoMeta} ${styles.warn}`} style={{ gridColumn: '1 / -1' }}>暫停交易</span>}
                    {infoError && <span className={`${styles.infoMeta} ${styles.warn}`} style={{ gridColumn: '1 / -1' }}>{infoError}</span>}
                </div>
            )}

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
                        placeholder={info?.reference ? `參考 ${info.reference}` : 'USD'}
                        value={price}
                        onChange={e => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
                    />
                    {info?.reference && (
                        <button className={styles.smallBtn} onClick={() => setPrice(info.reference!)} title='帶入前一日參考價'>參考價</button>
                    )}
                </div>
            )}

            <div className={ticket.fieldRow}>
                <span className={ticket.fieldLabel}>數量</span>
                <button className={ticket.stepBtn} aria-label='減少 1 股' onClick={() => setQty(q => String(Math.max(1, (Number(q) || 1) - 1)))}>-</button>
                <input
                    className={ticket.numInput}
                    inputMode='numeric'
                    aria-label='數量（股）'
                    value={qty}
                    onChange={e => setQty(e.target.value.replace(/\D/g, ''))}
                />
                <button className={ticket.stepBtn} aria-label='增加 1 股' onClick={() => setQty(q => String((Number(q) || 0) + 1))}>+</button>
                <span className={styles.unit}>股</span>
            </div>

            <div className={ticket.costRow}>
                {estimate ? `預估金額 ${fmtDec(decRound(estimate, 2), { minFraction: 2 })} USD（不含手續費）` : priceType === 'MKT' ? '市價單以成交價計算' : ' '}
            </div>

            <div className={styles.notice}>
                <AlertTriangle size={14} aria-hidden className={styles.warn} />
                美股 Beta：沒有即時報價，價格以前一日參考價為準；只能整股、限價或市價，改價會先刪單再重下。
            </div>

            <button
                className={ticket.execBtn[armed ? 'armed' : action === 'Buy' ? 'buy' : 'sell']}
                onClick={execute}
                disabled={busy || !live || !code || !account || !!problem}
                title={problem ?? undefined}
            >
                {!live
                    ? '交易連線中斷，暫停下單'
                    : busy
                      ? '傳送中…'
                      : !code
                        ? '請先選擇美股商品'
                        : armed
                          ? `確認${action === 'Buy' ? '買進' : '賣出'} ${code} ${qty} 股 ${priceType === 'MKT' ? '市價' : `@ ${price}`}`
                          : `${action === 'Buy' ? '買進' : '賣出'}下單`}
            </button>
            {code && problem && (price.trim() !== '' || priceType === 'MKT') && <span className={`${ticket.feedback} ${panel.statusText.err}`}>{problem}</span>}
            {feedback && <span className={`${ticket.feedback} ${panel.statusText[feedback.kind]}`}>{feedback.text}</span>}
        </div>
    );
}
