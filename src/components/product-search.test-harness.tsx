// 命令面板與自選搜尋的元件測試共用：render、輸入與列查詢
//
// 各測試檔自己 vi.mock 搜尋核心與串流；這裡只組裝兩個入口與讀取 DOM。

import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { expect, vi, type Mock } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';
import { PRODUCT_SEARCH_DEBOUNCE_MS } from '../lib/search-request';
import { CommandPalette } from './command-palette';
import { Watchlist } from './watchlist';

export type SurfaceKind = 'palette' | 'watchlist';
export const kinds = [{ kind: 'palette' as const }, { kind: 'watchlist' as const }];
export const DEBOUNCE = PRODUCT_SEARCH_DEBOUNCE_MS;
/** Result limit each surface asks the search core for. */
export const searchLimit = (kind: SurfaceKind) => (kind === 'palette' ? 8 : 10);
/** Options each surface passes the search core; only the palette subscribes to partial rows. */
export const searchOptionsFor = (kind: SurfaceKind) => expect.objectContaining({
    includeWarrants: true, signal: expect.any(AbortSignal), ...(kind === 'palette' ? { onUpdate: expect.any(Function) } : {}),
});

export const stock: ProductSuggestion = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票' };
export const future: ProductSuggestion = { code: 'CDFR1', name: '台積電期貨', security_type: 'FUT', exchange: 'TAIFEX', detail: '近月' };
export const warrant: ProductSuggestion = { code: '200001', name: '台積電測試購', security_type: 'WRT', exchange: 'TSE', detail: '認購' };

export function text(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(text).join('');
}

/** Host children, looking through components such as the shared option row. */
export function hostChildren(node: ReactTestInstance): (ReactTestInstance | string)[] {
    return node.children.flatMap((child) => (typeof child === 'string' || typeof child.type === 'string' ? [child] : hostChildren(child)));
}

export type WatchlistProps = Parameters<typeof Watchlist>[0];

export function watchlistProps(onAdd: WatchlistProps['onAdd'], overrides: Partial<WatchlistProps> = {}): WatchlistProps {
    return {
        items: [], selectedCode: null, onSelect: vi.fn(), onAdd, onRemove: vi.fn(), onReorder: vi.fn(),
        serverLists: [{ id: 'fixture', name: '測試', contracts: [] }], activeListId: 'fixture',
        onSelectList: vi.fn(), onCreateList: vi.fn(async () => undefined), onRenameList: vi.fn(async () => true),
        onDeleteList: vi.fn(async () => undefined), loading: false, structureBusy: false, loadError: false, onRetryLoad: vi.fn(),
        ...overrides,
    };
}

const mounted: ReactTestRenderer[] = [];

/** Unmount every view rendered since the last call; for afterEach. */
export function unmountAll() {
    for (const view of mounted.splice(0)) act(() => view.unmount());
}

/** Forget a view a test already unmounted itself. */
export function forget(view: ReactTestRenderer) {
    const index = mounted.indexOf(view);
    if (index >= 0) mounted.splice(index, 1);
}

export interface RenderedSurface {
    view: ReactTestRenderer;
    /** onJump for the palette, onAdd for the watchlist. */
    submit: Mock<() => Promise<unknown>>;
    close: Mock;
    addPanel: Mock;
    watchProps: WatchlistProps;
}

export function render(kind: SurfaceKind, {
    withCommands = false,
    submitHandler = async () => undefined,
    watchOverrides = {},
    createNodeMock,
}: {
    withCommands?: boolean;
    submitHandler?: () => Promise<unknown>;
    watchOverrides?: Partial<WatchlistProps>;
    createNodeMock?: (element: ReactElement) => unknown;
} = {}): RenderedSurface {
    const submit = vi.fn(submitHandler);
    const close = vi.fn();
    const addPanel = vi.fn();
    const watchProps = watchlistProps(submit, watchOverrides);
    let view!: ReactTestRenderer;
    act(() => {
        view = create(kind === 'palette'
            ? createElement(CommandPalette, { open: true, onClose: close, onJump: submit, onAddPanel: withCommands ? addPanel : undefined })
            : createElement(Watchlist, watchProps), createNodeMock ? { createNodeMock } : undefined);
    });
    mounted.push(view);
    return { view, submit, close, addPanel, watchProps };
}

export const input = (view: ReactTestRenderer) => view.root.findByType('input');
export const key = (view: ReactTestRenderer, name: string) => input(view).props.onKeyDown({ key: name, preventDefault: vi.fn() });

/** Type a query and wait out the debounce. */
export async function type(view: ReactTestRenderer, value: string) {
    act(() => input(view).props.onChange({ target: { value } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
}

/** The palette closes from its frame, so Esc on any row or button also closes it. */
export function escape(view: ReactTestRenderer, kind: SurfaceKind, extra: Record<string, unknown> = {}) {
    const event = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    const frame = kind === 'palette'
        ? view.root.find((node) => node.type === 'div' && typeof node.props.onKeyDown === 'function')
        : input(view);
    frame.props.onKeyDown(event);
    return event;
}

export function row(view: ReactTestRenderer, value: string) {
    return view.root.findAllByType('button').find((node) => text(node).includes(value));
}
export const listbox = (view: ReactTestRenderer) => view.root.find((node) => typeof node.type === 'string' && node.props.role === 'listbox');
export const optionNodes = (view: ReactTestRenderer) => view.root.findAll((node) => typeof node.type === 'string' && node.props.role === 'option');
/** The keyboard row, which aria-selected marks. */
export const activeText = (view: ReactTestRenderer) => text(optionNodes(view).find((node) => node.props['aria-selected'])!);

// Code, name and meta sit in one display:contents element that carries the hover title.
export const rowText = (button: ReactTestInstance) => button.children[0] as ReactTestInstance;
export const rowParts = (button: ReactTestInstance) => rowText(button).children as ReactTestInstance[];
/** The code of a host option element, read from its props as createNodeMock sees them. */
export const rowCode = (props: Record<string, unknown>) =>
    (((props.children as ReactElement).props as { children: ReactElement[] }).children[0]!.props as { children: string }).children;
