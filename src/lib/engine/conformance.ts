// Golden conformance format and comparison rules. Any BacktestCore — the
// TypeScript core, the native Rust core or an independent reference
// implementation written from the specification — is checked against the same
// golden JSON files with these rules. The golden files themselves live with the
// closed-source cores; this module only defines their shape and how to compare.

import type {
    BacktestCore, CoreRequest, CoreResponse, PrepareRequest, PrepareResponse, SelectionRequest, SelectionResult,
} from './core';

export const GOLDEN_SCHEMA_VERSION = 'backtest-golden-v2';
/** Normative behaviour specification the expected outputs follow (#202). */
export const GOLDEN_SPEC_VERSION = 'backtest-spec-v2';

export type GoldenCategory =
    | 'signal'
    | 'stateful'
    | 'multi-asset'
    | 'costs'
    | 'rejections'
    | 'calendar'
    | 'validation'
    | 'metrics'
    | 'optimization'
    | 'prepare'
    | 'lookahead'
    | 'limit-lock';

/**
 * Where a case's inputs came from. Expected outputs are always the output of
 * the implementation that generated the file (see GoldenFile.generatedBy);
 * provenance says how much of that output was ever checked independently.
 * - hand-calculated: inputs of a fixture whose key numbers were derived by hand
 *   (listed in `handChecked`), not by an engine.
 * - behaviour-test: inputs of an existing behaviour test that asserts some
 *   properties (listed in `handChecked` when numeric).
 * - parity-fixture: inputs of a TS-vs-TS parity check (vector vs sequential);
 *   agreement between two TS paths, not an independent answer.
 * - derived: new inputs added for coverage; output is an unreviewed snapshot.
 * - reference-impl: inputs taken from the independent reference implementation's cases.
 */
export type GoldenProvenanceKind = 'hand-calculated' | 'behaviour-test' | 'parity-fixture' | 'derived' | 'reference-impl';

/**
 * Review state, maintained by QA (#202). `refimpl-agreed`: the independent
 * reference implementation of backtest-spec-v2 reproduces `expected` under
 * GOLDEN_TOLERANCE; any case where it does not keeps another state and says
 * why in `note`.
 */
export type GoldenVerification = 'unverified' | 'independently-verified' | 'refimpl-agreed' | 'disputed';

export interface GoldenProvenance {
    kind: GoldenProvenanceKind;
    /** Test file and test name (or generator) the inputs were taken from. */
    source: string;
    /** Result paths whose expected values were checked by hand in `source`. */
    handChecked: string[];
    verification: GoldenVerification;
    note: string | null;
}

export interface GoldenRunCase {
    kind: 'run';
    id: string;
    title: string;
    categories: GoldenCategory[];
    provenance: GoldenProvenance;
    request: CoreRequest;
    expected: CoreResponse;
}

export interface GoldenSelectionCase {
    kind: 'selection';
    id: string;
    title: string;
    categories: GoldenCategory[];
    provenance: GoldenProvenance;
    request: SelectionRequest;
    expected: SelectionResult;
}

/** A request whose strategy is a source (the core's own script step, spec §8). */
export interface GoldenScriptCase extends Omit<GoldenRunCase, 'kind'> {
    kind: 'script';
}

/** An L1 data preparation case (spec §4). */
export interface GoldenPrepareCase {
    kind: 'prepare';
    id: string;
    title: string;
    categories: GoldenCategory[];
    provenance: GoldenProvenance;
    request: PrepareRequest;
    expected: PrepareResponse;
}

export type GoldenCase = GoldenRunCase | GoldenScriptCase | GoldenPrepareCase | GoldenSelectionCase;

export interface GoldenFile {
    schemaVersion: typeof GOLDEN_SCHEMA_VERSION;
    specVersion: typeof GOLDEN_SPEC_VERSION;
    /** Implementation id/version whose output became `expected`. */
    generatedBy: string;
    cases: GoldenCase[];
}

/**
 * Numeric comparison rules. Keys are the final property name of a value's
 * path (array indices are ignored). Integers-by-meaning compare exactly;
 * ratios to `ratioDecimals`; every other number (money, prices, PnL) to
 * `moneyDecimals`. "N decimals" means |actual − expected| < 0.5 × 10^−N,
 * the same rule as Vitest `toBeCloseTo(expected, N)`. A value directly inside
 * a record keyed by ids (`mapKeys`) is classified by the record's key, so
 * `equity[i].positions.A` is exact. Strings, booleans,
 * nulls, key sets and array lengths compare exactly.
 */
export const GOLDEN_TOLERANCE = Object.freeze({
    moneyDecimals: 9,
    ratioDecimals: 12,
    exactKeys: Object.freeze([
        'time', 'entryTime', 'exitTime', 'decisionTime', 'index', 'sourceIndex', 'sourceIndices',
        'quantity', 'qty', 'targetQuantity', 'roundedQuantity', 'lotSize', 'fills', 'trades', 'wins',
        'bars', 'barsHeld', 'positions', 'ranking', 'minTrades', 'seed', 'count', 'pyramiding',
        'params', 'space', 'quantities', 'orderTarget', 'periodsPerYear', 'minutes',
    ]),
    /** Records keyed by asset id / parameter name: their direct values use the record's own key. */
    mapKeys: Object.freeze(['positions', 'sourceIndices', 'availability', 'params', 'space', 'quantities',
        'attribution', 'tagAttribution', 'bars', 'vectors', 'assetOverrides']),
    ratioKeys: Object.freeze([
        'returnPct', 'maxDrawdownPct', 'exposure', 'winRate', 'weight', 'pnlPct', 'annualizedReturnPct',
        'sharpe', 'sortino', 'costToGrossProfit', 'turnover', 'profitFactor', 'buyAndHoldReturnPct',
        'averageHoldingBars', 'generalizationGap', 'sensitivity', 'fraction', 'maxGrossLeverage',
        'maxNetLeverage',
    ]),
});

export interface GoldenMismatch {
    path: string;
    expected: unknown;
    actual: unknown;
    rule: 'type' | 'keys' | 'length' | 'exact' | `decimals-${number}`;
}

const exactKeys = new Set<string>(GOLDEN_TOLERANCE.exactKeys);
const ratioKeys = new Set<string>(GOLDEN_TOLERANCE.ratioKeys);
const mapKeys = new Set<string>(GOLDEN_TOLERANCE.mapKeys);

function kindOf(value: unknown): string {
    return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** Deep comparison under GOLDEN_TOLERANCE; returns every mismatch (empty = pass). */
export function compareGoldenValue(actual: unknown, expected: unknown, path = '$', key = '',
    mapValue = false): GoldenMismatch[] {
    if (kindOf(actual) !== kindOf(expected)) return [{ path, expected, actual, rule: 'type' }];
    if (typeof expected === 'number') {
        const a = actual as number;
        if (exactKeys.has(key)) return Object.is(a, expected) || a === expected ? []
            : [{ path, expected, actual, rule: 'exact' }];
        const decimals = ratioKeys.has(key) ? GOLDEN_TOLERANCE.ratioDecimals : GOLDEN_TOLERANCE.moneyDecimals;
        return Math.abs(a - expected) < 0.5 * 10 ** -decimals ? []
            : [{ path, expected, actual, rule: `decimals-${decimals}` }];
    }
    if (Array.isArray(expected)) {
        const a = actual as unknown[];
        if (a.length !== expected.length) return [{ path, expected: expected.length, actual: a.length, rule: 'length' }];
        return expected.flatMap((item, index) => compareGoldenValue(a[index], item, `${path}[${index}]`, key, mapValue));
    }
    if (expected !== null && typeof expected === 'object') {
        const a = actual as Record<string, unknown>;
        const e = expected as Record<string, unknown>;
        const expectedKeys = Object.keys(e).sort();
        const actualKeys = Object.keys(a).sort();
        if (expectedKeys.join('\u0000') !== actualKeys.join('\u0000')) {
            return [{ path, expected: expectedKeys, actual: actualKeys, rule: 'keys' }];
        }
        // Values of an id-keyed record take the record's key; their own properties use their names.
        const record = mapKeys.has(key) && !mapValue;
        return expectedKeys.flatMap((name) => compareGoldenValue(a[name], e[name], `${path}.${name}`,
            record ? key : name, record));
    }
    return actual === expected ? [] : [{ path, expected, actual, rule: 'exact' }];
}

export interface GoldenCaseReport {
    id: string;
    passed: boolean;
    mismatches: GoldenMismatch[];
}

/** Runs one golden case against a core; the response crosses a JSON boundary first. */
export async function checkGoldenCase(core: BacktestCore, testCase: GoldenCase): Promise<GoldenCaseReport> {
    const response = async (): Promise<unknown> => {
        switch (testCase.kind) {
            case 'run': case 'script': return core.run(structuredClone(testCase.request));
            case 'selection': return core.selectCandidates(structuredClone(testCase.request));
            case 'prepare':
                if (!core.prepare) throw new Error(`core ${core.id} has no prepare step`);
                return core.prepare(structuredClone(testCase.request));
        }
    };
    const actual = JSON.parse(JSON.stringify(await response())) as unknown;
    const mismatches = compareGoldenValue(actual, testCase.expected);
    return { id: testCase.id, passed: mismatches.length === 0, mismatches };
}

export async function checkGoldenFile(core: BacktestCore, file: GoldenFile): Promise<GoldenCaseReport[]> {
    if (file.schemaVersion !== GOLDEN_SCHEMA_VERSION) throw new Error(`unsupported golden schema ${file.schemaVersion}`);
    const reports: GoldenCaseReport[] = [];
    for (const testCase of file.cases) reports.push(await checkGoldenCase(core, testCase));
    return reports;
}
