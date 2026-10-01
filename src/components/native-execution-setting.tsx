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
            <span className={hud.settingLabel}>背景持續執行（實驗）</span>
            <div className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='新建立的停損／停利觸價單與括號單在視窗關閉或重新載入時仍會持續盯價與送單'
                >
                    背景持續執行（實驗）
                </span>
                <button
                    className={hud.switchTrack[on ? 'on' : 'off']}
                    aria-label='背景持續執行（實驗）'
                    aria-pressed={on}
                    title={on ? '關閉：只影響之後新建的單' : '啟用：新單在視窗關閉或重新載入時持續執行'}
                    onClick={() => setNativeExecutionEnabled(!on)}
                />
            </div>
            <span className={hud.emptyHint}>
                開啟後，新建立的停損／停利觸價單與括號單在視窗關閉或重新載入時仍會持續盯價與送單；關閉只影響之後新建的單
                <br />
                狀態：{state} · 執行中 {programs.length} 筆
                {health?.lastError ? ` · ${health.lastError}` : ''}
                {health?.staleQuotes?.length ? ` · 行情暫無成交（已重新訂閱）：${health.staleQuotes.join('、')}` : ''}
            </span>
        </>
    );
}
