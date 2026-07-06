// src/lib/analytics.ts — optional GA4 telemetry for Realtime active users.
// Sends only app-level lifecycle pings, never market data, orders, or account ids.

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID ?? '';
const HEARTBEAT_MS = 60_000;

declare global {
    interface Window {
        dataLayer?: unknown[];
        gtag?: (...args: unknown[]) => void;
    }
}

let started = false;

export function analyticsEnabled(): boolean {
    return GA_ID.trim() !== '';
}

export function startAnalytics() {
    if (started || !analyticsEnabled()) return;
    started = true;

    window.dataLayer = window.dataLayer ?? [];
    window.gtag = (...args: unknown[]) => {
        window.dataLayer?.push(args);
    };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, {
        send_page_view: false,
        app_name: 'shioaji-pro-app',
        app_version: __SHIOAJI_APP_VERSION__,
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(script);

    logAnalyticsEvent('app_open');
    window.setInterval(() => {
        logAnalyticsEvent('app_heartbeat');
    }, HEARTBEAT_MS);
}

export function logAnalyticsEvent(name: string, params: Record<string, unknown> = {}) {
    if (!window.gtag) return;
    window.gtag('event', name, {
        app_version: __SHIOAJI_APP_VERSION__,
        runtime:
            typeof window !== 'undefined' && '__TAURI__' in window
                ? 'tauri'
                : 'web',
        ...params,
    });
}
