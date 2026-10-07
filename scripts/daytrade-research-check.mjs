/** One-off read-only market audit. Never logs in, subscribes, orders or touches accounts. */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDaytrade } from '../src/lib/daytrade-picker.ts';

const BASE = 'http://127.0.0.1:21322';
const TRADE_DATE = '2026-10-07';
const START_DATE = '2026-08-24';
const OUTPUT = 'C:/Users/lin61/Documents/股票期貨/v9-daytrade-top10-20261007/current-result-corrected.json';
const MIB = 1024 * 1024;
const RESERVE_BYTES = 20 * MIB;
const MAX_WIRE_INCREASE = 50 * MIB;
const MAX_HISTORY_JSON = 64 * MIB;
const DAY = 86400;
const OFFSET_MS = 8 * 3600_000;
let historicalJsonBytes = 0;

export function balancedCodes(groups, limit = 40) {
    const seen = new Set();
    const codes = [];
    const maximum = Math.max(0, ...groups.map(group => group.length));
    for (let index = 0; index < maximum && codes.length < limit; index++) {
        for (const group of groups) {
            const code = group[index]?.code;
            if (/^[1-9]\d{3}$/.test(code ?? '') && !seen.has(code)) {
                seen.add(code); codes.push(code);
                if (codes.length === limit) break;
            }
        }
    }
    return codes;
}

export function usageSafe(value) {
    return value && ['connections', 'bytes', 'limit_bytes', 'remaining_bytes']
        .every(key => Number.isFinite(value[key]) && value[key] >= 0)
        && value.remaining_bytes >= RESERVE_BYTES;
}

/** KBars source labels are Taiwan wall-clock, encoded UTC for the chart/core. No time shift. */
export function wallSeconds(datetime) {
    if (typeof datetime !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(datetime)) {
        throw new Error('KBars source datetime format/zone is unverified');
    }
    const y = Number(datetime.slice(0, 4)), m = Number(datetime.slice(5, 7)), d = Number(datetime.slice(8, 10));
    const h = Number(datetime.slice(11, 13)), minute = Number(datetime.slice(14, 16)), second = Number(datetime.slice(17, 19));
    const stamp = Date.UTC(y, m - 1, d, h, minute, second);
    const check = new Date(stamp);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d
        || check.getUTCHours() !== h || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
        throw new Error('KBars contains an invalid calendar/time label');
    }
    return stamp / 1000;
}

export function rawMinutes(kbars) {
    const keys = ['datetime', 'Open', 'High', 'Low', 'Close', 'Volume'];
    if (!keys.every(key => Array.isArray(kbars[key])) || !keys.every(key => kbars[key].length === kbars.datetime.length)) {
        throw new Error('KBars column lengths are inconsistent');
    }
    // Preserve every row, including duplicates and invalid price/volume values. No repair, sort or dedup.
    return kbars.datetime.map((source, index) => ({
        time: wallSeconds(source), open: kbars.Open[index], high: kbars.High[index],
        low: kbars.Low[index], close: kbars.Close[index], volume: kbars.Volume[index],
    }));
}

function validMinute(bar) {
    return Number.isInteger(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
        && Number.isFinite(bar.volume) && bar.volume >= 0 && bar.high >= Math.max(bar.open, bar.close, bar.low)
        && bar.low <= Math.min(bar.open, bar.close, bar.high);
}

export function closedDaily(minutes, nowMs) {
    const wallNow = (nowMs + OFFSET_MS) / 1000;
    const today = Math.floor(wallNow / DAY) * DAY;
    const groups = new Map();
    for (const bar of minutes) {
        const day = Math.floor(bar.time / DAY) * DAY;
        const clock = bar.time - day;
        if (clock <= 9 * 3600 || clock > 13.5 * 3600 || day >= today) continue;
        const group = groups.get(day) ?? [];
        group.push(bar); groups.set(day, group);
    }
    let daily = [];
    const missingCloseDays = [];
    for (const [day, group] of groups) {
        const last = group.at(-1);
        if (last.time !== day + 13.5 * 3600) {
            // Do not stitch prior completed days across a known missing-close source day.
            daily = [];
            missingCloseDays.push(new Date(day * 1000).toISOString().slice(0, 10));
            continue;
        }
        if (group.some((bar, index) => !validMinute(bar) || (index > 0 && bar.time <= group[index - 1].time))) {
            throw new Error('Historical regular-session minutes contain invalid bars/order/duplicates; not repaired');
        }
        daily.push({ time: day, open: group[0].open, high: Math.max(...group.map(bar => bar.high)),
            low: Math.min(...group.map(bar => bar.low)), close: last.close, volume: group.reduce((sum, bar) => sum + bar.volume, 0) });
    }
    return { daily, missingCloseDays };
}

function key(contract) {
    return { region: contract.region ?? 'TW', security_type: contract.security_type,
        exchange: contract.exchange, code: contract.code, target_code: contract.target_code || null };
}

async function request(path, body, history = false) {
    // A closed allowlist prevents an accidental trading/account/subscribe call during later script edits.
    const permitted = body === undefined
        ? path === '/api/v1/auth/usage' || /^\/api\/v1\/data\/contracts\/(?:[1-9]\d{3}|IX0001)\/info\?security_type=(?:STK|IND)&region=TW$/.test(path)
        : ['/api/v1/data/scanner', '/api/v1/data/kbars', '/api/v1/data/snapshots', '/api/v1/data/short_stock_sources'].includes(path);
    if (!permitted) throw new Error(`Read-only audit blocked endpoint ${path}`);
    const response = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${response.status} at ${path}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (history) {
        historicalJsonBytes += buffer.length;
        if (historicalJsonBytes > MAX_HISTORY_JSON) throw new Error('Historical JSON budget exceeded64MiB; further history requests stopped');
    }
    return JSON.parse(new TextDecoder().decode(buffer));
}

const usage = () => request('/api/v1/auth/usage');
function enforceBudget(current, before) {
    if (!usageSafe(current)) throw new Error('Usage unknown or remaining quota below20MiB; audit stopped');
    if (current.bytes - before.bytes >= MAX_WIRE_INCREASE) throw new Error('Reported usage increased50MiB; audit stopped');
    if (historicalJsonBytes >= MAX_HISTORY_JSON) throw new Error('Historical JSON reached64MiB; audit stopped');
}

async function chunks(values, size, fn) {
    const results = [];
    for (let offset = 0; offset < values.length; offset += size) {
        results.push(...await Promise.all(values.slice(offset, offset + size).map(fn)));
    }
    return results;
}

function prefixMetrics(minutes, nowMs) {
    const wall = (nowMs + OFFSET_MS) / 1000;
    const today = Math.floor(wall / DAY) * DAY;
    const count = Math.max(0, Math.floor((Math.floor(wall / 60) * 60 - today - 9 * 3600) / 300) * 5);
    const allDays = [...new Set(minutes.map(bar => Math.floor(bar.time / DAY) * DAY))];
    const isComplete = day => {
        const prefix = minutes.filter(bar => bar.time > day + 9 * 3600 && bar.time <= day + 9 * 3600 + count * 60);
        return prefix.length === count && count > 0 && prefix.every((bar, index) =>
            bar.time === day + 9 * 3600 + (index + 1) * 60 && validMinute(bar));
    };
    return { requestedClosedPrefixMinutes: count, currentPrefixComplete: isComplete(today),
        completePriorPrefixes: allDays.filter(day => day < today && isComplete(day)).length };
}

export async function main() {
    // Never replace an existing user or earlier audit artifact.
    try { await access(OUTPUT); throw new Error(`Output already exists; refusing overwrite: ${OUTPUT}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const startedAt = new Date().toISOString();
    const actualDate = new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 10);
    if (actualDate !== TRADE_DATE) throw new Error(`This dated audit is only for ${TRADE_DATE}, not ${actualDate}`);
    const before = await usage();
    if (!usageSafe(before)) throw new Error('Initial quota unknown or remaining below20MiB; no history requested');
    console.log(JSON.stringify({ stage: 'before', startedAt, usage: before }));
    // Shioaji uses true=largest-first and false=smallest-first (not conventional numeric ascending).
    const rules = [['ChangePercentRank', 20, true], ['ChangePercentRank', 20, false], ['VolumeRank', 25, true], ['AmountRank', 20, true]];
    const scanners = await Promise.all(rules.map(([scanner_type, count, ascending]) => request('/api/v1/data/scanner', { scanner_type, count, ascending, date: TRADE_DATE })));
    if (!scanners.every(Array.isArray)) throw new Error('Scanner result shape invalid');
    const codes = balancedCodes(scanners);
    const names = new Map(scanners.flat().map(item => [item.code, item.name]));
    const metadataErrors = [];
    const contracts = await chunks(codes, 4, async code => {
        try { return await request(`/api/v1/data/contracts/${code}/info?security_type=STK&region=TW`); }
        catch (error) { metadataErrors.push({ code, error: error.message });
            return { code, name: names.get(code) ?? code, security_type: 'STK', region: 'TW', exchange: null, currency: 'TWD', target_code: null, update_date: '', day_trade: '' }; }
    });
    const inputs = contracts.map(contract => ({ contract, daily: [], minutes: [] }));
    const historyMetrics = new Map();
    const historyErrors = [];
    let budgetStop = null;
    let completedHistoryRequests = 0;
    const usageSamples = [before];
    for (let offset = 0; offset < inputs.length; offset += 4) {
        const current = await usage(); usageSamples.push(current);
        try { enforceBudget(current, before); } catch (error) { budgetStop = error.message; break; }
        await Promise.all(inputs.slice(offset, offset + 4).map(async input => {
            const code = input.contract.code;
            if (!['TSE', 'OTC'].includes(input.contract.exchange)) return;
            completedHistoryRequests++;
            try {
                const raw = await request('/api/v1/data/kbars', { contract: key(input.contract), start: START_DATE, end: TRADE_DATE }, true);
                input.minutes = rawMinutes(raw);
                const aggregation = closedDaily(input.minutes, Date.now());
                input.daily = aggregation.daily;
                historyMetrics.set(code, { minuteCount: input.minutes.length, dailyCount: input.daily.length,
                    rawSourceFirst: raw.datetime[0] ?? null, rawSourceLast: raw.datetime.at(-1) ?? null,
                    rawOpeningLabels: raw.datetime.filter(label => label.startsWith(`${TRADE_DATE}T09:`) || label.startsWith(`${TRADE_DATE} 09:`)).slice(0, 5),
                    lastCompleteDay: input.daily.length ? new Date(input.daily.at(-1).time * 1000).toISOString().slice(0, 10) : null,
                    missingCloseDays: aggregation.missingCloseDays });
            } catch (error) { historyErrors.push({ code, error: error.message }); }
        }));
        const afterChunk = await usage(); usageSamples.push(afterChunk);
        console.log(JSON.stringify({ stage: 'history', completedHistoryRequests, poolSize: codes.length,
            historicalJsonMiB: +(historicalJsonBytes / MIB).toFixed(2), reportedUsageMiB: +(afterChunk.bytes / MIB).toFixed(2) }));
        try { enforceBudget(afterChunk, before); } catch (error) { budgetStop = error.message; break; }
    }
    let indexContract = null;
    try { indexContract = await request('/api/v1/data/contracts/IX0001/info?security_type=IND&region=TW'); } catch { /* optional relative-strength input */ }
    const snapshots = await request('/api/v1/data/snapshots', { contracts: [...contracts.filter(contract => ['TSE', 'OTC'].includes(contract.exchange)).map(key), ...(indexContract ? [key(indexContract)] : [])] });
    const quotes = new Map(snapshots.map(snapshot => [snapshot.code, snapshot]));
    let sources = [], shortError = null;
    try { sources = await request('/api/v1/data/short_stock_sources', { contracts: contracts.filter(contract => ['TSE', 'OTC'].includes(contract.exchange)).map(key) }); }
    catch (error) { shortError = error.message; }
    const shortSources = new Map(sources.map(source => [source.code, source]));
    for (const input of inputs) {
        input.snapshot = quotes.get(input.contract.code);
        const source = shortSources.get(input.contract.code);
        if (source) input.shortSource = { quantity: source.short_stock_source, datetime: source.datetime };
    }
    const nowMs = Date.now();
    const index = quotes.get('IX0001');
    // Only fresh, matching index snapshots may influence ranking. Zone-less labels mean Taipei, same as core.
    const indexStamp = index && Date.parse(/[Z+-]\d?/.test(index.datetime.slice(19)) ? index.datetime : `${index.datetime.replace(' ', 'T')}+08:00`);
    const indexChangeRate = index && index.exchange === indexContract?.exchange && Number.isFinite(indexStamp)
        && indexStamp <= nowMs && nowMs - indexStamp <= 180_000 && Number.isFinite(index.change_rate) ? index.change_rate : undefined;
    const result = evaluateDaytrade(inputs, nowMs, indexChangeRate);
    const after = await usage();
    const reasonCounts = {};
    for (const excluded of result.excluded) for (const reason of excluded.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    const metrics = inputs.map(input => ({ code: input.contract.code, name: input.contract.name, exchange: input.contract.exchange,
        qualificationDate: input.contract.update_date, dayTrade: input.contract.day_trade,
        tradingSuspended: input.contract.trading_suspended ?? null, dispositionLevel: input.contract.disposition_level ?? null,
        ...historyMetrics.get(input.contract.code), ...prefixMetrics(input.minutes, nowMs),
        snapshotDatetime: input.snapshot?.datetime ?? null,
        snapshotFields: input.snapshot ? { open: input.snapshot.open, high: input.snapshot.high, low: input.snapshot.low,
            close: input.snapshot.close, buyPrice: input.snapshot.buy_price, sellPrice: input.snapshot.sell_price,
            buyVolume: input.snapshot.buy_volume, sellVolume: input.snapshot.sell_volume,
            totalVolume: input.snapshot.total_volume, totalAmount: input.snapshot.total_amount } : null,
        shortSourceDatetime: input.shortSource?.datetime ?? null,
        shortSourceQuantity: input.shortSource?.quantity ?? null }));
    const artifact = { kind: 'v9-daytrade-readonly-market-audit', version: 1, poolLabel: '排行榜40檔；未含前端自選，不是全市場掃描',
        startedAt, evaluatedAt: new Date(nowMs).toISOString(), evaluatedAtTaipei: new Date(nowMs + OFFSET_MS).toISOString().replace('Z', '+08:00'),
        historyRange: { start: START_DATE, end: TRADE_DATE }, scannerRules: rules, poolSize: codes.length, poolCodes: codes,
        usageBefore: before, usageAfter: after, reportedUsageIncrease: after.bytes - before.bytes,
        historicalJsonBytes, completedHistoryRequests, budgetStop, metadataErrors, historyErrors, shortError,
        usageSamples, indexChangeRate: indexChangeRate ?? null,
        counts: { long: result.long.length, short: result.short.length, observationsLong: result.observationsLong.length,
            observationsShort: result.observationsShort.length, excluded: result.excluded.length }, result,
        reasonCounts, inputMetrics: metrics,
        limitations: ['僅研究、不下單；未啟動、登入、訂閱或修改服務', '資格來自券商契約日期，並非獨立重建交易所清單',
            '券源時間戳原樣保留，未把不明UTC／台北語意強行轉成新鮮資料', '分鐘量價估算VWAP、日K未校正除權息',
            '盤中條件與帳戶可實際成交／可借券數量不同', '來源缺漏或不足不補名額；目前名單會隨行情改變'] };
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ stage: 'done', output: OUTPUT, evaluatedAt: artifact.evaluatedAtTaipei,
        counts: artifact.counts, usageBefore: before, usageAfter: after, historicalJsonMiB: historicalJsonBytes / MIB,
        long: result.long.map(row => `${row.contract.code} ${row.contract.name}`), short: result.short.map(row => `${row.contract.code} ${row.contract.name}`),
        observationsLong: result.observationsLong.map(row => `${row.contract.code} ${row.contract.name}`),
        observationsShort: result.observationsShort.map(row => `${row.contract.code} ${row.contract.name}`), reasonCounts, historyErrors }));
    return artifact;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
