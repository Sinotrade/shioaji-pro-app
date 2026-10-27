import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Workspace } from '../lib/workspace';

const mocks = vi.hoisted(() => ({ locked: false, setRisk: vi.fn(), fetchInfo: vi.fn() }));
vi.mock('../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../lib/header-items', () => ({ useHeaderItems: () => ({ liveStatus: true, layoutLibrary: true, flashAll: true, clock: true }) }));
vi.mock('../lib/risk', () => ({ useRiskSettings: () => ({ locked: mocks.locked }), setRiskSettings: mocks.setRisk }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: mocks.fetchInfo }));
vi.mock('../lib/privacy', () => ({ usePrivacyMoney: () => false, maskMoney: (value: string) => value }));
vi.mock('../lib/tauri', () => ({
    appVersion: async () => 'dev · 4203ad5+dirty', checkForUpdates: vi.fn(),
    listenTrayEvents: async () => () => undefined, openFlashTiles: vi.fn(),
}));
vi.mock('../lib/flash-account', () => ({ flashPopoutParams: vi.fn(), reseedPopoutFlashAccounts: vi.fn() }));
vi.mock('../lib/order-account', () => ({ mainFlashSelection: vi.fn() }));
vi.mock('../lib/server-adoption', () => ({ useServerAttachment: () => ({ kind: 'none' }), externalServerLabel: () => '' }));
vi.mock('./market-bar', () => ({ MarketBar: () => null }));
vi.mock('./layout-library', () => ({ LayoutLibrary: () => null }));
vi.mock('./settings-dialog', () => ({ SettingsDialog: ({ open }: { open: boolean }) => open ? createElement('div', { role: 'dialog', 'aria-label': '設定' }) : null }));
vi.mock('./foreign-server-chip', () => ({ ForeignServerChip: () => createElement('span', { className: styles.foreignChip, role: 'status' }, '未連上另一個程式的伺服器', createElement('button', {}, '啟動本 App 的伺服器')) }));
vi.mock('./server-manager', () => ({ ServerManager: ({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) => createElement('div', { className: styles.settingsWrap }, createElement('button', { onClick: () => onToggle(!open) }, '伺服器'), open ? createElement('div', { className: styles.popover, style: { width: '19rem' }, role: 'dialog', 'aria-label': '伺服器' }) : null) }));

import { HudHeader } from './hud-header';
import * as styles from './hud-header.css';

const source = ts.createSourceFile('hud-header.css.ts', readFileSync(new URL('./hud-header.css.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function styleObject(name: string): ts.ObjectLiteralExpression {
    let result: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
            const argument = node.initializer.arguments[0];
            if (argument && ts.isObjectLiteralExpression(argument)) result = argument;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    expect(result, name).toBeDefined();
    return result!;
}
function field(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const property = object.properties.find((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
        && (ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(source)) === name);
    return property?.initializer;
}
function narrow(name: string): ts.ObjectLiteralExpression {
    const media = field(styleObject(name), '@media');
    expect(media && ts.isObjectLiteralExpression(media), `${name} media`).toBe(true);
    const rule = field(media as ts.ObjectLiteralExpression, '(max-width: 1050px)');
    expect(rule && ts.isObjectLiteralExpression(rule), `${name} narrow`).toBe(true);
    return rule as ts.ObjectLiteralExpression;
}
const cssText = (object: ts.ObjectLiteralExpression, name: string) => field(object, name)?.getText(source);

it('窄版 header 換行容納全部控制，僅隱藏 spacer，未以裁切或橫捲掩蓋溢出', () => {
    expect(cssText(narrow('header'), 'flexWrap')).toBe("'wrap'");
    expect(cssText(narrow('header'), 'gap')).toBe('vars.space.sm');
    expect(cssText(narrow('header'), 'minWidth')).toBe('0');
    expect(cssText(narrow('spacer'), 'display')).toBe("'none'");
    for (const name of ['overflow', 'overflowX']) expect(cssText(narrow('header'), name)).toBeUndefined();
    for (const name of ['header', 'resetBtn', 'chip', 'killHeaderOn', 'simBadge', 'prodBadge']) {
        expect(cssText(styleObject(name), 'display')).not.toBe("'none'");
    }
    // Desktop keeps the original single-row layout and dimensions.
    expect(cssText(styleObject('header'), 'flexWrap')).toBeUndefined();
    expect(cssText(styleObject('header'), 'gap')).toBe('vars.space.md');
    expect(cssText(styleObject('resetBtn'), 'height')).toBe("'25px'");
});

it('品牌／build identity 與外部伺服器警示可折行，窄版 popover 錨整個 header 並受 viewport 限寬', () => {
    expect(cssText(narrow('logoBlock'), 'flexWrap')).toBe("'wrap'");
    expect(cssText(narrow('logoBlock'), 'maxWidth')).toBe("'100%'");
    expect(cssText(narrow('logoBlock'), 'minWidth')).toBe('0');
    expect(cssText(narrow('logoSub'), 'whiteSpace')).toBe("'normal'");
    expect(cssText(narrow('logoSub'), 'overflowWrap')).toBe("'anywhere'");
    expect(cssText(narrow('foreignChip'), 'flexWrap')).toBe("'wrap'");
    expect(cssText(narrow('foreignChip'), 'height')).toBe("'auto'");
    expect(cssText(narrow('foreignChip'), 'maxWidth')).toBe("'100%'");
    expect(cssText(narrow('header'), 'position')).toBe("'relative'");
    expect(cssText(narrow('settingsWrap'), 'position')).toBe("'static'");
    expect(cssText(narrow('popover'), 'left')).toBeUndefined();
    expect(cssText(narrow('popover'), 'width')).toBeUndefined();
    expect(cssText(narrow('popover'), 'right')).toBe('8');
    expect(cssText(narrow('popover'), 'boxSizing')).toBe("'border-box'");
    expect(cssText(narrow('popover'), 'maxWidth')).toBe("'calc(100vw - 16px)'");
});

const views: ReactTestRenderer[] = [];
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
beforeEach(() => {
    vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.setRisk.mockClear(); mocks.fetchInfo.mockResolvedValue({ simulation: true });
});
afterEach(() => {
    for (const view of views.splice(0)) act(() => view.unmount());
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it.each([false, true])('真 HudHeader 保留 build identity、LIVE 與全部控制（風控 locked=%s），操作仍走原接線', async locked => {
    mocks.locked = locked;
    const addPanel = vi.fn();
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(createElement(HudHeader, {
            onOpenPanelLibrary: addPanel, profiles: [], currentWorkspace: {} as Workspace,
            onSaveProfile: vi.fn(), onLoadProfile: vi.fn(), onDeleteProfile: vi.fn(), onRenameProfile: vi.fn(),
            onResetWorkspace: vi.fn(), onLoadPreset: vi.fn(), flashCodes: ['2330'],
        }));
    });
    views.push(view);
    const button = (label: string) => view.root.findAllByType('button').find(node => text(node).trim() === label)!;
    for (const label of ['伺服器', locked ? '風控鎖定' : '風控', '＋ 新增面板', '版面', '全開', '設定']) {
        expect(button(label), label).toBeDefined();
        expect(button(label).props.disabled).not.toBe(true);
    }
    expect(text(view.root)).toContain('LIVE');
    expect(text(view.root)).toContain('App dev · 4203ad5+dirty');
    expect(text(view.root)).toContain('模擬環境');
    act(() => button(locked ? '風控鎖定' : '風控').props.onClick());
    expect(mocks.setRisk).toHaveBeenCalledExactlyOnceWith({ locked: !locked });
    act(() => button('＋ 新增面板').props.onClick());
    expect(addPanel).toHaveBeenCalledTimes(1);
    act(() => button('設定').props.onClick());
    expect(view.root.findAllByProps({ role: 'dialog', 'aria-label': '設定' })).toHaveLength(1);
    act(() => button('伺服器').props.onClick());
    expect(view.root.findAllByProps({ role: 'dialog', 'aria-label': '伺服器' })).toHaveLength(1);
});
