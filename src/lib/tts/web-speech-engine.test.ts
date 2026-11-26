import { expect, it } from 'vitest';
import { createWebSpeechEngine, rateToSpeed } from './web-speech-engine';

it('maps the abstract rate scale (-10~20) onto the Web Speech speed', () => {
    expect(rateToSpeed(0)).toBeCloseTo(1);
    expect(rateToSpeed(4)).toBeCloseTo(1.4);
    expect(rateToSpeed(10)).toBeCloseTo(2); // 舊上限：2.0 倍（既有設定值不受影響）
    expect(rateToSpeed(20)).toBeCloseTo(3); // 新上限：3.0 倍
    expect(rateToSpeed(-10)).toBeCloseTo(0.1);
});

it('clamps out-of-range rates instead of passing them through', () => {
    expect(rateToSpeed(99)).toBeCloseTo(3);
    expect(rateToSpeed(-99)).toBeCloseTo(0.1);
});

it('keeps the speed inside the range the Web Speech API accepts', () => {
    for (let rate = -20; rate <= 20; rate++) {
        const speed = rateToSpeed(rate);
        expect(speed).toBeGreaterThanOrEqual(0.1);
        expect(speed).toBeLessThanOrEqual(3);
    }
});

it('notifies subscribers when the voice list arrives late (Chromium / WebView2)', () => {
    // 桌面版（WebView2 158 實測）首次 getVoices() 回空陣列，之後才發 voiceschanged。
    // 面板若只讀一次清單，「語音選擇」就永遠不會出現 —— 這個測試鎖住訂閱行為。
    const listeners = new Map<string, () => void>();
    let voices: { voiceURI: string; name: string; lang: string }[] = [];
    const synth = {
        getVoices: () => voices,
        addEventListener: (type: string, cb: () => void) => {
            listeners.set(type, cb);
        },
        speak: () => {},
        cancel: () => {},
        speaking: false,
        paused: false,
    };
    // 這個 repo 的測試跑在 node 環境（未安裝 jsdom），因此直接注入 globalThis.window
    const g = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in g;
    const originalWindow = g.window;
    g.window = {
        speechSynthesis: synth,
        SpeechSynthesisUtterance: class {
            constructor(public text: string) {}
            rate = 1;
        },
    };

    try {
        const engine = createWebSpeechEngine();
        const seen: string[][] = [];
        const unsubscribe =
            engine.subscribeVoices?.((list) => {
                seen.push(list.map((v) => v.name));
            }) ?? (() => {});

        // 訂閱當下就回呼一次（此時系統還沒載入語音）
        expect(seen).toEqual([[]]);

        voices = [{ voiceURI: 'hanhan', name: 'Microsoft Hanhan', lang: 'zh-TW' }];
        listeners.get('voiceschanged')?.();
        expect(seen.at(-1)).toEqual(['Microsoft Hanhan']);

        // 解除訂閱後不再更新
        unsubscribe();
        voices = [{ voiceURI: 'yating', name: 'Microsoft Yating', lang: 'zh-TW' }];
        listeners.get('voiceschanged')?.();
        expect(seen.at(-1)).toEqual(['Microsoft Hanhan']);
    } finally {
        if (hadWindow) g.window = originalWindow;
        else delete g.window;
    }
});
