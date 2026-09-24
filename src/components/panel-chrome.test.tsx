// src/components/panel-chrome.test.tsx — #125 標題列顯示商品代碼＋名稱

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { PanelChrome } from './panel-chrome';
import * as styles from './panel-chrome.css';

function render(props: Parameters<typeof PanelChrome>[0]) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(PanelChrome, props));
    });
    return r;
}

const text = (n: { children: unknown[] }) => n.children.join('');
const byClass = (r: ReactTestRenderer, cls: string) =>
    r.root.findAll((n) => n.type === 'span' && n.props.className === cls);
const names = (r: ReactTestRenderer) => [
    ...byClass(r, styles.symbolName.afterCode),
    ...byClass(r, styles.symbolName.afterLabel),
];
const bar = (r: ReactTestRenderer) =>
    r.root.find((n) => n.type === 'div' && n.props['data-controls'] !== undefined);

const pinnedProps = {
    title: '閃電下單',
    symbolCode: 'NSFJ6',
    symbolName: '頎邦期貨 202610',
    pinnable: true,
    pin: 'NSFJ6',
    onPinChange: () => undefined,
};

it('renders label, code and name in order with a full tooltip', () => {
    const r = render({ title: '閃電下單', symbolCode: 'NSFJ6', symbolName: '頎邦期貨 202610' });
    const spans = r.root.findAllByType('span');
    const [label] = byClass(r, styles.symbolLabel);
    const [code] = byClass(r, styles.symbolCode);
    const [name] = byClass(r, styles.symbolName.afterCode);
    expect(text(label!)).toBe('閃電下單');
    expect(text(code!)).toBe('NSFJ6');
    expect(text(name!)).toBe('頎邦期貨 202610');
    expect(spans.indexOf(label!)).toBeLessThan(spans.indexOf(code!));
    expect(spans.indexOf(code!)).toBeLessThan(spans.indexOf(name!));
    // name lives in its own wrap box so it drops out instead of a lone ellipsis
    expect(byClass(r, styles.nameBox)).toHaveLength(1);
    expect(name!.props.title).toBe('閃電下單 · NSFJ6 · 頎邦期貨 202610');
    expect(label!.props.title).toBe('閃電下單 · NSFJ6 · 頎邦期貨 202610');
    expect(bar(r).props['data-controls']).toBe('none');
});

it('omits code/name elements when there is no contract or no name', () => {
    const none = render({ title: '持倉/委託/帳務' });
    // symbol-less panels keep the plain ellipsis title (never hidden when narrow)
    expect(byClass(none, styles.titleText)).toHaveLength(1);
    expect(byClass(none, styles.symbolCode)).toHaveLength(0);
    expect(names(none)).toHaveLength(0);

    for (const symbolName of [undefined, null, '']) {
        const r = render({ title: '閃電下單', symbolCode: 'TXFR1', symbolName });
        expect(byClass(r, styles.symbolCode)).toHaveLength(1);
        expect(names(r)).toHaveLength(0);
    }
});

it('linked panels mark their control set for the width thresholds', () => {
    const r = render({ ...pinnedProps, pin: null });
    expect(bar(r).props['data-controls']).toBe('linked');
    expect(byClass(r, styles.symbolCode)).toHaveLength(1);
});

it('pinned panels show "label · name" instead of repeating the code in the pin input', () => {
    const r = render(pinnedProps);
    expect(bar(r).props['data-controls']).toBe('pinned');
    expect(byClass(r, styles.symbolCode)).toHaveLength(0);
    const [name] = byClass(r, styles.symbolName.afterLabel);
    expect(text(name!)).toBe('頎邦期貨 202610');
    expect(r.root.findByType('input').props.value).toBe('NSFJ6');
});

it('hides the old name while a new code is being typed into the pin input', () => {
    const r = render(pinnedProps);
    const input = r.root.findByType('input');
    act(() => input.props.onChange({ target: { value: 'txfr' } }));
    expect(names(r)).toHaveLength(0);
    // typing back the same code (any case / padding) shows it again
    act(() => input.props.onChange({ target: { value: ' nsfj6 ' } }));
    expect(names(r)).toHaveLength(1);
});
