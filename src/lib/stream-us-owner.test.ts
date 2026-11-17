// src/lib/stream-us-owner.test.ts — 美股 SSE 跟著串流擁有權：交出時關、
// 接手時替這個視窗已有的美股訂閱重新開（Codex review）

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    marks: [] as [string, string | undefined][], child: false, autoOwn: true,
    forget: vi.fn(),
    claim: null as null | (() => void), release: null as null | (() => void),
}));
vi.mock('./shared-stream', () => ({
    createSharedStream: (options: { onOwn: () => void; onRelease: () => void }) => {
        let owner = false;
        m.claim = () => { owner = true; options.onOwn(); };
        m.release = () => { owner = false; options.onRelease(); };
        if (m.autoOwn) m.claim();
        return { isOwner: () => owner, publish: vi.fn() };
    },
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: vi.fn() }));
vi.mock('./server-info-store', () => ({ forgetServerInfo: m.forget, knownServerInfo: () => ({ simulation: true }) }));
vi.mock('./startup-timing', () => ({ markStage: (s: string, d?: string) => m.marks.push([s, d]) }));
vi.mock('./window-role', () => ({ isChildWindow: () => m.child }));

type Listener = (event: { data: string }) => void;
class FakeEventSource {
    static all: FakeEventSource[] = [];
    listeners = new Map<string, Listener[]>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) { FakeEventSource.all.push(this); }
    addEventListener(name: string, l: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), l]); }
    close() { this.closed = true; }
    emit(name: string) { for (const l of this.listeners.get(name) ?? []) l({ data: '{}' }); }
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.all = [];
    m.marks = [];
    m.forget.mockClear();
    m.child = false;
    m.autoOwn = true;
    m.claim = null;
    m.release = null;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const usSources = () => FakeEventSource.all.filter(s => /us_(tick|bidask)/.test(s.url));
const openUs = () => usSources().filter(s => !s.closed);

it('closes the US SSEs when ownership moves away and re-opens them for existing holds', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    const release = stream.retainUsQuoteStreams();
    expect(openUs()).toHaveLength(2);

    m.release!();
    expect(openUs()).toHaveLength(0);
    // 非擁有者的重開計時也不會偷開
    vi.advanceTimersByTime(10_000);
    expect(openUs()).toHaveLength(0);

    m.claim!();
    expect(openUs()).toHaveLength(2);
    release();
    expect(openUs()).toHaveLength(0);
});

it('a follower holding US quotes opens nothing until it takes ownership', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    expect(usSources()).toHaveLength(0);
    m.claim!();
    expect(openUs()).toHaveLength(2);
});

it('taking ownership without US holds opens no US SSE', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.ensureStream();
    m.claim!();
    expect(usSources()).toHaveLength(0);
});
