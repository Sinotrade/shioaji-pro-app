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

it('renders label, code and name in truncation-priority order with a full tooltip', () => {
    const r = render({ title: '閃電下單', symbolCode: 'NSFJ6', symbolName: '頎邦期貨 202610' });
    const spans = r.root.findAllByType('span');
    const label = spans.find((s) => s.props.className === styles.symbolLabel)!;
    const code = spans.find((s) => s.props.className === styles.symbolCode)!;
    const name = spans.find((s) => s.props.className === styles.symbolName)!;
    expect(text(label)).toBe('閃電下單');
    expect(text(code)).toBe('NSFJ6');
    expect(text(name)).toBe('頎邦期貨 202610');
    expect(spans.indexOf(label)).toBeLessThan(spans.indexOf(code));
    expect(spans.indexOf(code)).toBeLessThan(spans.indexOf(name));
    // truncated parts stay readable on hover
    expect(name.props.title).toBe('閃電下單 · NSFJ6 · 頎邦期貨 202610');
    expect(label.props.title).toBe('閃電下單 · NSFJ6 · 頎邦期貨 202610');
});

it('omits code/name elements when there is no contract or no name', () => {
    const none = render({ title: '持倉/委託/帳務' });
    // symbol-less panels keep the plain ellipsis title (never hidden when narrow)
    expect(none.root.findAll((n) => n.props.className === styles.titleText)).toHaveLength(1);
    expect(none.root.findAll((n) => n.props.className === styles.symbolCode)).toHaveLength(0);
    expect(none.root.findAll((n) => n.props.className === styles.symbolName)).toHaveLength(0);

    for (const symbolName of [undefined, null, '']) {
        const r = render({ title: '閃電下單', symbolCode: 'TXFR1', symbolName });
        expect(r.root.findAll((n) => n.props.className === styles.symbolCode)).toHaveLength(1);
        expect(r.root.findAll((n) => n.props.className === styles.symbolName)).toHaveLength(0);
    }
});

it('pinned panels show the name instead of repeating the code already in the pin input', () => {
    const r = render({
        title: '閃電下單',
        symbolCode: 'NSFJ6',
        symbolName: '頎邦期貨 202610',
        pinnable: true,
        pin: 'NSFJ6',
        onPinChange: () => undefined,
    });
    expect(r.root.findAll((n) => n.props.className === styles.symbolCode)).toHaveLength(0);
    const name = r.root.find((n) => n.props.className === styles.symbolName);
    expect(text(name)).toBe('頎邦期貨 202610');
    expect(name.props.title).toBe('閃電下單 · NSFJ6 · 頎邦期貨 202610');
    const input = r.root.findByType('input');
    expect(input.props.value).toBe('NSFJ6');
});
