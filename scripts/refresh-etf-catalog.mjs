// Public name metadata only. No brokerage session, account, price or credentials.
// Generated output is reviewed and shipped with the app; search never fetches it.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ETF_SOURCES = {
    TSE: 'https://openapi.twse.com.tw/v1/opendata/t187ap47_L',
    OTC: 'https://info.tpex.org.tw/api/etfFilter',
    TSE_NAMES: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
};

const codePattern = /^[A-Z0-9]{4,6}$/;
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '®', copy: '©', trade: '™' };

function plainText(value) {
    return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_match, entity) => {
        if (entity.startsWith('#')) {
            const point = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            if (point < 1 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('Invalid name character entity');
            return String.fromCodePoint(point);
        }
        const text = entities[entity.toLowerCase()];
        if (text === undefined) throw new Error(`Unknown name character entity: ${entity}`);
        return text;
    }).trim();
}

export function buildEtfCatalog(tseRows, otcResponse, retrievedAt, dailyRows) {
    if (!Array.isArray(tseRows) || !tseRows.length || otcResponse?.status !== 'success' ||
        !Array.isArray(otcResponse.data) || !otcResponse.data.length || !Array.isArray(dailyRows) || !dailyRows.length) {
        throw new Error('ETF sources must all contain a non-empty successful response');
    }
    const entries = [];
    const seen = new Set();
    const add = (code, name, exchange, aliasNames = []) => {
        if (typeof code !== 'string' || !codePattern.test(code) || typeof name !== 'string' || !name.trim()) {
            throw new Error(`Invalid ETF identity in ${exchange}`);
        }
        const key = `${exchange}:${code}`;
        if (seen.has(key)) throw new Error(`Duplicate ETF identity: ${key}`);
        seen.add(key);
        const display = plainText(name);
        if (!display) throw new Error(`Invalid ETF name in ${exchange}`);
        const aliases = [...new Set(aliasNames.filter(value => typeof value === 'string').map(plainText))]
            .filter(alias => alias && alias !== display);
        entries.push({ code, name: display, exchange, ...(aliases.length ? { aliases } : {}) });
    };
    const dailyNames = new Map();
    for (const row of dailyRows) {
        if (typeof row.Code !== 'string' || !codePattern.test(row.Code) || typeof row.Name !== 'string' || !row.Name.trim()) throw new Error('Invalid TWSE daily identity');
        if (dailyNames.has(row.Code)) throw new Error(`Duplicate TWSE daily identity: ${row.Code}`);
        dailyNames.set(row.Code, row.Name);
    }
    for (const row of tseRows) {
        if (typeof row['基金簡稱'] !== 'string' || !row['基金簡稱'].trim()) throw new Error('Invalid TWSE fund name');
        add(row['基金代號'], dailyNames.get(row['基金代號']) ?? row['基金簡稱'], 'TSE', [row['基金簡稱'], row['基金中文名稱']]);
    }
    for (const row of otcResponse.data) add(row.stockNo, row.stockName, 'OTC');
    const sourceDate = (values) => {
        const dates = [...new Set(values)];
        if (dates.length !== 1 || !/^\d{7}$/.test(dates[0])) throw new Error('TWSE source date is missing or inconsistent');
        const raw = dates[0];
        const day = `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
        if (!Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
            new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('Invalid TWSE source date');
        return day;
    };
    const twseDate = sourceDate(tseRows.map(row => row['出表日期']));
    const namesDate = sourceDate(dailyRows.map(row => row.Date));
    if (namesDate < twseDate) throw new Error('TWSE daily names are older than the fund source');
    if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('Invalid retrieval timestamp');
    entries.sort((a, b) => a.exchange.localeCompare(b.exchange) || a.code.localeCompare(b.code));
    return {
        schemaVersion: 1,
        retrievedAt,
        sources: [
            { exchange: 'TSE', url: ETF_SOURCES.TSE, dataDate: twseDate, count: tseRows.length },
            // TPEx's response supplies no as-of date; retrieval time is not a market-data date.
            { exchange: 'OTC', url: ETF_SOURCES.OTC, dataDate: null, count: otcResponse.data.length },
            { exchange: 'TSE', url: ETF_SOURCES.TSE_NAMES, dataDate: namesDate, count: dailyRows.length },
        ],
        entries,
    };
}

async function getJson(url, method = 'GET') {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}

async function main() {
    const [tseRows, otcResponse, dailyRows] = await Promise.all([
        getJson(ETF_SOURCES.TSE), getJson(ETF_SOURCES.OTC, 'POST'), getJson(ETF_SOURCES.TSE_NAMES),
    ]);
    const snapshot = buildEtfCatalog(tseRows, otcResponse, new Date().toISOString(), dailyRows);
    const output = new URL('../src/lib/data/etf-catalog.json', import.meta.url);
    let previous;
    try { previous = JSON.parse(await readFile(output, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
        for (const source of snapshot.sources) {
            const prior = previous.sources.find(row => row.url === source.url);
            if (prior && (source.count < prior.count * 0.8 ||
                source.dataDate && prior.dataDate && source.dataDate < prior.dataDate)) {
                throw new Error(`${source.exchange} source shrank by over 20% or became older; preserve the previous snapshot and investigate`);
            }
        }
    }
    const summary = snapshot.sources.map(row => `${row.exchange}=${row.count} (${row.url.split('/').at(-1)})`).join(', ');
    if (!process.argv.includes('--write')) {
        process.stdout.write(`Validated ${snapshot.entries.length} ETF names (${summary}). Use --write to update the reviewed snapshot.\n`);
        return;
    }
    await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(`Updated ETF name snapshot: ${snapshot.entries.length} (${summary}). Review the diff before committing.\n`);
}

// Importing the pure transformer from tests performs no network or file writes.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    await main();
}
