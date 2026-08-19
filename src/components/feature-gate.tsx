// src/components/feature-gate.tsx — wraps tiered features: renders children
// when entitled, otherwise a professional lock screen explaining why
// (VIP required / desktop-only) — the gate UI is public, the gated code may
// live in the closed modules repo.

import { Lock, MonitorDown } from 'lucide-react';
import { FEATURES, useFeature } from '../lib/features';

export function FeatureGate({
    feature,
    children,
}: {
    feature: string;
    children: React.ReactNode;
}) {
    const state = useFeature(feature);
    if (state.enabled) return <>{children}</>;
    const def = FEATURES.find((f) => f.key === feature);
    const desktopOnly = state.reason === 'desktop-only';
    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: '10px',
                padding: '24px',
                textAlign: 'center',
                color: 'var(--muted-foreground, #8593b3)',
                fontSize: '0.78rem',
                lineHeight: 1.7,
            }}
        >
            {desktopOnly ? <MonitorDown size={22} /> : <Lock size={22} />}
            <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--foreground, #dce4f5)' }}>
                {def?.name ?? feature}
                {desktopOnly ? ' 為桌面版專屬功能' : ' 為 VIP 專屬功能'}
            </span>
            {def?.desc && <span>{def.desc}</span>}
            {desktopOnly ? (
                <span style={{ fontSize: '0.7rem' }}>
                    桌面版發佈流程待更新
                </span>
            ) : (
                <span style={{ fontSize: '0.7rem' }}>
                    請聯繫您的營業員了解 VIP 方案
                </span>
            )}
        </div>
    );
}
