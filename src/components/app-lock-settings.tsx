// src/components/app-lock-settings.tsx — 設定 → 應用程式鎖。開關按下去先開表單，驗證過密碼
// 才真的改變狀態。「頂部列顯示螢幕鎖」在 設定 → 頂欄顯示。
import { useId, useState } from 'react';
import {
    changeAppLockPassword, disableAppLock, disableSystemAuth, enableAppLock, enableSystemAuth, lockApp,
    HINT_MAX, lockShortcutLabel, MIN_PASSWORD_LENGTH, passwordTooShort, setAppLockHint, setWakeGap, systemAuthLabel, systemAuthSupported,
    useAppLock, WAKE_OPTIONS,
} from '../lib/app-lock';
import * as styles from './app-lock.css';
import * as hud from './hud-header.css';
import * as s from './server-settings-dialog.css';

type Flow = 'enable' | 'change' | 'disable' | 'system';
const FAILED: Record<string, string> = {
    'wrong-password': '解鎖密碼不正確。', cancelled: '系統驗證已取消，沒有開啟。',
    unavailable: '這台電腦目前無法使用系統驗證。', missing: '這個版本還不能使用。',
};
const NOTE = '鎖定時遮住所有視窗並擋下手動操作；券商連線、停損停利、觸價與背景監控照常執行，也不會撤單。'
    + '電腦睡眠喚醒時自動鎖定（睡多久才鎖可以在下面選）；鎖著時關掉 App，下次開啟仍然鎖著。解鎖密碼連續錯 10 次，或在鎖定畫面按「忘記密碼？」並確認（旁人也按得到），會登出並清除所有已儲存帳號的金鑰。'
    + '解鎖密碼只在這台電腦保存雜湊，不保存原文。這是防旁人瞄到與誤觸的遮罩，不能取代電腦的螢幕鎖定。';
const EMPTY = { current: '', password: '', again: '' };

export function AppLockSettings() {
    const lock = useAppLock();
    const id = useId();
    const [flow, setFlow] = useState<Flow | null>(null);
    const [values, setValues] = useState(EMPTY);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const [message, setMessage] = useState('');
    const system = systemAuthLabel();
    const supported = systemAuthSupported();
    const choosing = flow === 'enable' || flow === 'change';
    const FLOWS = {
        enable: ['啟用應用程式鎖', '啟用', `應用程式鎖已啟用。按 ${lockShortcutLabel()} 或頂部列的「螢幕鎖」就能鎖定。`],
        change: ['修改解鎖密碼', '更新密碼', lock?.hint.trim() ? '解鎖密碼已更新。記得確認密碼提示還對得上。' : '解鎖密碼已更新。'],
        disable: ['關閉應用程式鎖', '關閉', '應用程式鎖已關閉，解鎖密碼已清除。'],
        system: [`開啟 ${system} 解鎖`, '繼續', `已開啟 ${system} 解鎖。`],
    } as const;
    const open = (next: Flow | null) => { setFlow(next); setValues(EMPTY); setProblem(''); };

    async function submit() {
        if (busy || !flow) return;
        const { current, password, again } = values;
        const invalid = flow !== 'enable' && !current ? '請輸入目前的解鎖密碼。'
            : choosing && passwordTooShort(password) ? `請使用至少 ${MIN_PASSWORD_LENGTH} 個字元的解鎖密碼。`
                : choosing && password !== again ? '兩次輸入的解鎖密碼不同，請再輸入一次。' : '';
        if (invalid) return setProblem(invalid);
        setBusy(true); setProblem('');
        try {
            const result = flow === 'enable' ? (await enableAppLock(password), 'ok')
                : flow === 'system' ? await enableSystemAuth(current)
                    : (await (flow === 'change' ? changeAppLockPassword(current, password) : disableAppLock(current))) ? 'ok' : 'wrong-password';
            if (result !== 'ok') { setProblem(FAILED[result]!); setValues((v) => ({ ...v, current: '' })); return; }
            open(null);
            setMessage(FLOWS[flow][2]);
        } catch {
            setProblem('暫時無法完成，請再試一次。');
        } finally {
            setBusy(false);
        }
    }

    const field = (name: keyof typeof EMPTY, label: string) => <div className={s.field}>
        <label className={s.label} htmlFor={`${id}-${name}`}>{label}</label>
        <input id={`${id}-${name}`} className={s.input} type='password' value={values[name]} readOnly={busy}
            autoComplete={name === 'current' ? 'current-password' : 'new-password'}
            onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} />
    </div>;
    const row = (name: string, label: string, note: string, on: boolean, onClick: () => void, disabled = busy) => <div className={hud.switchRow}>
        <div className={s.field}>
            <span className={hud.switchLabel} id={`${id}-${name}`}>{label}</span>
            <span className={s.fieldNote}>{note}</span>
        </div>
        <button type='button' role='switch' aria-checked={on} aria-labelledby={`${id}-${name}`}
            className={hud.switchTrack[on ? 'on' : 'off']} disabled={disabled} onClick={onClick} />
    </div>;

    return <div className={styles.settingsPage}>
        {row('main', '應用程式鎖', NOTE, !!lock, () => { open(lock ? 'disable' : 'enable'); setMessage(''); })}
        {lock && <>
            <div className={s.row}>
                <button type='button' className={s.smallButton} disabled={busy} onClick={lockApp}>{`立即鎖定（${lockShortcutLabel()}）`}</button>
                <button type='button' className={s.smallButton} disabled={busy} onClick={() => open('change')}>修改解鎖密碼…</button>
            </div>
            <div className={s.field}>
                <label className={hud.switchLabel} htmlFor={`${id}-hint`}>密碼提示（選填）</label>
                {/* 不受控：注音等輸入法組字中不存也不寫回欄位，組完字（或一般輸入）才存 */}
                <input id={`${id}-hint`} className={s.input} defaultValue={lock.hint} maxLength={HINT_MAX} disabled={busy} autoComplete='off'
                    onChange={(e) => { if (!(e.nativeEvent as InputEvent).isComposing) setAppLockHint(e.target.value); }}
                    onCompositionEnd={(e) => setAppLockHint(e.currentTarget.value)} />
                <span className={s.fieldNote}>{`${HINT_MAX} 個字以內。鎖定畫面按「密碼提示」才會顯示，旁人也看得到，不要直接寫密碼。`}</span>
            </div>
            <div className={hud.switchRow}>
                <div className={s.field}>
                    <label className={hud.switchLabel} htmlFor={`${id}-wake`}>睡眠喚醒時自動鎖定</label>
                    <span className={s.fieldNote}>電腦睡眠超過這段時間，喚醒時就鎖定。</span>
                </div>
                <select id={`${id}-wake`} className={styles.wakeSelect} value={lock.wakeMs} disabled={busy}
                    onChange={(e) => setWakeGap(Number(e.target.value))}>
                    {WAKE_OPTIONS.map(([ms, label]) => <option key={ms} value={ms}>{label}</option>)}
                </select>
            </div>
            {row('system', `也允許用 ${system} 解鎖`, supported ? `凡是能通過這台電腦 ${system} 的人，都能解開 Shioaji Pro。` : '這個版本還不能使用。',
                lock.system, () => { if (lock.system) { disableSystemAuth(); setMessage(`已關閉 ${system} 解鎖。`); } else open('system'); },
                busy || (!supported && !lock.system))}
        </>}
        {flow && <form className={s.card} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <h3 className={s.heading}>{FLOWS[flow][0]}</h3>
            {flow === 'system' && <p className={s.fieldNote}>{`輸入解鎖密碼後，會再請你用 ${system} 驗證一次。`}</p>}
            {flow !== 'enable' && field('current', flow === 'change' ? '目前的解鎖密碼' : '解鎖密碼')}
            {choosing && <>
                {field('password', flow === 'change' ? '新的解鎖密碼' : '解鎖密碼')}
                {field('again', '再輸入一次')}
                <p className={s.fieldNote}>{`至少 ${MIN_PASSWORD_LENGTH} 個字元。忘記密碼沒有復原方式，只能在鎖定畫面按「忘記密碼」登出後重新設定。`}</p>
            </>}
            {problem && <p className={s.warning} role='alert'>{problem}</p>}
            <div className={s.actions}>
                <button type='button' className={s.button} disabled={busy} onClick={() => open(null)}>取消</button>
                <button type='submit' className={s.primary} disabled={busy}>{busy ? '正在驗證…' : FLOWS[flow][1]}</button>
            </div>
        </form>}
        <div role='status'>{message && <p className={s.fieldNote}>{message}</p>}</div>
    </div>;
}
