// src/components/account-detail.tsx — 台股／美股共用的帳務明細呈現
//
// - DetailToggle：庫存列的展開鈕（代碼欄最前面），台股、美股同一顆
// - ExpandableRow：已實現損益列，點整列展開沖銷明細（台股 30 日、美股同一種互動）
// - DetailView：明細查詢的 載入中／失敗／空／表格 四態
// - DetailTable：明細表（欄位由呼叫端定義）

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';

type Dir = 'up' | 'down' | 'flat';

export function DetailToggle({ open, what, onToggle }: { open: boolean; what: string; onToggle: () => void }) {
    const label = `${open ? '收合' : '展開'}${what}`;
    return (
        <button
            type='button'
            className={dock.cancelBtn}
            aria-expanded={open}
            aria-label={label}
            title={label}
            onClick={e => { e.stopPropagation(); onToggle(); }}
        >
            {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        </button>
    );
}

/** 一列可展開的表格列：第一欄是箭頭，展開後下一列放明細（橫跨其餘欄） */
export function ExpandableRow({ cells, detailSpan, title, renderDetail }: {
    /** 箭頭以外的儲存格（<td>） */
    cells: ReactNode;
    /** 明細列要橫跨的欄數（不含箭頭欄） */
    detailSpan: number;
    title: string;
    renderDetail: () => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const toggle = () => setOpen(o => !o);
    return (
        <>
            <tr
                className={dock.clickableRow}
                onClick={toggle}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                tabIndex={0}
                aria-expanded={open}
                title={title}
            >
                <td className={dock.td}>{open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}</td>
                {cells}
            </tr>
            {open && (
                <tr>
                    <td className={dock.td} />
                    <td className={dock.td} colSpan={detailSpan}>{renderDetail()}</td>
                </tr>
            )}
        </>
    );
}

export interface DetailColumn<T> {
    header: string;
    cell: (row: T) => ReactNode;
    /** 漲跌色（損益欄） */
    dir?: (row: T) => Dir;
}

export function DetailTable<T>({ label, columns, rows, rowKey }: {
    label: string;
    columns: DetailColumn<T>[];
    rows: T[];
    rowKey: (row: T, index: number) => string;
}) {
    return (
        <table className={dock.table} aria-label={label}>
            <thead>
                <tr>{columns.map(c => <th key={c.header} className={dock.th}>{c.header}</th>)}</tr>
            </thead>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={rowKey(r, i)}>
                        {columns.map(c => <td key={c.header} className={`${dock.td} ${c.dir ? panel.dirText[c.dir(r)] : ''}`}>{c.cell(r)}</td>)}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/** 明細查詢四態：資料到之前顯示載入中或錯誤；空陣列顯示 emptyText；有資料交給 children */
export function DetailView<T>({ data, error, loading, loadingText, emptyText, renderError, children }: {
    data: T[] | undefined;
    error: string | null;
    loading: boolean;
    loadingText: string;
    emptyText: string;
    renderError: (error: string) => ReactNode;
    children: (rows: T[]) => ReactNode;
}) {
    if (!data) return error ? <>{renderError(error)}</> : <span className={dock.usNote} role='status'>{loading ? loadingText : ' '}</span>;
    if (data.length === 0) return <span className={dock.usNote}>{emptyText}</span>;
    return <>{children(data)}</>;
}
