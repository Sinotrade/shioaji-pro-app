// src/components/conditional-form.tsx — 新增條件單 (#226, design v4). The
// form only builds a request; the trigger engine validates and owns it.
// Pressing 建立 is the approval of the order it will send: when the
// condition is met it goes out without asking again.

import { Info, Plus, Shield, X } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { canTrade } from '../lib/account-tradable';
import { useAccounts } from '../lib/account-store';
import { ensureContract, useContract } from '../lib/contracts-cache';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import { addTrigger, addTriggerGroup, type BracketEntryPlan, type TriggerSend, type TriggerValidity } from '../lib/trigger-engine';
import { bracketPlanProblem } from '../lib/conditional/bracket-rules';
import { derivedPriceProblem, placePanelBracket, type PanelEntry } from '../lib/conditional/panel-bracket';
import { dateEnd, dayEnd, fmtNum, fmtUntil, sessionEnd, taipeiInstant, taipeiParts, type SessionMarket } from '../lib/conditional/session';
import { contractLabel } from '../lib/pending-trigger-view';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import type { ContractInfo } from '../lib/types/contract';
import type { Account } from '../lib/types/portfolio';
import { conditionalDemoActive, DEMO_ACCOUNTS, primeConditionalDemo } from '../lib/conditional/demo';
import { Dialog, useLastPrice } from './conditional-ui';
import * as styles from './conditional-panel.css';

export type CondFormType = 'trigger' | 'oco' | 'bracket' | 'time';
const QUICK_QTY = [1, 5, 10];

export function isFuturesLike(c: Pick<ContractInfo, 'security_type'> | null | undefined): boolean {
    return c?.security_type === 'FUT' || c?.security_type === 'OPT';
}

export function marketAccounts(accounts: Account[], futures: boolean): Account[] {
    return accounts.filter(a => canTrade(a) && a.account_type === (futures ? 'F' : 'S'));
}

const accountKey = (a: Account) => `${a.account_type}:${a.broker_id}:${a.account_id}`;

/** Common product / account rows (every type). */
function useTarget(initial: ContractInfo | null) {
    const demo = conditionalDemoActive();
    if (demo) primeConditionalDemo();
    const first = initial?.code ?? (demo ? 'TXFJ6' : '');
    const [code, setCodeRaw] = useState(first);
    const [resolved, setResolved] = useState<string | null>(first || null);
    const asked = useRef(first);
    // a changed code unresolves at once: nothing can be created for the old one
    const setCode = (v: string) => { setCodeRaw(v); if (v.trim().toUpperCase() !== resolved) setResolved(null); };
    const [lookupError, setLookupError] = useState<string | null>(null);
    const contract = useContract(resolved);
    const futures = isFuturesLike(contract);
    const state = useAccounts();
    const accounts = useMemo(() => marketAccounts(demo ? DEMO_ACCOUNTS : state.accounts, futures), [demo, state.accounts, futures]);
    const preferred = futures ? state.selectedFutures : state.selectedStock;
    const [accountId, setAccountId] = useState<string | null>(null);
    const account = accounts.find(a => accountKey(a) === accountId)
        ?? accounts.find(a => preferred && accountKey(a) === accountKey(preferred)) ?? accounts[0] ?? null;
    const resolve = (raw: string) => {
        const c = raw.trim().toUpperCase();
        if (!c || c === resolved) return;
        asked.current = c;
        setLookupError(null);
        setResolved(null);
        // only the latest lookup counts
        void ensureContract(c).then(() => { if (asked.current === c) setResolved(c); })
            .catch(() => { if (asked.current === c) setLookupError(`找不到商品 ${c}`); });
    };
    return { code, setCode, resolve, resolved, contract, futures, accounts, account, setAccountId, lookupError };
}

type Target = ReturnType<typeof useTarget>;

function TargetRows({ target }: { target: Target }) {
    const priv = usePrivacyMode();
    const last = useLastPrice(target.resolved ?? '');
    const name = target.resolved ? contractLabel(target.resolved, target.contract) : '';
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>商品</span>
                <input className={styles.inputWide} value={target.code} aria-label='商品代碼'
                    onChange={e => target.setCode(e.target.value)}
                    onBlur={e => target.resolve(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') target.resolve((e.target as HTMLInputElement).value); }} />
                <span className={styles.muted}>
                    {target.lookupError ?? (target.contract ? `${name !== target.resolved ? `${name} · ` : ''}現價 ${last === undefined ? '—' : fmtNum(last)}` : '輸入代碼後按 Enter')}
                </span>
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>帳戶</span>
                {target.accounts.length === 0 ? (
                    <span className={styles.tone.err}>沒有可下單的{target.futures ? '期貨' : '證券'}帳戶</span>
                ) : (
                    <select className={styles.select} aria-label='帳戶' value={target.account ? accountKey(target.account) : ''}
                        onChange={e => target.setAccountId(e.target.value)}>
                        {target.accounts.map(a => (
                            <option key={accountKey(a)} value={accountKey(a)}>
                                {a.account_type === 'F' ? '[期]' : '[證]'} {maskAccountId(a.account_id, priv)}
                            </option>
                        ))}
                    </select>
                )}
            </div>
        </>
    );
}

function Seg<T extends string>({ value, options, onChange, tone, label }: {
    value: T;
    options: { id: T; label: string; disabled?: boolean; title?: string }[];
    onChange: (v: T) => void;
    tone?: (id: T) => 'buy' | 'sell' | 'on';
    label: string;
}) {
    return (
        <span className={styles.seg} role='radiogroup' aria-label={label}>
            {options.map(o => (
                <button key={o.id} type='button' role='radio' aria-checked={value === o.id} disabled={o.disabled} title={o.title}
                    className={value === o.id ? styles.segItem[tone ? tone(o.id) : 'on'] : styles.segItem.off}
                    onClick={() => onChange(o.id)}>
                    {o.label}
                </button>
            ))}
        </span>
    );
}

export { Seg };

function parseNum(v: string): number | null {
    const n = Number(v.replace(/,/g, '').trim());
    return v.trim() === '' || !Number.isFinite(n) ? null : n;
}

/** 觸發後 (send style) state shared by the forms. */
export interface SendState { type: 'MKT' | 'MKP' | 'LMT'; ticks: string }

export function sendOf(s: SendState): TriggerSend | string {
    if (s.type !== 'LMT') return { type: s.type };
    const n = Number(s.ticks.replace('−', '-'));
    if (!Number.isSafeInteger(n) || Math.abs(n) > 50) return '限價檔數須為 −50～50 的整數';
    return { type: 'LMT', ticks: n };
}

export function SendControl({ value, onChange, futures, label = '觸發後' }: {
    value: SendState;
    onChange: (v: SendState) => void;
    futures: boolean;
    label?: string;
}) {
    return (
        <div className={styles.formRow}>
            <span className={styles.label}>{label}</span>
            <Seg label={label} value={value.type} onChange={type => onChange({ ...value, type })}
                options={[
                    { id: 'MKT', label: '市價' },
                    { id: 'MKP', label: '範圍市價', disabled: !futures, title: futures ? undefined : '範圍市價只適用期貨選擇權' },
                    { id: 'LMT', label: '限價' },
                ]} />
            {value.type === 'LMT' && (
                <>
                    <span>觸發價</span>
                    <input className={styles.inputNarrow} value={value.ticks} inputMode='numeric' aria-label='限價檔數'
                        onChange={e => onChange({ ...value, ticks: e.target.value })} />
                    <span>檔</span>
                </>
            )}
        </div>
    );
}

/** 有效期 state shared by the forms. */
export interface ValidityState { type: 'session' | 'today' | 'date' | 'none'; date: string }

export function validityOf(v: ValidityState, market: SessionMarket, now = Date.now()): TriggerValidity | string | null {
    if (v.type === 'none') return null;
    const until = v.type === 'session' ? sessionEnd(now, market) : v.type === 'today' ? dayEnd(now, market) : dateEnd(v.date, market);
    if (until === null) return '請選擇指定日';
    if (until <= now) return '指定日已過';
    return { type: v.type, until };
}

export function ValidityControl({ value, onChange, market, allowNone }: {
    value: ValidityState;
    onChange: (v: ValidityState) => void;
    market: SessionMarket;
    /** edit only: keep 直到取消 for a trigger made without a validity */
    allowNone?: boolean;
}) {
    const res = validityOf(value, market);
    return (
        <div className={styles.formRow}>
            <span className={styles.label}>有效期</span>
            <Seg label='有效期' value={value.type} onChange={type => onChange({ ...value, type })}
                options={[{ id: 'session', label: '本盤' }, { id: 'today', label: '今日' }, { id: 'date', label: '指定日' },
                    ...(allowNone ? [{ id: 'none' as const, label: '直到取消' }] : [])]} />
            {value.type === 'date' && (
                <input className={styles.input} type='date' value={value.date} aria-label='指定日' onChange={e => onChange({ ...value, date: e.target.value })} />
            )}
            {res !== null && (
                <span className={typeof res === 'string' ? styles.tone.err : styles.muted}>
                    {typeof res === 'string' ? res : `${fmtUntil(res.until)} 失效`}
                </span>
            )}
        </div>
    );
}

function QtyInput({ qty, setQty, unit, quick = QUICK_QTY }: { qty: string; setQty: (v: string) => void; unit: string; quick?: number[] }) {
    return (
        <>
            <input className={styles.inputNarrow} value={qty} inputMode='numeric' aria-label='數量' onChange={e => setQty(e.target.value)} />
            <span>{unit}</span>
            {quick.map(n => (
                <button key={n} type='button' className={styles.button.plain} onClick={() => setQty(String(n))}>{n}</button>
            ))}
        </>
    );
}

function Footer({ busy, problem, onClose, onSubmit }: { busy: boolean; problem: string | null; onClose: () => void; onSubmit: () => void }) {
    return (
        <div className={styles.dialogFoot} style={{ margin: '12px -12px -12px' }}>
            {problem && <span className={styles.muted}>{problem}</span>}
            <span className={styles.grow} />
            <button type='button' className={styles.button.plain} onClick={onClose}>取消</button>
            <button type='button' className={styles.button.primary} disabled={busy || !!problem} onClick={onSubmit}>建立</button>
        </div>
    );
}

function Summary({ children }: { children: ReactNode }) {
    return (
        <div className={styles.summary}>
            <Info size={13} aria-hidden style={{ flex: 'none', marginTop: 4 }} />
            <span>{children}</span>
        </div>
    );
}

const APPROVAL = '按「建立」即核可這筆下單，條件成立時不會再詢問。';

/** 「賣出 1 口 限價 47,898」 */
function orderWords(target: Target, action: 'Buy' | 'Sell', qty: number, send: TriggerSend | string, price: number | null): string {
    const unit = target.futures ? '口' : '張';
    const side = `${action === 'Buy' ? '買進' : '賣出'} ${qty || 0} ${unit}`;
    if (typeof send === 'string') return side;
    if (send.type === 'MKP') return `${side} 範圍市價`;
    if (send.type === 'LMT' && price !== null && target.contract) {
        const p = send.ticks === 0 ? price : stepPrice(target.contract, price, send.ticks);
        return `${side} 限價 ${fmtNum(p)}`;
    }
    return `${side} 市價`;
}

function useSubmit() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (fn: () => Promise<boolean>) => {
        if (conditionalDemoActive()) { setError('示範資料：不會建立條件單'); return; }
        setBusy(true);
        setError(null);
        try {
            if (!(await fn())) setError('沒有建立（原因見通知）');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, setError, submit };
}

function commonProblem(target: Target): string | null {
    const c = target.contract;
    if (!c || target.resolved !== target.code.trim().toUpperCase()) return '請先選擇商品（輸入代碼後按 Enter）';
    if (c.security_type !== 'STK' && !isFuturesLike(c)) return '此商品不支援條件單';
    if (!target.account) return `沒有可下單的${target.futures ? '期貨' : '證券'}帳戶`;
    return null;
}

function priceProblem(target: Target, p: number | null, label: string): string | null {
    if (p === null || p <= 0) return `請輸入${label}`;
    if (target.contract && roundToTick(target.contract, p) !== p) return `${label} ${fmtNum(p)} 不在跳動點上`;
    return null;
}

const kindFor = (condition: 'below' | 'above', action: 'Buy' | 'Sell') =>
    (condition === 'below') === (action === 'Sell') ? 'stop' as const : 'take' as const;

type CondOp = 'below' | 'above' | 'crossDown' | 'crossUp';

/** The trigger form (觸價單). */
function TriggerForm({ target, onClose, defaults }: { target: Target; onClose: () => void; defaults: FormDefaults }) {
    const [source, setSource] = useState<'last' | 'opposite'>('last');
    const [op, setOp] = useState<CondOp>('below');
    const [price, setPrice] = useState('');
    const [action, setAction] = useState<'Buy' | 'Sell'>('Sell');
    const [qty, setQty] = useState('1');
    const [send, setSend] = useState<SendState>({ type: target.futures ? defaults.send : 'MKT', ticks: '−2' });
    const [validity, setValidity] = useState<ValidityState>({ type: defaults.validity, date: '' });
    const { busy, error, submit } = useSubmit();
    const last = useLastPrice(target.resolved ?? '');
    const p = parseNum(price);
    const q = Number(qty);
    const condition: 'below' | 'above' = op === 'below' || op === 'crossDown' ? 'below' : 'above';
    const cross = op === 'crossDown' || op === 'crossUp';
    const market: SessionMarket = target.futures ? 'futures' : 'stock';
    const sendValue = sendOf(send.type === 'MKP' && !target.futures ? { ...send, type: 'MKT' } : send);
    const validityValue = validityOf(validity, market);
    const crossed = !cross && p !== null && last !== undefined && (condition === 'below' ? last <= p : last >= p);
    const problem = commonProblem(target) ?? priceProblem(target, p, '觸發價')
        ?? (!Number.isSafeInteger(q) || q <= 0 ? '數量必須是正整數' : null)
        ?? (typeof sendValue === 'string' ? sendValue : null) ?? (typeof validityValue === 'string' ? validityValue : null);
    const create = () => void submit(async () => {
        if (problem || !target.contract || !target.account || p === null || typeof sendValue === 'string' || typeof validityValue === 'string') return false;
        const made = await addTrigger({ code: target.contract.code, condition, price: p, action, quantity: q, kind: kindFor(condition, action),
            role: 'entry', ...(cross ? { cross: true } : {}), ...(source === 'opposite' ? { source } : {}),
            ...(sendValue.type !== 'MKT' ? { send: sendValue } : {}), ...(validityValue ? { validity: validityValue } : {}) },
            target.contract, { account: target.account });
        if (made) onClose();
        return !!made;
    });
    const opWord = op === 'crossDown' ? '下穿' : op === 'crossUp' ? '上穿' : condition === 'below' ? '≤' : '≥';
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>條件</span>
                <select className={styles.select} aria-label='價格來源' value={source} onChange={e => setSource(e.target.value as 'last' | 'opposite')}>
                    <option value='last'>成交價</option>
                    <option value='opposite'>對手價</option>
                </select>
                <Seg label='條件' value={op} onChange={setOp}
                    options={[{ id: 'below', label: '≤' }, { id: 'above', label: '≥' }, { id: 'crossDown', label: '下穿' }, { id: 'crossUp', label: '上穿' }]} />
                <input className={styles.input} value={price} inputMode='decimal' aria-label='觸發價' placeholder='觸發價'
                    onChange={e => setPrice(e.target.value)} />
                {p !== null && last !== undefined && (
                    <span className={styles.muted}>{p - last > 0 ? '+' : p - last < 0 ? '−' : ''}{fmtNum(Math.abs(p - last))}</span>
                )}
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>動作</span>
                <Seg label='買賣' value={action} onChange={setAction} tone={id => id === 'Buy' ? 'buy' : 'sell'}
                    options={[{ id: 'Buy', label: '買進' }, { id: 'Sell', label: '賣出' }]} />
                <QtyInput qty={qty} setQty={setQty} unit={target.futures ? '口' : '張'} quick={defaults.quickQty} />
            </div>
            <SendControl value={send} onChange={setSend} futures={target.futures} />
            <ValidityControl value={validity} onChange={setValidity} market={market} />
            <Summary>
                {p === null || !target.contract ? '填好條件後，這裡會用一句話說明這張單會做什麼。' : (
                    <>
                        當 <b>{target.contract.code} {source === 'opposite' ? (action === 'Sell' ? '買價' : '賣價') : '成交價'} {opWord} {fmtNum(p)}</b> 時，送出
                        <b className={action === 'Buy' ? styles.up : styles.down}> {orderWords(target, action, q, sendValue, p)}</b>
                        {typeof sendValue !== 'string' && sendValue.type === 'LMT' ? '（觸價後限價，未成交會留在委託中）' : ''}。
                        {validityValue && typeof validityValue !== 'string' ? `${fmtUntil(validityValue.until)} 前有效。` : ''}
                        {cross ? '價格要先在另一側、再穿過才算。' : ''}
                        {APPROVAL}
                        {crossed && <span className={styles.tone.err}> 目前價已在觸發價這一側，建立後下一筆成交就會觸發。</span>}
                    </>
                )}
            </Summary>
            {error && <div className={styles.message.err} role='alert'>{error}</div>}
            <Footer busy={busy} problem={problem} onClose={onClose} onSubmit={create} />
        </>
    );
}

/** 二擇一 (OCO): watch both sides; one fires, the other is removed (or loses what filled). */
function OcoForm({ target, onClose, defaults }: { target: Target; onClose: () => void; defaults: FormDefaults }) {
    const [up, setUp] = useState({ price: '', action: 'Buy' as 'Buy' | 'Sell', qty: '1' });
    const [down, setDown] = useState({ price: '', action: 'Sell' as 'Buy' | 'Sell', qty: '1' });
    const [send, setSend] = useState<SendState>({ type: target.futures ? defaults.send : 'MKT', ticks: '0' });
    const [mode, setMode] = useState<'trigger' | 'fill'>(defaults.ocoMode);
    const [validity, setValidity] = useState<ValidityState>({ type: defaults.validity, date: '' });
    const { busy, error, submit } = useSubmit();
    const last = useLastPrice(target.resolved ?? '');
    const market: SessionMarket = target.futures ? 'futures' : 'stock';
    const pu = parseNum(up.price);
    const pd = parseNum(down.price);
    const qu = Number(up.qty);
    const qd = Number(down.qty);
    const sendValue = sendOf(send.type === 'MKP' && !target.futures ? { ...send, type: 'MKT' } : send);
    const validityValue = validityOf(validity, market);
    const problem = commonProblem(target) ?? priceProblem(target, pu, '上方價') ?? priceProblem(target, pd, '下方價')
        ?? (pu !== null && pd !== null && pu <= pd ? '上方價必須高於下方價' : null)
        ?? (![qu, qd].every(n => Number.isSafeInteger(n) && n > 0) ? '數量必須是正整數' : null)
        ?? (typeof sendValue === 'string' ? sendValue : null) ?? (typeof validityValue === 'string' ? validityValue : null);
    const outside = last !== undefined && pu !== null && pd !== null && (last >= pu || last <= pd);
    const unit = target.futures ? '口' : '張';
    const create = () => void submit(async () => {
        if (problem || !target.contract || !target.account || pu === null || pd === null || typeof sendValue === 'string' || typeof validityValue === 'string') return false;
        const group = `oco:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
        const base = { code: target.contract.code, role: 'entry' as const, group, ocoMode: mode, ...(validityValue ? { validity: validityValue } : {}),
            ...(sendValue.type !== 'MKT' ? { send: sendValue } : {}) };
        const made = await addTriggerGroup([
            { ...base, condition: 'above', price: pu, action: up.action, quantity: qu, kind: kindFor('above', up.action) },
            { ...base, condition: 'below', price: pd, action: down.action, quantity: qd, kind: kindFor('below', down.action) },
        ], target.contract, { account: target.account });
        if (made) onClose();
        return !!made;
    });
    const side = (label: string, op: string, v: typeof up, set: (v: typeof up) => void, word: string) => (
        <div className={styles.formRow}>
            <span className={styles.label}>{label}</span>
            <span>成交價 {op}</span>
            <input className={styles.input} value={v.price} inputMode='decimal' aria-label={`${label}價`} onChange={e => set({ ...v, price: e.target.value })} />
            <Seg label={`${label}買賣`} value={v.action} onChange={action => set({ ...v, action })} tone={id => id === 'Buy' ? 'buy' : 'sell'}
                options={[{ id: 'Buy', label: '買進' }, { id: 'Sell', label: '賣出' }]} />
            <input className={styles.inputNarrow} value={v.qty} inputMode='numeric' aria-label={`${label}數量`} onChange={e => set({ ...v, qty: e.target.value })} />
            <span>{unit}</span>
            <span className={styles.muted}>{word}</span>
        </div>
    );
    return (
        <>
            {side('上方', '≥', up, setUp, up.action === 'Buy' ? '突破' : '停利')}
            {side('下方', '≤', down, setDown, down.action === 'Sell' ? '跌破' : '拉回')}
            <SendControl value={send} onChange={setSend} futures={target.futures} />
            <div className={styles.formRow}>
                <span className={styles.label}>另一邊</span>
                <Seg label='另一邊' value={mode} onChange={setMode}
                    options={[{ id: 'trigger', label: '任一觸發就刪除' }, { id: 'fill', label: '成交後刪對應口數' }]} />
            </div>
            <ValidityControl value={validity} onChange={setValidity} market={market} />
            {pu !== null && pd !== null && pu > pd && <OcoLadder up={pu} down={pd} last={last} upText={`${fmtNum(pu)} ${up.action === 'Buy' ? '突破買進' : '停利賣出'}`}
                downText={`${fmtNum(pd)} ${down.action === 'Sell' ? '跌破賣出' : '拉回買進'}`} />}
            <Summary>
                {pu === null || pd === null ? '填好兩邊價格後，這裡會用一句話說明這組單會做什麼。' : (
                    <>
                        現價在中間時同時盯兩邊：
                        <b className={up.action === 'Buy' ? styles.up : styles.down}>漲到 {fmtNum(pu)} {orderWords(target, up.action, qu, sendValue, pu)}</b>，或
                        <b className={down.action === 'Buy' ? styles.up : styles.down}>跌到 {fmtNum(pd)} {orderWords(target, down.action, qd, sendValue, pd)}</b>；
                        {mode === 'trigger' ? '任一邊觸發，另一邊立刻刪除。' : '任一邊成交多少，另一邊就扣掉多少口數，其餘繼續盯價（限價以 IOC 送出）。'}
                        {APPROVAL}
                        {outside && <span className={styles.tone.err}> 目前價不在兩個價格之間，建立後下一筆成交就會觸發一邊。</span>}
                    </>
                )}
            </Summary>
            {error && <div className={styles.message.err} role='alert'>{error}</div>}
            <Footer busy={busy} problem={problem} onClose={onClose} onSubmit={create} />
        </>
    );
}

function OcoLadder({ up, down, last, upText, downText }: { up: number; down: number; last: number | undefined; upText: string; downText: string }) {
    // three dashed levels (design v4): upper, current price, lower
    const pos = (v: number) => {
        const hi = Math.max(up, last ?? up);
        const lo = Math.min(down, last ?? down);
        return hi === lo ? 45 : 14 + ((hi - v) / (hi - lo)) * 62;
    };
    return (
        <div className={styles.ladder} aria-hidden>
            <div className={styles.level.up} style={{ top: pos(up) }}>{upText}</div>
            {last !== undefined && <div className={styles.level.muted} style={{ top: pos(last) }}>現價 {fmtNum(last)}</div>}
            <div className={styles.level.down} style={{ top: pos(down) }}>{downText}</div>
        </div>
    );
}

interface TierRow { ticks: string; qty: string; trail: boolean }

/** 括號單 (成交後附保護): entry, stop / up to 3 take tiers in ticks from the
 * fill price, 移動停損 and 保本. */
function BracketForm({ target, onClose, defaults }: { target: Target; onClose: () => void; defaults: FormDefaults }) {
    const [action, setAction] = useState<'Buy' | 'Sell'>('Buy');
    const [qty, setQty] = useState('3');
    const [entryType, setEntryType] = useState<'LMT' | 'touch' | 'MKT'>('LMT');
    const [price, setPrice] = useState('');
    const [stopTicks, setStopTicks] = useState('');
    const [tiers, setTiers] = useState<TierRow[]>([{ ticks: '', qty: '3', trail: false }]);
    const [trailOn, setTrailOn] = useState(false);
    // 移動停損距離不預填：第一次使用由使用者填（說明用範例在 placeholder）
    const [trail, setTrail] = useState({ activate: '', distance: '', step: '' });
    const [beOn, setBeOn] = useState(false);
    const [beOffset, setBeOffset] = useState('0');
    const [validity, setValidity] = useState<ValidityState>({ type: defaults.validity, date: '' });
    const { busy, error, submit } = useSubmit();
    const priv = usePrivacyMoney();
    const last = useLastPrice(target.resolved ?? '');
    const market: SessionMarket = target.futures ? 'futures' : 'stock';
    const unit = target.futures ? '口' : '張';
    const total = Number(qty);
    const p = parseNum(price);
    const st = Number(stopTicks);
    const int = (v: string) => (v.trim() === '' ? NaN : Number(v));
    const plan: BracketEntryPlan = {
        tiers: tiers.map(t => ({ quantity: int(t.qty), takeTicks: t.trail ? null : int(t.ticks) })),
        stopTicks: st,
        trail: trailOn ? { activateTicks: int(trail.activate), distanceTicks: int(trail.distance), stepTicks: int(trail.step) } : null,
        breakeven: beOn ? { afterTier: 1, offsetTicks: int(beOffset) } : null,
    };
    const tierSum = plan.tiers.reduce((s, t) => s + (Number.isFinite(t.quantity) ? t.quantity : 0), 0);
    const validityValue = validityOf(validity, market);
    const ref = entryType === 'MKT' ? last ?? null : p;
    const dir = action === 'Buy' ? 1 : -1;
    const c = target.contract;
    const at = (ticks: number) => (c && ref !== null && Number.isFinite(ticks) ? stepPrice(c, ref, dir * ticks) : null);
    const mult = c ? (target.futures ? Number((c as ContractInfo & { multiplier?: number }).multiplier) || 0 : 1000) : 0;
    const riskPerLot = c && ref !== null && Number.isFinite(st) && st > 0 && mult > 0 ? Math.abs(ref - stepPrice(c, ref, -dir * st)) * mult : null;
    const problem = commonProblem(target)
        ?? (!Number.isSafeInteger(total) || total <= 0 ? '進場數量必須是正整數' : null)
        ?? (entryType !== 'MKT' ? priceProblem(target, p, entryType === 'LMT' ? '限價' : '觸發價') : last === undefined ? '市價進場需要現價' : null)
        ?? bracketPlanProblem(plan)
        ?? (c && ref !== null ? derivedPriceProblem({ contract: c, action, plan, refPrice: ref }) : null)
        ?? (tierSum !== total ? `各層數量合計 ${tierSum}，要等於進場 ${total} ${unit}` : null)
        ?? (entryType === 'touch' && typeof validityValue === 'string' ? validityValue : null);
    const setTier = (i: number, patch: Partial<TierRow>) => setTiers(ts => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    const create = () => void submit(async () => {
        if (problem || !c || !target.account || ref === null) return false;
        const touchCondition: 'below' | 'above' = last !== undefined && p !== null && p < last ? 'below' : 'above';
        const entry: PanelEntry = entryType === 'LMT' ? { type: 'LMT', price: p! } : entryType === 'MKT' ? { type: 'MKT' }
            : { type: 'touch', price: p!, condition: touchCondition, send: { type: target.futures ? 'MKP' : 'MKT' },
                validity: typeof validityValue === 'string' || !validityValue ? { type: 'session', until: sessionEnd(Date.now(), market) } : validityValue };
        const r = await placePanelBracket({ contract: c, account: target.account, action, entry, plan, refPrice: ref });
        if (typeof r === 'object') throw new Error(r.error);
        onClose();
        return true;
    });
    const fmtAt = (ticks: number) => { const v = at(ticks); return v === null ? '—' : `≈ ${fmtNum(v)}`; };
    const trailIdx = tiers.findIndex(t => t.trail);
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>進場</span>
                <Seg label='進場買賣' value={action} onChange={setAction} tone={id => id === 'Buy' ? 'buy' : 'sell'}
                    options={[{ id: 'Buy', label: '買進' }, { id: 'Sell', label: '賣出' }]} />
                <input className={styles.inputNarrow} value={qty} inputMode='numeric' aria-label='進場數量'
                    onChange={e => { setQty(e.target.value); if (tiers.length === 1) setTier(0, { qty: e.target.value }); }} />
                <span>{unit}</span>
                <Seg label='進場方式' value={entryType} onChange={setEntryType}
                    options={[{ id: 'LMT', label: '限價' }, { id: 'touch', label: '觸價' }, { id: 'MKT', label: '市價' }]} />
                {entryType !== 'MKT' && (
                    <input className={styles.input} value={price} inputMode='decimal' aria-label={entryType === 'LMT' ? '進場限價' : '進場觸發價'}
                        placeholder={entryType === 'LMT' ? '限價' : '觸發價'} onChange={e => setPrice(e.target.value)} />
                )}
            </div>
            <div className={styles.subhead}>
                <Shield size={13} aria-hidden />成交後自動保護
                <span className={styles.muted} style={{ fontWeight: 400 }}>以實際成交價計算，每成交一口就補上</span>
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>停損</span>
                <span>成交價 {action === 'Buy' ? '−' : '+'}</span>
                <input className={styles.inputNarrow} value={stopTicks} inputMode='numeric' aria-label='停損檔數' placeholder='例：40'
                    onChange={e => setStopTicks(e.target.value)} />
                <span>檔</span>
                <span className={styles.muted}>
                    {Number.isFinite(st) && st > 0 ? fmtAt(-st) : ''}
                    {riskPerLot !== null ? ` · 每${target.futures ? '口' : '張'}風險 ${maskMoney(`${fmtNum(Math.round(riskPerLot))} 元`, priv)}` : ''}
                </span>
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>停利</span>
                <span className={styles.muted}>分批（最多 3 層）</span>
                {tiers.length < 3 && (
                    <button type='button' className={styles.button.plain} onClick={() => setTiers(ts => [...ts, { ticks: '', qty: '1', trail: false }])}>
                        <Plus size={12} aria-hidden />加一層
                    </button>
                )}
            </div>
            {tiers.map((t, i) => (
                <div key={i} className={styles.tier}>
                    <span className={styles.muted}>第 {i + 1} 層</span>
                    {t.trail ? <span className={styles.tone.ok}>移動停損</span> : (
                        <span>
                            {action === 'Buy' ? '+' : '−'}
                            <input className={styles.inputNarrow} value={t.ticks} inputMode='numeric' aria-label={`第 ${i + 1} 層停利檔數`} placeholder='例：30'
                                onChange={e => setTier(i, { ticks: e.target.value })} /> 檔
                        </span>
                    )}
                    <span>
                        <input className={styles.inputNarrow} value={t.qty} inputMode='numeric' aria-label={`第 ${i + 1} 層數量`}
                            onChange={e => setTier(i, { qty: e.target.value })} /> {unit}
                    </span>
                    <span className={styles.tierTail}>
                        <span className={styles.muted}>{t.trail ? '見下方' : t.ticks ? fmtAt(Number(t.ticks)) : ''}</span>
                        <label className={styles.check}>
                            <input type='checkbox' checked={t.trail} disabled={trailIdx >= 0 && trailIdx !== i}
                                onChange={e => { setTier(i, { trail: e.target.checked }); if (e.target.checked) setTrailOn(true); }} />
                            移動停損
                        </label>
                        {tiers.length > 1 && (
                            <button type='button' className={styles.iconButton.plain} aria-label={`刪除第 ${i + 1} 層`}
                                onClick={() => setTiers(ts => ts.filter((_, j) => j !== i))}>
                                <X size={12} aria-hidden />
                            </button>
                        )}
                    </span>
                </div>
            ))}
            <div className={styles.formRow}>
                <span className={styles.label}>移動停損</span>
                <Switch on={trailOn} label='移動停損' onChange={setTrailOn} />
                <span>獲利</span>
                <input className={styles.inputNarrow} value={trail.activate} inputMode='numeric' aria-label='移動停損啟動檔數' placeholder='例：20'
                    disabled={!trailOn} onChange={e => setTrail({ ...trail, activate: e.target.value })} />
                <span>檔後啟動，距最{action === 'Buy' ? '高' : '低'}</span>
                <input className={styles.inputNarrow} value={trail.distance} inputMode='numeric' aria-label='移動停損距離檔數' placeholder='例：15'
                    disabled={!trailOn} onChange={e => setTrail({ ...trail, distance: e.target.value })} />
                <span>檔，每</span>
                <input className={styles.inputNarrow} value={trail.step} inputMode='numeric' aria-label='移動停損步長檔數' placeholder='例：5'
                    disabled={!trailOn} onChange={e => setTrail({ ...trail, step: e.target.value })} />
                <span>檔移動</span>
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>保本</span>
                <Switch on={beOn} label='保本' onChange={setBeOn} />
                <span>第 1 層成交後，停損移到成本 {action === 'Buy' ? '+' : '−'}</span>
                <input className={styles.inputNarrow} value={beOffset} inputMode='numeric' aria-label='保本檔數' disabled={!beOn}
                    onChange={e => setBeOffset(e.target.value)} />
                <span>檔</span>
            </div>
            {entryType === 'touch' && <ValidityControl value={validity} onChange={setValidity} market={market} />}
            {entryType === 'LMT' && <div className={`${styles.formRow} ${styles.muted}`}><span className={styles.label}>有效期</span>限價進場單當盤有效（ROD）；保護到出場或你移除為止</div>}
            <Summary>
                {ref === null || !c ? '填好進場與停損後，這裡會用一句話說明這張單會做什麼。' : (
                    <>
                        {entryType === 'LMT' ? `限價 ${fmtNum(ref)} ` : entryType === 'MKT' ? '市價 ' : `觸價 ${fmtNum(ref)} 時 `}
                        <b className={action === 'Buy' ? styles.up : styles.down}>{action === 'Buy' ? '買進' : '賣出'} {total || 0} {unit}</b>。
                        成交後停損在成本 {action === 'Buy' ? '−' : '+'}{Number.isFinite(st) && st > 0 ? st : '?'} 檔；
                        {plan.tiers.map((t, i) => t.takeTicks === null ? null
                            : `${action === 'Buy' ? '+' : '−'}${Number.isFinite(t.takeTicks) ? t.takeTicks : '?'} 檔停利 ${Number.isFinite(t.quantity) ? t.quantity : '?'} ${unit}${i < plan.tiers.length - 1 ? '、' : '；'}`)}
                        {trailOn && plan.trail ? `${trailIdx >= 0 ? `第 ${trailIdx + 1} 層` : '全部'}獲利 ${trail.activate || '?'} 檔後改為移動停損（距最${action === 'Buy' ? '高' : '低'} ${trail.distance || '?'} 檔、每 ${trail.step || '?'} 檔移動，只往有利方向）。` : ''}
                        {beOn ? `第 1 層成交後停損移到成本${Number(beOffset) ? ` ${action === 'Buy' ? '+' : '−'}${beOffset} 檔` : ''}。` : ''}
                        {APPROVAL}
                    </>
                )}
            </Summary>
            {error && <div className={styles.message.err} role='alert'>{error}</div>}
            <Footer busy={busy} problem={problem} onClose={onClose} onSubmit={create} />
        </>
    );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type='button' role='switch' aria-checked={on} aria-label={label} className={on ? styles.switchOn : styles.switchOff}
            onClick={() => onChange(!on)} />
    );
}

/** Taipei `HH:MM` today (or the next occurrence when `next`) as an instant. */
export function taipeiTimeToday(hhmm: string, now = Date.now(), next = false): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    const p = taipeiParts(now);
    let at = taipeiInstant(p.y, p.mo, p.d, Number(m[1]), Number(m[2]));
    if (next && at <= now) at += 24 * 3600_000;
    return at;
}

/** 時間: 指定時間送單, or 收盤前平倉. */
function TimeForm({ target, onClose, defaults }: { target: Target; onClose: () => void; defaults: FormDefaults }) {
    const [mode, setMode] = useState<'send' | 'flatten'>('flatten');
    const [time, setTime] = useState('');
    const [action, setAction] = useState<'Buy' | 'Sell'>('Sell');
    const [qty, setQty] = useState('1');
    const [send, setSend] = useState<SendState>({ type: target.futures ? defaults.send : 'MKT', ticks: '0' });
    // the session still to come: after the day close (or before 05:00) it is the night one
    const [session, setSession] = useState<'day' | 'night'>(() => {
        const p = taipeiParts(Date.now());
        const m = p.h * 60 + p.mi;
        return m >= 13 * 60 + 45 || m < 5 * 60 ? 'night' : 'day';
    });
    const [lead, setLead] = useState(target.futures ? '5' : '10');
    const [scope, setScope] = useState<'code' | 'account'>('code');
    const { busy, error, submit } = useSubmit();
    const unit = target.futures ? '口' : '張';
    // expiry day (last trading day): futures close at 13:30, no night session
    const lastDay = (target.contract as { last_trading_date?: string } | undefined)?.last_trading_date;
    const today = (() => { const p = taipeiParts(Date.now()); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; })();
    const expiryDay = !!lastDay && lastDay === today;
    const closeAt = target.futures
        ? (expiryDay ? taipeiTimeToday('13:30') : session === 'day' ? taipeiTimeToday('13:45') : taipeiTimeToday('05:00', Date.now(), true))
        : taipeiTimeToday('13:30');
    const leadN = Number(lead);
    const at = mode === 'send' ? taipeiTimeToday(time) : closeAt !== null && Number.isSafeInteger(leadN) && leadN >= 1 && leadN <= 60 ? closeAt - leadN * 60_000 : null;
    const q = Number(qty);
    const sendValue = sendOf(send.type === 'MKP' && !target.futures ? { ...send, type: 'MKT' } : send);
    const code = target.contract?.target_code || target.contract?.code || '';
    const problem = commonProblem(target)
        ?? (mode === 'send' && at === null ? '請輸入時間（例：13:30）' : null)
        ?? (mode === 'flatten' && at === null ? '提前分鐘數須為 1～60' : null)
        ?? (at !== null && at <= Date.now() ? '時間已過；只能設定今天還沒到的時間' : null)
        ?? (mode === 'send' && (!Number.isSafeInteger(q) || q <= 0) ? '數量必須是正整數' : null)
        ?? (mode === 'send' && send.type === 'LMT' ? '指定時間送單沒有觸發價，請選市價或範圍市價' : null)
        ?? (typeof sendValue === 'string' ? sendValue : null);
    const create = () => void submit(async () => {
        if (problem || !target.contract || !target.account || at === null || typeof sendValue === 'string') return false;
        const made = await addTrigger({
            code: target.contract.code, condition: 'above', price: 0, action: mode === 'send' ? action : 'Sell',
            quantity: mode === 'send' ? q : 0, kind: 'stop',
            time: mode === 'send' ? { kind: 'send', at } : { kind: 'flatten', at, scope },
            ...(mode === 'send' ? { role: 'entry' as const } : {}),
            ...(mode === 'send' && sendValue.type !== 'MKT' ? { send: sendValue } : {}),
        }, target.contract, { account: target.account });
        if (made) onClose();
        return !!made;
    });
    const when = at === null ? '—' : fmtUntil(at);
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>何時</span>
                <Seg label='何時' value={mode} onChange={setMode} options={[{ id: 'send', label: '指定時間' }, { id: 'flatten', label: '收盤前平倉' }]} />
            </div>
            {mode === 'send' ? (
                <>
                    <div className={styles.formRow}>
                        <span className={styles.label}>時間</span>
                        <input className={styles.input} type='time' value={time} aria-label='送單時間' onChange={e => setTime(e.target.value)} />
                        <span className={styles.muted}>今天（台北時間）</span>
                    </div>
                    <div className={styles.formRow}>
                        <span className={styles.label}>動作</span>
                        <Seg label='買賣' value={action} onChange={setAction} tone={id => id === 'Buy' ? 'buy' : 'sell'}
                            options={[{ id: 'Buy', label: '買進' }, { id: 'Sell', label: '賣出' }]} />
                        <QtyInput qty={qty} setQty={setQty} unit={unit} quick={defaults.quickQty} />
                    </div>
                    <SendControl value={send} onChange={setSend} futures={target.futures} label='送出方式' />
                </>
            ) : (
                <>
                    <div className={styles.formRow}>
                        <span className={styles.label}>盤別</span>
                        {target.futures && !expiryDay ? (
                            <Seg label='盤別' value={session} onChange={setSession}
                                options={[{ id: 'day', label: '日盤 13:45' }, { id: 'night', label: '夜盤 05:00' }]} />
                        ) : <span>{expiryDay ? '最後交易日收盤 13:30' : '收盤 13:30'}</span>}
                        <span>提前</span>
                        <input className={styles.inputNarrow} value={lead} inputMode='numeric' aria-label='提前分鐘' onChange={e => setLead(e.target.value)} />
                        <span>分鐘</span>
                    </div>
                    <div className={styles.formRow}>
                        <span className={styles.label}>範圍</span>
                        <Seg label='範圍' value={scope} onChange={setScope}
                            options={[{ id: 'code', label: '此商品' }, { id: 'account', label: `此帳戶全部${target.futures ? '期貨' : '股票'}` }]} />
                    </div>
                    <div className={styles.formRow}>
                        <span className={styles.label}>做法</span>
                        <span>先刪未成交委託與條件單，再以{target.futures ? '範圍市價' : '市價'}平掉剩餘部位</span>
                    </div>
                </>
            )}
            <Summary>
                {mode === 'send' ? (
                    <><b>{when}</b> 送出 <b className={action === 'Buy' ? styles.up : styles.down}>{orderWords(target, action, q, sendValue, null)}</b>（{code}）。
                        時間已過（例如 App 當時沒開）就不補送。{APPROVAL}</>
                ) : (
                    <><b>{when}</b> 先刪除{scope === 'code' ? ` ${code} ` : '此帳戶'}未成交的委託與條件單，再以{target.futures ? '範圍市價' : '市價'}平掉
                        {scope === 'code' ? ` ${code} ` : '此帳戶'}剩餘部位。只在當日有效；到時若無部位就不送單，不會反手開倉。{APPROVAL}</>
                )}
            </Summary>
            {error && <div className={styles.message.err} role='alert'>{error}</div>}
            <Footer busy={busy} problem={problem} onClose={onClose} onSubmit={create} />
        </>
    );
}

/** Form defaults (the panel's settings fill these in). */
export interface FormDefaults {
    send: 'MKT' | 'MKP' | 'LMT';
    validity: ValidityState['type'];
    ocoMode: 'trigger' | 'fill';
    quickQty: number[];
}
export const FORM_DEFAULTS: FormDefaults = { send: 'MKP', validity: 'session', ocoMode: 'trigger', quickQty: QUICK_QTY };

export function NewConditionalDialog({ contract, onClose, defaults = FORM_DEFAULTS }: {
    contract: ContractInfo | null;
    onClose: () => void;
    defaults?: FormDefaults;
}) {
    const target = useTarget(contract);
    const [type, setType] = useState<CondFormType>('trigger');
    return (
        <Dialog title='新增條件單' icon={<Plus size={14} aria-hidden />} onClose={onClose}>
            <div className={styles.formRow}>
                <span className={styles.label}>類型</span>
                <Seg label='類型' value={type} onChange={setType} options={[{ id: 'trigger', label: '觸價單' }, { id: 'oco', label: '二擇一' }, { id: 'bracket', label: '括號單' }, { id: 'time', label: '時間' }]} />
            </div>
            <TargetRows target={target} />
            {type === 'trigger' && <TriggerForm key={`t:${target.resolved}`} target={target} onClose={onClose} defaults={defaults} />}
            {type === 'oco' && <OcoForm key={`o:${target.resolved}`} target={target} onClose={onClose} defaults={defaults} />}
            {type === 'time' && <TimeForm key={`m:${target.resolved}`} target={target} onClose={onClose} defaults={defaults} />}
            {type === 'bracket' && <BracketForm key={`b:${target.resolved}`} target={target} onClose={onClose} defaults={defaults} />}
        </Dialog>
    );
}
