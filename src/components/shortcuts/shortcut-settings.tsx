// src/components/shortcuts/shortcut-settings.tsx — 設定 → 快捷鍵
//
// 完整清單（依分類）、搜尋與篩選、點鍵帽錄製新按鍵、衝突偵測、單項與全部
// 回復預設。全部刪單只能開關、不能改鍵（2026-11-06 決定）。

import {
    Ban,
    Info,
    Keyboard,
    Lock,
    Pencil,
    RotateCcw,
    Search,
    ShieldAlert,
    ShieldCheck,
    TriangleAlert,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setRiskSettings, useRiskSettings } from '../../lib/risk';
import { holdKeyboard } from '../../lib/shortcuts/guards';
import { chordFromEvent, chordText, type Platform } from '../../lib/shortcuts/keys';
import {
    CATEGORY_LABEL,
    CATEGORY_ORDER,
    SCOPE_LABEL,
    checkBinding,
    defById,
    effectiveKeys,
    forPlatform,
    isEditable,
    type BindingCheck,
    type ShortcutDef,
} from '../../lib/shortcuts/registry';
import { clearBinding, resetAllBindings, resetBinding, setBinding, useShortcutState } from '../../lib/shortcuts/store';
import * as hud from '../hud-header.css';
import { Chord, KeyCaps } from './key-caps';
import * as styles from './shortcuts.css';

type Filter = 'all' | 'editable' | 'changed' | 'risk';

const RISK_BADGE: Partial<Record<ShortcutDef['risk'], { text: string; tone: 'risk' | 'danger' }>> = {
    direction: { text: '只切方向', tone: 'risk' },
    lock: { text: '影響委託線', tone: 'risk' },
    edit: { text: '送出改單', tone: 'risk' },
    send: { text: '會送單', tone: 'danger' },
    cancel: { text: '會撤單', tone: 'danger' },
};

function searchText(d: ShortcutDef, keys: readonly string[]): string {
    const keyText = keys.flatMap((k) => [chordText(k, 'mac'), chordText(k, 'win')]).join(' ');
    return [d.label, d.hint ?? '', CATEGORY_LABEL[d.category], SCOPE_LABEL[d.scope], keyText, d.gesture ?? ''].join(' ').toLowerCase();
}

const MOD_PREVIEW: Record<Platform, [string, keyof KeyboardEvent][]> = {
    mac: [['⌃', 'ctrlKey'], ['⌘', 'metaKey'], ['⌥', 'altKey'], ['⇧', 'shiftKey']],
    win: [['Ctrl', 'ctrlKey'], ['Alt', 'altKey'], ['Shift', 'shiftKey']],
};

// 錄製：window capture＋stopImmediatePropagation，錄製時按 B／S、Esc 都不會
// 傳到下單面板或全部刪單；持有鍵盤期間設定對話框不因 Esc 關閉
function useRecorder(
    active: boolean,
    platform: Platform,
    onChord: (chord: string) => void,
    onCancel: () => void,
    onClear: () => void,
) {
    const [held, setHeld] = useState<string[]>([]);
    useEffect(() => {
        if (!active) return;
        const release = holdKeyboard();
        const mods = (e: KeyboardEvent) =>
            setHeld(MOD_PREVIEW[platform].filter(([, k]) => e[k]).map(([cap]) => cap));
        const onDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
            if (bare && e.key === 'Escape') return onCancel();
            if (bare && (e.key === 'Backspace' || e.key === 'Delete')) return onClear();
            const chord = chordFromEvent(e, platform);
            if (chord) onChord(chord);
            else mods(e);
        };
        const onUp = (e: KeyboardEvent) => mods(e);
        window.addEventListener('keydown', onDown, true);
        window.addEventListener('keyup', onUp, true);
        return () => {
            window.removeEventListener('keydown', onDown, true);
            window.removeEventListener('keyup', onUp, true);
            setHeld([]);
            // 等這一下 Esc 派送完才交還，設定對話框才不會跟著關
            setTimeout(release, 0);
        };
    }, [active, platform, onChord, onCancel, onClear]);
    return held;
}

function Notice({
    chord,
    result,
    platform,
    onApply,
    onDismiss,
}: {
    chord: string;
    result: BindingCheck;
    platform: Platform;
    onApply: (replaceId?: string) => void;
    onDismiss: () => void;
}) {
    if (result.level === 'block') {
        return (
            <div className={styles.notice.block} role='alert'>
                <span className={styles.noticeHead}>
                    <Ban size={12} className={styles.noticeIcon} /> {result.message}
                </span>
                <div className={styles.noticeActions}>
                    <button className={styles.act.ghost} onClick={onDismiss}>知道了</button>
                </div>
            </div>
        );
    }
    if (result.level === 'conflict') {
        return (
            <div className={styles.notice.warn} role='alert'>
                <span className={styles.noticeHead}>
                    <TriangleAlert size={12} className={`${styles.noticeIcon} ${styles.noticeIconWarn}`} />
                    {result.message}
                </span>
                <span className={styles.noticeNote}>取代後「{result.other.label}」會變成未設定，之後可在這裡重新指定或回復預設。</span>
                <div className={styles.noticeActions}>
                    <button className={styles.act.ghost} onClick={onDismiss}>換一個鍵</button>
                    <button className={styles.act.primary} onClick={() => onApply(result.other.id)}>
                        改用 <Chord chord={chord} platform={platform} small />
                    </button>
                </div>
            </div>
        );
    }
    if (result.level === 'confirm') {
        return (
            <div className={styles.notice.warn} role='alert'>
                <span className={styles.noticeHead}>
                    <ShieldAlert size={12} className={`${styles.noticeIcon} ${styles.noticeIconWarn}`} /> {result.message}
                </span>
                {result.note && <span className={styles.noticeNote}>{result.note}</span>}
                <div className={styles.noticeActions}>
                    <button className={styles.act.ghost} onClick={onDismiss}>取消</button>
                    <button className={styles.act.primary} onClick={() => onApply()}>確認改鍵</button>
                </div>
            </div>
        );
    }
    if (result.level === 'note') {
        return (
            <div className={styles.notice.info}>
                <span className={styles.noticeHead}>
                    <Info size={12} className={styles.noticeIcon} /> {result.message}
                </span>
                <div className={styles.noticeActions}>
                    <button className={styles.act.ghost} onClick={onDismiss}>換一個鍵</button>
                    <button className={styles.act.primary} onClick={() => onApply()}>
                        使用 <Chord chord={chord} platform={platform} small />
                    </button>
                </div>
            </div>
        );
    }
    return null;
}

function Row({
    d,
    recording,
    onRecord,
    onStop,
}: {
    d: ShortcutDef;
    recording: boolean;
    onRecord: () => void;
    onStop: () => void;
}) {
    const { overrides, platform } = useShortcutState();
    const risk = useRiskSettings();
    const [pending, setPending] = useState<{ chord: string; result: BindingCheck } | null>(null);
    const keys = effectiveKeys(d, overrides);
    const changed = d.id in overrides;
    const editable = isEditable(d);
    const badge = RISK_BADGE[d.risk];

    const apply = (chord: string, replaceId?: string) => {
        setBinding(d.id, chord, replaceId);
        setPending(null);
    };
    const onChord = useCallback(
        (chord: string) => {
            onStop();
            if (keys.includes(chord)) return;
            const result = checkBinding(d, chord, overrides, platform);
            if (result.level === 'ok') setBinding(d.id, chord);
            else setPending({ chord, result });
        },
        [d, keys, overrides, platform, onStop],
    );
    const onClear = useCallback(() => {
        onStop();
        clearBinding(d.id);
    }, [d.id, onStop]);
    const held = useRecorder(recording, platform, onChord, onStop, onClear);

    const dim = d.status === 'disabled' || d.status === 'reserved';
    const rowCls = [styles.row, recording || pending ? styles.rowActive : '', changed ? styles.rowChanged : ''].join(' ');
    return (
        <>
            <div className={rowCls}>
                <div className={`${styles.rowText} ${dim ? styles.rowDim : ''}`}>
                    <span className={styles.rowLabel}>
                        {d.label}
                        {badge && (
                            <span className={styles.badge[badge.tone]}>
                                <ShieldAlert size={9} /> {badge.text}
                            </span>
                        )}
                        {d.status === 'reserved' && <span className={styles.badge.accent}>即將推出</span>}
                        {d.status === 'disabled' && <span className={styles.badge.muted}>已停用</span>}
                        {d.window === 'main' && d.scope !== 'native' && d.category === 'trade' && (
                            <span className={styles.badge.muted}>主視窗</span>
                        )}
                        {changed && <span className={styles.badge.accent}>已修改</span>}
                    </span>
                    {d.hint && <span className={styles.rowHint}>{d.hint}</span>}
                    {d.requires === 'escCancelAll' && (
                        <span className={styles.inlineSwitch}>
                            <button
                                className={hud.switchTrack[risk.escCancelAll ? 'on' : 'off']}
                                role='switch'
                                aria-checked={risk.escCancelAll}
                                aria-label='啟用雙擊 Esc 全部刪單'
                                onClick={() => setRiskSettings({ escCancelAll: !risk.escCancelAll })}
                            />
                            <span className={styles.rowHint}>
                                {risk.escCancelAll ? '已啟用' : '未啟用（預設關閉，避免誤觸）'} · 按鍵固定，不開放修改
                            </span>
                        </span>
                    )}
                </div>
                {recording ? (
                    <button className={styles.recording} onClick={onStop} aria-live='polite'>
                        <span className={styles.recDot} />
                        {held.length ? held.join(platform === 'mac' ? '' : '+') + ' …' : '按下新按鍵'}
                        <span className={styles.helpWhy}>Esc 取消{keys.length ? ' · Delete 清除' : ''}</span>
                    </button>
                ) : (
                    <button
                        className={styles.keyBtn}
                        disabled={!editable}
                        title={editable ? '點一下錄製新按鍵' : '固定按鍵，不開放修改'}
                        aria-label={editable ? `修改「${d.label}」的快捷鍵` : undefined}
                        onClick={() => {
                            setPending(null);
                            onRecord();
                        }}
                    >
                        <KeyCaps def={d} keys={keys} platform={platform} />
                        {editable && <Pencil size={11} className={styles.editGlyph} />}
                    </button>
                )}
                {changed ? (
                    <button
                        className={styles.iconBtn}
                        title={`回復預設（${d.keys.length ? d.keys.map((k) => chordText(k, platform)).join('、') : '未設定'}）`}
                        aria-label={`回復「${d.label}」預設值`}
                        onClick={() => {
                            resetBinding(d.id);
                            setPending(null);
                        }}
                    >
                        <RotateCcw size={12} />
                    </button>
                ) : editable && keys.length > 0 ? (
                    <button className={styles.iconBtn} title='清除這個快捷鍵（停用）' aria-label={`清除「${d.label}」的快捷鍵`} onClick={() => clearBinding(d.id)}>
                        <X size={12} />
                    </button>
                ) : !editable ? (
                    <span className={styles.lockCell} title='固定按鍵'>
                        <Lock size={11} />
                    </span>
                ) : (
                    <span />
                )}
            </div>
            {pending && (
                <Notice
                    chord={pending.chord}
                    result={pending.result}
                    platform={platform}
                    onApply={(replaceId) => apply(pending.chord, replaceId)}
                    onDismiss={() => setPending(null)}
                />
            )}
        </>
    );
}

export function ShortcutSettingsSection() {
    const { overrides, platform } = useShortcutState();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [recordingId, setRecordingId] = useState<string | null>(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const changedCount = Object.keys(overrides).length;
    const help = defById('help.open')!;
    const helpKey = effectiveKeys(help, overrides)[0];
    const stop = useCallback(() => setRecordingId(null), []);
    const topRef = useRef<HTMLDivElement>(null);

    const all = useMemo(() => forPlatform(platform), [platform]);
    const counts = useMemo(
        () => ({
            editable: all.filter(isEditable).length,
            risk: all.filter((d) => d.risk !== 'none').length,
        }),
        [all],
    );
    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return all
            .filter((d) => {
                if (filter === 'editable') return isEditable(d);
                if (filter === 'changed') return d.id in overrides;
                if (filter === 'risk') return d.risk !== 'none';
                return true;
            })
            .filter((d) => !q || searchText(d, effectiveKeys(d, overrides)).includes(q));
    }, [all, filter, overrides, query]);
    const groups = CATEGORY_ORDER.map((c) => ({ c, items: visible.filter((d) => d.category === c) })).filter((g) => g.items.length);

    return (
        <div className={styles.settings} ref={topRef}>
            <div className={styles.lead}>
                <span className={styles.leadIcon}>
                    <Keyboard size={16} />
                </span>
                <span className={styles.leadText}>
                    <span className={styles.leadTitle}>
                        記得一個鍵就好：按 {helpKey ? <Chord chord={helpKey} platform={platform} /> : '（未設定）'} 隨時叫出提示頁
                    </span>
                    <span className={styles.leadSub}>
                        點右側鍵帽改鍵 · 標示依這台電腦（{platform === 'mac' ? 'macOS' : 'Windows'}）· 改鍵存在本機，各視窗同步
                    </span>
                </span>
            </div>

            <div className={styles.toolbar}>
                <label className={styles.searchWrap}>
                    <Search size={12} />
                    <input
                        className={styles.searchInput}
                        placeholder='搜尋操作或按鍵，例如 刪單、Esc、⌘K'
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                        <button className={styles.iconBtn} aria-label='清除搜尋' onClick={() => setQuery('')}>
                            <X size={11} />
                        </button>
                    )}
                </label>
                <div className={styles.chips}>
                    <button className={styles.chip[filter === 'all' ? 'on' : 'off']} onClick={() => setFilter('all')}>
                        全部 <span className={styles.chipCount}>{all.length}</span>
                    </button>
                    <button className={styles.chip[filter === 'editable' ? 'on' : 'off']} onClick={() => setFilter('editable')}>
                        可自訂 <span className={styles.chipCount}>{counts.editable}</span>
                    </button>
                    <button className={styles.chip[filter === 'changed' ? 'on' : 'off']} onClick={() => setFilter('changed')}>
                        已修改 <span className={styles.chipCount}>{changedCount}</span>
                    </button>
                    <button className={styles.chip[filter === 'risk' ? 'on' : 'off']} onClick={() => setFilter('risk')}>
                        <ShieldAlert size={10} /> 影響委託 <span className={styles.chipCount}>{counts.risk}</span>
                    </button>
                    <span className={styles.spacer} />
                    {confirmReset ? (
                        <>
                            <button className={styles.textBtn} onClick={() => setConfirmReset(false)}>取消</button>
                            <button
                                className={styles.act.danger}
                                onClick={() => {
                                    resetAllBindings();
                                    setConfirmReset(false);
                                }}
                            >
                                回復 {changedCount} 項
                            </button>
                        </>
                    ) : (
                        <button className={styles.textBtn} disabled={!changedCount} onClick={() => setConfirmReset(true)}>
                            <RotateCcw size={11} /> 全部回復預設
                        </button>
                    )}
                </div>
            </div>

            {groups.map(({ c, items }) => (
                <div key={c} className={styles.group}>
                    <div className={styles.groupHead}>
                        {CATEGORY_LABEL[c]}
                        <span className={styles.groupCount}>{items.length}</span>
                    </div>
                    {items.map((d) => (
                        <Row
                            key={d.id}
                            d={d}
                            recording={recordingId === d.id}
                            onRecord={() => setRecordingId(d.id)}
                            onStop={stop}
                        />
                    ))}
                </div>
            ))}
            {!groups.length && (
                <div className={styles.empty}>
                    <Search size={16} />
                    {filter === 'changed' && !query ? '還沒有修改過的快捷鍵' : '沒有符合的快捷鍵'}
                </div>
            )}

            <div className={styles.foot}>
                <ShieldCheck size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>
                    下單相關快捷鍵只切換方向或撤單，不會直接送出委託；全部刪單第一版固定為連按兩次 Esc。
                    交易按鍵只在主視窗作用，彈出視窗可用 {helpKey ? chordText(helpKey, platform) : '提示頁快捷鍵'} 查看清單。
                </span>
            </div>
        </div>
    );
}
