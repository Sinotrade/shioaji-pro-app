// src/components/flash-protect.tsx — 閃電下單的「自動停損停利」列與設定（#216）。
// 列：目前設定、保護中數量、由誰執行；點開設定：開關、停損／停利檔數、
// 移動停損。設定屬於這個面板（FlashOrderOpts.protect），換設定解除點價。

import { ChevronDown, ShieldCheck, ShieldOff, ShieldAlert } from 'lucide-react';
import { useState, type MutableRefObject } from 'react';
import { DEFAULT_PROTECT, flashProtectProblem, flashProtectText, PROTECT_MAX_TICKS, type FlashProtect } from '../lib/flash-trigger';
import * as styles from './flash-order.css';

const numText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const parse = (s: string): number | null => (s.trim() === '' ? null : Number(s.trim()));

/** The draft as a setting, or why not. */
export function draftProtect(d: { on: boolean; stop: string; take: string; trail: boolean; activate: string; distance: string; step: string }): FlashProtect | string {
    const stop = parse(d.stop);
    const take = parse(d.take);
    const ints = (v: number | null, min: number) => v !== null && Number.isSafeInteger(v) && v >= min && v <= PROTECT_MAX_TICKS;
    if (!ints(stop, 1)) return `停損檔數須為 1～${PROTECT_MAX_TICKS} 的整數`;
    if (take !== null && !ints(take, 1)) return `停利檔數須為 1～${PROTECT_MAX_TICKS} 的整數，或留空`;
    let trail: FlashProtect['trail'] = null;
    if (d.trail) {
        const [a, dist, st] = [parse(d.activate), parse(d.distance), parse(d.step)];
        if (!ints(a, 0) || !ints(dist, 1) || !ints(st, 1)) return '移動停損的啟動、距離與移動檔數要填整數（距離與移動至少 1）';
        trail = { activateTicks: a!, distanceTicks: dist!, stepTicks: st! };
    }
    const p: FlashProtect = { on: d.on, stopTicks: stop!, takeTicks: take, trail };
    return flashProtectProblem(p) ?? p;
}

export function FlashProtectStrip({ protect, block, protectedQty, background, unit, onChange, compact = false, openRef }: {
    /** a small chip in the action bar (開／關＋保護中 N) instead of a row */
    compact?: boolean;
    /** lets the panel's settings open this editor */
    openRef?: MutableRefObject<(() => void) | null>;
    protect: FlashProtect | undefined;
    /** why the panel's current conditions cannot carry it (shown while on) */
    block: string | null;
    /** quantity under protection now (already masked when privacy is on) */
    protectedQty: string | null;
    background: boolean;
    unit: string;
    onChange: (next: FlashProtect) => void;
}) {
    const p = protect ?? DEFAULT_PROTECT;
    const [open, setOpen] = useState(false);
    const tone = !p.on ? 'off' : block ? 'bad' : 'on';
    const Icon = !p.on ? ShieldOff : block ? ShieldAlert : ShieldCheck;
    if (openRef) openRef.current = () => setOpen(true);
    const menu = open && <ProtectMenu protect={p} background={background} onClose={() => setOpen(false)} onSave={next => { onChange(next); setOpen(false); }} />;
    if (compact) {
        return (
            <span className={styles.protectChipAnchor}>
                <button
                    type='button'
                    className={styles.protectChip[tone]}
                    data-testid='flash-protect'
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    title={p.on
                        ? `自動停損停利：${flashProtectText(p)}${block ? `\n${block}` : ''}${protectedQty ? `\n保護中 ${protectedQty} ${unit}` : ''}${background ? '\n由背景執行' : ''}\n點一下修改`
                        : '自動停損停利：關（點一下設定）'}
                    onClick={() => setOpen(!open)}
                >
                    <Icon size={11} aria-hidden />
                    <span className={styles.protectChipText}>停損停利{p.on ? (block ? '・不符' : protectedQty ? `・保護 ${protectedQty}` : '・開') : '・關'}</span>
                </button>
                {menu}
            </span>
        );
    }
    return (
        <div className={styles.protectAnchor}>
            <button
                type='button'
                className={styles.protectStrip[tone]}
                data-testid='flash-protect'
                aria-haspopup='dialog'
                aria-expanded={open}
                title={p.on ? (block ?? '每筆閃電進場成交後，依實際成交價自動掛停損停利；點一下修改') : '點一下設定自動停損停利'}
                onClick={() => setOpen(!open)}
            >
                <Icon size={11} aria-hidden />
                <span className={styles.protectLabel}>自動停損停利</span>
                <span className={styles.protectValue}>{p.on ? flashProtectText(p) : '關'}</span>
                {p.on && block && <span className={styles.protectWarn}>{block}</span>}
                {p.on && !block && protectedQty && <span className={styles.protectMeta}>保護中 {protectedQty} {unit}</span>}
                {p.on && !block && background && <span className={styles.protectMeta}>背景執行</span>}
                <ChevronDown size={9} aria-hidden className={styles.protectChevron} />
            </button>
            {menu}
        </div>
    );
}

function ProtectMenu({ protect, background, onClose, onSave }: { protect: FlashProtect; background: boolean; onClose: () => void; onSave: (p: FlashProtect) => void }) {
    const [d, setD] = useState({
        on: protect.on,
        stop: numText(protect.stopTicks),
        take: numText(protect.takeTicks),
        trail: !!protect.trail,
        activate: numText(protect.trail?.activateTicks ?? 0),
        distance: numText(protect.trail?.distanceTicks),
        step: numText(protect.trail?.stepTicks ?? 1),
    });
    const result = draftProtect(d);
    const problem = typeof result === 'string' ? result : null;
    const field = (key: 'stop' | 'take' | 'activate' | 'distance' | 'step', label: string, disabled = false) => (
        <input
            className={styles.protectInput}
            aria-label={label}
            value={d[key]}
            inputMode='numeric'
            disabled={disabled}
            onChange={e => setD({ ...d, [key]: e.target.value.replace(/[^\d]/g, '') })}
        />
    );
    return (
        <>
            <div className={styles.menuBackdrop} onClick={onClose} />
            <div className={styles.protectMenu} role='dialog' aria-label='自動停損停利設定'>
                <div className={styles.protectHead}>
                    <span>自動停損停利</span>
                    <button
                        type='button'
                        role='switch'
                        aria-checked={d.on}
                        aria-label='自動停損停利開關'
                        className={styles.menuSegBtn[d.on ? 'on' : 'off']}
                        onClick={() => setD({ ...d, on: !d.on })}
                    >
                        {d.on ? '開' : '關'}
                    </button>
                </div>
                <div className={styles.protectRow}><span className={styles.menuSegLabel}>停損</span>成交價{' '}{field('stop', '停損檔數')} 檔</div>
                <div className={styles.protectRow}><span className={styles.menuSegLabel}>停利</span>成交價{' '}{field('take', '停利檔數')} 檔<span className={styles.menuDesc}>留空＝不設</span></div>
                <label className={styles.protectRow}>
                    <input type='checkbox' checked={d.trail} onChange={e => setD({ ...d, trail: e.target.checked })} />
                    移動停損
                </label>
                {d.trail && (
                    <div className={styles.protectSub}>
                        獲利 {field('activate', '啟動檔數')} 檔後啟動，距最高 {field('distance', '距離檔數')} 檔，每 {field('step', '移動檔數')} 檔移動
                    </div>
                )}
                <div className={styles.menuNote}>
                    每筆閃電進場（點價、市價、觸價進場）成交後，依實際成交價計算停損停利，只保護該筆成交的數量；觸發後市價平倉。
                    減倉不附加；反手（數量大於持倉）不送。按平倉或全刪會先取消這個商品的停損停利（出場單送出中或結果未知時不平倉）。
                </div>
                <div className={styles.menuNote}>{background ? '背景持續執行開啟：保護由背景執行。' : '保護由本視窗（主視窗）執行。'}</div>
                {problem && <div className={styles.protectError} role='alert'>{problem}</div>}
                <div className={styles.protectActions}>
                    <button type='button' className={styles.menuSegBtn.off} onClick={onClose}>取消</button>
                    <button type='button' className={styles.menuSegBtn.on} disabled={!!problem} onClick={() => { if (typeof result !== 'string') onSave(result); }}>套用</button>
                </div>
                <div className={styles.menuNote}>套用後自動解除「點價即下單」。</div>
            </div>
        </>
    );
}
