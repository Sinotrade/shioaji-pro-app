// src/lib/server-env-notice.ts — what the main screen says about a pending
// environment change (#370). The server panel is closed most of the time, and
// a stopped server only reads as LOST in the header, so the state of a switch
// has to be readable without opening anything.

import type { CredentialEnvironment } from './desktop-credentials';

export interface ServerSwitchTarget {
    environment: CredentialEnvironment;
    // another account in the same environment: not an environment change
    accountOnly: boolean;
}

export interface ServerEnvNoticeInput {
    target: ServerSwitchTarget | null;
    switching: boolean;
    running: boolean;
    savedForRestart: boolean;
    environmentMismatch: boolean;
}

export interface ServerEnvNotice {
    tone: 'progress' | 'action';
    text: string;
}

const environmentLabel = (environment: CredentialEnvironment) =>
    environment === 'production' ? '正式' : '模擬';

export function describeServerEnvNotice(input: ServerEnvNoticeInput): ServerEnvNotice | null {
    const { target } = input;
    if (target) {
        const what = target.accountOnly ? '切換帳號' : `切換到${environmentLabel(target.environment)}環境`;
        return input.switching
            ? { tone: 'progress', text: `正在${what}…` }
            : { tone: 'action', text: `${what}未完成，請開啟伺服器面板重試` };
    }
    if (!input.savedForRestart) return null;
    if (!input.running) return { tone: 'action', text: '設定已儲存，請按「啟動」套用' };
    if (input.environmentMismatch) return { tone: 'action', text: '環境設定已變更，請按「重啟」套用' };
    return null;
}
