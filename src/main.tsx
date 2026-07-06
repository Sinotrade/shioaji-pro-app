// src/main.tsx

// polyfills MUST stay the first import — patches globals (structuredClone,
// AbortSignal.timeout, …) before any dependency module evaluates
import './lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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

createRoot(rootElement).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
