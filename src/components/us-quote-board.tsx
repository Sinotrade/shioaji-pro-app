// src/components/us-quote-board.tsx — 美股報價板
//
// SDK 1.8.0b1 只有逐筆與最佳一檔，沒有快照與歷史：第一筆 tick 前只顯示
// 代碼／名稱／交易所／前一日參考價／幣別；之後補上成交價、漲跌、開高低、
// 總量與最佳買賣。價格一律是原始 decimal 字串（USD），不套用台股級距。

import { useQuote } from '../hooks/use-stream';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractInfo } from '../lib/types/contract';
import { decCompare, fmtUsPrice } from '../lib/us/decimal';
import { usHaltLabel, useUsHalt } from '../lib/us/us-halts';
import { getUsTickMeta, US_SESSION_LABEL } from '../lib/us/us-quotes';
import { fmtInt } from '../lib/utils/format';
import * as styles from './quote-board.css';
import * as us from './us-quote-board.css';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <span className={styles.stat}>
            <span className={styles.statLabel}>{label}</span>
            <span className={styles.statValue}>{children}</span>
        </span>
    );
}

const dirOf = (chg: string | undefined): 'up' | 'down' | 'flat' => {
    if (!chg) return 'flat';
    const c = decCompare(chg, '0');
    return c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
};

export function UsQuoteBoard({ contract }: { contract: ContractInfo }) {
    const key = contractLinkKey(contract);
    const quote = useQuote(key);
    const halt = useUsHalt(contract);
    const tick = quote?.tick;
    const bid = quote?.bidask?.bid_price?.[0];
    const ask = quote?.bidask?.ask_price?.[0];
    const meta = tick ? getUsTickMeta(key) : undefined;
    const dir = dirOf(tick?.price_chg);
    const ref = contract.us_reference;

    return (
        <div className={`${styles.board} ${us.board}`} aria-label='美股報價板' data-testid='us-quote-board'>
            <span className={us.ident}>
                <span className={us.code}>{contract.code}<span className={us.badge}>美股</span></span>
                <span className={us.meta}>{[contract.name !== contract.code ? contract.name : '', contract.exchange, 'USD'].filter(Boolean).join(' · ')}</span>
            </span>
            {tick ? (
                <>
                    <span className={styles.bigPrice[dir]}>{fmtUsPrice(tick.close)}</span>
                    <span className={styles.changeBlock}>
                        <span className={us.dir[dir]}>{tick.price_chg ? `${dir === 'up' ? '+' : ''}${fmtUsPrice(tick.price_chg)}` : '—'}</span>
                        <span className={us.dir[dir]}>{tick.pct_chg ? `${dir === 'up' ? '+' : ''}${Number(tick.pct_chg).toFixed(2)}%` : ''}</span>
                    </span>
                    <Stat label='開'>{fmtUsPrice(tick.open)}</Stat>
                    <Stat label='高'>{fmtUsPrice(tick.high)}</Stat>
                    <Stat label='低'>{fmtUsPrice(tick.low)}</Stat>
                    <Stat label='總量'>{fmtInt(tick.total_volume)}</Stat>
                    <Stat label='買'>{bid ? fmtUsPrice(bid) : '—'}</Stat>
                    <Stat label='賣'>{ask ? fmtUsPrice(ask) : '—'}</Stat>
                    {meta && US_SESSION_LABEL[meta.session] && <Stat label='時段'>{US_SESSION_LABEL[meta.session]}</Stat>}
                    {meta?.freshness && meta.freshness !== 'Realtime' && <Stat label='行情'>{meta.freshness === 'Delayed' ? '延遲' : '過時'}</Stat>}
                </>
            ) : (
                <>
                    <span className={styles.bigPrice.flat}>{ref ? fmtUsPrice(ref) : '—'}</span>
                    <span className={us.meta}>
                        前一日參考價{contract.reference_date ? `（${contract.reference_date}）` : ''}
                        <br />尚無即時報價
                    </span>
                </>
            )}
            {tick && ref && <Stat label='參考'>{fmtUsPrice(ref)}</Stat>}
            {(halt || contract.trading_suspended) && (
                <span className={us.halt}>{halt ? usHaltLabel(halt) : '暫停交易'}</span>
            )}
        </div>
    );
}
