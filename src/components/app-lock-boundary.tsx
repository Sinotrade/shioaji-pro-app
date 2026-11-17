// src/components/app-lock-boundary.tsx — 應用程式鎖的遮蔽層。
// 底層 App 永遠保持掛載（行情訂閱、停損停利與觸價不能因為鎖定被拆掉）。鎖著時在
// body 最外層疊一層不透明遮蔽，body 底下其餘內容不可操作、不可朗讀。
// 核可視窗也載入這個檔：不要引用 lucide-react 或 lib/trade。

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
    failureText, forgetAppLockPassword, LOGOUT_AFTER, systemAuthLabel, unlockWithPassword, unlockWithSystem, useAppLock,
    type AppLockState, type SystemAuthResult,
} from '../lib/app-lock';
import { isTauri } from '../lib/runtime';
import * as styles from './app-lock.css';
import * as s from './server-settings-dialog.css';

const SYSTEM_TEXT: Record<Exclude<SystemAuthResult, 'ok'>, string> = {
    cancelled: '系統驗證已取消，可以再試一次或輸入解鎖密碼。', unavailable: '這台電腦目前無法使用系統驗證，請輸入解鎖密碼。',
    missing: '這個版本還不能使用系統驗證，請輸入解鎖密碼。',
};
const COVER = [['inert', ''], ['aria-hidden', 'true']] as const;

// body 底下除了遮蔽層以外的直接子元素（#root、委託確認框等 portal）都加 inert 與 aria-hidden；
// 遮蔽期間新增的也一樣處理。還原時放回原本的值：原本就有的屬性（例如 aria-hidden="false"、
// 已經 inert）不能被拿掉或改掉
function coverSiblings(body: HTMLElement): () => void {
    const saved = new Map<Element, (string | null)[]>();
    const hide = (el: Element) => {
        if (el.hasAttribute('data-app-lock-surface') || saved.has(el)) return;
        saved.set(el, COVER.map(([name]) => el.getAttribute(name)));
        COVER.forEach(([name, value]) => el.setAttribute(name, value));
    };
    const restore = (el: Element) => {
        saved.get(el)?.forEach((value, i) => value === null ? el.removeAttribute(COVER[i]![0]) : el.setAttribute(COVER[i]![0], value));
        saved.delete(el);
    };
    Array.from(body.children).forEach(hide);
    const observer = new MutationObserver((records) => records.forEach((record) => {
        record.removedNodes.forEach((node) => { if (node.nodeType === 1) restore(node as Element); });
        record.addedNodes.forEach((node) => { if (node.nodeType === 1) hide(node as Element); });
    }));
    observer.observe(body, { childList: true });
    return () => { observer.disconnect(); Array.from(saved.keys()).forEach(restore); };
}

function LockSurface({ lock }: { lock: AppLockState }) {
    const root = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const id = useId();
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const [showHint, setShowHint] = useState(false);
    const [forgetting, setForgetting] = useState(false);
    // layout effect：inert 在繪製前就生效。Tab 的循環在 lib/app-lock 的攔截層。
    // 解鎖後不把焦點還給上鎖前的元素：按住 Enter 解鎖時，重複的按鍵會觸發那顆按鈕
    useLayoutEffect(() => coverSiblings(document.body), []);
    useEffect(() => { (input.current ?? root.current)?.focus(); }, []);

    async function attempt(run: () => Promise<string>) {
        if (busy) return;
        setBusy(true); setProblem('');
        try { setProblem(await run()); } catch { setProblem('暫時無法驗證，請再試一次。'); }
        // 第 10 次輸錯時密碼欄已經拿掉：焦點改落在遮蔽層本身
        finally { setBusy(false); setPassword(''); (input.current ?? root.current)?.focus(); }
    }
    const reminder = problem || (lock.failures >= 5 ? failureText(lock.failures) : '');
    const hint = showHint ? lock.hint.trim() : '';
    const described = [hint && `${id}-hint`, reminder && `${id}-problem`].filter(Boolean).join(' ');

    return <div ref={root} data-app-lock-surface='' tabIndex={-1} role='dialog' aria-modal='true' aria-labelledby={id}
        className={styles.cover} onMouseDown={(event) => {
            // 點到空白處時瀏覽器會把焦點給最近的可聚焦祖先（tabIndex=-1 的外框），之後打字沒有欄位接
            if ((event.target as Element).closest('input, button, a, select, textarea')) return;
            event.preventDefault();
            (input.current ?? root.current)?.focus();
        }}>
        <form className={styles.card} noValidate onSubmit={(event) => {
            event.preventDefault();
            if (!password) { setProblem('請輸入解鎖密碼。'); return; }
            void attempt(async () => {
                const failures = await unlockWithPassword(password);
                return failures === null ? '' : failureText(failures);
            });
        }}>
            <h1 id={id} className={s.title}>Shioaji Pro 已鎖定</h1>
            {lock.failures >= LOGOUT_AFTER ? <p className={s.warning} role='alert'>
                {isTauri ? (lock.forgot ? '正在登出並清除這台電腦的 API 金鑰…' : '解鎖密碼連續錯 10 次，正在登出…')
                    : `${lock.forgot ? '' : '解鎖密碼連續錯 10 次。'}網頁版無法自動登出，請清除這個網站的資料後重新整理。`}
            </p> : <>
                <div className={s.field}>
                    <label className={s.label} htmlFor={`${id}-password`}>解鎖密碼</label>
                    {/* 送出期間用唯讀而不是 disabled：停用的欄位會讓鍵盤焦點掉到 body */}
                    <input id={`${id}-password`} ref={input} className={s.input} type='password' value={password}
                        autoComplete='current-password' readOnly={busy} aria-invalid={problem ? true : undefined}
                        aria-describedby={described || undefined} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div className={styles.helpRow}>
                    {hint ? <span id={`${id}-hint`}>{`提示：${hint}`}</span>
                        : lock.hint.trim() && <button type='button' className={s.linkButton} onClick={() => { setShowHint(true); input.current?.focus(); }}>密碼提示</button>}
                    {/* 焦點先移到遮蔽層：用 Enter 按下去時，按住不放的重複按鍵不會接著按到確認 */}
                    <button type='button' className={styles.forgot} disabled={busy} onClick={() => { root.current?.focus(); setForgetting(true); }}>忘記密碼？</button>
                </div>
                {forgetting && <div className={s.saveConfirm}>
                    <p className={s.confirmText} role='alert'>會登出並清除這台電腦所有帳號的 API 金鑰，之後要重新輸入金鑰，或到官網重新申請。登出會停止本 App 的 Agent 與伺服器，停損停利、觸價也會停。</p>
                    <div className={s.confirmButtons}>
                        <button type='button' className={s.smallButton} onClick={() => { setForgetting(false); input.current?.focus(); }}>取消</button>
                        <button type='button' className={s.confirmDanger} disabled={busy} onClick={() => { root.current?.focus(); forgetAppLockPassword(); }}>確認登出並清除</button>
                    </div>
                </div>}
                {reminder && <p id={`${id}-problem`} className={s.warning} role='alert'>{reminder}</p>}
                <button type='submit' className={s.primary} disabled={busy}>解鎖</button>
                {lock.system && <button type='button' className={s.button} disabled={busy} onClick={() => void attempt(async () => {
                    const result = await unlockWithSystem();
                    return result === 'ok' ? '' : SYSTEM_TEXT[result];
                })}>{`使用 ${systemAuthLabel()} 解鎖`}</button>}
            </>}
        </form>
    </div>;
}

export function AppLockBoundary({ children }: { children: ReactNode }) {
    const lock = useAppLock();
    return <>
        {children}
        {lock?.locked && createPortal(<LockSurface lock={lock} />, document.body)}
    </>;
}
