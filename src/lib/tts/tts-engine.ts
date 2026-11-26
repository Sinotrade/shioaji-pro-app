// src/lib/tts/tts-engine.ts — 語音引擎介面。
//
// 播報上層（broadcast/*）只認這個介面，實際發聲交給各平台實作：
//   - web-speech：瀏覽器 / WebView2 / WKWebView 的 Web Speech API
//   - 未來可再加 native-tts（Tauri Rust 端：WinRT / AVSpeechSynthesizer）
//
// 為什麼要有這層抽象：Linux 的 WebKitGTK 根本沒實作 Web Speech API，
// window.speechSynthesis 會是 undefined。與其讓上層默默失敗，不如由
// engine 回報 available=false 與原因，UI 直接顯示「此平台不支援語音播報」。
//
// 上層不要 import 任何平台 API，一律走這裡。

export interface TtsSpeakOptions {
    /**
     * 語速，面板滑桿刻度 **-10 ~ 20**（0 = 正常，每格約 10%）。
     * 各 engine 自行映射到自己的語意：
     *   - Web Speech：倍率 1 + rate/10，夾在 0.1~3
     *   - 原生引擎（WinRT／AVSpeech／sherpa）：各自的 rate / length_scale
     * 不要在共用層做映射——那是各平台語意不同的部分。
     */
    rate?: number;
    /** 音量 0~1 */
    volume?: number;
    /** 指定 voice 的 uri；不給就用 engine 預設的中文語音 */
    voiceUri?: string;
}

/** 引擎的實際可用性（由 probe() 非同步取得） */
export interface TtsProbe {
    available: boolean;
    /** 不能用時的原因，給 UI 直接顯示 */
    reason?: string;
}

export interface TtsEngine {
    /** engine 識別名（診斷 / log 用） */
    readonly id: string;
    /**
     * 同步判斷：這個 engine 物件在目前環境存不存在
     * （例如瀏覽器沒有 Web Speech API → false）。
     * 「實際能不能用」要問 probe()。
     */
    readonly available: boolean;
    /** 不能用時的原因，給 UI 直接顯示 */
    readonly reason?: string;
    /**
     * 非同步探測：實際能不能用。
     * 原生引擎的可用性取決於「執行檔在不在、模型下載了沒」——那是非同步才知道的，
     * 同步欄位只能先給樂觀值，UI 要等 probe() 才有資格說「可用」。
     */
    probe(): Promise<TtsProbe>;
    /** 念一句話；Promise 在念完（或失敗、被取消）時 resolve */
    speak(text: string, options?: TtsSpeakOptions): Promise<void>;
    /** 打斷目前所有語音（急件插播用） */
    cancelAll(): void;
    /** 目前有沒有在念 */
    readonly speaking: boolean;
    /** 可選的語音清單（實作不支援就回空陣列） */
    listVoices(): TtsVoice[];
}

export interface TtsVoice {
    uri: string;
    name: string;
    lang: string;
}
