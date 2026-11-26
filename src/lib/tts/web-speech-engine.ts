// src/lib/tts/web-speech-engine.ts — Web Speech API 實作。
//
// 支援環境：Chrome / Edge / WebView2（Windows）、Safari / WKWebView（macOS）。
// 不支援環境：Linux WebKitGTK（speechSynthesis 為 undefined）→ 回報不可用。
//
// 為什麼自己管佇列而不直接用 speechSynthesis 的內建佇列：
// WPF 那套的「過時丟棄（排隊超過 10 秒就不念）」需要知道一句話「幾點被要求念」
// 與「幾點真的念出來」，瀏覽器的內建佇列不給這個資訊。佇列放在上層
// （broadcast-queue.ts），engine 只負責單純地把一句話念完。

import type { TtsEngine, TtsProbe, TtsSpeakOptions, TtsVoice } from './tts-engine';

/**
 * 抽象語速刻度（-10~20，0 = 正常）→ Web Speech 的倍率（1 = 正常）。
 * WPF 的 SpeechSynthesizer.Rate 每格約 10%，這裡採同樣的近似比例。
 *
 * 為什麼放在 engine 裡而不是共用層：各平台的「語速」語意不同
 * （Web Speech 是倍率、WinRT 是 -10~10 的整數、sherpa 是 length_scale），
 * 映射是平台相關的，必須各做各的。
 */
export function rateToSpeed(rate: number): number {
    // 刻度上限 20 → 倍率 3.0；舊刻度 10 → 2.0，所以放寬不影響既有設定值。
    const normalized = Math.min(20, Math.max(-10, rate));
    return Math.min(3, Math.max(0.1, 1 + normalized * 0.1));
}

function getVoices(synth: SpeechSynthesis): SpeechSynthesisVoice[] {
    try {
        return synth.getVoices() ?? [];
    } catch {
        return [];
    }
}

function pickVoice(
    voices: SpeechSynthesisVoice[],
    voiceUri?: string,
): SpeechSynthesisVoice | null {
    if (voiceUri) {
        const exact = voices.find((v) => v.voiceURI === voiceUri);
        if (exact) return exact;
    }
    // 優先繁中，其次任何中文，最後才 fallback 到第一個語音
    return (
        voices.find((v) => /^zh[-_]TW/i.test(v.lang)) ??
        voices.find((v) => /^zh/i.test(v.lang)) ??
        voices[0] ??
        null
    );
}

function unavailable(reason: string): TtsEngine {
    return {
        id: 'web-speech',
        available: false,
        reason,
        probe: async () => ({ available: false, reason }),
        speak: async () => undefined,
        cancelAll: () => undefined,
        speaking: false,
        listVoices: () => [],
    };
}

export function createWebSpeechEngine(): TtsEngine {
    if (typeof window === 'undefined') {
        return unavailable('無瀏覽器環境，語音播報不可用');
    }
    const synth = window.speechSynthesis;
    const UtteranceCtor = window.SpeechSynthesisUtterance;
    if (!synth || !UtteranceCtor) {
        // Linux WebKitGTK 走這條路：語音要靠原生引擎，不是這裡能救的
        return unavailable(
            '此平台的 webview 未實作 Web Speech API（Linux WebKitGTK），語音播報需要原生語音引擎',
        );
    }

    let voices = getVoices(synth);
    // Chromium 的 getVoices() 常常一開始是空的，等 voiceschanged 再補
    synth.addEventListener?.('voiceschanged', () => {
        voices = getVoices(synth);
    });

    let current: { utterance: SpeechSynthesisUtterance; resolve: () => void } | null =
        null;

    return {
        id: 'web-speech',
        available: true,

        get speaking() {
            return current !== null;
        },

        listVoices(): TtsVoice[] {
            const list = voices.length ? voices : getVoices(synth);
            return list.map((v) => ({
                uri: v.voiceURI,
                name: v.name,
                lang: v.lang,
            }));
        },

        async probe(): Promise<TtsProbe> {
            // Web Speech 的可用性在建構時就定了（speechSynthesis 存不存在），
            // probe 只是把結論原樣交出去；未來原生引擎才需要真的去查檔案。
            const list = voices.length ? voices : getVoices(synth);
            return {
                available: true,
                reason: list.length
                    ? undefined
                    : '系統沒有可用的語音（voice 清單是空的）',
            };
        },

        speak(text: string, options?: TtsSpeakOptions): Promise<void> {
            return new Promise<void>((resolve) => {
                if (!text.trim()) {
                    resolve();
                    return;
                }
                const utterance = new UtteranceCtor(text);
                utterance.lang = 'zh-TW';
                utterance.rate = rateToSpeed(options?.rate ?? 0);
                utterance.volume = options?.volume ?? 1;
                const voice = pickVoice(voices, options?.voiceUri);
                if (voice) utterance.voice = voice;

                const finish = () => {
                    if (current?.utterance === utterance) current = null;
                    resolve();
                };
                utterance.onend = finish;
                utterance.onerror = (event) => {
                    // 不要靜默吞掉：語音失敗（例如瀏覽器未啟用語音、找不到語音）
                    // 使用者只會看到「沒反應」，這裡留一行告警方便追查。
                    console.warn('[tts] 語音播放失敗', event);
                    finish();
                };

                current = { utterance, resolve: finish };
                synth.speak(utterance);
            });
        },

        cancelAll() {
            try {
                synth.cancel();
            } catch {
                // 某些環境 cancel 會丟例外，忽略即可（下面照樣收斂 Promise）
            }
            // cancel 後瀏覽器不一定會觸發 onend —— 在這裡直接收斂，
            // 否則上層的佇列會卡在 await 上，後面的播報全部停擺。
            const pending = current;
            current = null;
            pending?.resolve();
        },
    };
}
