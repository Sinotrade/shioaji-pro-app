// src/main.tsx

// polyfills MUST stay the first import — patches globals (structuredClone,
// AbortSignal.timeout, …) before any dependency module evaluates
import './lib/polyfills';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppGate } from './app-gate';
import './index.css';
import { startAnalytics } from './lib/analytics';
import { bootstrap } from './lib/boot';
import { initTheme } from './lib/theme-store';
import { startTriggerEngine } from './lib/trigger-engine';

initTheme();
startAnalytics();
startTriggerEngine();
bootstrap();

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
        <AppGate />
    </StrictMode>,
);
