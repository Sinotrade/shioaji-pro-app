// src/components/conditional-dialogs.tsx — 條件單設定 and 全平並取消 (#226,
// design v4). 全平並取消 shows its scope and what it will do, then needs a
// second, deliberate click; it never opens a position.

import { Info, OctagonX, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccounts } from '../lib/account-store';
import type { AccountRef } from '../lib/bracket-core';
import { accountTag, type CondRow } from '../lib/conditional/rows';
import { planFlatten, workingInScope, inScope, type FlattenResult, type FlattenScope } from '../lib/conditional/flatten';
import { flattenSummary, runFlatten } from '../lib/conditional/runtime';
import { setConditionalSettings, useConditionalSettings } from '../lib/conditional/settings';
import { conditionalDemoActive, demoFlattenState } from '../lib/conditional/demo';
import { getCachedContract } from '../lib/contracts-cache';
import { backgroundSupported } from '../lib/execution/background';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { setRiskSettings, useRiskSettings } from '../lib/risk';
import { useTradingState } from '../lib/trading-state';
import type { ContractInfo } from '../lib/types/contract';
import { BackgroundExecutionSetting } from './background-execution-setting';
import { Seg } from './conditional-form';
import { Dialog } from './conditional-ui';
import * as styles from './conditional-panel.css';

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
    return (
        <button type='button' role='switch' aria-checked={on} aria-label={label} disabled={disabled}
            className={on ? styles.switchOn : styles.switchOff} onClick={() => onChange(!on)} />
    );
}

function Row({ name, hint, children, last }: { name: string; hint: string; children: React.ReactNode; last?: boolean }) {
    return (
        <div className={last ? styles.settingLast : styles.setting}>
            <div className={styles.grow}>
                <div className={styles.settingName}>{name}</div>
                <div className={styles.muted}>{hint}</div>
            </div>
            {children}
        </div>
    );
}

export function ConditionalSettingsDialog({ onClose }: { onClose: () => void }) {
    const s = useConditionalSettings();
    const risk = useRiskSettings();
    const [qty, setQty] = useState(s.quickQty.join(', '));
    const saveQty = () => {
        const list = qty.split(/[,\s，]+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
        setConditionalSettings({ quickQty: list });
        setQty((list.length ? list : s.quickQty).join(', '));
    };
    return (
        <Dialog title='條件單設定' icon={<Settings2 size={14} aria-hidden />} onClose={onClose}>
            <div className={styles.settings}>
                <Row name='背景持續執行（實驗）' hint='視窗關閉或重新載入時，期貨選擇權的停損停利與括號單仍持續盯價與送單'>
                    {backgroundSupported() ? <span /> : <span className={styles.muted}>只在桌面版提供</span>}
                </Row>
                {backgroundSupported() && <div className={styles.settingEmbed}><BackgroundExecutionSetting /></div>}
                <Row name='預設有效期' hint='新增條件單時預先選好的有效期'>
                    <Seg label='預設有效期' value={s.defaultValidity} onChange={v => setConditionalSettings({ defaultValidity: v })}
                        options={[{ id: 'session', label: '本盤' }, { id: 'today', label: '今日' }]} />
                </Row>
                <Row name='預設送出方式' hint='觸價成立後送單的方式（期貨選擇權；股票一律市價）'>
                    <Seg label='預設送出方式' value={s.defaultSend} onChange={v => setConditionalSettings({ defaultSend: v })}
                        options={[{ id: 'MKP', label: '範圍市價' }, { id: 'LMT', label: '限價' }]} />
                </Row>
                <Row name='觸發與成交通知' hint='條件成立、送出、成交時跳通知；錯誤與待確認一律通知'>
                    <Switch on={s.notify} label='觸發與成交通知' onChange={v => setConditionalSettings({ notify: v })} />
                </Row>
                <Row name='恢復時已穿價' hint='App 重開或連線恢復時，若條件早已成立：不自動送出，等你決定'>
                    <Seg label='恢復時已穿價' value='confirm' onChange={() => undefined} options={[{ id: 'confirm', label: '等我確認' }]} />
                </Row>
                <Row name='二擇一／停損停利的另一邊' hint='一邊觸發時，另一邊怎麼處理（新增二擇一的預設）'>
                    <Seg label='另一邊' value={s.ocoMode} onChange={v => setConditionalSettings({ ocoMode: v })}
                        options={[{ id: 'trigger', label: '觸發就刪除' }, { id: 'fill', label: '成交後刪對應口數' }]} />
                </Row>
                <Row name='快速口數' hint='新增條件單時的數量按鈕（以逗號分隔，最多 6 個）'>
                    <input className={styles.input} value={qty} aria-label='快速口數' onChange={e => setQty(e.target.value)} onBlur={saveQty}
                        onKeyDown={e => { if (e.key === 'Enter') saveQty(); }} />
                </Row>
                <Row name='下單確認（含平倉）' hint='手動下單與平倉前先跳委託確認；條件成立後的自動送單不再詢問'>
                    <Switch on={risk.confirmManualOrders} label='下單確認' onChange={v => setRiskSettings({ confirmManualOrders: v })} />
                </Row>
                <Row name='Esc 連按兩下取消全部委託' hint='在任何畫面 0.6 秒內連按兩下 Esc，撤銷所有未成交委託'>
                    <Switch on={risk.escCancelAll} label='Esc 連按兩下取消全部委託' onChange={v => setRiskSettings({ escCancelAll: v })} />
                </Row>
                <div className={styles.settingSection}>括號單規則</div>
                <Row name='新盤別自動重新啟用' hint='目前一律由你在新盤別確認口數後重新啟用（委託不跨盤別）'>
                    <Switch on={false} label='新盤別自動重新啟用' disabled onChange={() => undefined} />
                </Row>
                <Row name='晚到成交自動補保護' hint='目前不自動補：保護結束後才成交的口數標示「未受保護」並通知'>
                    <Switch on={false} label='晚到成交自動補保護' disabled onChange={() => undefined} />
                </Row>
                <Row name='全部暫停時停損停利也暫停' hint='預設只停新進場；開啟後全部暫停也會停下停損停利（括號單的保護不受影響）' last>
                    <Switch on={s.pauseStopsExits} label='全部暫停時停損停利也暫停' onChange={v => setConditionalSettings({ pauseStopsExits: v })} />
                </Row>
            </div>
        </Dialog>
    );
}

type ScopeKind = 'code' | 'account' | 'all';

function scopeOf(kind: ScopeKind, contract: ContractInfo | null, account: AccountRef | null): FlattenScope | null {
    if (kind === 'all') return { type: 'all' };
    if (kind === 'account') return account ? { type: 'account', account } : null;
    if (!contract) return null;
    return { type: 'code', codes: [...new Set([contract.code, contract.target_code || contract.code])], account: null };
}

const KIND_WORD: Record<string, string> = { trigger: '觸價', oco: '二擇一', bracket: '括號', time: '時間', grid: '蛛網' };

export function FlattenDialog({ contract: given, rows, onClose }: { contract: ContractInfo | null; rows: CondRow[]; onClose: () => void }) {
    // dev-only sample (`?condDemo`): sample holdings, nothing is sent
    const demo = conditionalDemoActive() ? demoFlattenState() : null;
    const contract = given ?? (demo ? getCachedContract('TXFJ6') ?? null : null);
    const futures = contract?.security_type === 'FUT' || contract?.security_type === 'OPT';
    const accounts = useAccounts();
    const live = useTradingState();
    const trading = demo ? { ...live, positions: demo.positions as never, trades: demo.trades as never } : live;
    const priv = usePrivacyMode();
    const selected = futures ? accounts.selectedFutures : accounts.selectedStock;
    const account: AccountRef | null = demo ? demo.account : selected && (selected.account_type === 'S' || selected.account_type === 'F')
        ? { account_type: selected.account_type, broker_id: selected.broker_id, account_id: selected.account_id } : null;
    const [kind, setKind] = useState<ScopeKind>(contract ? 'code' : 'account');
    const [armed, setArmed] = useState(false);
    const armedAt = useRef(0);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<FlattenResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const scope = scopeOf(kind, contract, account);
    useEffect(() => { setArmed(false); }, [kind]);
    useEffect(() => {
        if (!armed) return;
        const t = setTimeout(() => setArmed(false), 10_000);
        return () => clearTimeout(t);
    }, [armed]);
    const preview = useMemo(() => {
        if (!scope) return null;
        const conditional = rows.filter(r => ['trigger', 'oco', 'bracket', 'bgBracket'].includes(r.source.type))
            .filter(r => [r.code, r.orderCode].some(c => inScope(scope, r.account, c)));
        const byKind = new Map<string, number>();
        for (const r of conditional) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
        const working = workingInScope(trading.trades, scope);
        const plan = planFlatten(trading.positions, scope);
        return { conditional, byKind, working, plan };
    }, [scope, rows, trading.trades, trading.positions]);
    const go = () => {
        if (!scope) return;
        if (!armed) { armedAt.current = Date.now(); setArmed(true); return; }
        if (Date.now() - armedAt.current < 400) return; // a double-click never passes both steps
        setArmed(false);
        if (conditionalDemoActive()) { setError('示範資料：不會執行全平並取消'); return; }
        setBusy(true);
        setError(null);
        void runFlatten(scope).then(setResult, e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
    };
    const scopeOptions = [
        { id: 'code' as const, label: contract ? (contract.target_code || contract.code) : '此商品', disabled: !contract },
        { id: 'account' as const, label: '此帳戶', disabled: !account, title: account ? accountTag(account, id => maskAccountId(id, priv)) : '沒有選擇帳戶' },
        { id: 'all' as const, label: '全部帳戶' },
    ];
    const positionsText = preview?.plan.orders.length
        ? preview.plan.orders.map(o => `${o.code} ${o.action === 'Sell' ? '多單' : '空單'} ${o.market === 'stock' ? `${o.quantity} 股` : `${o.quantity} 口`}`).join('、')
        : '目前沒有部位';
    return (
        <Dialog title='全平並取消' tone='danger' icon={<OctagonX size={14} aria-hidden />} onClose={onClose} narrow
            footer={result ? (
                <><span className={styles.grow} /><button type='button' className={styles.button.plain} onClick={onClose}>關閉</button></>
            ) : (
                <>
                    <span className={styles.grow} />
                    <button type='button' className={styles.button.plain} onClick={onClose}>取消</button>
                    <button type='button' className={styles.button.dangerSolid} disabled={busy || !scope} onClick={go}>
                        {busy ? '處理中…' : armed ? '再按一次：確認全平' : '確認全平'}
                    </button>
                </>
            )}>
            <div className={styles.formRow}>
                <span className={styles.label}>範圍</span>
                <Seg label='範圍' value={kind} onChange={setKind} options={scopeOptions} />
            </div>
            {result ? (
                <div className={styles.summary} role='status'><Info size={13} aria-hidden style={{ flex: 'none', marginTop: 4 }} /><span>{flattenSummary(result)}</span></div>
            ) : preview && (
                <div className={styles.summary} style={{ marginTop: 4, lineHeight: 1.9 }}>
                    <span>
                        將會：<br />
                        ① 暫停並取消 <b>{preview.conditional.length}</b> 張條件單
                        {preview.byKind.size > 0 && `（${[...preview.byKind].map(([k, n]) => `${KIND_WORD[k] ?? k} ${n}`).join('、')}）`}<br />
                        ② 刪除 <b>{preview.working.length}</b> 張未成交委託<br />
                        ③ 以<b>{futures || kind !== 'code' ? '範圍市價' : '市價'}</b>平倉 <b className={styles.up}>{positionsText}</b>（依成交回報重算，不會反手開倉）
                        {preview.plan.skipped.length > 0 && <><br /><span className={styles.tone.warn}>不會平倉：{preview.plan.skipped.map(s => `${s.code}（${s.reason}）`).join('、')}</span></>}
                    </span>
                </div>
            )}
            <div className={`${styles.formRow} ${styles.muted}`}>
                <Info size={13} aria-hidden style={{ flex: 'none' }} />
                <span className={styles.grow}>漲跌停或無對手單時可能無法成交，剩餘部位會留在面板與持倉提醒；送出前會重新查詢委託與持倉</span>
            </div>
            {error && <div className={styles.message.err} role='alert'>{error}</div>}
        </Dialog>
    );
}
