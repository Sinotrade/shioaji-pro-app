// src/main.tsx

// polyfills MUST stay the first import — patches globals (structuredClone,
// AbortSignal.timeout, …) before any dependency module evaluates
import './lib/polyfills';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppGate } from './app-gate';
import { AppErrorBoundary } from './components/app-error-boundary';
import { AppLockBoundary } from './components/app-lock-boundary';
import './index.css';
import { startAnalytics } from './lib/analytics';
import { initializeAppLock } from './lib/app-lock';
import { bootstrap } from './lib/boot';
import { initTheme } from './lib/theme-store';
import { startBracketRuntime } from './lib/bracket';
import { startBackgroundExecution } from './lib/execution/background';
import { startOddSpreadService } from './lib/odd-spread-service';
import { startTriggerEngine } from './lib/trigger-engine';
import { startConditionalRuntime } from './lib/conditional/runtime';

// 應用程式鎖：要最先註冊 window 擷取階段的事件攔截（含 ⇧⌘L、睡眠偵測），早於下面所有
// start*()／bootstrap() 與 App 掛載後才註冊的快捷鍵 listener（同一個 window
// 擷取階段先註冊先執行）。重複呼叫只會裝一次，HMR 重跑本檔也安全。
initializeAppLock();
initTheme();
startAnalytics();
// both are no-ops outside the main window (#102: main-only execution)
startTriggerEngine();
startBracketRuntime();
// 整零價差兩腳送單：接回重新整理前的執行並追蹤成交（只在執行中的主視窗）
startOddSpreadService();
// #201 「背景持續執行（實驗）」: mirror the App's background engine (desktop
// only; every window displays, the main window keeps its quotes)
startBackgroundExecution();
// #226 收盤前平倉 time orders run 全平並取消 in the executing main window
startConditionalRuntime();
bootstrap();
// #201 ③ dev only: `?mockPendingConfirm` shows fake 委託待確認 cards until the
// background engine implements the contract. Never part of a release build.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mockPendingConfirm')) {
    void import('./lib/execution/pending-confirm-dev').then(m => m.installMockPendingConfirm());
}

// #226 dev only: `?condDemo` fills the 條件單管理面板 with sample rows (no
// trigger, order or server state behind them). Never part of a release build.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('condDemo')) {
    void import('./lib/conditional/demo-install').then(m => m.installConditionalDemo());
}

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

// Vite can re-evaluate this entry module during HMR. Keep the Root on the DOM
// node so a hot update renders into the existing tree instead of calling
// createRoot twice (which also duplicated background bootstrap side effects).
const rootHost = rootElement as HTMLElement & { __shioajiRoot?: Root };
const root = rootHost.__shioajiRoot ?? createRoot(rootHost);
rootHost.__shioajiRoot = root;
root.render(
    <StrictMode>
        {/* 鎖在外層：App 出錯換成錯誤頁時，鎖定畫面不能跟著卸載（攔截層還在，會鎖死） */}
        <AppLockBoundary>
            <AppErrorBoundary>
                <AppGate />
            </AppErrorBoundary>
        </AppLockBoundary>
    </StrictMode>,
);
