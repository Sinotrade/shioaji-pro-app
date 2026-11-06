import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerEnvNotice, WebServerHint } from './server-env-notice';

describe('server env notices', () => {
    let view: ReactTestRenderer;
    afterEach(async () => { await act(async () => view.unmount()); vi.unstubAllGlobals(); });
    const render = async (node: ReturnType<typeof createElement>) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        await act(async () => { view = create(node); });
    };
    it('opens the server panel from the main-screen notice', async () => {
        const onOpen = vi.fn();
        await render(createElement(ServerEnvNotice, { notice: { tone: 'action', text: '設定已儲存，請按「啟動」套用' }, onOpen }));
        expect(JSON.stringify(view.toJSON())).toContain('請按「啟動」套用');
        await act(async () => view.root.findByType('button').props.onClick());
        expect(onOpen).toHaveBeenCalledOnce();
    });
    it('tells a Web user that the server has to be restarted by hand, only while LOST', async () => {
        await render(createElement(WebServerHint, { status: 'down' }));
        expect(JSON.stringify(view.toJSON())).toContain('請重新啟動 Shioaji server');
        for (const status of ['live', 'connecting', 'stale'] as const) {
            await act(async () => view.update(createElement(WebServerHint, { status })));
            expect(view.toJSON()).toBeNull();
        }
    });
    it('keeps the Web hint through reconnect attempts until the stream is LIVE again', async () => {
        await render(createElement(WebServerHint, { status: 'connecting' }));
        expect(view.toJSON()).toBeNull();
        await act(async () => view.update(createElement(WebServerHint, { status: 'down' })));
        for (const status of ['connecting', 'down', 'stale', 'connecting'] as const) {
            await act(async () => view.update(createElement(WebServerHint, { status })));
            expect(JSON.stringify(view.toJSON())).toContain('請重新啟動 Shioaji server');
        }
        await act(async () => view.update(createElement(WebServerHint, { status: 'live' })));
        expect(view.toJSON()).toBeNull();
    });
});
