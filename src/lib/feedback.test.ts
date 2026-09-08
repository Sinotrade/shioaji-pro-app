// src/lib/feedback.test.ts — 回報問題按鈕的純邏輯：占位符要 URL-encode、
// 沒占位符原樣回傳、未知值不能漏出 "null"/"undefined"、第一行格式與
// server-manager 的「複製診斷資訊」一致。

import { describe, expect, it } from 'vitest';
import {
    buildFeedbackUrl,
    formatDiagnostics,
    type FeedbackContext,
} from './feedback';

const ctx: FeedbackContext = {
    ver: '0.1.39',
    os: 'Windows x64',
    env: 'sim',
    tier: 'free',
    stream: 'LIVE',
    heartbeatAge: 3,
    rate: '12.4',
    serverVersion: 'v1.7.1',
    tokenHours: 11,
    apiBase: '',
};

describe('formatDiagnostics', () => {
    it('first line matches the server-manager copy format', () => {
        const [first] = formatDiagnostics(ctx).split('\n');
        expect(first).toBe('Shioaji Pro v0.1.39 · Windows x64');
    });

    it('renders unknowns as placeholders, never "null"/"undefined"', () => {
        const out = formatDiagnostics({
            ...ctx,
            ver: '',
            heartbeatAge: null,
            serverVersion: '',
            tokenHours: null,
            env: 'unknown',
        });
        expect(out).toContain('Shioaji Pro v?');
        expect(out).toContain('heartbeat: —');
        expect(out).toContain('server: — (unknown)');
        expect(out).toContain('token: —');
        expect(out).toContain('api: (same-origin)');
        expect(out).not.toMatch(/null|undefined/);
    });
});

describe('buildFeedbackUrl', () => {
    it('substitutes and URL-encodes every placeholder', () => {
        const url = buildFeedbackUrl(
            'https://f/x?ver={ver}&os={os}&env={env}&tier={tier}&d={diag}',
            ctx,
            'line1\nline 2 & more',
        );
        expect(url).toBe(
            'https://f/x?ver=0.1.39&os=Windows%20x64&env=sim&tier=free&d=line1%0Aline%202%20%26%20more',
        );
    });

    it('returns the template unchanged when it has no placeholders', () => {
        const t = 'https://docs.google.com/forms/d/e/abc/viewform';
        expect(buildFeedbackUrl(t, ctx, 'ignored')).toBe(t);
    });

    it('leaves unknown braces alone', () => {
        expect(buildFeedbackUrl('https://f/?x={nope}', ctx, '')).toBe(
            'https://f/?x={nope}',
        );
    });
});
