import { expect, it, vi } from 'vitest';
import { BroadcastQueue } from './broadcast-queue';
import type { TtsEngine } from '../tts';

function makeEngine() {
    const spoken: string[] = [];
    let speaking = false;
    let settle: (() => void) | null = null;
    const engine: TtsEngine = {
        id: 'fake',
        available: true,
        probe: async () => ({ available: true }),
        get speaking() {
            return speaking;
        },
        speak(text: string) {
            spoken.push(text);
            speaking = true;
            return new Promise<void>((resolve) => {
                settle = () => {
                    speaking = false;
                    settle = null;
                    resolve();
                };
            });
        },
        cancelAll() {
            settle?.();
        },
        listVoices: () => [],
    };
    return { engine, spoken, finish: () => settle?.() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

it('does not repeat the exact same sentence for one symbol', async () => {
    const { engine, spoken } = makeEngine();
    const queue = new BroadcastQueue(engine);
    queue.enqueue('台積電 1900.0', { symbolCode: '2330' });
    queue.enqueue('台積電 1900.0', { symbolCode: '2330' });
    expect(spoken).toEqual(['台積電 1900.0']);
});

it('announces the same sentence for different symbols', async () => {
    const { engine, spoken, finish } = makeEngine();
    const queue = new BroadcastQueue(engine);
    queue.enqueue('漲停', { symbolCode: '2330' });
    queue.enqueue('漲停', { symbolCode: '2317' });
    // 語音是序列的：第二句排在第一句後面
    expect(spoken).toEqual(['漲停']);
    finish();
    await flush();
    expect(spoken).toEqual(['漲停', '漲停']);
});

it('一句發聲失敗不會讓後面的句子停擺（失敗要記錄，不可靜默吞掉）', async () => {
    const spoken: string[] = [];
    const engine: TtsEngine = {
        id: 'fake-failing',
        available: true,
        probe: async () => ({ available: true }),
        get speaking() {
            return false;
        },
        speak(text: string) {
            spoken.push(text);
            // 模擬 Web Speech 的 onerror（例如被系統打斷）
            return text.includes('失敗')
                ? Promise.reject(new Error('interrupted'))
                : Promise.resolve();
        },
        cancelAll() {},
        listVoices: () => [],
    };
    const queue = new BroadcastQueue(engine);
    queue.enqueue('這句會失敗', { symbolCode: '2330' });
    queue.enqueue('這句要念出來', { symbolCode: '2317' });
    await flush();
    await flush();
    await flush();
    expect(spoken).toEqual(['這句會失敗', '這句要念出來']);
});

it('被過時丟棄的句子不會讓下一次同句話被誤擋（去重記憶不可記錄未念出的句子）', async () => {
    const spoken: string[] = [];
    // 用物件持有器而不是 let：TS 的控制流分析看不到 Promise executor 內的
    // 賦值，`let release: (() => void) | null` 在呼叫端會被窄化成 null。
    const gate: { release: (() => void) | null } = { release: null };
    const engine: TtsEngine = {
        id: 'fake-blocking',
        available: true,
        probe: async () => ({ available: true }),
        get speaking() {
            return gate.release !== null;
        },
        speak(text: string) {
            spoken.push(text);
            return new Promise<void>((resolve) => {
                gate.release = () => {
                    gate.release = null;
                    resolve();
                };
            });
        },
        cancelAll() {},
        listVoices: () => [],
    };
    let now = 0;
    const queue = new BroadcastQueue(engine, () => now, 10_000);

    queue.enqueue('第一句', { symbolCode: 'X' }); // pump 開始念，卡住
    await flush();
    queue.enqueue('第二句', { symbolCode: 'Y' }); // 排隊中，且被寫進去重記憶
    now = 20_000; // 放置超過 10 秒
    gate.release?.();
    await flush();
    await flush();
    expect(spoken).toEqual(['第一句']); // 「第二句」被過時丟棄

    // 重新排「從未真正念過」的第二句 → 必須念出來
    now = 21_000;
    queue.enqueue('第二句', { symbolCode: 'Y' });
    gate.release?.();
    await flush();
    expect(spoken).toContain('第二句');
});

it('drops a queued announcement that went stale while waiting', async () => {
    let now = 0;
    const { engine, spoken, finish } = makeEngine();
    const queue = new BroadcastQueue(engine, () => now);
    queue.enqueue('第一句', { symbolCode: '2330' });
    queue.enqueue('第二句', { symbolCode: '2317' });
    expect(spoken).toEqual(['第一句']);

    now = 11_000; // 排隊超過 10 秒 → 市場早就變了，不念
    finish();
    await flush();
    expect(spoken).toEqual(['第一句']);
});

it('interrupts the current speech and drops the backlog for an urgent message', async () => {
    const { engine, spoken } = makeEngine();
    const queue = new BroadcastQueue(engine);
    queue.enqueue('普通句', { symbolCode: '2330' });
    queue.enqueue('排隊句', { symbolCode: '2317' });
    expect(spoken).toEqual(['普通句']);

    queue.enqueue('急件', { symbolCode: '2330', interrupt: true });
    await flush();
    expect(spoken).toEqual(['普通句', '急件']);
});

it('keeps the dedup memory across an interrupt (same as WPF ClearQueue)', async () => {
    const { engine, spoken } = makeEngine();
    const queue = new BroadcastQueue(engine);
    queue.enqueue('台積電 1900.0', { symbolCode: '2330' });
    queue.enqueue('急件', { symbolCode: '2330', interrupt: true });
    await flush();
    expect(spoken).toEqual(['台積電 1900.0', '急件']);

    // 記憶還在 → 同一句話不會再念一次
    queue.enqueue('台積電 1900.0', { symbolCode: '2330' });
    await flush();
    expect(spoken).toEqual(['台積電 1900.0', '急件']);
});

it('ignores an empty announcement', () => {
    const { engine, spoken } = makeEngine();
    const queue = new BroadcastQueue(engine);
    queue.enqueue('   ', { symbolCode: '2330' });
    expect(spoken).toEqual([]);
});

it('reports a message when it starts speaking, not after it finishes', async () => {
    const { engine, spoken, finish } = makeEngine();
    const onSpeak = vi.fn();
    const queue = new BroadcastQueue(engine, Date.now, 10_000, onSpeak);
    queue.enqueue('台積電 1900.0，創新高', { symbolCode: '2330' });
    // 還在念 → 面板已經要看到「現在正在播這一句」（時間戳 = 開始時間）
    expect(onSpeak).toHaveBeenCalledWith('台積電 1900.0，創新高', '2330');
    // 念完不會再回報一次
    finish();
    await flush();
    expect(onSpeak).toHaveBeenCalledTimes(1);
});

it('does not report a message that was dropped as stale', async () => {
    let now = 0;
    const { engine, spoken, finish } = makeEngine();
    const onSpeak = vi.fn();
    const queue = new BroadcastQueue(engine, () => now, 10_000, onSpeak);
    queue.enqueue('第一句', { symbolCode: '2330' });
    queue.enqueue('第二句', { symbolCode: '2317' });
    now = 11_000;
    finish();
    await flush();
    expect(spoken).toEqual(['第一句']);
    expect(onSpeak).toHaveBeenCalledTimes(1);
    expect(onSpeak).toHaveBeenCalledWith('第一句', '2330');
});

it('does not report a message that was dropped by an interrupt', async () => {
    const { engine, spoken } = makeEngine();
    const onSpeak = vi.fn();
    const queue = new BroadcastQueue(engine, Date.now, 10_000, onSpeak);
    queue.enqueue('普通句', { symbolCode: '2330' });
    queue.enqueue('排隊句', { symbolCode: '2317' });
    // 急件清掉排隊 → 排隊句從來沒被念過 → 不該出現在「最近播報」
    queue.enqueue('急件', { symbolCode: '2330', interrupt: true });
    await flush();
    expect(onSpeak).not.toHaveBeenCalledWith('排隊句', '2317');
    expect(onSpeak).toHaveBeenCalledWith('急件', '2330');
});
