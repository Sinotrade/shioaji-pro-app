import type { QuoteState } from './stream';
import type { ContractInfo } from './types/contract';
import type { ScannerItem, Snapshot } from './types/market';

export type QuoteDirection = 'up' | 'down' | 'flat';
export type QuoteSource = 'tick' | 'index' | 'snapshot' | 'contract' | 'scanner' | 'none';

export interface NormalizedQuote {
    code: string;
    source: QuoteSource;
    price: number | null;
    reference: number | null;
    change: number | null;
    changePercent: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    amount: number | null;
    time: string | null;
    direction: QuoteDirection;
}

export function finiteNumber(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function positiveNumber(value: unknown): number | null {
    const n = finiteNumber(value);
    return n !== null && n > 0 ? n : null;
}

function firstNumber(...values: unknown[]): number | null {
    for (const value of values) {
        const n = finiteNumber(value);
        if (n !== null) return n;
    }
    return null;
}

function firstPositive(...values: unknown[]): number | null {
    for (const value of values) {
        const n = positiveNumber(value);
        if (n !== null) return n;
    }
    return null;
}

function directionFromChange(change: number | null): QuoteDirection {
    if (change === null || change === 0) return 'flat';
    return change > 0 ? 'up' : 'down';
}

function pctFrom(change: number | null, reference: number | null): number | null {
    return change !== null && reference !== null && reference > 0
        ? (change / reference) * 100
        : null;
}

function referenceFromPriceChange(
    price: number | null,
    change: number | null,
): number | null {
    if (price === null || change === null) return null;
    const reference = price - change;
    return reference > 0 && Number.isFinite(reference) ? reference : null;
}

function snapshotReference(snapshot?: Snapshot): number | null {
    if (!snapshot) return null;
    return referenceFromPriceChange(
        positiveNumber(snapshot.close),
        finiteNumber(snapshot.change_price),
    );
}

export function normalizeQuoteState(
    quote?: QuoteState,
    snapshot?: Snapshot,
    contract?: ContractInfo,
): NormalizedQuote {
    const tick = quote?.tick;
    const index = quote?.index;
    const code =
        tick?.code ??
        index?.code ??
        snapshot?.code ??
        contract?.code ??
        '';

    if (index) {
        const price = firstPositive(index.close, snapshot?.close);
        const explicitChange = firstNumber(
            index.change_price,
            snapshot?.change_price,
        );
        const reference = firstPositive(
            index.reference,
            referenceFromPriceChange(price, explicitChange),
            snapshotReference(snapshot),
            contract?.reference,
        );
        const change =
            explicitChange ??
            (price !== null && reference !== null ? price - reference : null);
        return {
            code,
            source: 'index',
            price,
            reference,
            change,
            changePercent: pctFrom(change, reference),
            open: firstPositive(index.open, snapshot?.open),
            high: firstPositive(index.high, snapshot?.high),
            low: firstPositive(index.low, snapshot?.low),
            volume: firstNumber(index.vol_sum, index.volume, snapshot?.total_volume),
            amount: firstNumber(
                index.amount_sum,
                index.amount,
                snapshot?.total_amount,
            ),
            time: index.time || index.datetime || snapshot?.datetime || null,
            direction: directionFromChange(change),
        };
    }

    if (tick) {
        const price = firstPositive(tick.close, snapshot?.close);
        const explicitChange = finiteNumber(tick.price_chg);
        const reference = firstPositive(
            referenceFromPriceChange(price, explicitChange),
            snapshotReference(snapshot),
            contract?.reference,
        );
        const change =
            explicitChange ??
            (price !== null && reference !== null ? price - reference : null);
        return {
            code,
            source: 'tick',
            price,
            reference,
            change,
            changePercent: pctFrom(change, reference),
            open: firstPositive(tick.open, snapshot?.open),
            high: firstPositive(tick.high, snapshot?.high),
            low: firstPositive(tick.low, snapshot?.low),
            volume: firstNumber(tick.total_volume, tick.volume, snapshot?.total_volume),
            amount: firstNumber(tick.total_amount, tick.amount, snapshot?.total_amount),
            time: tick.time || snapshot?.datetime || null,
            direction: directionFromChange(change),
        };
    }

    if (snapshot) {
        const price = positiveNumber(snapshot.close);
        const change = finiteNumber(snapshot.change_price);
        const reference = firstPositive(
            snapshotReference(snapshot),
            contract?.reference,
        );
        return {
            code,
            source: 'snapshot',
            price,
            reference,
            change,
            changePercent: pctFrom(change, reference),
            open: positiveNumber(snapshot.open),
            high: positiveNumber(snapshot.high),
            low: positiveNumber(snapshot.low),
            volume: firstNumber(snapshot.total_volume, snapshot.volume),
            amount: firstNumber(snapshot.total_amount, snapshot.amount),
            time: snapshot.datetime || null,
            direction: directionFromChange(change),
        };
    }

    return {
        code,
        source: contract ? 'contract' : 'none',
        price: null,
        reference: positiveNumber(contract?.reference),
        change: null,
        changePercent: null,
        open: null,
        high: null,
        low: null,
        volume: null,
        amount: null,
        time: null,
        direction: 'flat',
    };
}

export function normalizeScannerItem(item: ScannerItem): NormalizedQuote {
    const price = positiveNumber(item.close);
    const change = finiteNumber(item.change_price);
    const reference = referenceFromPriceChange(price, change);
    const explicitPercent = finiteNumber(item.change_rate);
    return {
        code: item.code,
        source: 'scanner',
        price,
        reference,
        change,
        changePercent: explicitPercent ?? pctFrom(change, reference),
        open: positiveNumber(item.open),
        high: positiveNumber(item.high),
        low: positiveNumber(item.low),
        volume: firstNumber(item.total_volume),
        amount: firstNumber(item.total_amount),
        time: item.date || null,
        direction: directionFromChange(change),
    };
}

export function quoteSortPercent(
    quote?: QuoteState,
    snapshot?: Snapshot,
    contract?: ContractInfo,
): number {
    return normalizeQuoteState(quote, snapshot, contract).changePercent ?? 0;
}
