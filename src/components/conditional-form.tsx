// src/components/conditional-form.tsx — 新增條件單 (#226, design v4). The
// form only builds a request; the trigger engine validates and owns it.
// Pressing 建立 is the approval of the order it will send: when the
// condition is met it goes out without asking again.

import { Info, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { canTrade } from '../lib/account-tradable';
import { useAccounts } from '../lib/account-store';
import { ensureContract, useContract } from '../lib/contracts-cache';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { addTrigger, addTriggerGroup, type TriggerSend, type TriggerValidity } from '../lib/trigger-engine';
import { dateEnd, dayEnd, fmtNum, fmtUntil, sessionEnd, type SessionMarket } from '../lib/conditional/session';
import { contractLabel } from '../lib/pending-trigger-view';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import type { ContractInfo } from '../lib/types/contract';
import type { Account } from '../lib/types/portfolio';
import { conditionalDemoActive, DEMO_ACCOUNTS, primeConditionalDemo } from '../lib/conditional/demo';
import { Dialog, useLastPrice } from './conditional-ui';
import * as styles from './conditional-panel.css';

export type CondFormType = 'trigger' | 'oco';
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
    const [code, setCode] = useState(first);
    const [resolved, setResolved] = useState<string | null>(first || null);
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
        setLookupError(null);
        void ensureContract(c).then(() => setResolved(c)).catch(() => setLookupError(`找不到商品 ${c}`));
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

function QtyInput({ qty, setQty, unit }: { qty: string; setQty: (v: string) => void; unit: string }) {
    return (
        <>
            <input className={styles.inputNarrow} value={qty} inputMode='numeric' aria-label='數量' onChange={e => setQty(e.target.value)} />
            <span>{unit}</span>
            {QUICK_QTY.map(n => (
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
    if (!c) return '請先選擇商品';
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
                <QtyInput qty={qty} setQty={setQty} unit={target.futures ? '口' : '張'} />
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

/** Form defaults (the panel's settings fill these in). */
export interface FormDefaults {
    send: 'MKT' | 'MKP' | 'LMT';
    validity: ValidityState['type'];
    ocoMode: 'trigger' | 'fill';
}
export const FORM_DEFAULTS: FormDefaults = { send: 'MKP', validity: 'session', ocoMode: 'trigger' };

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
                <Seg label='類型' value={type} onChange={setType} options={[{ id: 'trigger', label: '觸價單' }, { id: 'oco', label: '二擇一' }]} />
            </div>
            <TargetRows target={target} />
            {type === 'trigger' && <TriggerForm key={`t:${target.resolved}`} target={target} onClose={onClose} defaults={defaults} />}
            {type === 'oco' && <OcoForm key={`o:${target.resolved}`} target={target} onClose={onClose} defaults={defaults} />}
        </Dialog>
    );
}
