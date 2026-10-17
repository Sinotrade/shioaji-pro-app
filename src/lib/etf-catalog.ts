import snapshot from './data/etf-catalog.json';

// Names are a versioned convenience index, not a trading contract catalog.
// Only live STK Base identities joined by exchange+code may use these records.
export const ETF_CATALOG_SOURCES = snapshot.sources;
export const ETF_CATALOG_RETRIEVED_AT = snapshot.retrievedAt;

const byIdentity = new Map(snapshot.entries.map(row => [`${row.exchange}:${row.code}`, row]));

export function etfNameFor(code: string, exchange: string) {
    return byIdentity.get(`${exchange}:${code}`);
}
