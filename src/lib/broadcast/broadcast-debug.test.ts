import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearBroadcastTrace,
    debugDecision,
    debugNoQuote,
    debugQuoteArrived,
    debugSpoke,
    debugSubscribed,
    formatBroadcastTrace,
    getBroadcastDebug,
    getBroadcastTrace,
} from './broadcast-debug';

// 這些測試只鎖「旁路觀測層」的三件事：
//   1. 有界（不會因為跑幾小時把記憶體吃光）
//   2. 抗洪（同一商品同一事件不會把有用的記錄擠掉）
//   3. 不影響本來就有的狀態與計數（觀測層不能改變被觀測的東西）

beforeEach(() => {
    clearBroadcastTrace();
});

describe('語音播報 trace', () => {
    it('沒有任何記錄時也給得出可讀文字，不是空字串', () => {
        const text = formatBroadcastTrace([], Date.UTC(2026, 10, 26, 10, 30, 0));
        expect(text).toContain('[shioaji-pro] 語音播報 trace');
        expect(text).toContain('---- 目前狀態 ----');
        expect(text).toContain('（沒有記錄');
    });

    it('同一商品同一種事件在 1 秒內折疊成一行，並累計次數', () => {
        debugNoQuote('2330', '盤後沒有即時成交');
        debugNoQuote('2330', '盤後沒有即時成交');
        debugNoQuote('2330', '盤後沒有即時成交');

        const trace = getBroadcastTrace();
        expect(trace).toHaveLength(1);
        expect(trace.at(0)?.kind).toBe('no-quote');
        // 3 次事件 → 1 行，第 2、3 次折進 repeat
        expect(trace.at(0)?.repeat).toBe(2);
    });

    it('不同種類的事件不會被折疊掉', () => {
        debugNoQuote('2330', 'x');
        debugSubscribed('2330', ['tick']);
        debugNoQuote('2330', 'x');

        expect(getBroadcastTrace().map((e) => e.kind)).toEqual([
            'no-quote',
            'subscribe',
            'no-quote',
        ]);
    });

    it('上限 1000 筆，超過時丟掉最舊的', () => {
        for (let i = 0; i < 1050; i += 1) {
            // 用不同代碼讓每一筆都是獨立事件，不會被折疊
            debugNoQuote(`C${i}`, 'x');
        }

        const trace = getBroadcastTrace();
        expect(trace).toHaveLength(1000);
        expect(trace.at(0)?.code).toBe('C50');
        expect(trace.at(-1)?.code).toBe('C1049');
    });

    it('報價只在「沒有 → 有」的轉折記一筆，之後每筆 tick 不灌進來', () => {
        debugNoQuote('2330', '收盤後沒有即時成交');
        debugQuoteArrived('2330');
        expect(getBroadcastTrace()).toHaveLength(2);

        // tick 每一筆都會呼叫 debugQuoteArrived()，這裡模擬高頻呼叫
        debugQuoteArrived('2330');
        debugQuoteArrived('2330');
        // 已經有報價了 → 只留下原先那筆轉折記錄與它的 repeat
        const trace = getBroadcastTrace();
        expect(trace).toHaveLength(2);
        expect(trace.at(-1)?.kind).toBe('quote-arrived');
        expect(trace.at(-1)?.repeat).toBe(0);
    });

    it('匯出的每一行都有「時:分:秒.毫秒 事件種類 代碼 說明」', () => {
        debugSubscribed('2330', ['tick']);
        const text = formatBroadcastTrace();
        expect(text).toMatch(
            /\d{2}:\d{2}:\d{2}\.\d{3}\s+subscribe\s+2330 訂閱 tick/,
        );
    });

    it('同商品同種類但內容不同的判定不得被折疊（實測 trace 抓到的 bug）', () => {
        // 真實案例（broadcast-trace-20261126-211647.txt:36-37）：
        // 21:14:52.169 decision CDFR1 不念（原因：first-tick）
        // 21:14:52.307 speak    CDFR1 «台積電期貨 近月 2160»
        // 兩筆判定相隔 138ms、同商品同種類，但一個不念、一個要念。
        // 折疊若只看 (kind, code)，「念」那筆會被吞進「不念」那行，
        // trace 就會出現「只判定不念」卻又有 speak 的自相矛盾。
        debugDecision('CDFR1', { status: '', speak: false, reason: 'first-tick' });
        debugDecision('CDFR1', {
            status: '',
            speak: true,
            text: '台積電期貨 近月 2160',
        });

        const trace = getBroadcastTrace();
        expect(trace).toHaveLength(2);
        expect(trace.at(0)?.text).toContain('不念');
        expect(trace.at(-1)?.text).toContain('念 «');
    });

    it('折疊的次數會出現在匯出文字裡', () => {
        debugNoQuote('2330', 'x');
        debugNoQuote('2330', 'x');
        expect(formatBroadcastTrace()).toContain('(×2)');
    });

    it('「已播」只算真正發聲，判定要念不算（實測 trace 抓到的計數謊報）', () => {
        // 實測 200 行窗口：判定要念 34 次、真正 speak 只有 7 次。
        // counters.spoke 若在「判定」與「發聲」兩處都 +1，數字就不是事實。
        const readSpoke = () =>
            Number(formatBroadcastTrace().match(/已播 (\d+)/)?.[1] ?? -1);
        const before = readSpoke();
        expect(before).toBeGreaterThanOrEqual(0);

        debugDecision('2330', {
            status: '創新高',
            speak: true,
            text: '台積電 創新高 1900',
        });
        expect(readSpoke()).toBe(before); // 只是「決定要念」→ 不算已播

        debugSpoke('台積電 創新高 1900', '2330');
        expect(readSpoke()).toBe(before + 1); // 真正發聲 → 才算
    });

    it('trace 是旁路：記錄不改變既有的計數與開關狀態', () => {
        const before = getBroadcastDebug().counters;
        debugNoQuote('2330', 'x');
        debugSubscribed('2330', ['tick']);
        const after = getBroadcastDebug().counters;
        expect(after).toEqual(before);
    });
});