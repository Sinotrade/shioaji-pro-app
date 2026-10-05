// steps-b 元件測試共用的 react-test-renderer 輔助（node 環境，沒有 jsdom）。
import type { ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { vi, type Mock } from 'vitest';

export function textOf(node: ReactTestInstance | ReactTestRenderer['root']): string {
    return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

export async function mount(element: ReactElement): Promise<ReactTestRenderer> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(element);
    });
    return view;
}

export const dump = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

export const buttonTexts = (view: ReactTestRenderer) =>
    view.root.findAllByType('button').map((button) => textOf(button));

export function buttonByText(view: ReactTestRenderer, text: string): ReactTestInstance {
    const found = view.root.findAllByType('button').filter((button) => textOf(button).includes(text));
    if (found.length !== 1) throw new Error(`expected exactly one button "${text}", got ${found.length}`);
    return found[0] as ReactTestInstance;
}

export function buttonByLabel(view: ReactTestRenderer, label: string): ReactTestInstance {
    return view.root.findByProps({ 'aria-label': label });
}

export const click = (node: ReactTestInstance) =>
    act(async () => {
        node.props.onClick({ preventDefault() {} });
    });

export const change = (node: ReactTestInstance, target: Record<string, unknown>) =>
    act(async () => {
        node.props.onChange({ target });
    });

/** window / history / navigator 的最小替身；回傳可檢查的 spy。 */
export interface BrowserStub {
    history: { pushState: Mock; state: unknown };
    win: EventTarget;
    writeText: Mock;
}

export function stubBrowser(): BrowserStub {
    const history = { pushState: vi.fn(), state: null as unknown };
    const win = Object.assign(new EventTarget(), { history });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    return { win, history, writeText };
}

/** Node 的 Event 沒有可寫的 returnValue，補一個，行為和瀏覽器的 BeforeUnloadEvent 一致。 */
export function beforeUnloadEvent() {
    const event = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(event, 'returnValue', { value: true, writable: true, configurable: true });
    return event;
}

export const keydownEvent = (key: string) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key });
