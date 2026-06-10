// src/components/health-badge.tsx

import { useEffect, useState } from 'react';
import { fetchHealth } from '../lib/shioaji';
import type { Health } from '../lib/types/health';
import * as styles from './health-badge.css';

type State =
    | { kind: 'loading' }
    | { kind: 'ok'; data: Health }
    | { kind: 'err'; msg: string };

export function HealthBadge() {
    const [state, setState] = useState<State>({ kind: 'loading' });

    useEffect(() => {
        fetchHealth()
            .then((data) => setState({ kind: 'ok', data }))
            .catch((e: Error) => setState({ kind: 'err', msg: e.message }));
    }, []);

    if (state.kind === 'loading') {
        return <span>Checking shioaji…</span>;
    }
    if (state.kind === 'err') {
        return (
            <span>
                <span className={styles.dot.err} />
                shioaji unreachable: {state.msg}
            </span>
        );
    }
    return (
        <span>
            <span className={styles.dot.ok} />
            shioaji {state.data.version} · {state.data.status}
        </span>
    );
}
