// src/lib/conditional/demo-install.ts — dev only (`?condDemo`, #226): the
// demo 委託待確認 item behind 確認成交… through the mock backend.

import { createMockPendingConfirmBackend, installPendingConfirmBackend } from '../execution/pending-confirm';
import { conditionalDemoSources } from './demo';

export function installConditionalDemo(): void {
    const items = conditionalDemoSources(Date.now()).pendingConfirm;
    installPendingConfirmBackend(createMockPendingConfirmBackend({ version: 2, runId: 'demo', sequence: 1, uncleanShutdown: false, items: [...items] }));
}
