// Shared status for asynchronous panel data. The owner decides when a read is
// pending, verified empty, or failed; this component only renders that truth.
import type { CSSProperties, ReactNode } from 'react';
import { Orb, type OrbVariant } from './orb';
import * as styles from './async-status.css';

export type AsyncPhase = 'loading' | 'empty' | 'error' | 'idle';

export function AsyncStatus({
    phase,
    text,
    action,
    size = 12,
    variant = 'radial',
    className,
    style,
}: {
    phase: AsyncPhase;
    text: string;
    action?: ReactNode;
    size?: number;
    variant?: OrbVariant;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <span
            className={`${styles.status} ${className ?? ''}`}
            style={style}
            role={phase === 'loading' ? 'status' : phase === 'error' ? 'alert' : undefined}
        >
            {phase === 'loading' && <Orb size={size} variant={variant} />}
            <span>{text}</span>
            {action}
        </span>
    );
}
