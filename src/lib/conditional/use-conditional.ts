// src/lib/conditional/use-conditional.ts — live inputs of the 條件單管理面板
// (#226): every store a conditional order lives in, projected by rows.ts.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useBrackets } from '../bracket';
import { useBackgroundPrograms } from '../execution/background';
import { bracketViews } from '../execution/bracket-contract';
import { usePendingConfirm } from '../execution/pending-confirm';
import { currentProtectionEnv } from '../protection-env';
import { useServerInfo } from '../server-info-store';
import { getStreamStatus, subscribeStatusStore, type StreamStatus } from '../stream';
import { useEndedTriggers, useTriggerExits, useTriggerFeed, useTriggers } from '../trigger-engine';
import { conditionalDemoActive, conditionalDemoSources, DEMO_ENV } from './demo';
import { projectRows, type Projection } from './rows';

export function useStreamStatus(): StreamStatus {
    return useSyncExternalStore(subscribeStatusStore, getStreamStatus);
}

/** Re-render every `ms` (staleness, 有效期 countdowns); no broker request. */
export function useClock(ms = 5000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(timer);
    }, [ms]);
    return now;
}

export interface ConditionalView extends Projection {
    stream: StreamStatus;
    envNow: string | null;
    executing: boolean;
}

export function useConditionalView(): ConditionalView {
    const triggers = useTriggers();
    const brackets = useBrackets();
    const exits = useTriggerExits();
    const ended = useEndedTriggers();
    const feed = useTriggerFeed();
    const pending = usePendingConfirm();
    const stream = useStreamStatus();
    const programs = useBackgroundPrograms();
    const bgBrackets = useMemo(() => bracketViews(programs), [programs]);
    useServerInfo(); // re-render when the server mode becomes known / changes
    const envNow = currentProtectionEnv();
    const now = useClock();
    const items = pending.snapshot?.items;
    const demo = conditionalDemoActive();
    const projection = useMemo(() => projectRows(demo ? conditionalDemoSources(now) : {
        triggers, brackets, exits, ended, pendingConfirm: items ?? [], bgBrackets, feedMissing: feed.feedMissing,
        executing: feed.executing, envNow, streamLive: stream === 'live', now,
    }), [demo, bgBrackets, triggers, brackets, exits, ended, items, feed.feedMissing, feed.executing, envNow, stream, now]);
    if (demo) return { ...projection, stream: 'live', envNow: DEMO_ENV, executing: true };
    return { ...projection, stream, envNow, executing: feed.executing };
}
