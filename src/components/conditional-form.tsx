// src/components/conditional-form.tsx — 新增條件單 (#226, design v4). The
// form only builds a request; the trigger engine validates and owns it.
// Pressing 建立 is the approval of the order it will send: when the
// condition is met it goes out without asking again.

import { Info, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { canTrade } from '../lib/account-tradable';
import { useAccounts } from '../lib/account-store';
import { ensureContract, useContract } from '../lib/contracts-cache';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { addTrigger } from '../lib/trigger-engine';
import { contractLabel } from '../lib/pending-trigger-view';
import { roundToTick } from '../lib/utils/ticksize';
import { fmtNum } from '../lib/conditional/session';
import type { ContractInfo } from '../lib/types/contract';
import type { Account } from '../lib/types/portfolio';
import { Dialog, useLastPrice } from './conditional-ui';
import * as styles from './conditional-panel.css';

export type CondFormType = 'trigger';
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
    const [code, setCode] = useState(initial?.code ?? '');
    const [resolved, setResolved] = useState<string | null>(initial?.code ?? null);
    const [lookupError, setLookupError] = useState<string | null>(null);
    const contract = useContract(resolved);
    const futures = isFuturesLike(contract);
    const state = useAccounts();
    const accounts = useMemo(() => marketAccounts(state.accounts, futures), [state.accounts, futures]);
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

/** The trigger form (觸價單). */
function TriggerForm({ target, onClose }: { target: Target; onClose: () => void }) {
    const [condition, setCondition] = useState<'below' | 'above'>('below');
    const [price, setPrice] = useState('');
    const [action, setAction] = useState<'Buy' | 'Sell'>('Sell');
    const [qty, setQty] = useState('1');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const last = useLastPrice(target.resolved ?? '');
    const p = parseNum(price);
    const q = Number(qty);
    const unit = target.futures ? '口' : '張';
    useEffect(() => { setError(null); }, [price, qty, condition, action, target.resolved]);
    const crossed = p !== null && last !== undefined && (condition === 'below' ? last <= p : last >= p);
    const problem = (() => {
        const c = target.contract;
        if (!c) return '請先選擇商品';
        if (c.security_type !== 'STK' && !isFuturesLike(c)) return '此商品不支援條件單';
        if (!target.account) return `沒有可下單的${target.futures ? '期貨' : '證券'}帳戶`;
        if (p === null || p <= 0) return '請輸入觸發價';
        if (roundToTick(c, p) !== p) return `觸發價 ${fmtNum(p)} 不在跳動點上`;
        if (!Number.isSafeInteger(q) || q <= 0) return '數量必須是正整數';
        return null;
    })();
    const submit = async () => {
        if (problem || !target.contract || !target.account || p === null) { setError(problem); return; }
        setBusy(true);
        try {
            const kind = (condition === 'below') === (action === 'Sell') ? 'stop' : 'take';
            const made = await addTrigger({ code: target.contract.code, condition, price: p, action, quantity: q, kind, role: 'entry' },
                target.contract, { account: target.account });
            if (made) onClose();
            else setError('沒有建立（原因見通知）');
        } finally {
            setBusy(false);
        }
    };
    const word = condition === 'below' ? (action === 'Sell' ? '跌破' : '拉回') : (action === 'Buy' ? '突破' : '上漲');
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>條件</span>
                <span className={styles.muted}>成交價</span>
                <Seg label='條件' value={condition} onChange={setCondition}
                    options={[{ id: 'below', label: '≤' }, { id: 'above', label: '≥' }]} />
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
                <input className={styles.inputNarrow} value={qty} inputMode='numeric' aria-label='數量' onChange={e => setQty(e.target.value)} />
                <span>{unit}</span>
                {QUICK_QTY.map(n => (
                    <button key={n} type='button' className={styles.button.plain} onClick={() => setQty(String(n))}>{n}</button>
                ))}
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>觸發後</span>
                <Seg label='觸發後' value='MKT' onChange={() => undefined} options={[{ id: 'MKT', label: '市價' }]} />
            </div>
            <div className={styles.summary}>
                <Info size={13} aria-hidden style={{ flex: 'none', marginTop: 4 }} />
                <span>
                    {p === null || !target.contract ? '填好條件後，這裡會用一句話說明這張單會做什麼。' : (
                        <>
                            當 <b>{target.contract.code} 成交價 {condition === 'below' ? '≤' : '≥'} {fmtNum(p)}</b>（{word}）時，送出
                            <b className={action === 'Buy' ? styles.up : styles.down}> {action === 'Buy' ? '買進' : '賣出'} {q || 0} {unit} 市價</b>。
                            直到你取消或它觸發為止。按「建立」即核可這筆下單，條件成立時不會再詢問。
                            {crossed && <span className={styles.tone.err}> 目前價已在觸發價這一側，建立後下一筆成交就會觸發。</span>}
                        </>
                    )}
                </span>
            </div>
            {error && <div className={styles.message.err} role='alert'>{error}</div>}
            <div className={styles.dialogFoot} style={{ margin: '12px -12px -12px' }}>
                <span className={styles.grow} />
                <button type='button' className={styles.button.plain} onClick={onClose}>取消</button>
                <button type='button' className={styles.button.primary} disabled={busy || !!problem} title={problem ?? undefined}
                    onClick={() => void submit()}>
                    建立
                </button>
            </div>
        </>
    );
}

export function NewConditionalDialog({ contract, onClose }: { contract: ContractInfo | null; onClose: () => void }) {
    const target = useTarget(contract);
    const [type, setType] = useState<CondFormType>('trigger');
    return (
        <Dialog title='新增條件單' icon={<Plus size={14} aria-hidden />} onClose={onClose}>
            <div className={styles.formRow}>
                <span className={styles.label}>類型</span>
                <Seg label='類型' value={type} onChange={setType} options={[{ id: 'trigger', label: '觸價單' }]} />
            </div>
            <TargetRows target={target} />
            <TriggerForm target={target} onClose={onClose} />
        </Dialog>
    );
}
