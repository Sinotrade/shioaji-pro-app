// src/lib/tts/index.ts — engine 取得入口。
//
// 上層只 import 這裡，不要直接 import web-speech-engine：
// 未來要接原生引擎（Tauri Rust 端：Windows WinRT / macOS AVSpeechSynthesizer /
// Linux speech-dispatcher）時，選擇 engine 的邏輯集中在這一個檔案換掉即可，
// 播報上層與 UI 完全不用動。

import type { TtsEngine } from './tts-engine';
import { createWebSpeechEngine } from './web-speech-engine';

export type { TtsEngine, TtsProbe, TtsSpeakOptions, TtsVoice } from './tts-engine';

let engine: TtsEngine | null = null;

/** 單例 engine：整個 app 共用一個語音出口，避免多個 queue 互相搶話。 */
export function getTtsEngine(): TtsEngine {
    if (!engine) engine = createWebSpeechEngine();
    return engine;
}
