// src/components/native-execution-setting.tsx — 「原生執行引擎（實驗）」
// toggle (#201). Desktop only, off by default. On: NEW stop / take triggers
// and brackets run in the App's native engine (survive window reloads);
// triggers / brackets that already exist keep running where they were
// created until they finish — nothing is moved between executors.

import {
    setNativeExecutionEnabled,
    useNativeExecutionEnabled,
    useNativeHealth,
    useNativePrograms,
} from '../lib/execution/native';
import * as hud from './hud-header.css';

const STATE: Record<string, string> = {
    idle: '待命',
    connecting: '連線中',
    live: '已連線',
    down: '未連線',
    failed: '啟動失敗',
};

export function NativeExecutionSetting() {
    const on = useNativeExecutionEnabled();
    const health = useNativeHealth();
    const programs = useNativePrograms().filter(p => p.status !== 'stopped');
    const state = health ? `${STATE[health.state] ?? health.state}${health.env ? `（${health.env === 'simulation' ? '模擬' : '正式'}）` : ''}` : '無法取得狀態';
    return (
        <>
            <span className={hud.settingLabel}>原生執行引擎（實驗）</span>
            <div className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='新的停損／停利觸價單與括號單改由 App 原生程序執行，視窗重新載入不影響'
                >
                    原生執行引擎（實驗）
                </span>
                <button
                    className={hud.switchTrack[on ? 'on' : 'off']}
                    aria-label='原生執行引擎（實驗）'
                    aria-pressed={on}
                    title={on ? '關閉：新單改回由主視窗執行' : '啟用：新單由原生引擎執行'}
                    onClick={() => setNativeExecutionEnabled(!on)}
                />
            </div>
            <span className={hud.emptyHint}>
                預設關閉。開啟後新建立的停損／停利觸價單與括號單由 App 原生程序執行（標示「原生」），
                視窗重新載入或隱藏不影響；已存在的單維持原本的執行方式直到結束，不會重複執行。
                關閉只影響之後新建的單，原生單會繼續執行到結束。
                <br />
                狀態：{state} · 原生單 {programs.length} 筆
                {health?.lastError ? ` · ${health.lastError}` : ''}
            </span>
        </>
    );
}
