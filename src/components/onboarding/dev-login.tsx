// src/components/onboarding/dev-login.tsx — DEV-only login screen (account wizard + the upstream
// API Key form behind tabs). onboarding-setup.tsx loads it lazily under import.meta.env.DEV, so
// packaged builds never ship this module, its styles or the pointer listener.

import { useRef, useState, type ReactNode } from 'react';
import * as styles from '../onboarding-setup.css';
import { AmbientBackdrop } from './ambient-backdrop';
import * as glassStyles from './login-glass.css';
import { LoginPane, ModeSwitch, type LoginMode } from './mode-switch';
import { SinopacWizard, type SinopacWizardProps } from './sinopac-wizard';
import { usePointerParallax } from './use-pointer-parallax';

export interface DevLoginProps {
    mode: LoginMode;
    setMode: (mode: LoginMode) => void;
    startWithKeys: SinopacWizardProps['onKeysReady'];
    switchToApiKey: () => void;
    /** the upstream API Key form, shown behind the API Key tab */
    form: ReactNode;
    /** the agent card's header and body */
    agent: ReactNode;
}

export default function DevLogin({ mode, setMode, startWithKeys, switchToApiKey, form, agent }: DevLoginProps) {
    const shellRef = useRef<HTMLDivElement>(null);
    const [locked, setLocked] = useState(false);
    usePointerParallax(shellRef);

    return (
        <div className={`${styles.shell} ${glassStyles.shell}`} ref={shellRef}>
            <AmbientBackdrop />
            <div className={`${styles.layout} ${glassStyles.layout}`}>
                <div className={`${styles.card} ${glassStyles.card}`}>
                    <div>
                        <div className={styles.logo}>Shioaji Pro</div>
                        <div className={styles.subtitle}>選擇登入方式以啟動交易伺服器</div>
                    </div>

                    <ModeSwitch value={mode} onChange={setMode} disabled={locked} />
                    <LoginPane id='account' value={mode}>
                        <SinopacWizard onKeysReady={startWithKeys} onUseApiKey={switchToApiKey} onLockedChange={setLocked} />
                    </LoginPane>
                    <LoginPane id='apikey' value={mode}>
                        {form}
                    </LoginPane>
                </div>

                {/* DEV keeps the right column even without the closed agent
                    module, so the two-column layout can be previewed in a
                    browser; FeatureGate then shows its desktop-only screen */}
                <div className={`${styles.agentCard} ${glassStyles.agentCard}`}>{agent}</div>
            </div>
        </div>
    );
}
