// src/components/chain-feed.tsx — the live 1-minute K-bar feed shared by
// 產業鏈資金流向 and 持股族群.
//
// Both panels subscribe the same members (every code of every chain and
// theme), so they build the same K-bar batch keys: the capability registry
// ref-counts them and opening the second panel adds no request. Snapshots are
// seeded once per code (lib/chain-flow-feed.ts).

import { AlertTriangle, Radio } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useChainMapData } from '../hooks/use-chain-map-data';
import { SESSION_SLOTS } from '../lib/chain-flow';
import { chainFlowBook, chainFlowStatus, connectChainFlow, useChainFlowRevision, type FeedMember } from '../lib/chain-flow-feed';
import { memberCodes, stockContract } from '../lib/chain-map';
import { entityIndex, entityName, STALE_TEXT } from '../lib/company-data';
import type { Theme } from '../lib/company-data/types';
import { NextBar, useBoxSize, useFeedPhase, usePaused, useReducedMotion } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

/** Feed members of every chain and theme (stable order: the batch keys depend on it). */
export function feedMembers(
    themes: readonly Theme[],
    marketOf: (code: string) => string | undefined,
    sharesOf: (code: string) => number | null,
): FeedMember[] {
    return memberCodes(themes).map((code) => ({ code, contract: stockContract(code, marketOf(code)), shares: sharesOf(code) }));
}

export function useChainFeed() {
    const data = useChainMapData();
    const ready = data.phase === 'ready' ? data : null;
    const themes = ready?.themes ?? null;
    const entities = ready?.entities ?? null;
    const index = useMemo(() => (entities ? entityIndex(entities) : null), [entities]);
    const nameOf = useCallback((code: string) => entityName(index, `tw.${code}`), [index]);

    const members = useMemo<FeedMember[]>(() => {
        if (!themes) return [];
        const daily = ready?.market?.quotes;
        return feedMembers(
            themes,
            (code) => index?.get(`tw.${code}`)?.market,
            (code) => daily?.[code]?.shares ?? null,
        );
    }, [themes, index, ready?.market]);
    useEffect(() => (members.length > 0 ? connectChainFlow(members) : undefined), [members]);

    const { ref: rootRef, element: rootEl, size: rootSize } = useBoxSize<HTMLDivElement>();
    const paused = usePaused(rootEl);
    const reducedMotion = useReducedMotion();
    const revision = useChainFlowRevision(paused);
    const book = chainFlowBook;
    const feed = chainFlowStatus();
    const now = book.lastSlot;
    const from = book.firstSlot;
    const phase = useFeedPhase(book.date, feed.lastBarAt, now, paused);

    // live / closed come from the Taipei clock, the session date and feed
    // freshness (useFeedPhase); seeded after 13:30 also means the snapshot
    // already covers the whole session
    let closed = phase === 'closed';
    if (!closed && now === null) for (const f of book.codes.values()) if (f.seedSlot >= SESSION_SLOTS) { closed = true; break; }
    const live = !closed && phase === 'live';
    const minutes = now !== null && from !== null ? now - from + 1 : 0;
    const liveText = closed
        ? now !== null
            ? `已收盤・1 分 K 已接收 ${minutes} 分鐘`
            : '已收盤・今日彙總'
        : now !== null
          ? `1 分 K・${feed.kbarCodes} 檔・已接收 ${minutes} 分鐘${phase === 'stalled' ? '・暫無新資料' : ''}`
          : feed.batches > 0
            ? `1 分 K 已訂閱 ${feed.subscribed}/${feed.batches} 批・等待下一根`
            : '';

    return { data, ready, themes, index, nameOf, rootRef, rootSize, paused, reducedMotion, revision, book, feed, now, from, closed, live, liveText };
}

export type ChainFeed = ReturnType<typeof useChainFeed>;

/** Feed status for a panel toolbar: subscription error or live text, next-bar timer, stale data. */
export function FeedStatus({ feed: f }: { feed: ChainFeed }) {
    return (
        <>
            {f.feed.kbarError ? (
                <span className={`${s.live} ${panel.statusText.err}`} title={f.feed.kbarError}>
                    <AlertTriangle size={11} aria-hidden='true' />1 分 K 訂閱失敗
                </span>
            ) : f.liveText ? (
                <span className={s.live} title='即時 1 分 K 訂閱；其他面板已訂閱的 tick 會更快更新價格。開啟面板前的分鐘只有 snapshot 彙總，不下載歷史 K 線'>
                    <Radio size={11} className={f.live ? s.liveOn : undefined} aria-hidden='true' />
                    {f.liveText}
                </span>
            ) : null}
            <NextBar live={f.live && !f.paused} />
            {f.ready?.stale && <span className={s.stale}>{STALE_TEXT}</span>}
        </>
    );
}
