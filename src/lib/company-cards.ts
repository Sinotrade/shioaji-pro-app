// src/lib/company-cards.ts — shioaji-data tw/cards reduced to what the
// panels group by: official industry, 細產業, primary chain and tier, main
// theme. Read once and shared (持股族群, 產業鏈資金流向's 細產業).
//
// Light on purpose: 產業鏈資金流向 imports it without the trading state.

import { useCallback, useEffect, useState } from 'react';
import { companyData } from './company-data';
import type { ChainTier } from './company-data/types';

export interface CardInfo {
    code: string;
    name: string;
    market: string;
    industry: string | null;
    industryCode: string | null;
    /** 細產業 (AI research taxonomy l3); null when the company is not researched. */
    subIndustry: string | null;
    chain: string | null;
    tier: ChainTier | null;
    mainTheme: string | null;
}

let cardsPromise: Promise<Map<string, CardInfo>> | null = null;

function loadCards(): Promise<Map<string, CardInfo>> {
    cardsPromise ??= companyData.getDataset('tw/cards').then(({ data }) => {
        const map = new Map<string, CardInfo>();
        for (const raw of data as Record<string, unknown>[]) {
            const code = typeof raw.code === 'string' ? raw.code : null;
            if (!code) continue;
            const ind = (raw.industry ?? {}) as Record<string, unknown>;
            const stage = (raw.chain_stage ?? null) as Record<string, unknown> | null;
            map.set(code, {
                code,
                name: typeof raw.name === 'string' ? raw.name : code,
                market: typeof raw.market === 'string' ? raw.market : 'twse',
                industry: typeof ind.l0_name === 'string' ? ind.l0_name : null,
                industryCode: typeof ind.l0_code === 'string' ? ind.l0_code : null,
                subIndustry: typeof ind.l3_name === 'string' ? ind.l3_name : null,
                chain: typeof raw.chain === 'string' ? raw.chain : null,
                tier: stage && typeof stage.tier === 'string' ? (stage.tier as ChainTier) : null,
                mainTheme: typeof raw.main_theme === 'string' ? raw.main_theme : null,
            });
        }
        return map;
    });
    cardsPromise.catch(() => {
        cardsPromise = null;
    });
    return cardsPromise;
}

export function useCards(enabled = true) {
    const [cards, setCards] = useState<Map<string, CardInfo> | null>(null);
    const [error, setError] = useState<string | null>(null);
    // bumped by retry(): a failed read clears the shared promise, so this reads again
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        loadCards().then(
            (m) => alive && setCards(m),
            (e) => alive && setError(e instanceof Error ? e.message : String(e)),
        );
        return () => {
            alive = false;
        };
    }, [enabled, attempt]);
    const retry = useCallback(() => {
        setError(null);
        setAttempt((n) => n + 1);
    }, []);
    return { cards, error, retry };
}
