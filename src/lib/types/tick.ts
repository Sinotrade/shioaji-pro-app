// src/lib/types/tick.ts

export interface Tick {
    code: string;
    time: string;
    close: number;
    volume: number;
    tick_type: number;
}

export interface HistoryTicks {
    datetime: string[];
    close: number[];
    volume: number[];
    bid_price: number[];
    bid_volume: number[];
    ask_price: number[];
    ask_volume: number[];
    tick_type: number[];
}
