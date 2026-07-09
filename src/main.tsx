// src/main.tsx

// polyfills MUST stay the first import — patches globals (structuredClone,
// AbortSignal.timeout, …) before any dependency module evaluates
import './lib/polyfills';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { OnboardingSetup } from './components/onboarding-setup';
import './index.css';
import { startAnalytics } from './lib/analytics';
import { bootstrap } from './lib/boot';
import { isTauri, loadDesktopSettings } from './lib/tauri';
import { initTheme } from './lib/theme-store';
import { startTriggerEngine } from './lib/trigger-engine';

initTheme();
startAnalytics();
startTriggerEngine();
bootstrap();

// A fresh desktop install has no API key saved yet — the dashboard would
// otherwise render fully but every panel silently fails against a server
// that was never even asked to start (nothing prompts the user to go find
// the small 伺服器 button). Gate on that specific state with a full-screen
// setup screen instead. Web builds are always backed by a running server,
// so this never applies there.
function AppGate() {
    const [needsSetup, setNeedsSetup] = useState<boolean | null>(
        isTauri ? null : false,
    );
    useEffect(() => {
        if (!isTauri) return;
        void loadDesktopSettings().then((s) =>
            setNeedsSetup(!s.apiKey || !s.secretKey),
        );
    }, []);
    if (needsSetup === null) return null; // instant local read, no flash
    return needsSetup ? <OnboardingSetup /> : <App />;
}

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
    <StrictMode>
        <AppGate />
    </StrictMode>,
);
