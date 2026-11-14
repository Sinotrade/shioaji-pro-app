import { useSyncExternalStore, type ComponentProps } from 'react';
import { useTradingLive } from '../hooks/use-stream';
import { currentProtectionEnv } from '../lib/protection-env';
import { subscribeServerInfo } from '../lib/server-info-store';
import { getTradingMirrorFresh, subscribeTradingMirror } from '../lib/trading-mirror-lease';
import { RECONCILE_REASON_LABELS, useTradingState, type TradingQueryStatus } from '../lib/trading-state';
import { CandleChart } from './candle-chart';

// 成交標記隱藏時要說得出原因；「待對帳」沿用帳務面板（bottom-dock）的說法與原因名稱。
function pendingNote(live: boolean, confirmed: boolean, orders: TradingQueryStatus): string {
    if (orders.needsReconcile) {
        const labels = orders.reasons.map(r => RECONCILE_REASON_LABELS[r]).filter(Boolean);
        if (!labels.length) return '成交待對帳';
        return `成交待對帳：${labels.slice(0, 2).join('、')}${labels.length > 2 ? ` 等 ${labels.length} 項` : ''}`;
    }
    // !live 也包含剛啟動還沒連上、以及小視窗等不到主視窗資料，不能直接說「中斷」
    return !live ? '成交暫停：連線尚未就緒' : confirmed ? '成交待確認' : '成交待確認：委託尚未確認';
}

// 連線尚未就緒時不用使用者動手：小視窗等主視窗同步，主視窗等串流恢復
const WAIT_HINT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout')
    ? '主視窗的資料同步後會自動確認' : '連線恢復後會自動確認';

// 共用既有帳務 owner；不增加查詢。資料保留不代表可跨環境重用。
// 不看 trading.loading：持倉／餘額更新也會設 loading，等它會讓標記閃爍。委託是
// 逐帳戶整批替換，換環境或可交易帳戶變動時 ordersSnapshotEnv 會先被清空。
export function LiveCandleChart(props: Omit<ComponentProps<typeof CandleChart>, 'trades' | 'fillsReady' | 'fillsNote' | 'fillsHint' | 'fillsRetain' | 'fillsEnv'>) {
    const trading = useTradingState();
    const live = useTradingLive();
    const env = useSyncExternalStore(subscribeServerInfo, currentProtectionEnv);
    // 待確認時保留上次確認的標記：主視窗一直可以；彈出視窗只在主視窗鏡像還新鮮時可以，
    // 主視窗關閉（main-gone）、租約逾時或改由自己持有串流時立即清空。
    const mirrorFresh = useSyncExternalStore(subscribeTradingMirror, getTradingMirrorFresh);
    const orders = trading.queries.orders;
    const confirmed = !!env && trading.ordersSnapshotEnv === env;
    const fillsReady = live && confirmed && !orders.needsReconcile;
    return <CandleChart {...props} trades={trading.trades} fillsReady={fillsReady} fillsRetain={mirrorFresh} fillsEnv={env}
        fillsNote={fillsReady ? undefined : pendingNote(live, confirmed, orders)}
        fillsHint={!live && !orders.needsReconcile ? WAIT_HINT : undefined} />;
}
