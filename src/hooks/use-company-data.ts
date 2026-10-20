// src/hooks/use-company-data.ts — company panel data (#337) from the shared
// shioaji-data reader. The company file decides the panel state; financials,
// themes, market and sources are optional parts that degrade on their own.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
    companyData,
    companyDataErrorText,
    isCompanyDataError,
    type CompanyDataClient,
    type CompanyDataErrorCode,
    type DataMeta,
} from '../lib/company-data';
import type {
    Company,
    Entity,
    Financials,
    MarketDaily,
    Sources,
    Theme,
} from '../lib/company-data/types';

export interface CompanyDataView {
    code: string;
    company: Company;
    meta: DataMeta;
    financials: Financials | null;
    financialsMeta: DataMeta | null;
    /** Text when financials failed for a reason other than "not listed". */
    financialsError: string | null;
    themes: Theme[] | null;
    market: MarketDaily | null;
    sources: Sources | null;
}

export type CompanyDataState =
    | { phase: 'loading'; code: string }
    | { phase: 'error'; code: string; error: string; errorCode: CompanyDataErrorCode | null }
    | ({ phase: 'ready'; refreshing: boolean } & CompanyDataView);

async function optional<T>(promise: Promise<{ data: T; meta: DataMeta }>) {
    try {
        const { data, meta } = await promise;
        return { data, meta, error: null as unknown };
    } catch (error) {
        return { data: null, meta: null, error };
    }
}

export async function loadCompanyView(client: CompanyDataClient, code: string): Promise<CompanyDataView> {
    const [company, financials, themes, market, sources] = await Promise.all([
        client.getCompany(code),
        optional(client.getFinancials(code)),
        optional(client.getThemes()),
        optional(client.getMarket()),
        optional(client.getSources()),
    ]);
    const financialsMissing = isCompanyDataError(financials.error) && financials.error.code === 'not_found';
    return {
        code,
        company: company.data,
        meta: company.meta,
        financials: financials.data,
        financialsMeta: financials.meta,
        financialsError: financials.error && !financialsMissing ? companyDataErrorText(financials.error) : null,
        themes: themes.data,
        market: market.data,
        sources: sources.data,
    };
}

export function useCompanyData(code: string | null, client: CompanyDataClient = companyData) {
    const [state, setState] = useState<CompanyDataState | null>(null);
    const [generation, setGeneration] = useState(0);
    const status = useSyncExternalStore(client.subscribeStatus, client.getStatus);

    useEffect(() => {
        if (!code) {
            setState(null);
            return;
        }
        let active = true;
        setState((prev) =>
            prev && prev.phase === 'ready' && prev.code === code
                ? { ...prev, refreshing: true }
                : { phase: 'loading', code },
        );
        const run = async () => {
            if (generation > 0) await client.getManifest({ force: true }).catch(() => undefined);
            return loadCompanyView(client, code);
        };
        run().then(
            (view) => {
                if (active) setState({ phase: 'ready', refreshing: false, ...view });
            },
            (error: unknown) => {
                if (!active) return;
                setState({
                    phase: 'error',
                    code,
                    error: companyDataErrorText(error),
                    errorCode: isCompanyDataError(error) ? error.code : null,
                });
            },
        );
        return () => {
            active = false;
        };
    }, [client, code, generation]);

    const refresh = useCallback(() => setGeneration((g) => g + 1), []);
    return { state: state && state.code === code ? state : code ? ({ phase: 'loading', code } as const) : null, status, refresh };
}

/** Entity index for the relations list (names, exchange for live quotes). */
export function useCompanyEntities(enabled: boolean, client: CompanyDataClient = companyData) {
    const [entities, setEntities] = useState<Entity[] | null>(null);
    useEffect(() => {
        if (!enabled || entities) return;
        let active = true;
        client.getEntities().then(
            ({ data }) => {
                if (active) setEntities(data);
            },
            () => undefined,
        );
        return () => {
            active = false;
        };
    }, [client, enabled, entities]);
    return entities;
}
