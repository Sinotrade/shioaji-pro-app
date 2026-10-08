// src/components/background-execution-setting.tsx — 「背景持續執行（實驗）」
// (#201 ①-3). Desktop only, off by default, stored by the App. On: NEW
// futures / options stop and take triggers are watched and sent by the App
// itself, so reloading or closing a window does not stop them. Triggers that
// already exist keep running where they were created — nothing is moved.

import { useEffect, useState } from 'react';
import {
    refreshBackground,
    setBackgroundEnabled,
    useBackgroundHealth,
    useBackgroundSetting,
    useBackgroundPrograms,
} from '../lib/execution/background';
import * as hud from './hud-header.css';

const STATE: Record<string, string> = {
    idle: '待命',
    connecting: '連線中',
    live: '執行中',
    down: '未連線',
};

export function BackgroundExecutionSetting() {
    const health = useBackgroundHealth();
    const saved = useBackgroundSetting();
    const running = useBackgroundPrograms().filter(p => p.status !== 'stopped').length;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { void refreshBackground(); }, []);
    const on = saved === true;
    const state = saved === null ? '開關狀態不明'
        : health ? `${STATE[health.state] ?? health.state}${health.env ? `（${health.env === 'simulation' ? '模擬' : '正式'}）` : ''}`
            : on ? '背景執行目前無法使用（新的觸價單不會建立，可關閉改用本視窗）' : '背景執行未啟動';
    const toggle = () => {
        setBusy(true);
        setError(null);
        setBackgroundEnabled(!on)
            .catch(e => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    };
    return (
        <>
            <span className={hud.settingLabel}>背景持續執行（實驗）</span>
            <div className={hud.switchRow}>
                <span className={hud.switchLabel} title='期貨與選擇權的停損、停利觸價單改由 App 在背景盯價與送單'>
                    背景持續執行（實驗）
                </span>
                <button
                    className={hud.switchTrack[on ? 'on' : 'off']}
                    aria-label='背景持續執行（實驗）'
                    aria-pressed={on}
                    // turning it off always works; on needs a running engine
                    disabled={busy || (!on && !health)}
                    title={on ? '關閉：之後新建的觸價單回到原本的方式' : '開啟：之後新建的期貨與選擇權觸價單在背景執行'}
                    onClick={toggle}
                />
            </div>
            <span className={hud.emptyHint}>
                預設關閉。開啟後，之後新建的期貨與選擇權停損、停利觸價單，會由 App 在背景盯價與送單；
                重新整理或關掉視窗也不會中斷。股票、零股和到價警示照舊。
                已經存在的觸價單維持原本的方式到結束，不會重複送單。關閉只影響之後新建的單，
                已在背景的單會繼續執行到結束。送出結果不明的委託不會自動重送，會列在「委託待確認」請你核對。
                <br />
                狀態：{state} · 背景觸價單 {running} 筆
                {health?.lastError ? ` · ${health.lastError}` : ''}
                {error ? ` · 未變更：${error}` : ''}
            </span>
        </>
    );
}
