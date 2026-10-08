// src/components/settings-test-order.tsx — 模擬環境的下單通路測試：
// 兩列各選一個商品（預設 2890 / TXFR1），送 1 張／1 口限價 ROD 買單。用於
// 測試送單回應速度；送出當下再守一次 env，與設定視窗是否顯示無關。
// 結果優先顯示列內；切分頁或關閉設定視窗卸載元件後才走 notify；
// 送出中旗標放模組層，重掛後按鈕仍停用。
// 商品框打字只搜尋；從清單選取後才換掉送單對象與行情訂閱。框內還有沒選取的
// 字時不准送出；Tab／失焦保留文字，只有明確選取或 Esc 才解除搜尋。

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { CircleCheck, CircleX, RefreshCw, Search, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { isImeKey } from './chart-drawing-tools';
import { Orb } from './orb';
import { ExternalLink } from './external-link';
import { SIGNING_URLS } from '../lib/account-signing';
import { ensureContract, primeContract, useContract } from '../lib/contracts-cache';
import {
    ACCOUNT_CHANGED_MESSAGE,
    captureSelectedAccount,
    isSelectedAccountUnchanged,
} from '../lib/order-account';
import { searchProducts, type ProductSuggestion } from '../lib/product-search';
import { currentProtectionEnv } from '../lib/protection-env';
import { notify, placeQuickOrder } from '../lib/trade';
import { roundToTick } from '../lib/utils/ticksize';
import { fetchSnapshots } from '../lib/shioaji';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import { getAccountState, refreshAccounts, useAccounts } from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import { useServerInfo } from '../lib/server-info-store';
import { useEscClose } from '../hooks/use-esc-close';
import { useQuery } from '../hooks/use-query';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import * as hud from './hud-header.css';
import * as s from './settings-test-order.css';

// searchProducts 對「台指」只回小台、「小台／微台」直接回空，補一張別名表
// （比對前剝掉「期／期貨／月」尾巴，「小台指／大台指次」再正規化成「小台／大台次」）
const FUT_ALIASES: Record<string, string> = {
    台指: 'TXFR1', 台指近: 'TXFR1', 大台: 'TXFR1', 大台近: 'TXFR1',
    台指次: 'TXFR2', 大台次: 'TXFR2',
    小台: 'MXFR1', 小台近: 'MXFR1', 小台次: 'MXFR2',
    微台: 'TMFR1', 微台近: 'TMFR1', 微台次: 'TMFR2',
};
const ALIAS_LABELS: Record<string, string> = {
    TXFR1: '台指近', TXFR2: '台指次', MXFR1: '小台近', MXFR2: '小台次', TMFR1: '微台近', TMFR2: '微台次',
};
// 月份契約全名「小型臺指期貨 202610」在清單（與商品框同寬）放不下，會被截在月份前；
// 改用別名語彙「小台 202610」。其他商品（含個股期「台積電期貨」）維持全名
const ROOT_ALIAS: Record<string, string> = { TXF: '台指', MXF: '小台', TMF: '微台' };
const shortName = (x: { code: string; name: string }) => {
    const root = ROOT_ALIAS[x.code.slice(0, 3)];
    const month = /\d{6}$/.exec(x.name)?.[0];
    return ALIAS_LABELS[x.code] ?? (root && month ? `${root} ${month}` : x.name);
};

type Product = { code: string; label: string; name: string; security_type: SecurityType };
type Market = 'S' | 'F';
const inMarket = (x: { security_type: SecurityType; combo?: unknown }, market: Market) =>
    tradable(x) && accountTypeOf(x.security_type) === market;
const DEFAULTS: Product[] = [
    { code: '2890', label: '永豐金', name: '永豐金', security_type: 'STK' },
    { code: 'TXFR1', label: ALIAS_LABELS.TXFR1!, name: '臺股期貨', security_type: 'FUT' },
];
const accountTypeOf = (t: SecurityType) => (t === 'STK' ? 'S' : t === 'FUT' || t === 'OPT' ? 'F' : null);
const unitOf = (t: SecurityType) => (t === 'STK' ? '張' : '口');
const tradable = (x: { security_type: SecurityType; combo?: unknown }) => !!accountTypeOf(x.security_type) && !x.combo;
const MAX_SUGGESTIONS = 8;

// 兩列共用、跨卸載：同時只送一筆，第二列不會撞上第一列還開著的確認視窗；
// 切走再切回來（元件重掛）也還知道有一筆在路上
// ponytail: 不設自動解鎖（結果未知不重送）；某個 await 永遠不回（例如合約查詢卡住）時要 reload 才解開
let sending = false;
const sendingListeners = new Set<() => void>();
const setSending = (b: boolean) => {
    sending = b;
    sendingListeners.forEach((l) => l());
};
const subscribeSending = (l: () => void) => {
    sendingListeners.add(l);
    return () => {
        sendingListeners.delete(l);
    };
};
const getSending = () => sending;

// failed：有查詢出錯。清單空的時候不能說成「找不到」（可能只是 sidecar 斷線）
async function suggest(q: string, market: Market): Promise<{ items: ProductSuggestion[]; failed: boolean }> {
    const norm = q.replace(/臺/g, '台');
    // 不做反向前綴（「台指選擇權」會命中台指期）；剝完是空字串（只打「期」）就不剝
    const key = (norm.replace(/(期貨|期|月)$/, '') || norm).replace(/^([大小微])台指/, '$1台');
    const aliasCodes = market === 'S' ? [] : [...new Set(Object.entries(FUT_ALIASES).filter(([k]) => k.startsWith(key)).map(([, c]) => c))];
    let failed = false;
    const lost = <T,>(fallback: T) => () => {
        failed = true;
        return fallback;
    };
    const [aliased, found] = await Promise.all([
        Promise.all(aliasCodes.map((c) => ensureContract(c, 'FUT').catch(lost(null)))),
        searchProducts(q, MAX_SUGGESTIONS).catch(lost<ProductSuggestion[]>([])),
    ]);
    const head = aliased
        .filter((c): c is ContractInfo => !!c)
        .map((c): ProductSuggestion => ({ code: c.code, name: c.name, security_type: 'FUT', exchange: c.exchange ?? '', detail: '期貨', contract: c }));
    const seen = new Set<string>();
    const items = [...head, ...found]
        .filter((x) => {
            if (seen.has(x.code) || !inMarket(x, market) || (x.contract && !inMarket(x.contract, market))) return false;
            seen.add(x.code);
            return true;
        })
        .slice(0, MAX_SUGGESTIONS);
    return { items, failed };
}

// unknown：結果未知（勿重送），不能被打字、改價清掉
type RowState = {
    phase: 'idle' | 'loading' | 'ok' | 'error' | 'unknown';
    text: string;
    receipt?: { price: number; unit: string; orderId: string; elapsedMs?: number };
};
const IDLE: RowState = { phase: 'idle', text: '' };
// 依固定市場列保存未決結果；換商品、切分頁及卸載皆不能解除。
let unresolved: Partial<Record<Market, RowState>> = {};
const unresolvedListeners = new Set<() => void>();
const subscribeUnresolved = (l: () => void) => { unresolvedListeners.add(l); return () => { unresolvedListeners.delete(l); }; };
const getUnresolved = () => unresolved;
function setUnresolved(market: Market, value?: RowState) {
    unresolved = { ...unresolved, [market]: value };
    unresolvedListeners.forEach(l => l());
}
function SearchEscClose({ cancel }: { cancel: () => void }) {
    useEscClose(cancel);
    return null;
}
const quoteTime = (value?: string) => {
    const time = value ? Date.parse(value.replace(' ', 'T')) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
};

const STATUS_CLASS: Partial<Record<RowState['phase'], string>> = { error: s.statusError, unknown: s.statusUnknown, ok: s.statusOk };
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
// 全形數字與千分位逗號先轉成一般數字，再擋掉其他字元
const normalizePrice = (v: string) =>
    v.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, '');
// 只整理顯示：不轉換原始輸入，也不丟失小數尾零或尚未完成的小數點。
const displayPrice = (value: string | number) => {
    const [integer, ...fraction] = String(value).split('.');
    return integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction.length ? `.${fraction.join('.')}` : '');
};

function TestOrderRow({ initial, busy, live }: { initial: Product; busy: boolean; live: boolean }) {
    const market: Market = initial.security_type === 'STK' ? 'S' : 'F';
    const marketLabel = market === 'S' ? '證券' : '期貨';
    const accounts = useAccounts();
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const simulation = useServerInfo()?.simulation === true;
    const pending = useSyncExternalStore(subscribeUnresolved, getUnresolved)[market];
    const [selected, setSelected] = useState(initial);
    // null = 沒在打字，框內顯示 selected 的名稱
    const [query, setQuery] = useState<string | null>(null);
    const [result, setResult] = useState<{ q: string; items: ProductSuggestion[]; failed: boolean } | null>(null);
    const [active, setActive] = useState(0);
    const listId = useId();
    const statusId = useId();
    const srcId = useId();
    const productId = useId();
    const productInputId = useId();
    const priceInputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const priceRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    // 點進框時全選名稱，直接打字就是新搜尋；WebKit 的 mouseup 會把 focus 時的
    // 全選改回游標，所以「這一下點擊才聚焦」時擋掉那次 mouseup
    const focusClick = useRef(false);
    // 注音組字中（ㄊㄞˊ…）不搜尋，否則停頓就會閃「找不到」
    const [composing, setComposing] = useState(false);

    const q = query?.trim() ?? '';
    useEffect(() => {
        if (!q) {
            setResult(null);
            return;
        }
        if (composing) return;
        let live = true;
        const timer = setTimeout(() => {
            void suggest(q, market).then((r) => {
                if (!live) return;
                setResult({ q, ...r });
                setActive(0);
            });
        }, 150);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [q, composing, market]);
    const items = q && result?.q === q && !composing ? result.items : [];
    // 事件處理函式即使來自舊 render，仍比對最新輸入與組字狀態。
    const searchRef = useRef({ q, composing });
    searchRef.current = { q, composing };
    const expanded = items.length > 0;
    // 清單往上展開；設定內容捲到底、上方空間不夠時（矮視窗、帳戶多）把清單捲進可視範圍
    useEffect(() => {
        if (expanded) listRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, [expanded, items.length]);
    // 只有這次查詢真的回來了才下結論（新查詢未回來時不閃上一次的「找不到」）
    const emptyMsg = q && result?.q === q && !composing && !expanded
        ? (result.failed
            ? '搜尋失敗（伺服器沒有回應），請稍後再打一次'
            : `找不到「${q}」。可打代碼（2890）、名稱或簡稱（台指、小台、微台）；指數、權證、組合商品不支援測試單`)
        : '';

    const cachedContract = useContract(selected.code);
    const tick = useQuote(selected.code)?.tick;
    const tickClose = Number(tick?.close);
    // 收盤後沒有 tick 推播時的成交價來源：每個商品查一次快照（session 內不重查，
    // 失敗時使用者點進價位框才再查一次）
    // 連續月 TXFR1 的快照 code 是實際月份（target_code，如 TXFJ6），兩個都比對
    const { code, security_type } = selected;
    const { data: snap, error: snapError, refresh: refreshSnap } = useQuery<{ close: number; datetime: string } | undefined>(
        useCallback(async () => {
            const c = await ensureContract(code, security_type);
            const snaps = await fetchSnapshots([c]);
            const found = snaps.find((x) => x.code === c.code || x.code === c.target_code);
            return found && { close: found.close, datetime: found.datetime };
        }, [code, security_type]),
        `settings-test-order-snap:${code}`,
    );
    const useTick = Number.isFinite(tickClose) && tickClose > 0 &&
        (!(snap && snap.close > 0) || quoteTime(`${tick?.date ?? ''}T${tick?.time ?? ''}`) >= quoteTime(snap.datetime));
    const last = useTick ? tickClose : snap && Number.isFinite(snap.close) && snap.close > 0 ? snap.close : undefined;
    const [edited, setEdited] = useState<string | null>(null);
    const [editingPrice, setEditingPrice] = useState(false);
    const price = edited ?? (last !== undefined ? String(last) : '');
    const [localState, setState] = useState<RowState>(IDLE);
    const state = pending ?? localState;
    // 條件已解除的錯誤不留在畫面上；結果未知例外
    const clearError = () => setState((st) => (st.phase === 'error' ? IDLE : st));
    // 選取後焦點仍在框內：全選新名稱，接著打字就是下一次搜尋
    useEffect(() => {
        const el = inputRef.current;
        if (el && el === document.activeElement) el.select();
    }, [selected]);

    const pick = (x: ProductSuggestion) => {
        if (searchRef.current.q !== result?.q || searchRef.current.composing || !inMarket(x, market) || (x.contract && !inMarket(x.contract, market))) return;
        if (x.contract) primeContract(x.contract);
        setSelected({ code: x.code, label: shortName(x), name: x.name, security_type: x.security_type });
        setQuery(null);
        setEdited(null);
        setState(IDLE);
    };
    // 不處理 Escape（KI-20：沒標記的 Esc 會被風控算成 Esc×2 全刪單的第一下）
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (!expanded || isImeKey(e)) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        } else if (e.key === 'Enter') {
            // 只有明確 Enter／點選才接受商品，Tab 與失焦保留搜尋文字。
            e.preventDefault();
            // 清單還是上一次查詢的結果（新查詢未回來）時不選，免得快打快按選錯商品
            if (result?.q === q) pick(items[active] ?? items[0]!);
        }
    };

    const fail = (target: Product, text: string, title?: string, phase: 'error' | 'unknown' = 'error') => {
        const next = { phase, text };
        if (phase === 'unknown') setUnresolved(market, next);
        setState(phase === 'unknown' ? IDLE : next);
        if (title && !mounted.current) notify({ kind: 'err', title, body: `${target.label} ${target.code}：${text}` });
    };
    const account = market === 'S' ? accounts.selectedStock : accounts.selectedFutures;
    const hasAccount = accounts.accounts.some(a => a.account_type === market);
    const available = !!account && account.account_type === market && accounts.accounts.some(a =>
        a.account_type === market && a.broker_id === account.broker_id && a.account_id === account.account_id);
    const signed = canTrade(account);
    const env = currentProtectionEnv();
    const value = Number(price);
    const invalidPrice = !Number.isFinite(value) || value <= 0 || (cachedContract && (
        roundToTick(cachedContract, value) !== value ||
        (cachedContract.limit_up > 0 && cachedContract.limit_down > 0 &&
            (value > cachedContract.limit_up || value < cachedContract.limit_down))
    ));
    const reason = !simulation || !env?.endsWith('|simulation') ? '非模擬環境'
        : !live ? '未連線'
        : !hasAccount ? `無${marketLabel}帳戶`
        : !available ? '未選帳戶'
        : !signed ? '帳戶未簽署'
        : busy ? '傳送中'
        : query !== null ? '請選商品'
        : price === '' ? '等待價格'
        : invalidPrice ? '請輸入價位'
        : pending ? '待核對' : null;
    const send = async () => {
        if (sending || getUnresolved()[market] || reason) return;
        const target = selected; // 點擊當下的商品；await 之後只比對、不換對象
        if (query !== null) return fail(target, '請先從清單選取商品');
        const env = currentProtectionEnv();
        if (!simulation || !env || !env.endsWith('|simulation')) return fail(target, '目前不是模擬環境，未送出');
        const accountType = accountTypeOf(target.security_type);
        if (!accountType) return fail(target, '此商品不支援測試單');
        const captured = captureSelectedAccount(accountType);
        if (!captured) return fail(target, `請先在上方「${accountType === 'S' ? '證券帳戶' : '期貨帳戶'}」選擇可下單的帳戶`);
        if (price === '') return fail(target, snapError ? '無法取得成交價，請手動輸入價位' : '尚未取得成交價，請稍候或手動輸入價位');
        const p = Number(price);
        if (!Number.isFinite(p) || p <= 0) return fail(target, '價位需為大於 0 的數字');
        setSending(true);
        setState({ phase: 'loading', text: '傳送中…' });
        try {
            let contract: ContractInfo;
            try {
                contract = await ensureContract(target.code, target.security_type);
            } catch (e) {
                return fail(target, `未送出：無法取得商品 ${target.code}：${errorMessage(e)}`, '測試單未送出');
            }
            if (contract.code !== target.code || contract.security_type !== target.security_type || !tradable(contract)) {
                return fail(target, '未送出：此商品不支援測試單', '測試單未送出');
            }
            const onTick = roundToTick(contract, p);
            if (onTick !== p) return fail(target, `未送出：價格不符合跳動單位（最近的是 ${onTick}）`, '測試單未送出');
            const { limit_up: up, limit_down: down } = contract;
            if (up > 0 && down > 0 && (p > up || p < down)) {
                return fail(target, `未送出：價格超出漲跌停（${down}～${up}）`, '測試單未送出');
            }
            try {
                let started: number | undefined;
                const trade = await placeQuickOrder(contract, 'Buy', p, 1, {
                    account: captured,
                    isAccountCurrent: () => isSelectedAccountUnchanged(captured),
                    beforeSend: () => {
                        if (!isSelectedAccountUnchanged(captured)) throw new Error(ACCOUNT_CHANGED_MESSAGE);
                        if (!env.endsWith('|simulation') || currentProtectionEnv() !== env) throw new Error('伺服器或模式已切換');
                        started = performance.now();
                    },
                });
                const receipt = {
                    price: p,
                    unit: unitOf(target.security_type),
                    orderId: trade.order.seqno || trade.order.id.slice(0, 8),
                    elapsedMs: started === undefined ? undefined : Math.round(performance.now() - started),
                };
                const text = `已送出：買進 1 ${receipt.unit} @ ${p}（委託 ${receipt.orderId}）${receipt.elapsedMs === undefined ? '' : ` · 回應 ${receipt.elapsedMs} ms`}`;
                setState({ phase: 'ok', text, receipt });
                if (!mounted.current) notify({ kind: 'ok', title: '測試單已送出', body: `${target.label} ${target.code}：${text}` });
            } catch (e) {
                if (e instanceof Error && e.name === 'OrderConfirmCancelled') setState(IDLE);
                else if ((e as { mutationNotStarted?: boolean })?.mutationNotStarted) fail(target, `未成立：${errorMessage(e)}`, '測試單未成立');
                else fail(target, `${target.label} ${target.code}：結果未知：${errorMessage(e)}。請到「委託」核對是否已成立，確認前不要再按「測試」`, '測試單結果未知', 'unknown');
            }
        } finally {
            setSending(false);
        }
    };

    const setPrice = (v: string | null) => {
        setEdited(v);
        clearError();
    };
    const unit = unitOf(selected.security_type);
    const currentPriceUnavailable = busy || query !== null || last === undefined;
    const currentPriceLabel = last !== undefined
        ? `現價：帶入${useTick ? '成交價' : '快照價'}（目前 ${last}）`
        : '現價：尚無可用報價';
    const verificationLabel = account
        ? `${marketLabel}帳戶${account.signed === true ? '已通過' : '尚未通過'}驗證`
        : `${marketLabel}無帳戶`;

    return (
        <div className={s.row}>
            {query !== null && <SearchEscClose cancel={() => { setQuery(null); setComposing(false); inputRef.current?.focus(); }} />}
            <span className={s.market}><span className={s.marketName}>{marketLabel}</span></span>
            <span className={s.verification} data-verified={account?.signed === true || undefined} aria-label={verificationLabel} title={verificationLabel}>
                {account?.signed === true
                    ? <ShieldCheck size={12} aria-hidden className={s.okIcon} />
                    : <ShieldAlert size={12} aria-hidden />}
                {account ? account.signed === true ? '通過' : '未通過' : '無帳戶'}
            </span>
            <div className={s.productField}>
                <div className={`${s.cell} ${s.productCell}`}>
                    {/* 常駐 live region：臨時掛上的提示 VoiceOver 不一定唸 */}
                    <div role='status'>
                        {emptyMsg && (
                            <div className={s.popup}>
                                <div className={s.emptyOption}>{emptyMsg}</div>
                            </div>
                        )}
                    </div>
                    {expanded && (
                        <div ref={listRef} className={s.popup} role='listbox' id={listId} aria-label='商品建議'>
                            {items.map((x, i) => (
                                <div
                                    key={x.code}
                                    id={`${listId}-${i}`}
                                    role='option'
                                    aria-selected={i === active}
                                    className={s.option}
                                    // 不搶焦點，免得 blur 先把清單關掉；選取放 click（只有主鍵，右鍵不換商品）
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => pick(x)}
                                    // 滑鼠與鍵盤共用同一個反白，Enter 選的就是看到的那列
                                    onMouseMove={() => {
                                        if (i !== active) setActive(i);
                                    }}
                                >
                                    <span className={s.optionName} title={x.name}>{shortName(x)}</span>
                                    <span className={s.optionCat}>{x.detail}</span>
                                    <span className={s.optionCode}>{x.code}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <Search size={12} aria-hidden className={s.searchIcon} />
                    <input
                        id={productInputId}
                        ref={inputRef}
                        className={`${hud.saveInput} ${s.control} ${s.productInput}`}
                        role='combobox'
                        aria-label={`${marketLabel}商品`}
                        aria-autocomplete='list'
                        aria-expanded={expanded}
                        aria-controls={expanded ? listId : undefined}
                        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
                        aria-describedby={`${productId} ${statusId}`}
                        // 右側讓出代碼的寬度（選擇權代碼可達 10 字以上），過長的名稱以省略號收尾
                        style={query === null ? { paddingRight: `calc(${selected.code.length}ch + 14px)` } : undefined}
                        value={query ?? selected.label}
                        placeholder='名稱或代碼'
                        disabled={busy}
                        // 設定視窗的 Esc 看這個：搜尋中只取消搜尋，不關整個視窗
                        data-searching={query !== null || undefined}
                        onMouseDown={(e) => { focusClick.current = e.currentTarget !== document.activeElement; }}
                        onMouseUp={(e) => {
                            if (focusClick.current) e.preventDefault();
                            focusClick.current = false;
                        }}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            clearError();
                        }}
                        onBlur={() => { clearError(); }}
                        onCompositionStart={() => setComposing(true)}
                        onCompositionEnd={() => setComposing(false)}
                        onKeyDown={onKeyDown}
                    />
                    {/* 別名（台指近）背後實際送單的代碼，不用 hover 就看得到 */}
                    <span id={productId} className={s.srOnly}>{cachedContract?.name ?? selected.name} {selected.code}</span>
                    {query === null && <span className={s.productCode} aria-hidden='true'>{selected.code}</span>}
                </div>
            </div>
            <div className={s.priceField}>
                <label htmlFor={priceInputId} className={s.narrowPriceLabel}>委託價格</label>
                <div className={`${s.cell} ${s.priceCell}`}>
                    <input
                        id={priceInputId}
                        ref={priceRef}
                        className={`${hud.saveInput} ${s.control} ${s.priceInput}`}
                        aria-label={`${selected.label} 價位`}
                        aria-describedby={`${srcId} ${statusId}`}
                        inputMode='decimal'
                        value={editingPrice ? price : displayPrice(price)}
                        disabled={busy}
                        // 搜尋中：價位還屬於舊商品，和送出鈕一起淡化
                        data-stale={query !== null || undefined}
                        // 欄內僅顯示簡短狀態；送出時的提示再說明要手動輸入
                        placeholder={snapError ? '無法取得成交價' : '等待成交價'}
                        onFocus={() => {
                            setEditingPrice(true);
                            if (snapError && last === undefined) void refreshSnap();
                        }}
                        onBlur={() => setEditingPrice(false)}
                        onChange={(e) => {
                            const v = normalizePrice(e.target.value);
                            if (/^\d*\.?\d*$/.test(v)) setPrice(v === '' ? null : v);
                        }}
                    />
                    <span id={srcId} className={s.srOnly}>{edited !== null ? '固定委託價' : last !== undefined ? useTick ? '成交價' : '快照價' : '尚無可用報價'}</span>
                    {/* 只帶入點擊當下的既有報價；不新增查詢，也不隨後續行情改動委託價。 */}
                    <button
                        type='button'
                        className={s.priceReset}
                        aria-label={currentPriceLabel}
                        title={currentPriceLabel}
                        disabled={currentPriceUnavailable}
                        onClick={() => {
                            if (currentPriceUnavailable || last === undefined) return;
                            setPrice(String(last));
                            priceRef.current?.focus();
                        }}
                    >現價</button>
                </div>
            </div>
            <div className={s.actionCell}>
                <span className={s.srOnly}>買進 1 {unit}</span>
                <button
                    type='button'
                    className={`${hud.updateBtn} ${s.sendBtn}`}
                    aria-label={reason ?? `測試（買進）：${selected.label} ${selected.code} 1 ${unit}`}
                    title={`買進 1 ${unit}，限價 ROD`}
                    aria-describedby={statusId}
                    aria-disabled={!!reason}
                    // 原因直接顯示於按鈕，aria-disabled 保留鍵盤焦點。
                    data-stale={query !== null || undefined}
                    // 框內還有沒選取的字：不搶焦點，字留著，send 會擋下並提示
                    onMouseDown={(e) => {
                        if (query !== null) e.preventDefault();
                    }}
                    onClick={send}
                >
                    {reason ?? '測試'}
                </button>
            </div>
            {!signed && available && <span className={s.status}>尚未完成 API 簽署或模擬測試。若是先登入才完成簽署，請登出後重新登入，簽署才會生效。</span>}
            {/* 常駐 live region（成功也要唸）；不用 AsyncStatus，免得 role 巢狀重複報讀 */}
            {/* 三種結果用圖示形狀區分，不只靠顏色：結果未知最該停下來核對 */}
            <span role='status' id={statusId} className={`${hud.emptyHint} ${s.status} ${STATUS_CLASS[state.phase] ?? ''}`}>
                {state.phase === 'loading' && <Orb size={12} />}
                {state.phase === 'ok' && <CircleCheck size={12} aria-hidden className={s.okIcon} />}
                {state.phase === 'error' && <CircleX size={12} aria-hidden className={s.statusIcon} />}
                {state.phase === 'unknown' && <TriangleAlert size={12} aria-hidden className={s.unknownIcon} />}
                {state.phase === 'ok' && state.receipt ? (
                    <span className={s.resultContent}>
                        <span className={s.resultHeading}>
                            <span>已送出</span>
                            {state.receipt.elapsedMs !== undefined && <span className={s.resultLatency}> · 回應 {state.receipt.elapsedMs} ms</span>}
                        </span>
                        <span className={s.resultDetails}>買進 1 {state.receipt.unit} · 送出委託價 {displayPrice(state.receipt.price)} · 委託 {state.receipt.orderId}</span>
                    </span>
                ) : state.text}
                {pending && <button type='button' className={s.acknowledge} onClick={() => { setUnresolved(market); setState(IDLE); }}>我已核對委託</button>}
            </span>
        </div>
    );
}

export function SimTestOrderSection() {
    const busy = useSyncExternalStore(subscribeSending, getSending);
    const live = useTradingLive();
    const headId = useId();
    const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const refreshing = useRef(false);
    const updateVerification = async () => {
        if (refreshing.current) return;
        refreshing.current = true;
        setRefreshState('loading');
        try {
            await refreshAccounts();
            // Store load failures resolve normally and retain the last account data.
            if (getAccountState().loadError) setRefreshState('error');
            else {
                setUpdatedAt(new Date());
                setRefreshState('success');
            }
        } catch {
            setRefreshState('error');
        } finally {
            refreshing.current = false;
        }
    };
    return (
        // 整個測試單（標題、兩列、提示、說明）是同一張卡片、同一個 labelled region
        <section aria-labelledby={headId} className={s.card}>
            <div className={s.header}>
                <div className={s.heading}>
                    <span id={headId} className={s.title}>測試單</span>
                    <span className={s.environment}>模擬環境</span>
                </div>
                <div className={s.headerActions}>
                    <span className={`${s.refreshMessage} ${refreshState === 'error' ? s.statusError : ''}`} role='status' aria-atomic='true' aria-label={refreshState === 'success' ? '驗證狀態已更新' : undefined}>
                        {refreshState === 'loading' ? '正在更新驗證狀態…' : refreshState === 'success' && updatedAt ? <>已更新 <time dateTime={updatedAt.toISOString()}>{updatedAt.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></> : refreshState === 'error' ? '更新失敗，保留上次狀態。請稍後再試。' : null}
                    </span>
                    <button type='button' className={s.refreshButton} title='重新取得帳戶驗證狀態' disabled={refreshState === 'loading'} onClick={updateVerification}>
                        {refreshState === 'loading' ? <Orb size={13} variant='ring' /> : <RefreshCw size={13} aria-hidden />}
                        {refreshState === 'loading' ? '更新中…' : '更新狀態'}
                    </button>
                </div>
            </div>
            <p className={s.testSchedule}>資格驗證時段：開盤日 08:00–20:00（台北時間）</p>
            <div className={s.grid}>
                <div className={s.columnHeaders} aria-hidden='true'>
                    <span className={`${s.columnHeader} ${s.columnHeaderMarket}`}>種類</span>
                    <span className={`${s.columnHeader} ${s.columnHeaderStatus}`}>狀態</span>
                    <span className={`${s.columnHeader} ${s.columnHeaderProduct}`}>商品代號</span>
                    <span className={`${s.columnHeader} ${s.columnHeaderPrice}`}>委託價格</span>
                    <span className={`${s.columnHeader} ${s.columnHeaderAction}`}>操作</span>
                </div>
                {DEFAULTS.map((p) => (
                    <TestOrderRow key={p.code} initial={p} busy={busy} live={live} />
                ))}
            </div>
            {/* 列上以可聚焦的 aria-disabled 按鈕顯示原因，這裡補充整體狀態。 */}
            {!live && <p className={s.sectionNotice}>⚠ 行情或交易狀態未連線，暫停送出測試單</p>}
            {busy && <p className={s.sectionNotice}>有一筆測試單傳送中，完成前暫停送出</p>}
            <div className={s.guidance}>
                <p className={s.description}>按下即買進 1 張／1 口限價 ROD，可能立即成交。</p>
            </div>
            <details className={s.help}>
                <summary className={s.helpToggle}>測試規則與簽署</summary>
                <ul className={s.instructions}>
                    <li>測試前，先完成 API 電子交易風險預告書暨使用同意書；證券與期貨須分別簽署。<span className={s.signingLinks}><ExternalLink className={s.ruleLink} href={SIGNING_URLS.S.url}>證券簽署</ExternalLink><ExternalLink className={s.ruleLink} href={SIGNING_URLS.F.url}>期貨簽署</ExternalLink></span></li>
                    <li>以模擬環境登入，API 金鑰須有「交易」權限；Shioaji 版本須為 1.2 以上。</li>
                    <li>資格測試於開盤日 08:00–20:00 受理（台北時間）；08:00–18:00 不限制 IP 地區，18:00–20:00 僅限台灣 IP。</li>
                    <li>證券與期貨須各自完成下單測試；兩次測試請間隔至少 1 秒。</li>
                    <li>測試通過後，數小時內會開通。按「更新狀態」查詢目前選取的帳戶；若仍未更新，可重新登入後再查詢。</li>
                    <li>證券可輸入股票名稱或代碼；期貨也可輸入簡稱（台指、小台、微台）。</li>
                </ul>
                <p className={s.helpFooter}>未成交的請到「委託」刪單，已成交的請到「持倉」平倉。</p>
                <ExternalLink className={s.ruleLink} href='https://sinotrade.github.io/zh/tutor/prepare/terms/'>官方測試規則</ExternalLink>
            </details>
        </section>
    );
}
