// src/hooks/use-stream.ts — bind components to the SSE quote store

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ensureContract } from '../lib/contracts-cache';
import { retainContractQuotes } from '../lib/quote-ownership';
import { getTradingMirrorFresh, subscribeTradingMirror } from '../lib/trading-mirror-lease';
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
    const status = useStreamStatus();
    const mirrorFresh = useSyncExternalStore(subscribeTradingMirror, getTradingMirrorFresh);
    return status === 'live' && mirrorFresh;
}

export interface UseQuoteOptions {
    /** 盤中零股行情（intraday_odd）：獨立訂閱與 store，量以股計（#204） */
    oddLot?: boolean;
    /** 只讀成交與指數；BidAsk 變動維持相同視圖參照，不喚醒價格看板。 */
    narrow?: boolean;
}

export type PriceQuoteState = Pick<QuoteState, 'tick' | 'index'>;
export function useQuote(code: string | null, options: UseQuoteOptions & { narrow: true }): PriceQuoteState | undefined;
export function useQuote(code: string | null, options?: UseQuoteOptions & { narrow?: false }): QuoteState | undefined;
export function useQuote(code: string | null, options?: UseQuoteOptions): PriceQuoteState | QuoteState | undefined {
    const oddLot = options?.oddLot === true;
    const cached = useRef<{ code: string; oddLot: boolean; view: PriceQuoteState } | null>(null);
    useEffect(() => {
        ensureStream();
        let active = true;
        let release: (() => void) | undefined;
        if (code) void ensureContract(code).then(c => { if (active) release = retainContractQuotes(c, oddLot ? { oddLot } : undefined); }).catch(() => undefined);
        return () => { active = false; release?.(); };
    }, [code, oddLot]);
    return useSyncExternalStore(
        (listener) =>
            code ? subscribeQuoteStore(code, listener, oddLot) : () => undefined,
        () => {
            const quote = code ? getQuote(code, oddLot) : undefined;
            if (!options?.narrow || !quote || !code) return quote;
            const previous = cached.current;
            if (previous?.code === code && previous.oddLot === oddLot &&
                previous.view.tick === quote.tick && previous.view.index === quote.index) return previous.view;
            const view = { tick: quote.tick, index: quote.index };
            cached.current = { code, oddLot, view };
            return view;
        },
    );
}
