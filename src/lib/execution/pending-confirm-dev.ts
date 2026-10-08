// src/lib/execution/pending-confirm-dev.ts — dev-only fake 委託待確認 list
// (#201 ③), loaded from main.tsx with `?mockPendingConfirm`. Uses the current
// protection environment so the cards are actionable; resolving only edits
// the in-memory list. Never sends anything.

import { currentProtectionEnv } from '../protection-env';
import { createMockPendingConfirmBackend, installPendingConfirmBackend } from './pending-confirm';
import { mockPendingConfirmDemo } from './pending-confirm-mock';

export function installMockPendingConfirm(env = currentProtectionEnv() ?? 'http://127.0.0.1:21323|simulation'): () => void {
    return installPendingConfirmBackend(createMockPendingConfirmBackend(mockPendingConfirmDemo(env)));
}
