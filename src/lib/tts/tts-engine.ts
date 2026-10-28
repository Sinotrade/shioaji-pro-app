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
    /** 語速倍率（Web Speech 語意為 0.1~10）。映射由 engine 自行決定。 */
    rate?: number;
    /** 音量 0~1 */
    volume?: number;
    /** 指定 voice 的 uri；不給就用 engine 預設的中文語音 */
    voiceUri?: string;
}

export interface TtsEngine {
    /** engine 識別名（診斷 / log 用） */
    readonly id: string;
    /** 目前環境能不能用 */
    readonly available: boolean;
    /** 不能用時的原因，給 UI 直接顯示 */
    readonly reason?: string;
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
