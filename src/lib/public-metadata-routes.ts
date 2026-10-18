// Fixed same-origin name-only routes; never accept a caller-supplied upstream URL.
export const ETF_SOURCE_ROUTES = Object.freeze({
    tseFunds: '/metadata/etf/tse-funds',
    otcFunds: '/metadata/etf/otc-funds',
    tseNames: '/metadata/etf/tse-names',
} as const);

export const EQUITY_SOURCE_ROUTES = Object.freeze({
    tseCompanies: '/metadata/equity/tse-companies',
    otcCompanies: '/metadata/equity/otc-companies',
    oesCompanies: '/metadata/equity/oes-companies',
} as const);

export const EQUITY_SOURCES = Object.freeze({
    TSE: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    OTC: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    OES: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R',
});

export type PublicMetadataRoute = typeof ETF_SOURCE_ROUTES[keyof typeof ETF_SOURCE_ROUTES]
    | typeof EQUITY_SOURCE_ROUTES[keyof typeof EQUITY_SOURCE_ROUTES];
