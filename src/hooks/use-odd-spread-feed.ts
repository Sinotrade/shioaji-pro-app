// src/hooks/use-odd-spread-feed.ts — 整零價差面板的行情轉接層。
//
// 面板只吃 OddSpreadFeed（兩邊五檔＋最後成交），不直接碰行情 store，
// 方便測試與截圖時以固定資料餵入。
//
// - 整股：一般 quote store（useDisplayBook；尚無串流五檔時以快照一檔補）
// - 零股：#204 的盤中零股 store（useQuote(code, { oddLot: true })，
//   intraday_odd 訂閱，量以股計）。零股約每 5 秒撮合一次，最後成交與五檔
//   只在撮合時更新；尚未收到零股行情前 oddAvailable=false，面板顯示
//   「等待零股行情」並停用送出。零股不以快照補，避免把整股快照當零股。

import { useMemo } from 'react';
import { displayBook } from '../lib/display-book';
import type { SideBook } from '../lib/odd-spread';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtClock } from '../lib/utils/format';
import { useDisplayBook } from './use-display-book';
import { useQuote } from './use-stream';

export interface OddSpreadFeed {
    round: SideBook;
    odd: SideBook;
    roundLast: number | null;
    roundChange: number | null;
    oddLast: number | null;
    oddChange: number | null;
    /** 零股最近一次撮合時間（HH:MM:SS） */
    oddTime: string | null;
    /** 是否已收到零股行情 */
    oddAvailable: boolean;
}

export const EMPTY_BOOK: SideBook = { bids: [], asks: [] };

function num(v: string | number | undefined | null): number | null {
    const n = Number(v);
    return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null;
}

function change(last: number | null, priceChg: string | undefined, reference: number | undefined): number | null {
    return num(priceChg) ?? (last !== null && reference ? Math.round((last - reference) * 100) / 100 : null);
}

export function useOddSpreadFeed(contract: ContractInfo, snapshot?: Snapshot): OddSpreadFeed {
    const { quote, snapshot: baseline, book } = useDisplayBook(contract.code, snapshot, contract);
    const oddQuote = useQuote(contract.security_type === 'STK' ? contract.code : null, { oddLot: true });
    const tick = quote?.tick;
    const roundLast = num(tick?.close) ?? (baseline?.close || null);
    const roundChange = change(roundLast, tick?.price_chg, contract.reference);
    const oddBook = useMemo(
        () => displayBook(contract.code, undefined, oddQuote?.bidask, contract.target_code),
        [contract.code, contract.target_code, oddQuote?.bidask],
    );
    const oddTick = oddQuote?.tick;
    const oddLast = num(oddTick?.close);
    const oddChange = change(oddLast, oddTick?.price_chg, contract.reference);
    const oddTime = fmtClock(oddTick?.time ?? oddQuote?.bidask?.time) || null;
    const oddAvailable = !!oddQuote && (!!oddQuote.bidask || !!oddTick);
    return useMemo(() => ({
        round: { bids: book?.bids ?? [], asks: book?.asks ?? [] },
        odd: oddBook ? { bids: oddBook.bids, asks: oddBook.asks } : EMPTY_BOOK,
        roundLast,
        roundChange,
        oddLast,
        oddChange,
        oddTime,
        oddAvailable,
    }), [book, oddBook, roundLast, roundChange, oddLast, oddChange, oddTime, oddAvailable]);
}
