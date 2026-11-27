// src/lib/broadcast/broadcast-queue.ts — 語音佇列（去重 / 過時丟棄 / 插播）。
//
// 序列化語意：一次只念一句，念完才取下一個（上層佇列不允許並發出聲）。
// 以 Promise 串接表達，等同「單一消費者 + 阻塞佇列」的模型。
//
// 三道機制：
//   1. 去重：同一商品「完全一樣的一句話」不重複念（_latestSymbolMessages）
//   2. 過時丟棄：排隊超過 10 秒的句子直接丟（市場早變了，念了也是舊資訊）
//   3. 插播：急件清空佇列 + 打斷目前正在念的話

import type { TtsEngine } from '../tts';
import {
    debugDuplicateSuppressed,
    debugDroppedStale,
    debugSpeakFailed,
    debugQueuePending,
    debugSpeakingDone,
    debugSpoke,
} from './broadcast-debug';

export interface BroadcastEnqueueOptions {
    /** 商品代碼；同一商品同句話會被去重。系統訊息可留空 */
    symbolCode?: string;
    /** 急件：清空佇列並打斷目前的語音 */
    interrupt?: boolean;
}

interface QueuedMessage {
    text: string;
    symbolCode: string;
    interrupt: boolean;
    requestedAt: number;
}

export const STALE_AFTER_MS = 10_000;

export class BroadcastQueue {
    private readonly queue: QueuedMessage[] = [];
    private readonly lastTextBySymbol = new Map<string, string>();
    private running = false;

    constructor(
        private readonly engine: TtsEngine,
        private readonly now: () => number = Date.now,
        private readonly staleAfterMs: number = STALE_AFTER_MS,
        /**
         * 句子「開始播報」時的回呼（用來寫播報紀錄 → 面板的「最近播報」）。
         *
         * 為什麼是「開始」而不是「念完」：面板要立刻看到「現在正在念這一句」，
         * 時間戳才是開始的時間。TS 的 `await` 語意跟 C# 的 `await` 一樣 ——
         * `await` 之後的程式碼要等語音結束才會執行；所以回呼要放在 `await` **之前**。
         *
         * ⚠️ 不要為了「讓 log 先出現」把 `engine.speak()` 改成 fire-and-forget：
         * 那會讓多句同時出聲 → 去重、冷卻、10 秒過時丟棄全部失效。
         */
        private readonly onSpeak?: (text: string, symbolCode: string) => void,
    ) {}

    /** 目前排隊中的句數（診斷 / 測試用） */
    get pending(): number {
        return this.queue.length;
    }

    enqueue(text: string, options: BroadcastEnqueueOptions = {}) {
        if (!text.trim()) return;
        const symbolCode = options.symbolCode ?? '';

        if (options.interrupt) {
            // 急件：清空佇列 + 打斷正在念的話
            this.queue.length = 0;
            this.engine.cancelAll();
            this.queue.push({
                text,
                symbolCode,
                interrupt: true,
                requestedAt: this.now(),
            });
            void this.pump();
            return;
        }

        // 智慧過濾：同一商品跟「上一句」一模一樣就不念
        if (symbolCode) {
            if (this.lastTextBySymbol.get(symbolCode) === text) {
                debugDuplicateSuppressed(symbolCode);
                return;
            }
            this.lastTextBySymbol.set(symbolCode, text);
        }

        this.queue.push({
            text,
            symbolCode,
            interrupt: false,
            requestedAt: this.now(),
        });
        debugQueuePending(this.queue.length);
        void this.pump();
    }

    /** 清空排隊（不影響「上次念了什麼」的去重記憶；清空後同一句話仍不重複播報） */
    clear() {
        this.queue.length = 0;
    }

    private async pump() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                const message = this.queue.shift();
                if (!message) break;
                debugQueuePending(this.queue.length);
                // 過時丟棄：不是急件且已經放超過 10 秒 → 市場早變了，別念
                if (
                    !message.interrupt &&
                    this.now() - message.requestedAt > this.staleAfterMs
                ) {
                    // 這句從未發聲：把它從去重記憶中移除。
                    // 少了這段，「第二句」被過時丟棄後，之後再排同一句會被
                    // 誤判成「跟上一句一樣」而永久靜音（實測重現：
                    // SPOKEN = ['第一句']，重新排「第二句」仍不發聲）。
                    if (
                        message.symbolCode &&
                        this.lastTextBySymbol.get(message.symbolCode) ===
                            message.text
                    ) {
                        this.lastTextBySymbol.delete(message.symbolCode);
                    }
                    debugDroppedStale(message.symbolCode);
                    continue;
                }
                const startedAt = this.now();
                try {
                    debugSpoke(message.text, message.symbolCode);
                    // ★ 在 await 之前回報：這一句確定要念了（冷卻／去重擋下的句子
                    // 根本進不了佇列，過時丟棄的也走不到這裡），
                    // 讓面板「立刻」看到目前正在播的內容。
                    this.onSpeak?.(message.text, message.symbolCode);
                    await this.engine.speak(message.text);
                    debugSpeakingDone(this.now() - startedAt);
                } catch (err) {
                    // 單次發音失敗不影響後續的句子 —— 但**不可以靜默吞掉**：
                    // 記進 trace，否則使用者只會覺得「怎麼沒聲音」。
                    debugSpeakFailed(
                        err instanceof Error ? err.message : String(err),
                        this.now() - startedAt,
                    );
                    debugSpeakingDone(this.now() - startedAt);
                }
            }
        } finally {
            this.running = false;
            debugQueuePending(0);
        }
    }
}
