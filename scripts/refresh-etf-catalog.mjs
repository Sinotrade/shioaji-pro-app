// Public name metadata only. No brokerage session, account, price or credentials.
// Generated output is the bundled fallback. Runtime refresh uses the same validator.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ETF_SOURCES, buildEtfCatalog } from '../src/lib/etf-catalog-normalizer.mjs';
export { ETF_SOURCES, buildEtfCatalog };

async function getJson(url, method = 'GET') {
    const response = await fetch(url, { method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}

async function main() {
    const [tseRows, otcResponse, dailyRows] = await Promise.all([
        getJson(ETF_SOURCES.TSE), getJson(ETF_SOURCES.OTC, 'POST'), getJson(ETF_SOURCES.TSE_NAMES),
    ]);
    const output = new URL('../src/lib/data/etf-catalog.json', import.meta.url);
    let previous;
    try { previous = JSON.parse(await readFile(output, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const snapshot = buildEtfCatalog(tseRows, otcResponse, new Date().toISOString(), dailyRows, previous);
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
