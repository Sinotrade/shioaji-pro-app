// src/lib/us/us-adapter.ts — 美股資料轉成台股元件吃的形狀
//
// 報價板、五檔、K 線、走勢、成交明細都用台股那一套元件畫美股；差別只在資料：
// 這裡把美股快照（UsSnapshot）轉成台股 Snapshot，code 用連動 key（US:CODE，
// 與行情 store 的 key 一致），時間是紐約牆鐘（和 bidask_stk_us 的 date／time 同一
// 套），display-book 比較「快照 vs 即時一檔」誰新時兩邊才對得上。
// 美股快照沒有的欄位（均價、單量、金額…）填 0，台股元件本來就把 0 當沒有。

import { usLinkKey } from '../contract-key';
import type { Snapshot } from '../types/market';
import type { UsSnapshot } from './us-history';
import { nyDateTime } from './us-quotes';

export function usSnapshotToTw(s: UsSnapshot): Snapshot {
    const { date, time } = s.ts ? nyDateTime(s.ts * 1000) : { date: '', time: '' };
    return {
        code: usLinkKey(s.code),
        exchange: s.exchange,
        datetime: date ? `${date}T${time}` : s.tradeDate,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close,
        average_price: 0,
        buy_price: s.buyPrice ?? 0,
        buy_volume: s.buyVolume ?? 0,
        sell_price: s.sellPrice ?? 0,
        sell_volume: s.sellVolume ?? 0,
        volume: 0,
        total_volume: s.totalVolume,
        amount: 0,
        total_amount: 0,
        change_price: s.changePrice,
        change_rate: s.changeRate,
        change_type: '',
        tick_type: '',
        volume_ratio: 0,
        yesterday_volume: s.yesterdayVolume ?? 0,
    };
}
