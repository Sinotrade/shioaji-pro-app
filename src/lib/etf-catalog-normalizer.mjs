// Pure shared validator for the offline snapshot generator and runtime refresh.
// No network, filesystem, DOM or Node dependencies belong in this module.
export const ETF_SOURCES = Object.freeze({
    TSE: 'https://openapi.twse.com.tw/v1/opendata/t187ap47_L',
    OTC: 'https://info.tpex.org.tw/api/etfFilter',
    TSE_NAMES: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
});
const CODE = /^[A-Z0-9]{4,6}$/;
const ENTITIES = Object.freeze({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '®', copy: '©', trade: '™',
});
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ETF source row');
    return value;
}
function rows(value) {
    if (!Array.isArray(value) || value.length === 0) throw new Error('ETF sources must contain a non-empty successful response');
    return value.map(record);
}
function plainText(value) {
    if (typeof value !== 'string') throw new Error('Invalid ETF name');
    const name = value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_match, entity) => {
        if (entity.startsWith('#')) {
            const point = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            if (point < 1 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('Invalid name character entity');
            return String.fromCodePoint(point);
        }
        const key = entity.toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(ENTITIES, key)) throw new Error(`Unknown name character entity: ${entity}`);
        return ENTITIES[key];
    }).trim();
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid ETF name');
    return name;
}
function identity(value) {
    if (typeof value !== 'string' || !CODE.test(value)) throw new Error('Invalid ETF code');
    return value;
}
function sourceDate(values) {
    const dates = [...new Set(values)];
    const raw = dates[0];
    if (dates.length !== 1 || typeof raw !== 'string' || !/^\d{7}$/.test(raw)) throw new Error('TWSE source date is missing or inconsistent');
    const day = `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
    const parsed = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) throw new Error('Invalid TWSE source date');
    return day;
}

/** Daily stock rows supply names only; the two ETF-specific sources define membership. */
export function buildEtfCatalog(tsePayload, otcPayload, retrievedAt, dailyPayload, previous) {
    const tse = rows(tsePayload);
    const otcResponse = record(otcPayload);
    if (otcResponse.status !== 'success') throw new Error('ETF sources must contain a non-empty successful TPEx response');
    const otc = rows(otcResponse.data);
    const daily = rows(dailyPayload);
    const at = Date.parse(retrievedAt);
    if (!Number.isFinite(at)) throw new Error('Invalid retrieval timestamp');
    const twseDate = sourceDate(tse.map(row => row['出表日期']));
    const namesDate = sourceDate(daily.map(row => row.Date));
    if (namesDate < twseDate) throw new Error('TWSE daily names are older than the fund source');
    const today = new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
    if (namesDate > today || twseDate > today) throw new Error('TWSE source date is in the future');
    const dailyNames = new Map();
    for (const row of daily) {
        const code = identity(row.Code);
        if (dailyNames.has(code)) throw new Error(`Duplicate TWSE daily identity: ${code}`);
        dailyNames.set(code, plainText(row.Name));
    }
    const entries = [];
    const seen = new Set();
    const previousNames = new Map((previous?.entries ?? []).map(entry => [`${entry.exchange}:${entry.code}`, entry]));
    const add = (code, name, exchange, aliases = []) => {
        const key = `${exchange}:${code}`;
        if (seen.has(key)) throw new Error(`Duplicate ETF identity: ${key}`);
        seen.add(key);
        // Preserve reviewed old names for identities still present in official membership.
        // This union must never create entries for delisted/removed identities.
        const prior = previousNames.get(key);
        const unique = [...new Set([...aliases, ...(prior ? [prior.name, ...(prior.aliases ?? [])] : [])])]
            .filter(alias => alias && alias !== name);
        entries.push(Object.freeze({ code, exchange, name, ...(unique.length ? { aliases: Object.freeze(unique) } : {}) }));
    };
    for (const row of tse) {
        const code = identity(row['基金代號']);
        const fundName = plainText(row['基金簡稱']);
        const aliases = [fundName];
        if (typeof row['基金中文名稱'] === 'string' && row['基金中文名稱'].trim()) aliases.push(plainText(row['基金中文名稱']));
        add(code, dailyNames.get(code) ?? fundName, 'TSE', aliases);
    }
    for (const row of otc) add(identity(row.stockNo), plainText(row.stockName), 'OTC');
    const sources = [
        { exchange: 'TSE', url: ETF_SOURCES.TSE, dataDate: twseDate, count: tse.length },
        // TPEx supplies no as-of date. Retrieval time is not a market-data date.
        { exchange: 'OTC', url: ETF_SOURCES.OTC, dataDate: null, count: otc.length },
        { exchange: 'TSE', url: ETF_SOURCES.TSE_NAMES, dataDate: namesDate, count: daily.length },
    ];
    for (const source of sources) {
        const prior = previous?.sources.find(row => row.url === source.url);
        if (prior && (source.count < prior.count * 0.8 || source.dataDate && prior.dataDate && source.dataDate < prior.dataDate)) {
            throw new Error('ETF source shrank by over 20% or became older');
        }
    }
    entries.sort((a, b) => a.exchange.localeCompare(b.exchange) || a.code.localeCompare(b.code));
    return Object.freeze({
        schemaVersion: 1, retrievedAt,
        sources: Object.freeze(sources.map(source => Object.freeze(source))),
        entries: Object.freeze(entries),
    });
}
