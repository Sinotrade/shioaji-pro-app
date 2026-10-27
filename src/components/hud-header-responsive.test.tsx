import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

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
