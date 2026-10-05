import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModeSwitch, type LoginMode } from './mode-switch';
import * as styles from './mode-switch.css';

afterEach(() => { vi.unstubAllGlobals(); });

const mount = async (value: LoginMode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onChange = vi.fn();
    const focus = { account: vi.fn(), apikey: vi.fn() };
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(createElement(ModeSwitch, { value, onChange }), {
            createNodeMock: (el) => ({ focus: (el.props as { id?: string }).id === 'login-tab-account' ? focus.account : focus.apikey }),
        });
    });
    const tab = (mode: LoginMode) => view.root.findByProps({ id: `login-tab-${mode}` });
    const press = (mode: LoginMode, key: string) => {
        const preventDefault = vi.fn();
        act(() => tab(mode).props.onKeyDown({ key, preventDefault }));
        return preventDefault;
    };
    const thumb = () => view.root.find((n) => n.type === 'span' && n.props['aria-hidden'] === 'true');
    return { view, onChange, focus, tab, press, thumb };
};

describe('ModeSwitch', () => {
    it('marks the selected tab and keeps only it in the tab order', async () => {
        const { tab, thumb } = await mount('account');
        expect(tab('account').props['aria-selected']).toBe(true);
        expect(tab('account').props.tabIndex).toBe(0);
        expect(tab('apikey').props['aria-selected']).toBe(false);
        expect(tab('apikey').props.tabIndex).toBe(-1);
        expect(tab('apikey').props['aria-controls']).toBe('login-panel-apikey');
        expect(thumb().props.className).toBe(styles.thumb.account);
    });

    it('slides the thumb under the selected tab', async () => {
        const { tab, thumb } = await mount('apikey');
        expect(thumb().props.className).toBe(styles.thumb.apikey);
        expect(tab('apikey').props.tabIndex).toBe(0);
    });

    it.each([
        ['ArrowRight', 'account', 'apikey'],
        ['End', 'account', 'apikey'],
        ['ArrowLeft', 'apikey', 'account'],
        ['Home', 'apikey', 'account'],
    ] as const)('%s moves the selection and focus', async (key, from, to) => {
        const { press, onChange, focus } = await mount(from);
        expect(press(from, key)).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledExactlyOnceWith(to);
        expect(focus[to]).toHaveBeenCalledOnce();
    });

    it('ignores other keys so Tab and Enter keep their default behaviour', async () => {
        const { press, onChange } = await mount('account');
        expect(press('account', 'Tab')).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('selects on click', async () => {
        const { tab, onChange } = await mount('account');
        act(() => tab('apikey').props.onClick());
        expect(onChange).toHaveBeenCalledExactlyOnceWith('apikey');
    });
});
