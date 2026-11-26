// src/lib/broadcast/broadcast-events.ts — 成交／委託與通知的語音文案（純函式）。
//
// 為什麼另外寫一套、不直接用 order-report.ts 的 describeOrderReport()：
// 那份是「畫面用」的文案（`@ 1900.00`、`改價 → 1900.00`），念出來不自然。
// 這裡是「念出來」的文案：沒有 @ 與箭頭、數字不帶千分位。
//
// 這個模組刻意不 import 任何有副作用的模組（trade / stream / api），
// 只吃「已經整理好的資料」→ 純函式、可單獨測試。

import type { Action } from '../types/order';
import type { OrderEventReport, OrderMarket } from '../order-report';

/** 通知事件（與 lib/trade.ts 的 AppNotice 同形，這裡只宣告需要的欄位） */
export interface BroadcastNotice {
    kind: 'ok' | 'err' | 'info';
    title: string;
    body: string;
}

/** 語音用的數字：不帶千分位、小數最多兩位 */
function speakNumber(n: number): string {
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n * 100) / 100);
}

function actionText(action?: Action): string {
    if (action === 'Buy') return '買進';
    if (action === 'Sell') return '賣出';
    return '';
}

function unitText(r: { market: OrderMarket; orderLot?: string }): string {
    if (r.market === 'futures') return '口';
    // 美股（OrderMarket 的 'us'）：一股就是一股，沒有「張」的概念
    if (r.market === 'us') return '股';
    return r.orderLot === 'Odd' || r.orderLot === 'IntradayOdd' ? '股' : '張';
}

/**
 * 成交／委託事件的語音文案。
 *
 * - 成交：買進 2330，1000 張，成交價 1900
 * - 委託：委託買進 2330，1000 張，1900
 * - 撤單：取消買進 2330，1000 張
 * - 改價：改價買進 2330，1000 張，1900
 * - 失敗：委託失敗 2330，請檢查
 *
 * 回傳 null 代表這樁事件不值得念（例如沒有方向、沒有代號）。
 */
export function describeOrderVoice(ev: OrderEventReport): string | null {
    const act = actionText(ev.action);
    const code = ev.code;
    if (!code) return null;

    const unit = unitText(ev);
    const qty = speakNumber(ev.quantity);
    const price = speakNumber(ev.price);

    if (ev.kind === 'deal') {
        const parts = [act, code];
        if (qty) parts.push(`${qty} ${unit}`);
        // 價格拿不到時不要把「成交價」單獨留下（會念成「… 張 成交價」）
        if (price) parts.push('成交價', price);
        return parts.join(' ');
    }

    // 委託類
    if (ev.failed || ev.opType === 'Reject') {
        return `委託失敗 ${code}${act ? ` ${act}` : ''}，請檢查`;
    }

    switch (ev.opType) {
        case 'Cancel': {
            const cut = ev.cancelQuantity > 0 ? ev.cancelQuantity : ev.quantity;
            return `取消${act} ${code} ${speakNumber(cut)} ${unit}`.trim();
        }
        case 'UpdatePrice': {
            const to = ev.modifiedPrice > 0 ? ev.modifiedPrice : ev.price;
            return `改價${act} ${code} ${speakNumber(ev.quantity)} ${unit} ${speakNumber(to)}`.trim();
        }
        case 'UpdateQty': {
            const cut = ev.cancelQuantity;
            return cut > 0
                ? `減量${act} ${code} ${speakNumber(cut)} ${unit}`.trim()
                : `數量已更新 ${act} ${code}`.trim();
        }
        default: {
            const parts = ['委託', act, code];
            if (qty) parts.push(`${qty} ${unit}`);
            if (price) parts.push(price);
            return parts.join(' ').trim();
        }
    }
}

/** 通知／條件單事件的語音文案。body 太長就只念 title。 */
export function describeNoticeVoice(n: BroadcastNotice): string | null {
    const title = n.title?.trim();
    if (!title) return null;
    const body = n.body?.trim() ?? '';
    // body 太長念起來很吵，只念有點長度上限的
    if (body && body.length <= 40) return `${title}，${body}`;
    return title;
}
