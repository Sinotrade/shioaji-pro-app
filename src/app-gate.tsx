// src/app-gate.tsx — first render decision per window.
//
// Main window: a fresh desktop install has no API key saved yet — the
// dashboard would otherwise render fully but every panel silently fails
// against a server that was never even asked to start. Gate on that state
// with a full-screen setup screen instead.
//
// Child windows (popouts, tray panel): never read settings.json — it holds
// the API key, secret key and CA password, and child windows have no store
// permission. They only need "is setup done", which the main window publishes
// as a non-secret flag (desktop-setup-state). Web builds are always backed by
// a running server, so no gate applies there.

import { useEffect, useState, useSyncExternalStore } from 'react';
import App from './App';
import {
    ChildSetupNotice,
    SettingsLoadError,
} from './components/child-setup-notice';
import { OnboardingSetup } from './components/onboarding-setup';
import {
    readDesktopConfigured,
    subscribeDesktopConfigured,
} from './lib/desktop-setup-state';
import { isTauri, loadDesktopSettings } from './lib/tauri';
import { isChildWindow } from './lib/window-role';

type MainGateState = 'loading' | 'setup' | 'app' | 'error';

function MainWindowGate() {
    const [state, setState] = useState<MainGateState>(
        isTauri ? 'loading' : 'app',
    );
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!isTauri) return;
        let cancelled = false;
        loadDesktopSettings()
            .then((s) => {
                if (!cancelled) setState(!s.apiKey || !s.secretKey ? 'setup' : 'app');
            })
            .catch(() => {
                // Never fall through to first-run setup here: a transient read
                // failure must not invite the user to overwrite saved keys.
                if (!cancelled) setState('error');
            });
        return () => {
            cancelled = true;
        };
    }, [attempt]);
    if (state === 'loading') return null; // instant local read, no flash
    if (state === 'error') {
        return (
            <SettingsLoadError
                onRetry={() => {
                    setState('loading');
                    setAttempt((n) => n + 1);
                }}
            />
        );
    }
    return state === 'setup' ? <OnboardingSetup /> : <App />;
}

function ChildWindowGate() {
    const configured = useSyncExternalStore(
        subscribeDesktopConfigured,
        readDesktopConfigured,
        () => null,
    );
    if (isTauri && configured !== true) return <ChildSetupNotice />;
    return <App />;
}

export function AppGate() {
    const [child] = useState(isChildWindow);
    return child ? <ChildWindowGate /> : <MainWindowGate />;
}
