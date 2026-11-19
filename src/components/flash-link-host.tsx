// src/components/flash-link-host.tsx — 閃電下單的「對應商品」
// 把面板收到的來源商品（自選選取、群組代碼、鎖定代碼）依面板設定換成要下單的
// 合約：照選取／現股／個股期（規格、月份）。換不到就暫停並說明，絕不保留上一檔。
// linkKey 涵蓋群組、對應設定與來源代碼 — 任何一項變了，閃電同一次 render 解除
// 點價下單，確認中的那筆也不送。

import { CirclePause, ArrowLeftRight, Ban, ChevronDown, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react';
import { ensureContract, primeContract, useContract } from '../lib/contracts-cache';
import { expiryTime, linkedStockCode, monthLabel, pickStockFuture, type FlashLink } from '../lib/flash-link';
import { fetchFutures } from '../lib/shioaji';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractInfo } from '../lib/types/contract';
import { SettingsSegRow, settingsSelectClass } from './chart-order-popover';
import * as styles from './flash-order.css';
import * as hostStyles from './flash-link-host.css';

// ---- 個股期合約（依標的股票快取）----
type FuturesEntry = { status: 'loading' } | { status: 'ok'; rows: ContractInfo[]; at: number } | { status: 'error' };
const futures = new Map<string, FuturesEntry>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

// 同一檔共用進行中的查詢；只有最新一次查詢的結果能寫回（晚到的失敗不會蓋掉成功）
const inflight = new Map<string, number>();
let requestSeq = 0;
function loadStockFutures(code: string, force = false) {
    if (inflight.has(code) && !force) return;
    const id = ++requestSeq;
    inflight.set(code, id);
    futures.set(code, { status: 'loading' });
    emit();
    const current = () => inflight.get(code) === id;
    fetchFutures({ underlyingCode: code }).then(rows => {
        if (!current()) return;
        // 以這次取得的資料為準（更新快取裡可能過時的同代碼合約）
        for (const row of rows) primeContract(row);
        futures.set(code, { status: 'ok', rows, at: Date.now() });
    }, () => { if (current()) futures.set(code, { status: 'error' }); }).finally(() => {
        if (current()) inflight.delete(code);
        emit();
    });
}

export function resetStockFuturesCache() {
    futures.clear();
    inflight.clear();
}

function useStockFutures(code: string | null): FuturesEntry | undefined {
    const entry = useSyncExternalStore(
        l => { listeners.add(l); return () => listeners.delete(l); },
        () => (code ? futures.get(code) : undefined),
    );
    // 載入之後有合約到期（換月）就重新取得，新掛牌的月份才會出現；重新取得期間暫停
    const stale = entry?.status === 'ok' && entry.rows.some(r => {
        const t = expiryTime(r);
        return t !== null && t > entry.at && t <= Date.now();
    });
    useEffect(() => {
        if (code && (!futures.has(code) || stale)) loadStockFutures(code);
    }, [code, stale]);
    return stale ? { status: 'loading' } : entry;
}

// 近月到期換月：每次 render 都用當下時間判斷，並在到期那一刻重新 render
// （分段計時：setTimeout 上限約 24.8 天）
function useRerenderAt(at: number | null) {
    const [tick, bump] = useState(0);
    useEffect(() => {
        if (at === null || Date.now() > at + 1000) return;
        const t = setTimeout(() => bump(n => n + 1), Math.min(Math.max(0, at - Date.now()) + 50, 6 * 3600_000));
        return () => clearTimeout(t);
    }, [at, tick]);
}

export interface FlashLinkProps {
    linkKey: string;
    symbolExtra?: ReactNode;
    settingsRows: ReactNode;
    showRef: boolean;
    expiresAt?: number | null;
    paused?: string;
}

const KIND_OPTIONS = [['select', '照選取'], ['stock', '現股'], ['future', '個股期']] as const;

export function FlashLinkHost({ source, link: savedLink, group, onLinkChange, render, targetRef, pending }: {
    source: ContractInfo;
    link: FlashLink;
    /** 連動方式（main／pin／A／B／C） */
    group: string;
    onLinkChange: (next: FlashLink) => void;
    render: (contract: ContractInfo, props: FlashLinkProps) => ReactNode;
    /** 目前實際下單的合約代碼（彈出視窗用）；暫停時 null */
    targetRef?: MutableRefObject<string | null>;
    /** 群組正在查新代碼：暫停（不能啟用、確認中的單作廢），查完一起換 */
    pending?: string;
}) {
    if (targetRef) targetRef.current = null;
    // 美股沒有個股期／現股對應：一律照選取（下單合約＝來源），絕不查個股期。
    // 只影響這次的判斷，不改寫面板存的設定（換回台股時恢復原本的對應方式）
    const us = source.region === 'US';
    const link: FlashLink = us ? { ...savedLink, kind: 'select' } : savedLink;
    // 最後畫出的閃電：查詢中保留它（暫停、不顯示舊合約），數量等面板狀態不因查詢快慢而不同
    const lastShown = useRef<ContractInfo | null>(null);
    const lastExpiry = useRef<number | null | undefined>(undefined);
    const show = (contract: ContractInfo, props: FlashLinkProps) => {
        if (targetRef) targetRef.current = contractLinkKey(contract); // 美股 US:CODE（彈出視窗以此查合約）
        lastShown.current = contract;
        lastExpiry.current = props.expiresAt;
        return render(contract, props);
    };
    const stockCode = link.kind === 'select' ? null : linkedStockCode(source);
    // 現股：來源是個股期時找回標的股票
    const needStock = link.kind === 'stock' && stockCode !== null && stockCode !== source.code ? stockCode : null;
    const stock = useContract(needStock);
    const [stockLoad, setStockLoad] = useState<{ code: string; ok: boolean } | null>(null);
    const stockFailed = stockLoad && !stockLoad.ok ? stockLoad.code : null;
    const [stockRetry, setStockRetry] = useState(0);
    useEffect(() => {
        if (!needStock || stock) return;
        let active = true;
        ensureContract(needStock).then(
            () => { if (active) setStockLoad({ code: needStock, ok: true }); },
            () => { if (active) setStockLoad({ code: needStock, ok: false }); },
        );
        return () => { active = false; };
    }, [needStock, stock, stockRetry]);
    const fut = useStockFutures(link.kind === 'future' ? stockCode : null);
    const pick = link.kind === 'future' && fut?.status === 'ok' ? pickStockFuture(fut.rows, link, Date.now()) : null;
    useRerenderAt(pick?.status === 'ok' ? pick.expiresAt : null);
    const picked = useContract(pick?.status === 'ok' ? pick.contract.code : null) ?? (pick?.status === 'ok' ? pick.contract : undefined);

    const set = (patch: Partial<FlashLink>) => onLinkChange({ ...savedLink, ...patch });
    const months = pick?.status === 'ok' ? pick.months : [];
    const settingsRows = us ? null : (
        <>
            <SettingsSegRow label='對應商品' value={link.kind} options={KIND_OPTIONS} onPick={kind => set({ kind })} />
            {link.kind === 'future' && (pick?.status === 'ok' && pick.hasMini || link.spec === 'mini' || pick?.status === 'noStd') && (
                <SettingsSegRow label='規格' value={link.spec}
                    options={[['std', '標準'], ['mini', '小型']]} onPick={spec => set({ spec })} />
            )}
            {link.kind === 'future' && (
                <SettingsSegRow label='月份' value={link.month}
                    options={[['near', '近月', months[0] && monthLabel(months[0])], ['next', '次月', months[1] && monthLabel(months[1])]]}
                    onPick={month => set({ month })}
                    extra={(
                        <select className={`${settingsSelectClass} ${hostStyles.monthSelect}`} aria-label='指定月份'
                            value={/^\d{6}$/.test(link.month) ? link.month : ''} onChange={e => { if (e.target.value) set({ month: e.target.value }); }}>
                            <option value=''>指定月份</option>
                            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                        </select>
                    )} />
            )}
            <SettingsSegRow label='價差對照' value={link.ref ? 'on' : 'off'}
                options={[['on', '顯示'], ['off', '隱藏']]} onPick={v => set({ ref: v === 'on' })} />
        </>
    );
    const linkKey = `${group}|${link.kind}|${link.spec}|${link.month}|${contractLinkKey(source)}${pending ? `|pending:${pending}` : ''}`;
    const name = `${source.code === source.name || !source.name ? source.code : source.security_type === 'STK' ? `${source.code} ${source.name}` : source.name}`;

    const loading = (text: string) => (lastShown.current
        // 保留原本的換月截止時間（暫停期間閘門不放寬）
        ? render(lastShown.current, { linkKey, settingsRows, showRef: link.ref, paused: text, expiresAt: lastExpiry.current })
        : <div className={styles.waiting}>{text}</div>);
    const empty = (icon: ReactNode, title: string, note?: string, action?: ReactNode) => {
        lastShown.current = null; // 閃電已卸載
        return (
            <div className={hostStyles.empty}>
                {icon}
                <div className={hostStyles.emptyTitle}>{title}</div>
                {note && <div className={hostStyles.emptyNote}>{note}</div>}
                {action}
            </div>
        );
    };
    const button = (label: ReactNode, onClick: () => void) => (
        <button type='button' className={hostStyles.emptyBtn} onClick={onClick}>{label}</button>
    );

    if (pending) return loading('載入商品…');
    if (link.kind === 'select') return show(source, { linkKey, settingsRows, showRef: link.ref });
    if (stockCode === null) {
        return empty(<CirclePause size={18} aria-hidden />, `${name} 不是個股`, '選一檔股票或個股期即恢復',
            button('改為照選取', () => set({ kind: 'select' })));
    }
    if (link.kind === 'stock') {
        const target = needStock ? stock : source;
        if (target) return show(target, { linkKey, settingsRows, showRef: link.ref });
        if (stockFailed === needStock) {
            return empty(<Ban size={18} aria-hidden />, `找不到 ${needStock}`, undefined,
                <span className={hostStyles.emptyActions}>
                    {button(<><RotateCw size={11} aria-hidden /> 重試</>, () => { setStockLoad(null); setStockRetry(n => n + 1); })}
                    {button('改為照選取', () => set({ kind: 'select' }))}
                </span>);
        }
        return loading('載入商品…');
    }
    if (!fut || fut.status === 'loading') return loading('載入個股期…');
    if (fut.status === 'error') {
        return empty(<Ban size={18} aria-hidden />, '個股期合約載入失敗', undefined,
            button(<><RotateCw size={11} aria-hidden /> 重試</>, () => loadStockFutures(stockCode, true)));
    }
    if (pick?.status === 'none') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode}${source.security_type === 'STK' && source.name ? ` ${source.name}` : ''} 沒有個股期貨`, '群組換到有個股期的股票時自動恢復',
            button(<><ArrowLeftRight size={11} aria-hidden /> 改為現股</>, () => set({ kind: 'stock' })));
    }
    if (pick?.status === 'noMini') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode} 沒有小型個股期`, undefined,
            button('改為標準', () => set({ spec: 'std' })));
    }
    if (pick?.status === 'expired') {
        return empty(<Ban size={18} aria-hidden />, `${monthLabel(pick.month)} 合約已到期`, undefined,
            button('改為近月', () => set({ month: 'near' })));
    }
    if (pick?.status === 'noStd') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode} 沒有標準規格個股期`, undefined,
            button('改為小型', () => set({ spec: 'mini' })));
    }
    if (pick?.status === 'noExpiry') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode} 個股期到期日無法確認`, '暫停送單',
            button(<><ArrowLeftRight size={11} aria-hidden /> 改為現股</>, () => set({ kind: 'stock' })));
    }
    if (pick?.status === 'unlisted') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode} 沒有${pick.month === 'next' ? '次月' : ` ${monthLabel(pick.month)} `}合約`, undefined,
            <span className={hostStyles.emptyActions}>
                {button('改為近月', () => set({ month: 'near' }))}
                {button(<><RotateCw size={11} aria-hidden /> 重新查詢</>, () => loadStockFutures(stockCode, true))}
            </span>);
    }
    if (pick?.status !== 'ok' || !picked) return loading('載入個股期…');
    const monthText = link.month === 'near' ? '近月' : link.month === 'next' ? '次月' : monthLabel(link.month);
    const symbolExtra = (
        <>
            <label className={styles.monthPick} title='個股期月份'>
                {monthText}
                <ChevronDown size={9} aria-hidden />
                <select className={styles.monthSelect} aria-label='個股期月份' value={link.month} onChange={e => set({ month: e.target.value })}>
                    <option value='near'>近月</option>
                    <option value='next'>次月</option>
                    {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
            </label>
            {pick.expiresToday && <span className={styles.expiryTag}>今日到期</span>}
        </>
    );
    return show(picked, { linkKey, symbolExtra, settingsRows, showRef: link.ref, expiresAt: pick.expiresAt });
}
