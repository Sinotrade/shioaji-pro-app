import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ panel: vi.fn(() => null), defaults: vi.fn() }));
vi.mock('../lib/features', () => ({
    agentModule: { Panel: mocks.panel, ensureDefaultProvider: mocks.defaults },
    useFeature: () => ({ enabled: true }),
    FEATURES: [],
}));
vi.mock('../lib/tauri', () => ({
    isTauri: true, pickCaFile: vi.fn(), pickEnvFile: vi.fn(), reloadWhenHealthy: vi.fn(),
    saveDesktopSettings: vi.fn(), serverStart: vi.fn(),
}));

import { OnboardingSetup } from './onboarding-setup';

describe('first-run guide runtime scope', () => {
    it('explicitly opts only the embedded guide into onboarding', () => {
        const html = renderToStaticMarkup(createElement(OnboardingSetup));
        expect(html).toContain('引導申請 API Key');
        expect(mocks.panel).toHaveBeenCalledWith({
            onboarding: true,
            initialPrompt: '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？',
            visibleTabs: ['chat', 'settings'],
        }, undefined);
        expect(mocks.defaults).toHaveBeenCalledWith('codex');
    });
});
