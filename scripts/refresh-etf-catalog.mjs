// Public name metadata only. No brokerage session, account, price or credentials.
// Generated output is reviewed and shipped with the app; search never fetches it.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ETF_SOURCES = {
    TSE: 'https://openapi.twse.com.tw/v1/opendata/t187ap47_L',
    OTC: 'https://info.tpex.org.tw/api/etfFilter',
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

export function buildEtfCatalog(tseRows, otcResponse, retrievedAt) {
    if (!Array.isArray(tseRows) || !tseRows.length || otcResponse?.status !== 'success' ||
        !Array.isArray(otcResponse.data) || !otcResponse.data.length) {
        throw new Error('ETF sources must both contain a non-empty successful response');
    }
    const entries = [];
    const seen = new Set();
    const add = (code, name, exchange, fullName) => {
        if (typeof code !== 'string' || !codePattern.test(code) || typeof name !== 'string' || !name.trim()) {
            throw new Error(`Invalid ETF identity in ${exchange}`);
        }
        const key = `${exchange}:${code}`;
        if (seen.has(key)) throw new Error(`Duplicate ETF identity: ${key}`);
        seen.add(key);
        const display = plainText(name);
        if (!display) throw new Error(`Invalid ETF name in ${exchange}`);
        const full = typeof fullName === 'string' ? plainText(fullName) : '';
        const aliases = full && full !== display ? [full] : [];
        entries.push({ code, name: display, exchange, ...(aliases.length ? { aliases } : {}) });
    };
    for (const row of tseRows) add(row['基金代號'], row['基金簡稱'], 'TSE', row['基金中文名稱']);
    for (const row of otcResponse.data) add(row.stockNo, row.stockName, 'OTC');
    const dates = [...new Set(tseRows.map(row => row['出表日期']))];
    if (dates.length !== 1 || !/^\d{7}$/.test(dates[0])) throw new Error('TWSE source date is missing or inconsistent');
    const raw = dates[0];
    const twseDate = `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
    if (!Number.isFinite(Date.parse(`${twseDate}T00:00:00Z`)) ||
        new Date(`${twseDate}T00:00:00Z`).toISOString().slice(0, 10) !== twseDate) throw new Error('Invalid TWSE source date');
    if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('Invalid retrieval timestamp');
    entries.sort((a, b) => a.exchange.localeCompare(b.exchange) || a.code.localeCompare(b.code));
    return {
        schemaVersion: 1,
        retrievedAt,
        sources: [
            { exchange: 'TSE', url: ETF_SOURCES.TSE, dataDate: twseDate, count: tseRows.length },
            // TPEx's response supplies no as-of date; retrieval time is not a market-data date.
            { exchange: 'OTC', url: ETF_SOURCES.OTC, dataDate: null, count: otcResponse.data.length },
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
    const [tseRows, otcResponse] = await Promise.all([
        getJson(ETF_SOURCES.TSE), getJson(ETF_SOURCES.OTC, 'POST'),
    ]);
    const snapshot = buildEtfCatalog(tseRows, otcResponse, new Date().toISOString());
    const output = new URL('../src/lib/data/etf-catalog.json', import.meta.url);
    let previous;
    try { previous = JSON.parse(await readFile(output, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
        for (const source of snapshot.sources) {
            const prior = previous.sources.find(row => row.exchange === source.exchange);
            if (prior && (source.count < prior.count * 0.8 ||
                source.dataDate && prior.dataDate && source.dataDate < prior.dataDate)) {
                throw new Error(`${source.exchange} source shrank by over 20% or became older; preserve the previous snapshot and investigate`);
            }
        }
    }
    const summary = snapshot.sources.map(row => `${row.exchange}=${row.count}`).join(', ');
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
