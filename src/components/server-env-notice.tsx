// src/components/server-env-notice.tsx — the header's reading of a pending
// environment change (#370). Desktop: the switch in progress, or what is left
// for the user to press. Web: this page cannot control the server, so all it
// can do is say where the change has to be made.

import { CircleAlert } from 'lucide-react';
import { useRef } from 'react';
import type { ServerEnvNotice as Notice } from '../lib/server-env-notice';
import type { StreamStatus } from '../lib/stream';
import { Orb } from './orb';
import * as styles from './hud-header.css';

export function ServerEnvNotice({ notice, onOpen }: { notice: Notice; onOpen: () => void }) {
    return (
        <button type='button' className={styles.serverEnvNotice} role='status' onClick={onOpen}>
            {notice.tone === 'progress'
                ? <Orb size={12} variant='ring' />
                : <CircleAlert size={13} aria-hidden />}
            {notice.text}
        </button>
    );
}

export function WebServerHint({ status }: { status: StreamStatus }) {
    // a reconnect attempt reads as connecting for a moment: stay until LIVE
    const lost = useRef(false);
    lost.current = status === 'down' || (status !== 'live' && lost.current);
    if (!lost.current) return null;
    return (
        <span className={styles.webServerHint} role='status'>
            <CircleAlert size={13} aria-hidden />
            伺服器未連線；切換模擬／正式環境後，請重新啟動 Shioaji server
        </span>
    );
}
