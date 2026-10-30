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
