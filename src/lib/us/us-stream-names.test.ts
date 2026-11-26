// SDK 1.8.0（shioaji MR !525）美股串流改名：新名稱優先，舊 sidecar（1.8.0b1–b3）404 退回舊名稱
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    get: vi.fn(), post: vi.fn(), base: 'http://a.invalid',
    info: null as null | object, infoListener: null as null | (() => void),
}));
vi.mock('../api', () => ({ apiGet: m.get, apiPost: m.post }));
vi.mock('../runtime', () => ({ getApiBase: () => m.base }));
vi.mock('../server-info-store', () => ({
    knownServerInfo: () => m.info,
    subscribeServerInfo: (l: () => void) => { m.infoListener = l; return () => {}; },
}));

import {
    isNotFoundError, noteUsStreamNames, postUsStreamAction, probeUsStreamPath, resetUsStreamNamesForTest,
    usStreamDataPath, usStreamEventNames, usStreamKindOfEvent, usStreamName, usStreamUsesLegacyNames,
} from './us-stream-names';

const notFound = () => Object.assign(new Error('404 Not Found'), { status: 404 });

afterEach(() => { resetUsStreamNamesForTest(); vi.resetAllMocks(); m.base = 'http://a.invalid'; m.info = null; });

describe('US stream names', () => {
    it('recognises both the 1.8.0 and the legacy event names', () => {
        expect(usStreamKindOfEvent('tick_stk_us')).toBe('tick');
        expect(usStreamKindOfEvent('us_tick')).toBe('tick');
        expect(usStreamKindOfEvent('bidask_stk_us')).toBe('bidask');
        expect(usStreamKindOfEvent('us_bidask')).toBe('bidask');
        expect(usStreamKindOfEvent('halt_stk_us')).toBe('halt');
        expect(usStreamKindOfEvent('us_halt')).toBe('halt');
        expect(usStreamKindOfEvent('tick_stk')).toBeNull();
        expect(usStreamKindOfEvent('us_halts')).toBeNull();
        expect(usStreamEventNames('tick')).toEqual(['tick_stk_us', 'us_tick']);
    });

    it('prefers the new names and remembers legacy per API base', () => {
        expect(usStreamDataPath('tick')).toBe('/api/v1/stream/data/tick_stk_us');
        expect(usStreamDataPath('bidask')).toBe('/api/v1/stream/data/bidask_stk_us');
        expect(usStreamDataPath('halt')).toBe('/api/v1/stream/data/halt_stk_us');
        noteUsStreamNames('http://a.invalid', true);
        expect(usStreamDataPath('tick')).toBe('/api/v1/stream/data/us_tick');
        expect(usStreamName('halt')).toBe('us_halt');
        // 其他 sidecar 不受影響
        expect(usStreamName('tick', 'http://b.invalid')).toBe('tick_stk_us');
    });

    it('forgets the legacy record when /info is cleared (sidecar may have restarted)', () => {
        noteUsStreamNames('http://a.invalid', true);
        m.info = { version: '1.8.0' };
        m.infoListener?.();
        expect(usStreamUsesLegacyNames()).toBe(true);
        m.info = null;
        m.infoListener?.();
        expect(usStreamUsesLegacyNames()).toBe(false);
    });

    it('detects a 404 from either the status field or the message', () => {
        expect(isNotFoundError(notFound())).toBe(true);
        expect(isNotFoundError(new Error('404 Not Found'))).toBe(true);
        // POST 未知的 subscribe/<name>：salvo 回 405
        expect(isNotFoundError(Object.assign(new Error('405 Method Not Allowed'), { status: 405 }))).toBe(true);
        expect(isNotFoundError(Object.assign(new Error('400 bad'), { status: 400 }))).toBe(false);
        expect(isNotFoundError(new TypeError('Failed to fetch'))).toBe(false);
        expect(isNotFoundError(undefined)).toBe(false);
    });
});

describe('postUsStreamAction', () => {
    it('posts the new path on a 1.8.0 sidecar', async () => {
        m.post.mockResolvedValue({ success: true });
        await expect(postUsStreamAction('subscribe', 'halt', {})).resolves.toEqual({ success: true });
        expect(m.post).toHaveBeenCalledTimes(1);
        expect(m.post).toHaveBeenCalledWith('/api/v1/stream/subscribe/halt_stk_us', {});
        expect(usStreamUsesLegacyNames()).toBe(false);
    });

    it('falls back to the legacy path on 404 and goes there directly afterwards', async () => {
        m.post.mockImplementation(async (path: string) => {
            if (path.endsWith('halt_stk_us')) throw notFound();
            return { success: true };
        });
        await postUsStreamAction('subscribe', 'halt', {});
        expect(m.post.mock.calls.map(c => c[0])).toEqual([
            '/api/v1/stream/subscribe/halt_stk_us', '/api/v1/stream/subscribe/us_halt',
        ]);
        expect(usStreamUsesLegacyNames()).toBe(true);
        m.post.mockClear();
        await postUsStreamAction('unsubscribe', 'halt', {});
        expect(m.post.mock.calls.map(c => c[0])).toEqual(['/api/v1/stream/unsubscribe/us_halt']);
    });

    it('treats a 405 on the new subscribe path as unknown (salvo answer for an unrouted POST)', async () => {
        m.post.mockImplementation(async (path: string) => {
            if (path.endsWith('halt_stk_us')) throw Object.assign(new Error('405 Method Not Allowed'), { status: 405 });
            return { success: true };
        });
        await postUsStreamAction('subscribe', 'halt', {});
        expect(m.post.mock.calls.map(c => c[0])).toEqual([
            '/api/v1/stream/subscribe/halt_stk_us', '/api/v1/stream/subscribe/us_halt',
        ]);
        expect(usStreamUsesLegacyNames()).toBe(true);
    });

    it('switches back to the new names when a remembered legacy path 404s', async () => {
        noteUsStreamNames('http://a.invalid', true);
        m.post.mockImplementation(async (path: string) => {
            if (path.endsWith('us_halt')) throw notFound();
            return { success: true };
        });
        await postUsStreamAction('subscribe', 'halt', {});
        expect(m.post.mock.calls.map(c => c[0])).toEqual([
            '/api/v1/stream/subscribe/us_halt', '/api/v1/stream/subscribe/halt_stk_us',
        ]);
        expect(usStreamUsesLegacyNames()).toBe(false);
    });

    it('rethrows other errors without falling back', async () => {
        m.post.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
        await expect(postUsStreamAction('subscribe', 'halt', {})).rejects.toThrow('401');
        expect(m.post).toHaveBeenCalledTimes(1);
        expect(usStreamUsesLegacyNames()).toBe(false);
    });

    it('does not record anything when both paths 404', async () => {
        m.post.mockRejectedValue(notFound());
        await expect(postUsStreamAction('subscribe', 'halt', {})).rejects.toThrow('404');
        expect(usStreamUsesLegacyNames()).toBe(false);
    });
});

describe('probeUsStreamPath', () => {
    it('switches to the legacy names when the new SSE path 404s', async () => {
        m.get.mockRejectedValue(notFound());
        await expect(probeUsStreamPath('tick')).resolves.toBe(true);
        expect(m.get).toHaveBeenCalledWith('/api/v1/stream/data/tick_stk_us', expect.objectContaining({ signal: expect.anything() }));
        expect(usStreamDataPath('tick')).toBe('/api/v1/stream/data/us_tick');
    });

    it('keeps the names when the probe fails for another reason', async () => {
        m.get.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(probeUsStreamPath('bidask')).resolves.toBe(false);
        expect(usStreamUsesLegacyNames()).toBe(false);
    });

    it('ignores a 404 that arrives after the API base changed', async () => {
        m.get.mockImplementation(async () => { m.base = 'http://b.invalid'; throw notFound(); });
        await expect(probeUsStreamPath('tick', 'http://a.invalid')).resolves.toBe(false);
        expect(usStreamUsesLegacyNames('http://a.invalid')).toBe(false);
    });
});
