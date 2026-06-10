// src/components/api-explorer.tsx

import { type ChangeEvent, useState } from 'react';
import { fetchContract, fetchHistoryTicks } from '../lib/shioaji';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import type { Tick } from '../lib/types/tick';
import { todayStr } from '../lib/utils/date';
import { unPackHistoryTicks } from '../lib/utils/transformers/tick';
import * as styles from './api-explorer.css';
import { ContractCard } from './contract-card';
import { TicksTable } from './ticks-table';

const SECURITY_TYPE_OPTIONS: Exclude<SecurityType, null>[] = [
    'STK',
    'FUT',
    'OPT',
    'IND',
];
const TICKS_DISPLAY_LIMIT = 10;

type ContractState = ContractInfo | { err: string } | null;
type HistoryState =
    | { kind: 'ok'; ticks: Tick[]; totalCount: number }
    | { kind: 'err'; msg: string }
    | null;

export function ApiExplorer() {
    const [code, setCode] = useState('2330');
    const [securityType, setSecurityType] =
        useState<Exclude<SecurityType, null>>('STK');
    const [contract, setContract] = useState<ContractState>(null);
    const [history, setHistory] = useState<HistoryState>(null);
    const [contractLoading, setContractLoading] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);

    const hasCode = code.trim().length > 0;
    const hasContract = contract !== null && !('err' in contract);

    const clearAll = () => {
        setContract(null);
        setHistory(null);
    };

    const handleSecurityTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
        setSecurityType(e.target.value as Exclude<SecurityType, null>);
        clearAll();
    };

    const handleCodeChange = (e: ChangeEvent<HTMLInputElement>) => {
        setCode(e.target.value);
        clearAll();
    };

    const handleLookupClick = async () => {
        const trimmed = code.trim();
        if (!trimmed) return;
        setContractLoading(true);
        setHistory(null);
        try {
            const data = await fetchContract(trimmed, securityType);
            setContract(data);
        } catch (e) {
            setContract({ err: (e as Error).message });
        } finally {
            setContractLoading(false);
        }
    };

    const handleHistoryClick = async () => {
        if (!hasContract) return;
        setHistoryLoading(true);
        try {
            const raw = await fetchHistoryTicks(contract, todayStr());
            const ticks = unPackHistoryTicks(raw, contract.code);
            const start = Math.max(0, ticks.length - TICKS_DISPLAY_LIMIT);
            setHistory({
                kind: 'ok',
                ticks: ticks.slice(start).reverse(),
                totalCount: ticks.length,
            });
        } catch (e) {
            setHistory({ kind: 'err', msg: (e as Error).message });
        } finally {
            setHistoryLoading(false);
        }
    };

    const showing =
        history !== null ? 'history' : contract !== null ? 'contract' : 'none';

    return (
        <>
            <div className={styles.searchRow}>
                <select
                    className={styles.select}
                    value={securityType}
                    onChange={handleSecurityTypeChange}
                    aria-label='Security type'
                >
                    {SECURITY_TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                            {t}
                        </option>
                    ))}
                </select>
                <input
                    className={styles.input}
                    value={code}
                    onChange={handleCodeChange}
                    placeholder='Code, e.g. 2330'
                    aria-label='Contract code'
                />
            </div>
            <div className={styles.buttonRow}>
                <button
                    type='button'
                    className={styles.lookupButton}
                    onClick={handleLookupClick}
                    disabled={!hasCode || contractLoading}
                >
                    {contractLoading ? 'Loading…' : 'Look up contract'}
                </button>
                <button
                    type='button'
                    className={styles.lookupButton}
                    onClick={handleHistoryClick}
                    disabled={!hasContract || historyLoading}
                    title={hasContract ? undefined : 'Look up a contract first'}
                >
                    {historyLoading ? 'Loading…' : "Fetch today's ticks"}
                </button>
            </div>
            {showing === 'history' && history !== null && (
                <>
                    {history.kind === 'err' ? (
                        <ErrorCard msg={history.msg} />
                    ) : (
                        <TicksTable
                            ticks={history.ticks}
                            totalCount={history.totalCount}
                        />
                    )}
                </>
            )}
            {showing === 'contract' && contract !== null && (
                <>
                    {'err' in contract ? (
                        <ErrorCard msg={contract.err} />
                    ) : (
                        <ContractCard data={contract} />
                    )}
                </>
            )}
        </>
    );
}

function ErrorCard({ msg }: { msg: string }) {
    return (
        <div className={styles.errorCard}>
            <span>
                <span className={styles.dot.err} />
                {msg}
            </span>
        </div>
    );
}
