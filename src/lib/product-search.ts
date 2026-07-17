import {
    fetchFutures,
    fetchFuturesRoots,
    fetchOptionRoots,
    fetchOptions,
    fetchWarrants,
    normalizeContractCode,
    resolveContract,
} from './shioaji';
import {
    loadStockCatalog,
    searchStocks,
    SECTOR_INDICES,
} from './stock-index';
import { todayStr } from './utils/date';
import type {
    ContractInfo,
    SecurityType,
} from './types/contract';

export interface ProductSuggestion {
    code: string;
    name: string;
    security_type: Exclude<SecurityType, null>;
    exchange: string;
    detail: string;
    contract?: ContractInfo;
}

let rootsLoading:
    | Promise<{
          futures: Awaited<ReturnType<typeof fetchFuturesRoots>>;
          options: Awaited<ReturnType<typeof fetchOptionRoots>>;
      }>
    | null = null;

function loadRoots() {
    if (!rootsLoading) {
        rootsLoading = Promise.all([
            fetchFuturesRoots(),
            fetchOptionRoots(),
        ])
            .then(([futures, options]) => ({ futures, options }))
            .catch((error) => {
                rootsLoading = null;
                throw error;
            });
    }
    return rootsLoading;
}

function asSuggestion(
    contract: ContractInfo,
    detail?: string,
): ProductSuggestion {
    return {
        code: contract.code,
        name: contract.name || contract.code,
        security_type: (contract.security_type ?? 'STK') as Exclude<
            SecurityType,
            null
        >,
        exchange: contract.exchange ?? '',
        detail:
            detail ??
            contract.spec_kind ??
            contract.root ??
            contract.security_type ??
            '',
        contract,
    };
}

function derivativeSort(a: ContractInfo, b: ContractInfo) {
    const aliasA = /R[12]$/.test(a.code) ? 0 : 1;
    const aliasB = /R[12]$/.test(b.code) ? 0 : 1;
    return (
        aliasA - aliasB ||
        (a.delivery_month ?? '').localeCompare(b.delivery_month ?? '') ||
        a.code.localeCompare(b.code)
    );
}

function normalizeSearchText(value: string) {
    return value.trim().replace(/臺/g, '台').toUpperCase();
}

function findRoot(
    roots: { root: string; name: string }[],
    lookup: string,
    raw: string,
) {
    const normalizedLookup = normalizeSearchText(lookup);
    const normalizedRaw = normalizeSearchText(raw);
    return roots
        .filter((root) => {
            const code = normalizeSearchText(root.root);
            const name = normalizeSearchText(root.name);
            return code === normalizedLookup || name.includes(normalizedLookup);
        })
        .sort((a, b) => {
            const exactA = normalizeSearchText(a.name) === normalizedRaw ? 0 : 1;
            const exactB = normalizeSearchText(b.name) === normalizedRaw ? 0 : 1;
            return exactA - exactB || a.name.length - b.name.length;
        })[0];
}

export async function searchProducts(
    rawQuery: string,
    limit = 10,
    options: { includeWarrants?: boolean } = {},
): Promise<ProductSuggestion[]> {
    const raw = rawQuery.trim();
    if (!raw) return [];
    const warrantQuery = /(?:權證|warrant)/i.test(raw);
    if (warrantQuery && options.includeWarrants !== true) return [];
    const wantsWarrants = options.includeWarrants === true && warrantQuery;
    const wantsFutures =
        /(?:期貨|個股期|future)/i.test(raw) || /期$/.test(raw);
    const wantsOptions = /(?:選擇權|option)/i.test(raw);
    const query = raw
        .replace(/(?:權證|warrant|期貨|個股期|future|選擇權|option)/gi, '')
        .replace(/期$/, '')
        .trim();
    const lookup = query || raw;

    const [catalog, roots] = await Promise.all([
        loadStockCatalog(),
        loadRoots(),
    ]);
    const stockMatches = searchStocks(catalog, lookup, limit);
    const exactStock =
        stockMatches.find(
            (stock) =>
                stock.code.toUpperCase() === lookup.toUpperCase() ||
                stock.name === lookup,
        ) ?? stockMatches[0];
    const results: ProductSuggestion[] = stockMatches.map((stock) => ({
        code: stock.code,
        name: stock.name,
        security_type: 'STK',
        exchange: stock.exchange,
        detail: stock.category ? `股票 · ${stock.category}` : '股票',
    }));

    const normalized = raw.toUpperCase();
    if (/^[A-Z0-9]+$/.test(normalized)) {
        const canonicalIndex = normalizeContractCode(normalized, 'IND');
        const direct = await resolveContract(
            canonicalIndex,
            canonicalIndex !== normalized ? 'IND' : undefined,
        ).catch(() => null);
        if (
            direct &&
            (direct.security_type !== 'WRT' || options.includeWarrants)
        ) {
            results.unshift(asSuggestion(direct, '直接代碼'));
        }
    }

    if (exactStock && (wantsFutures || /期$/.test(raw))) {
        const futures = await fetchFutures({
            underlyingCode: exactStock.code,
        }).catch((): ContractInfo[] => []);
        results.unshift(
            ...[...futures]
                .sort(derivativeSort)
                .slice(0, 6)
                .map((contract) =>
                    asSuggestion(
                        contract,
                        contract.code.endsWith('R1')
                            ? '個股期 · 近月'
                            : contract.code.endsWith('R2')
                              ? '個股期 · 次月'
                              : `個股期 · ${contract.delivery_month ?? ''}`,
                    ),
                ),
        );
    }

    if (exactStock && wantsWarrants) {
        const warrants = await fetchWarrants(exactStock.code, {
            expiryFrom: todayStr(),
        }).catch(
            (): ContractInfo[] => [],
        );
        results.unshift(
            ...[...warrants]
                .filter((contract) => contract.name)
                .sort(
                    (a, b) =>
                        (a.expiry_date ?? '').localeCompare(
                            b.expiry_date ?? '',
                        ) || a.code.localeCompare(b.code),
                )
                .slice(0, 8)
                .map((contract) =>
                    asSuggestion(
                        contract,
                        `${contract.call_put === 'P' ? '認售' : '認購'} · ${contract.expiry_date ?? ''}`,
                    ),
                ),
        );
    }

    const matchingFutureRoot = findRoot(roots.futures, lookup, raw);
    if (matchingFutureRoot && (wantsFutures || !exactStock)) {
        const futures = await fetchFutures({
            root: matchingFutureRoot.root,
        }).catch((): ContractInfo[] => []);
        results.unshift(
            ...[...futures]
                .sort(derivativeSort)
                .slice(0, 6)
                .map((contract) => asSuggestion(contract, '期貨')),
        );
    }

    const matchingOptionRoot = findRoot(roots.options, lookup, raw);
    if (matchingOptionRoot && wantsOptions) {
        const options = await fetchOptions(matchingOptionRoot.root).catch(
            (): ContractInfo[] => [],
        );
        const frontMonth = options
            .map((contract) => contract.delivery_month)
            .filter((month): month is string => !!month)
            .sort()[0];
        results.unshift(
            ...[...options]
                .filter(
                    (contract) =>
                        !frontMonth || contract.delivery_month === frontMonth,
                )
                .sort(
                    (a, b) =>
                        (a.strike_price ?? 0) - (b.strike_price ?? 0),
                )
                .slice(0, 8)
                .map((contract) => asSuggestion(contract, '選擇權')),
        );
    }

    const indexMatches = [
        {
            code: 'IX0001',
            name: '發行量加權股價指數',
            category: '',
        },
        ...SECTOR_INDICES.map((index) => ({
            code: index.index,
            name: `${index.label}類指數`,
            category: index.category,
        })),
    ].filter(
        (index) =>
            index.code.startsWith(
                normalizeContractCode(normalized, 'IND'),
            ) || index.name.includes(lookup),
    );
    results.push(
        ...indexMatches.map((index) => ({
            code: index.code,
            name: index.name,
            security_type: 'IND' as const,
            exchange: 'TSE',
            detail: '指數',
        })),
    );

    const seen = new Set<string>();
    return results.filter((item) => {
        const key = `${item.security_type}:${item.code}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, limit);
}
