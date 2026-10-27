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
function media(name: string, query: string): ts.ObjectLiteralExpression {
    const rules = field(styleObject(name), '@media');
    expect(rules && ts.isObjectLiteralExpression(rules), `${name} media`).toBe(true);
    const rule = field(rules as ts.ObjectLiteralExpression, query);
    expect(rule && ts.isObjectLiteralExpression(rule), `${name} ${query}`).toBe(true);
    return rule as ts.ObjectLiteralExpression;
}
const narrow = (name: string) => media(name, '(max-width: 1050px)');
const cssText = (object: ts.ObjectLiteralExpression, name: string) => field(object, name)?.getText(source);

it('header 放不下時換行容納全部控制，窄版僅隱藏 spacer，未以裁切或橫捲掩蓋溢出', () => {
    // Wrapping only happens when a row does not fit, so a wide window keeps one row.
    expect(cssText(styleObject('header'), 'flexWrap')).toBe("'wrap'");
    expect(cssText(media('header', '(max-width: 1600px)'), 'gap')).toBe('vars.space.sm');
    expect(cssText(narrow('spacer'), 'display')).toBe("'none'");
    for (const name of ['overflow', 'overflowX']) expect(cssText(styleObject('header'), name)).toBeUndefined();
    for (const name of ['header', 'resetBtn', 'chip', 'killHeaderOn', 'simBadge', 'prodBadge']) {
        expect(cssText(styleObject(name), 'display')).not.toBe("'none'");
    }
    // Wide windows keep the original spacing and dimensions.
    expect(cssText(styleObject('header'), 'gap')).toBe('vars.space.md');
    expect(cssText(styleObject('resetBtn'), 'height')).toBe("'25px'");
});

it('品牌／build identity 與外部伺服器警示可折行，popover 維持按鈕錨定的桌面設計', () => {
    expect(cssText(narrow('logoBlock'), 'flexWrap')).toBe("'wrap'");
    expect(cssText(narrow('logoBlock'), 'maxWidth')).toBe("'100%'");
    expect(cssText(narrow('logoBlock'), 'minWidth')).toBe('0');
    expect(cssText(narrow('logoSub'), 'whiteSpace')).toBe("'normal'");
    expect(cssText(narrow('logoSub'), 'overflowWrap')).toBe("'anywhere'");
    expect(cssText(narrow('foreignChip'), 'flexWrap')).toBe("'wrap'");
    expect(cssText(narrow('foreignChip'), 'height')).toBe("'auto'");
    expect(cssText(narrow('foreignChip'), 'maxWidth')).toBe("'100%'");
    // Wrapped buttons keep their own anchor; useHeaderPopoverFit pulls the menu back on screen.
    expect(cssText(styleObject('settingsWrap'), 'position')).toBe("'relative'");
    expect(cssText(styleObject('popover'), 'right')).toBe('0');
    for (const name of ['settingsWrap', 'popover']) expect(field(styleObject(name), '@media')).toBeUndefined();
});
