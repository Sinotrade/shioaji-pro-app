export interface EtfNameEntry {
    readonly code: string;
    readonly exchange: 'TSE' | 'OTC';
    readonly name: string;
    readonly aliases?: readonly string[];
}
export interface EtfNameSource {
    readonly exchange: 'TSE' | 'OTC';
    readonly url: string;
    readonly dataDate: string | null;
    readonly count: number;
}
export interface EtfNameCatalog {
    readonly schemaVersion: 1;
    readonly retrievedAt: string;
    readonly sources: readonly EtfNameSource[];
    readonly entries: readonly EtfNameEntry[];
}
export const ETF_SOURCES: Readonly<{
    TSE: 'https://openapi.twse.com.tw/v1/opendata/t187ap47_L';
    OTC: 'https://info.tpex.org.tw/api/etfFilter';
    TSE_NAMES: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
}>;
export function buildEtfCatalog(
    tsePayload: unknown, otcPayload: unknown, retrievedAt: string, dailyPayload: unknown,
    previous?: EtfNameCatalog,
): EtfNameCatalog;
