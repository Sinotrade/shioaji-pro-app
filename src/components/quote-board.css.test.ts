import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { BOARD_TIERS, RAIL_TIERS, STOCK_TIERS, type BoardTier } from '../lib/board-tier';
import { RAIL_CHARS, railCellsRem } from '../lib/day-range';

interface Rule { selector: string; declarations: Record<string, string>; conditions: string[] }
let rules: Rule[];
let classes: typeof import('./quote-board.css');

// 只解析編譯後的規則與條件，不模擬瀏覽器 specificity 或實際排版。
function parseRules(css: string, conditions: string[] = []): Rule[] {
    const result: Rule[] = [];
    let cursor = 0;
    while (cursor < css.length) {
        const open = css.indexOf('{', cursor);
        if (open < 0) break;
        let depth = 1;
        let close = open + 1;
        for (; close < css.length && depth; close++) {
            if (css[close] === '{') depth++;
            if (css[close] === '}') depth--;
        }
        const selector = css.slice(cursor, open).trim();
        const body = css.slice(open + 1, close - 1);
        if (selector.startsWith('@')) result.push(...parseRules(body, [...conditions, selector]));
        else result.push({ selector, conditions, declarations: Object.fromEntries(body.split(';').flatMap(part => {
            const colon = part.indexOf(':');
            return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
        })) });
        cursor = close;
    }
    return result;
}

beforeAll(async () => {
    const built = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [vanillaExtractPlugin({ identifiers: 'debug' })],
        build: { write: false, minify: false, cssCodeSplit: false, lib: {
            entry: path.resolve('src/components/quote-board.css.ts'), formats: ['es'],
        } },
    });
    const output = (Array.isArray(built) ? built : [built]).flatMap(bundle => 'output' in bundle ? bundle.output : []);
    const css = output.find(asset => asset.type === 'asset' && asset.fileName.endsWith('.css'));
    const js = output.find(asset => asset.type === 'chunk');
    if (!css || css.type !== 'asset' || !js || js.type !== 'chunk') throw new Error('看板 CSS 編譯沒有產出樣式或 class 對照');
    rules = parseRules(String(css.source).replace(/\/\*[\s\S]*?\*\//g, ''));
    classes = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`);
}, 60_000);

const dot = (className: string) => `.${className.split(' ')[0]}`;
function declaration(className: string, property: string) {
    const selectors = className.split(' ').map(value => `.${value}`);
    return rules.filter(rule => !rule.conditions.length && selectors.includes(rule.selector))
        .map(rule => rule.declarations[property]).filter(value => value !== undefined).at(-1);
}
function display(base: string, tier: BoardTier, child: string) {
    const target = `${dot(base)}[data-tier="${tier}"] ${dot(child)}`;
    return rules.filter(rule => !rule.conditions.length && rule.selector.split(',').some(selector =>
        selector.trim() === dot(child) || selector.trim() === target))
        .map(rule => rule.declarations.display).filter(value => value !== undefined).at(-1);
}
function expectHidden(base: string, child: string, tiers: readonly BoardTier[], hidden: readonly BoardTier[]) {
    for (const tier of tiers) {
        expect(display(base, tier, child), `${tier}: ${child}`).toBe(hidden.includes(tier) ? 'none' : declaration(child, 'display'));
    }
}

describe('編譯後的報價看板 CSS', () => {
    it('指數依階梯保留優先欄位，compact 與 strip 收起統計', () => {
        expectHidden(classes.boardIndex, classes.lowPriority, BOARD_TIERS, ['mid', 'inline', 'lean']);
        expectHidden(classes.boardIndex, classes.secondary, BOARD_TIERS, ['lean']);
        expectHidden(classes.boardIndex, classes.indexStats, BOARD_TIERS, ['compact', 'strip']);
    });

    it('個股依序收起停板、開盤、高低、量比，軌道另接管開盤', () => {
        const tiers = [...new Set([...STOCK_TIERS, ...RAIL_TIERS])];
        expectHidden(classes.boardStock, classes.stockLimit, tiers, ['mid', 'inline', 'lean']);
        expectHidden(classes.boardStock, classes.stockOpen, tiers, ['lean', 'rail', 'railMid', 'railLow']);
        expectHidden(classes.boardStock, classes.stockStats, tiers, ['compact', 'tight', 'strip']);
        expectHidden(classes.boardStock, classes.stockVolTagRatio, tiers, ['tight']);
    });

    it('所有價格字數都有 railMid 與 railLow 的開盤、高低容器門檻', () => {
        for (const chars of RAIL_CHARS) {
            for (const [child, cells] of [[classes.railOpen, 3], [classes.railHL, 2]] as const) {
                const found = rules.filter(rule => rule.conditions.some(condition => condition.startsWith('@container')) &&
                    rule.selector.includes(`[data-chars="${chars}"] > ${dot(child)}`));
                expect(found, `${chars} 字／${cells} 格`).toHaveLength(1);
                expect(found[0]!.selector).toContain(`${dot(classes.boardStock)}[data-tier="railMid"]`);
                expect(found[0]!.selector).toContain(`${dot(classes.boardStock)}[data-tier="railLow"]`);
                expect(found[0]!.declarations.display).toBe('none');
                const threshold = found[0]!.conditions.join().match(/max-width:\s*([\d.]+)rem/);
                expect(Number(threshold?.[1])).toBe(Number(railCellsRem(cells, chars).toFixed(2)));
            }
        }
    });

    it('容器門檻與編譯後的標籤、數字字級及格距一致', () => {
        const rem = (className: string, property: string) => {
            const value = declaration(className, property);
            expect(value).toMatch(/rem$/);
            return parseFloat(value!);
        };
        const label = rem(classes.pairLabel, 'font-size');
        const labelGap = rem(classes.railNumLabel, 'margin-right');
        const number = rem(classes.railNumbers, 'font-size');
        const cellGap = rem(classes.railCells, 'column-gap');
        for (const chars of RAIL_CHARS) {
            const cell = label + labelGap + chars * number * 0.6;
            expect(railCellsRem(3, chars)).toBeCloseTo(3 * cell + 2 * cellGap + 0.25);
        }
    });
});
