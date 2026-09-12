import type { Snapshot, SseBidAsk } from './types/market';

export interface BookLevel { price: number; vol: number }
export interface DisplayBook {
    bids: BookLevel[];
    asks: BookLevel[];
    source: 'snapshot' | 'stream';
    time?: string;
}

/** Exchange timestamps without offsets are Taiwan local time. */
export function marketTime(date: string | undefined, time?: string): number {
    if (!date) return NaN;
    const value = (time ? `${date}T${time}` : date).replaceAll('/', '-').replace(' ', 'T');
    const normalized = value.replace(/(\.\d{3})\d+/, '$1');
    return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
}
export function matchesSnapshot(snapshot: Snapshot | undefined, code: string, targetCode?: string | null): snapshot is Snapshot {
    return !!snapshot && (snapshot.code === code || (!!targetCode && snapshot.code === targetCode));
}
function levels(prices: unknown[], volumes: unknown[], allowSigned: boolean): BookLevel[] {
    return prices.flatMap((raw, i) => {
        const volume = volumes[i];
        if (raw === null || raw === undefined || raw === '' || volume === null || volume === undefined || volume === '') return [];
        const price = Number(raw), vol = Number(volume);
        return Number.isFinite(price) && Number.isFinite(vol) && vol > 0 && (allowSigned || price > 0) ? [{ price, vol }] : [];
    });
}
/** Display only. Never write this fallback into the streaming/strategy store. */
export function displayBook(code: string, snapshot?: Snapshot, stream?: SseBidAsk, targetCode?: string | null, allowSigned = false): DisplayBook | undefined {
    const snap = matchesSnapshot(snapshot, code, targetCode) ? snapshot : undefined;
    const book = stream && (stream.code === code || stream.code === targetCode) ? stream : undefined;
    const snapTime = marketTime(snap?.datetime);
    const bookTime = marketTime(book?.date, book?.time);
    if (book && (!snap || !Number.isFinite(snapTime) || (Number.isFinite(bookTime) && bookTime >= snapTime))) {
        // A reported empty side is authoritative: never revive it from a snapshot.
        return { bids: levels(book.bid_price, book.bid_volume, allowSigned), asks: levels(book.ask_price, book.ask_volume, allowSigned), source: 'stream', time: `${book.date} ${book.time}` };
    }
    if (!snap) return undefined;
    return { bids: levels([snap.buy_price], [snap.buy_volume], allowSigned), asks: levels([snap.sell_price], [snap.sell_volume], allowSigned), source: 'snapshot', time: snap.datetime };
}
