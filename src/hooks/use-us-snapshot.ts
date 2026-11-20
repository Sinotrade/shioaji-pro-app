// src/hooks/use-us-snapshot.ts — 美股快照（SDK 1.8.0b1），報價板與五檔共用
//
// enabled 時抓一次（同商品的請求在 us-history 共用）；失敗不重試，換商品或
// 重新掛載再抓。快照只當即時資料到達前的墊底，呼叫端一律以即時資料優先。

import { useEffect, useState } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import { fetchUsSnapshotShared, nyDateStr, type UsSnapshot } from '../lib/us/us-history';
import { usLinkKey } from '../lib/contract-key';
import { noteUsReference, usReferenceFor } from '../lib/us/us-quotes';
import type { SseTick } from '../lib/types/market';
import { useUsMarketClock } from './use-us-market-clock';
import { usSessionView, type UsClockPhase, type UsSessionView } from '../lib/us/us-session-view';

/**
 * 快照有沒有可顯示的東西：有成交價，或有最佳一檔。剛上市還沒成交的 IPO
 * （例如 ANT：close 0、session Unknown、exchange 空字串）只有撮合前的買賣價，
 * 那也是真實報價，五檔與報價板要顯示。
 */
export function usSnapshotHasData(row: Pick<UsSnapshot, 'close' | 'buyPrice' | 'sellPrice'>): boolean {
    return row.close > 0 || (row.buyPrice ?? 0) > 0 || (row.sellPrice ?? 0) > 0;
}

export function useUsSnapshot(contract: Pick<ContractInfo, 'code' | 'exchange'>, enabled: boolean): UsSnapshot | null {
    const [snap, setSnap] = useState<{ key: string; phase: string; row: UsSnapshot } | null>(null);
    const key = `${contract.exchange}:${contract.code}`;
    // 美東時段界線（04:00、09:30、16:00、20:00 ET）一過再抓一次，沒有即時成交時也會換到
    // 正確的盤前／盤後狀態；重抓期間照用舊的那筆，看板不會先清空再補回
    const clock = useUsMarketClock();
    const phase = `${clock.date}:${clock.phase}`;
    const have = snap?.key === key;
    const fresh = have && snap!.phase === phase;
    useEffect(() => {
        if (!enabled || fresh) return;
        let cancelled = false;
        fetchUsSnapshotShared(contract)
            .then(row => {
                if (row?.tradeDate) noteUsReference(usLinkKey(contract.code), row.tradeDate, row.reference);
                if (!cancelled && row && usSnapshotHasData(row)) setSnap({ key, phase, row });
            })
            .catch(() => { /* 沒有快照：呼叫端維持原本的顯示 */ });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled, fresh, phase]);
    return have ? snap!.row : null;
}

/**
 * 美股參考價（報價板、自選清單、下單面板、閃電下單共用同一個來源）：
 * 交易日＝即時成交的日期，沒有成交時用快照的交易日；參考價取那天的快照
 * reference，其次是確定適用那天的合約檔參考價。不從成交價或 price_chg 回推。
 * 沒有成交也沒有快照時才顯示合約檔參考價（附收盤日）。
 */
export function pickUsReference(
    tick: Pick<SseTick, 'date'> | undefined,
    snap: Pick<UsSnapshot, 'reference' | 'tradeDate'> | null,
    contract: Pick<ContractInfo, 'us_reference' | 'reference_date'>,
    today = nyDateStr(),
): { price: string | null; date: string | null; tradeDate: string } {
    const tradeDate = tick?.date || snap?.tradeDate || today;
    const picked = usReferenceFor(tradeDate, snap, contract);
    // 還沒有成交也沒有快照：只是顯示用（置中、帶價），照合約檔參考價並標它的收盤日；
    // 有成交時漲跌一定要用適用當天的參考價，不走這條
    if (!picked.price && !tick && contract.us_reference) return { price: contract.us_reference, date: contract.reference_date ?? null, tradeDate };
    return { ...picked, tradeDate };
}


/**
 * 美股報價的一般盤主行與盤前／盤後副行（自選清單、報價板共用，見 us-session-view）。
 * 參考價取 tick 與快照中較新的那個交易日（盤前快照已換日、tick 還是前一天的盤後時，
 * 盤前漲跌要對今天的參考價）。
 */
export function usSessionViewFor(
    contract: Pick<ContractInfo, 'us_reference' | 'reference_date'>,
    tick: SseTick | undefined,
    snap: UsSnapshot | null,
    now: { phase: UsClockPhase; date: string },
): UsSessionView {
    const refTick = tick && (!snap?.tradeDate || !tick.date || tick.date >= snap.tradeDate) ? tick : undefined;
    const reference = refTick || snap ? pickUsReference(refTick ?? { date: snap!.tradeDate }, snap, contract).price : null;
    return usSessionView({ tick, snap, reference, now });
}
