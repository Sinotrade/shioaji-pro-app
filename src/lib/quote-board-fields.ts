// src/lib/quote-board-fields.ts：報價欄的自訂欄位（每個 K 線面板各一份，跟版面一起存）。
// 使用者可以決定每一區、每一格要不要顯示，以及區塊與格子的先後順序；指數與個股（含期貨、選擇權）各一組。
// 面板變窄時的自動降級照舊：降級規則看的是格子的優先度（board-tier、quote-board.css），
// 這裡隱藏的格子不畫出來，階梯量測自然量到較少的內容。現價、漲跌、試撮／快照與停板標籤固定顯示，不在這裡設定。

export type BoardKind = 'index' | 'stock';

export type IndexSection = 'breadth' | 'volume';
export type IndexField =
    | 'limitUp'
    | 'raise'
    | 'flat'
    | 'fall'
    | 'limitDown'
    | 'breadthBar'
    | 'amount'
    | 'estimate'
    | 'change'
    | 'time';

export type StockSection = 'range' | 'stats';
export type StockField = 'rail' | 'sector' | 'highLow' | 'open' | 'volume' | 'ratio' | 'limits';

export interface FieldMeta<F extends string> {
    id: F;
    label: string;
    hint?: string;
    // 位置固定（比例條畫在家數下方、產業標籤跟著區間軌），只能開關，不能排序
    fixed?: boolean;
}

export interface SectionMeta<S extends string, F extends string> {
    id: S;
    label: string;
    fields: readonly FieldMeta<F>[];
}

export const INDEX_SECTIONS: readonly SectionMeta<IndexSection, IndexField>[] = [
    {
        id: 'breadth',
        label: '漲跌家數',
        fields: [
            { id: 'limitUp', label: '漲停' },
            { id: 'raise', label: '上漲' },
            { id: 'flat', label: '平盤' },
            { id: 'fall', label: '下跌' },
            { id: 'limitDown', label: '跌停' },
            { id: 'breadthBar', label: '比例條', hint: '家數下方的漲平跌比例', fixed: true },
        ],
    },
    {
        id: 'volume',
        label: '量能',
        fields: [
            { id: 'amount', label: '成交金額' },
            { id: 'estimate', label: '預估量', hint: '收盤後為實際量' },
            { id: 'change', label: '較昨日' },
            { id: 'time', label: '時間' },
        ],
    },
];

export const STOCK_SECTIONS: readonly SectionMeta<StockSection, StockField>[] = [
    {
        id: 'range',
        label: '日內區間',
        fields: [
            { id: 'rail', label: '區間軌', hint: '關閉時改用數字欄' },
            { id: 'sector', label: '產業標籤', hint: '只有上市櫃個股', fixed: true },
        ],
    },
    {
        id: 'stats',
        label: '數字欄',
        fields: [
            { id: 'highLow', label: '高低' },
            { id: 'open', label: '開' },
            { id: 'volume', label: '量' },
            { id: 'ratio', label: '量比', hint: '只有個股' },
            { id: 'limits', label: '漲跌停' },
        ],
    },
];

export interface KindLayout<S extends string, F extends string> {
    // 區塊順序
    sections: S[];
    // 每個區塊內格子的順序（含隱藏的格子，重新打開時回到原位）
    order: Record<S, F[]>;
    hidden: F[];
}

export interface QuoteBoardFields {
    index: KindLayout<IndexSection, IndexField>;
    stock: KindLayout<StockSection, StockField>;
}

// 存檔格式：只存和預設不同的那一種（缺省 = 預設），舊存檔與日後新增的格子都能讀
export type QuoteBoardFieldsConfig = Partial<{
    index: Partial<KindLayout<IndexSection, IndexField>>;
    stock: Partial<KindLayout<StockSection, StockField>>;
}>;

function defaultLayout<S extends string, F extends string>(metas: readonly SectionMeta<S, F>[]): KindLayout<S, F> {
    return {
        sections: metas.map((s) => s.id),
        order: Object.fromEntries(metas.map((s) => [s.id, s.fields.map((f) => f.id)])) as Record<S, F[]>,
        hidden: [],
    };
}

export const DEFAULT_QUOTE_BOARD_FIELDS: QuoteBoardFields = {
    index: defaultLayout(INDEX_SECTIONS),
    stock: defaultLayout(STOCK_SECTIONS),
};

// 讀存檔：丟掉不認得的值、補上缺的區塊與格子（排在最後），格子不能跨區
function normalizeLayout<S extends string, F extends string>(
    metas: readonly SectionMeta<S, F>[],
    raw: unknown,
): KindLayout<S, F> {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof KindLayout<S, F>, unknown>>;
    const ids = metas.map((s) => s.id);
    const pickList = <T extends string>(list: unknown, allowed: readonly T[]): T[] => {
        const seen = new Set<T>();
        if (Array.isArray(list)) {
            for (const v of list) if (allowed.includes(v as T)) seen.add(v as T);
        }
        return [...seen];
    };
    const sections = pickList(r.sections, ids);
    for (const id of ids) if (!sections.includes(id)) sections.push(id);
    const rawOrder = (r.order && typeof r.order === 'object' ? r.order : {}) as Record<string, unknown>;
    const order = {} as Record<S, F[]>;
    for (const meta of metas) {
        const all = meta.fields.map((f) => f.id);
        const movable = meta.fields.filter((f) => !f.fixed).map((f) => f.id);
        const list = pickList(rawOrder[meta.id], movable);
        for (const id of movable) if (!list.includes(id)) list.push(id);
        // 位置固定的格子永遠排在區塊最後
        order[meta.id] = [...list, ...all.filter((id) => !movable.includes(id))];
    }
    const hidden = pickList(r.hidden, metas.flatMap((s) => s.fields.map((f) => f.id)));
    return { sections, order, hidden };
}

export function normalizeQuoteBoardFields(raw: QuoteBoardFieldsConfig | undefined | null): QuoteBoardFields {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
        index: normalizeLayout(INDEX_SECTIONS, r.index),
        stock: normalizeLayout(STOCK_SECTIONS, r.stock),
    };
}

const sameLayout = <S extends string, F extends string>(a: KindLayout<S, F>, b: KindLayout<S, F>) =>
    JSON.stringify(a.sections) === JSON.stringify(b.sections) &&
    JSON.stringify(a.order) === JSON.stringify(b.order) &&
    [...a.hidden].sort().join() === [...b.hidden].sort().join();

// 寫回存檔：和預設相同的那一種不存；兩種都是預設時回傳 undefined（版面存檔不多一個欄位）
export function compactQuoteBoardFields(fields: QuoteBoardFields): QuoteBoardFieldsConfig | undefined {
    const out: QuoteBoardFieldsConfig = {};
    if (!sameLayout(fields.index, DEFAULT_QUOTE_BOARD_FIELDS.index)) out.index = fields.index;
    if (!sameLayout(fields.stock, DEFAULT_QUOTE_BOARD_FIELDS.stock)) out.stock = fields.stock;
    return out.index || out.stock ? out : undefined;
}

export function isDefaultLayout(fields: QuoteBoardFields, kind: BoardKind): boolean {
    return kind === 'index'
        ? sameLayout(fields.index, DEFAULT_QUOTE_BOARD_FIELDS.index)
        : sameLayout(fields.stock, DEFAULT_QUOTE_BOARD_FIELDS.stock);
}

type AnyLayout = KindLayout<string, string>;

function withLayout(fields: QuoteBoardFields, kind: BoardKind, next: AnyLayout): QuoteBoardFields {
    return { ...fields, [kind]: next } as QuoteBoardFields;
}

function swap<T>(list: readonly T[], i: number, j: number): T[] {
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
}

export function toggleField(fields: QuoteBoardFields, kind: BoardKind, field: string): QuoteBoardFields {
    const layout = fields[kind] as AnyLayout;
    const hidden = layout.hidden.includes(field)
        ? layout.hidden.filter((f) => f !== field)
        : [...layout.hidden, field];
    return withLayout(fields, kind, { ...layout, hidden });
}

// delta：-1 往前、+1 往後；位置固定的格子不動、其他格子也不能換到它後面
export function moveField(fields: QuoteBoardFields, kind: BoardKind, field: string, delta: -1 | 1): QuoteBoardFields {
    const layout = fields[kind] as AnyLayout;
    const metas = (kind === 'index' ? INDEX_SECTIONS : STOCK_SECTIONS) as readonly SectionMeta<string, string>[];
    for (const meta of metas) {
        const list = layout.order[meta.id]!;
        const i = list.indexOf(field);
        if (i < 0) continue;
        const j = i + delta;
        const fixed = (id: string | undefined) => meta.fields.find((f) => f.id === id)?.fixed === true;
        if (j < 0 || j >= list.length || fixed(field) || fixed(list[j])) return fields;
        return withLayout(fields, kind, { ...layout, order: { ...layout.order, [meta.id]: swap(list, i, j) } });
    }
    return fields;
}

export function moveSection(fields: QuoteBoardFields, kind: BoardKind, section: string, delta: -1 | 1): QuoteBoardFields {
    const layout = fields[kind] as AnyLayout;
    const i = layout.sections.indexOf(section);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= layout.sections.length) return fields;
    return withLayout(fields, kind, { ...layout, sections: swap(layout.sections, i, j) });
}

export function resetKind(fields: QuoteBoardFields, kind: BoardKind): QuoteBoardFields {
    return withLayout(fields, kind, DEFAULT_QUOTE_BOARD_FIELDS[kind] as AnyLayout);
}

// 畫面用：依區塊順序列出要畫的格子（已排除隱藏的）
export function visibleFields<S extends string, F extends string>(layout: KindLayout<S, F>, section: S): F[] {
    return layout.order[section].filter((f) => !layout.hidden.includes(f));
}

export function isShown<F extends string>(layout: KindLayout<string, F>, field: F): boolean {
    return !layout.hidden.includes(field);
}

// 彈出視窗：面板的自訂欄位放進網址（qb=…），只帶和預設不同的部分
export function encodeQuoteBoardFields(config: QuoteBoardFieldsConfig | undefined): string | undefined {
    return config ? JSON.stringify(config) : undefined;
}

export function decodeQuoteBoardFields(raw: string | null): QuoteBoardFieldsConfig | undefined {
    if (!raw) return undefined;
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? compactQuoteBoardFields(normalizeQuoteBoardFields(parsed as QuoteBoardFieldsConfig)) : undefined;
    } catch {
        return undefined;
    }
}
