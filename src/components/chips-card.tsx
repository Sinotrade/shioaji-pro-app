// src/components/chips-card.tsx — 個股籌碼卡: margin/short quota, lending
// sources, regulatory punish flag (stocks only)

import { useCallback } from 'react';
import { useQuery } from '../hooks/use-query';
import { apiGet, apiPost } from '../lib/api';
import type { ContractInfo } from '../lib/types/contract';
import { fmtInt } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';

interface CreditEnquire {
    stock_id: string;
    system: string;
    update_time: string;
    margin_unit: number;
    short_unit: number;
    margin_loan_ratio: number;
    short_margin_ratio: number;
}

interface ShortSource {
    code: string;
    short_stock_source: number;
    datetime: string;
}

interface ChipsData {
    credit?: CreditEnquire;
    shortSource?: ShortSource;
    punished: boolean | null;
    errors: string[];
}

async function fetchChips(contract: ContractInfo): Promise<ChipsData> {
    const key = {
        security_type: contract.security_type,
        exchange: contract.exchange,
        code: contract.code,
    };
    const [credit, short, punish] = await Promise.allSettled([
        apiPost<CreditEnquire[]>('/api/v1/data/credit_enquire', {
            contracts: [key],
        }),
        apiPost<ShortSource[]>('/api/v1/data/short_stock_sources', {
            contracts: [key],
        }),
        apiGet<{ code: string[] }>('/api/v1/data/regulatory_punish'),
    ]);
    return {
        errors: [credit.status === 'rejected' ? '融資券查詢失敗' : '', short.status === 'rejected' ? '券源查詢失敗' : '', punish.status === 'rejected' ? '處置查詢失敗' : ''].filter(Boolean),
        credit:
            credit.status === 'fulfilled' ? credit.value[0] : undefined,
        shortSource:
            short.status === 'fulfilled' ? short.value[0] : undefined,
        punished:
            punish.status === 'fulfilled' ? punish.value.code.includes(contract.code) : null,
    };
}

export function ChipsCard({ contract }: { contract: ContractInfo }) {
    const { data, error, loading, refresh } = useQuery<ChipsData>(
        useCallback(() => fetchChips(contract), [contract]),
        `chips:${contract.code}`, contract.security_type === 'STK',
    );

    if (contract.security_type !== 'STK') {
        return (
            <div className={dock.emptyState}>籌碼資訊僅支援股票商品</div>
        );
    }
    const control = <><button className={panel.btn} disabled={loading} onClick={() => void refresh()}>更新籌碼</button>{(error || data?.errors.length) ? <span role="status">{error || data?.errors.join("；")}</span> : null}</>;
    if (!data) return <div className={dock.emptyState}>{control}{loading ? '載入籌碼資訊…' : '尚無資料'}</div>;

    const items: { label: string; value: string; warn?: boolean }[] = [
        {
            label: '處置/警示',
            value: data.punished === null ? '未知（查詢失敗）' : data.punished ? '⚠ 處置股' : '正常',
            warn: data.punished === true,
        },
        {
            label: '當沖資格',
            value:
                contract.day_trade === 'Yes'
                    ? '可當沖'
                    : contract.day_trade === 'OnlyBuy'
                      ? '僅可先買'
                      : '不可當沖',
            warn: contract.day_trade !== 'Yes',
        },
    ];
    if (data.credit) {
        items.push(
            {
                label: '融資成數 / 餘額單位',
                value: `${data.credit.margin_loan_ratio}% / ${fmtInt(data.credit.margin_unit)}`,
            },
            {
                label: '融券成數 / 餘額單位',
                value: `${data.credit.short_margin_ratio}% / ${fmtInt(data.credit.short_unit)}`,
            },
        );
    }
    items.push(
        {
            label: '融資餘額(契約)',
            value: fmtInt(contract.margin_trading_balance),
        },
        {
            label: '融券餘額(契約)',
            value: fmtInt(contract.short_selling_balance),
        },
    );
    if (data.shortSource) {
        items.push({
            label: '可借券源',
            value: fmtInt(data.shortSource.short_stock_source),
        });
    }

    return (
        <div className={panel.panelBody}>{control}
            <div className={dock.accountGrid}>
                {items.map((it) => (
                    <div key={it.label} className={dock.statCard}>
                        <span className={dock.statCardLabel}>{it.label}</span>
                        <span
                            className={`${dock.statCardValue} ${
                                it.warn ? panel.dirText.up : ''
                            }`}
                            style={{ fontSize: '0.85rem' }}
                        >
                            {it.value}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
