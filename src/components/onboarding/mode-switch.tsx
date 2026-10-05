import { KeyRound, User } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import * as styles from './mode-switch.css';

export type LoginMode = 'account' | 'apikey';

const TABS = [
    { id: 'account', label: '帳號密碼登入', Icon: User },
    { id: 'apikey', label: 'API Key 登入', Icon: KeyRound },
] as const;

const KEY_TARGET: Record<string, LoginMode> = { ArrowLeft: 'account', Home: 'account', ArrowRight: 'apikey', End: 'apikey' };

// disabled: the wizard is holding a one-time secret on screen, so the tabs stay put
export function ModeSwitch({ value, onChange, disabled = false }: { value: LoginMode; onChange: (mode: LoginMode) => void; disabled?: boolean }) {
    const refs = useRef<Partial<Record<LoginMode, HTMLButtonElement | null>>>({});
    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
        const next = KEY_TARGET[e.key];
        if (!next || disabled) return;
        e.preventDefault();
        onChange(next);
        refs.current[next]?.focus();
    };
    return (
        <div className={styles.track} role='tablist' aria-label='登入方式'>
            <span className={styles.thumb[value]} aria-hidden='true' />
            {TABS.map(({ id, label, Icon }) => (
                <button
                    key={id}
                    ref={(el) => { refs.current[id] = el; }}
                    type='button'
                    role='tab'
                    id={`login-tab-${id}`}
                    aria-selected={value === id}
                    aria-disabled={disabled || undefined}
                    aria-controls={`login-panel-${id}`}
                    tabIndex={value === id ? 0 : -1}
                    className={styles.tab[value === id ? 'on' : 'off']}
                    onClick={() => { if (!disabled) onChange(id); }}
                    onKeyDown={onKeyDown}
                >
                    <Icon size={14} />
                    {label}
                </button>
            ))}
        </div>
    );
}

// production keeps the upstream DOM: no wrapper, no tab semantics
export function LoginPane({ id, value, children }: { id: LoginMode; value: LoginMode; children: ReactNode }) {
    if (!import.meta.env.DEV) return children;
    return <div className={styles.pane} hidden={value !== id} role='tabpanel' id={`login-panel-${id}`} aria-labelledby={`login-tab-${id}`}>{children}</div>;
}
