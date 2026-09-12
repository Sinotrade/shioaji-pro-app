// src/hooks/use-stream.ts — bind components to the SSE quote store

import { useEffect, useSyncExternalStore } from 'react';
import { ensureContract } from '../lib/contracts-cache';
import { retainContractQuotes } from '../lib/quote-ownership';
import type { QuoteState, StreamStatus } from '../lib/stream';
import {
    ensureStream,
    getQuote,
    getStreamStatus,
    subscribeQuoteStore,
    subscribeStatusStore,
} from '../lib/stream';

export function useStreamStatus(): StreamStatus {
    useEffect(ensureStream, []);
    return useSyncExternalStore(subscribeStatusStore, getStreamStatus);
}

// trading is only safe when the quote feed is LIVE — components disable
// order buttons on anything else so users never fire into a dead connection
// or think a click sent an order when it didn't (issue #2)
export function useTradingLive(): boolean {
    return useStreamStatus() === 'live';
}

export function useQuote(code: string | null): QuoteState | undefined {
    useEffect(() => {
        ensureStream();
        let active = true;
        let release: (() => void) | undefined;
        if (code) void ensureContract(code).then(c => { if (active) release = retainContractQuotes(c); }).catch(() => undefined);
        return () => { active = false; release?.(); };
    }, [code]);
    return useSyncExternalStore(
        (listener) =>
            code ? subscribeQuoteStore(code, listener) : () => undefined,
        () => (code ? getQuote(code) : undefined),
    );
}
