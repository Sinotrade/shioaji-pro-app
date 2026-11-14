// src/lib/shortcuts/registry.ts — 快捷鍵登錄表（唯一來源）
//
// 設定頁、提示頁、按鍵比對都讀這一份。兩種項目：
// - 由登錄表比對的（handled: 'registry'）：use-hotkeys、K 線圖、畫圖工具
//   在事件發生時用 matchesShortcut(id, e) 判斷，改鍵立即生效。
// - 元件自己處理的固定鍵（handled: 'component'）：Enter 送出、Esc 關閉等，
//   列出來讓使用者查得到，也讓改鍵時能偵測衝突；不開放修改。
//
// 安全原則（2026-11-06 產品決定）：
// - 全部刪單（Esc×2）第一版不開放改鍵；開關在本頁與 設定 → 風控。
// - 會送單的操作第一版不做快捷鍵；改方向的 B／S 只切換、不送單。
// - 交易相關按鍵只在主視窗作用；提示頁在彈出視窗也能開。

import { baseChord, chordText, isValidChord, parseChord, strongModifierCount, type Platform } from './keys';

// 作用範圍：global＝視窗內任何地方；其餘＝焦點（最後點選）在該類面板時
export type Scope = 'global' | 'ticket' | 'chart' | 'flash' | 'oddspread' | 'dock' | 'agent' | 'dialog' | 'native';
export type Category = 'general' | 'trade' | 'chart' | 'drawing' | 'flash' | 'agent' | 'dialog' | 'native';
// direction 改下單方向（不送單）；lock 影響委託線誤拖保護；edit 送出改單；
// send 送出委託；cancel 撤銷委託
export type Risk = 'none' | 'direction' | 'lock' | 'edit' | 'send' | 'cancel';
// free 可改；guarded 可改，改前要確認；fixed 不開放改
export type Tier = 'free' | 'guarded' | 'fixed';

export interface ShortcutDef {
    id: string;
    label: string;
    hint?: string;
    category: Category;
    scope: Scope;
    keys: string[]; // 預設鍵；空陣列＝預設不綁，可自行指定
    gesture?: string; // 滑鼠手勢（取代 keys 顯示）
    tier: Tier;
    risk: Risk;
    // 焦點在輸入框時是否仍會觸發
    typing: 'works' | 'blocked';
    // 哪些視窗有作用：main＝只有主視窗；any＝主視窗與彈出視窗
    window: 'main' | 'any';
    handled: 'registry' | 'component';
    status?: 'reserved' | 'disabled'; // reserved＝已保留、功能即將推出；disabled＝刻意停用的系統鍵
    requires?: 'escCancelAll';
    platform?: Platform;
}

export const CATEGORY_LABEL: Record<Category, string> = {
    general: '一般',
    trade: '下單與委託',
    chart: 'K 線圖',
    drawing: '畫圖工具',
    flash: '閃電下單與整零價差',
    agent: 'AI Agent 面板',
    dialog: '對話框與清單',
    native: '視窗與系統',
};

export const CATEGORY_ORDER: Category[] = ['general', 'trade', 'chart', 'drawing', 'flash', 'agent', 'dialog', 'native'];

export const SCOPE_LABEL: Record<Scope, string> = {
    global: '全域',
    ticket: '下單面板／組合單',
    chart: 'K 線圖',
    flash: '閃電下單',
    oddspread: '整零價差',
    dock: '委託列表',
    agent: 'Agent 面板',
    dialog: '對話框',
    native: '系統',
};

// 面板類型（BLOCK_META key）→ 作用範圍
export const PANEL_SCOPE: Partial<Record<string, Scope>> = {
    ticket: 'ticket',
    combo: 'ticket',
    chart: 'chart',
    flash: 'flash',
    oddspread: 'oddspread',
    dock: 'dock',
    assistant: 'agent',
};

type Extra = Partial<Omit<ShortcutDef, 'id' | 'label' | 'category' | 'scope' | 'keys'>>;

function def(id: string, label: string, category: Category, scope: Scope, keys: string[], extra: Extra = {}): ShortcutDef {
    return { id, label, category, scope, keys, tier: 'free', risk: 'none', typing: 'blocked', window: 'any', handled: 'registry', ...extra };
}

const fixed: Extra = { tier: 'fixed', handled: 'component' };

// 畫圖工具（id 對應 DrawingToolId；'draw.<tool>'）
export const DRAW_TOOL_SHORTCUTS: { tool: string; label: string; key: string | null }[] = [
    { tool: 'trend', label: '趨勢線', key: 'Alt+KeyT' },
    { tool: 'ray', label: '射線', key: null },
    { tool: 'extended', label: '延伸線', key: null },
    { tool: 'horizontal', label: '水平線', key: 'Alt+KeyH' },
    { tool: 'vertical', label: '垂直線', key: 'Alt+KeyV' },
    { tool: 'channel', label: '平行通道', key: 'Alt+KeyP' },
    { tool: 'box', label: '方框', key: 'Alt+KeyR' },
    { tool: 'fib', label: '斐波那契回撤', key: 'Alt+KeyF' },
    { tool: 'text', label: '文字註記', key: 'Alt+KeyN' },
    { tool: 'measure', label: '價差量測', key: 'Alt+KeyM' },
];

export const SHORTCUTS: ShortcutDef[] = [
    // ── 一般 ──
    def('help.open', '快捷鍵提示頁', 'general', 'global', ['Mod+Slash'], { typing: 'works', hint: '記得這一個就夠了：隨時叫出所有快捷鍵' }),
    def('palette.open', '商品搜尋與面板指令', 'general', 'global', ['Mod+KeyK'], { typing: 'works', window: 'main' }),
    def('agent.toggle', '開關頂欄 AI Agent', 'general', 'global', ['Mod+KeyJ'], { typing: 'works', window: 'main', status: 'reserved', hint: '頂欄 Agent 面板推出後生效，按鍵已保留' }),
    def('settings.open', '開啟設定', 'general', 'global', ['Mod+Comma'], { typing: 'works', window: 'main' }),

    // ── 下單與委託 ──
    def('ticket.buy', '切到買進', 'trade', 'ticket', ['KeyB'], {
        tier: 'guarded', risk: 'direction', window: 'main',
        hint: '只作用在目前選取的下單面板或組合單；只切方向、不送單。Shift+B 不觸發，Caps Lock 不影響',
    }),
    def('ticket.sell', '切到賣出', 'trade', 'ticket', ['KeyS'], {
        tier: 'guarded', risk: 'direction', window: 'main',
        hint: '只作用在目前選取的下單面板或組合單；只切方向、不送單。Shift+S 不觸發，Caps Lock 不影響',
    }),
    def('orders.cancelAll', '全部刪單', 'trade', 'global', ['Escape*2'], {
        tier: 'fixed', risk: 'cancel', window: 'main', requires: 'escCancelAll',
        hint: '0.6 秒內連按兩次 Esc，撤銷所有未成交委託；第一下會先跳提示。閃電下單啟用中時，Esc 只解除閃電下單，不算第一下',
    }),
    def('dock.submitEdit', '送出改價／改量', 'trade', 'dock', ['Enter'], { ...fixed, risk: 'edit', typing: 'works', window: 'main', hint: '委託列表的行內編輯框' }),
    def('dock.cancelEdit', '取消改價／改量', 'trade', 'dock', ['Escape'], { ...fixed, typing: 'works', window: 'main' }),

    // ── K 線圖 ──
    def('chart.lockOrders', '鎖定／解鎖委託線', 'chart', 'chart', ['Mod+KeyL'], { tier: 'guarded', risk: 'lock', hint: '解鎖後委託線可拖曳改價' }),
    def('chart.toggleDrawings', '隱藏／顯示全部畫圖', 'chart', 'chart', ['Alt+Shift+KeyH'], { hint: '有顯示中的物件就全部隱藏，否則全部顯示' }),
    def('chart.lockDrawings', '鎖定／解鎖全部畫圖', 'chart', 'chart', [], { hint: '預設未設定，可自行指定' }),
    def('chart.dragCancel', '取消拖曳中的委託線', 'chart', 'chart', ['Escape'], { ...fixed, window: 'main' }),

    // ── 畫圖工具 ──
    ...DRAW_TOOL_SHORTCUTS.map((t) => def(`draw.${t.tool}`, t.label, 'drawing', 'chart', t.key ? [t.key] : [], t.key ? {} : { hint: '預設未設定，可自行指定' })),
    def('draw.undo', '復原', 'drawing', 'chart', ['Mod+KeyZ'], { tier: 'fixed' }),
    def('draw.redo', '重做', 'drawing', 'chart', ['Mod+Shift+KeyZ', 'Mod+KeyY'], { tier: 'fixed' }),
    def('draw.delete', '刪除選取的物件', 'drawing', 'chart', ['Delete', 'Backspace'], { ...fixed }),
    def('draw.escape', '取消畫圖／量測／選取', 'drawing', 'chart', ['Escape'], { ...fixed, hint: '用掉的 Esc 不會算進全部刪單' }),

    // ── 閃電下單與整零價差 ──
    def('flash.disarm', '解除閃電下單', 'flash', 'flash', ['Escape'], { ...fixed, hint: '啟用中才有作用；這一下不算全部刪單的第一下' }),
    def('flash.trigger', '掛觸價單', 'flash', 'flash', [], { ...fixed, risk: 'send', gesture: 'Alt＋點價格列', hint: '啟用中才有作用' }),
    def('flash.recenter', '置中到成交價', 'flash', 'flash', [], { ...fixed, gesture: '雙擊價格表' }),
    def('oddspread.disarm', '解除整零價差', 'flash', 'oddspread', ['Escape'], { ...fixed, hint: '啟用中才有作用；這一下不算全部刪單的第一下' }),

    // ── AI Agent 面板 ──
    def('agent.send', '送出訊息', 'agent', 'agent', ['Enter'], { ...fixed, typing: 'works' }),
    def('agent.newline', '換行', 'agent', 'agent', ['Shift+Enter'], { ...fixed, typing: 'works' }),
    def('agent.stop', '停止目前回合', 'agent', 'agent', ['Escape'], { ...fixed, typing: 'works', hint: '執行中才有作用' }),
    def('agent.recallQueued', '收回排隊中的訊息', 'agent', 'agent', ['Alt+ArrowUp'], { ...fixed, typing: 'works' }),

    // ── 對話框與清單 ──
    def('dialog.close', '關閉最上層對話框', 'dialog', 'dialog', ['Escape'], { ...fixed, typing: 'works', hint: '用來關閉的 Esc 不會算進全部刪單' }),
    def('dialog.navigate', '在清單中移動', 'dialog', 'dialog', ['ArrowUp', 'ArrowDown'], { ...fixed, typing: 'works' }),
    def('dialog.confirm', '選定目前項目', 'dialog', 'dialog', ['Enter'], { ...fixed, typing: 'works' }),

    // ── 視窗與系統 ──
    def('native.showMain', '回到主視窗', 'native', 'native', ['Mod+Digit0'], { ...fixed, typing: 'works', platform: 'mac' }),
    def('native.close', '關閉視窗', 'native', 'native', ['Mod+KeyW'], { ...fixed, typing: 'works', platform: 'mac', hint: '主視窗是隱藏到選單列，服務繼續執行' }),
    def('native.minimize', '最小化', 'native', 'native', ['Mod+KeyM'], { ...fixed, typing: 'works', platform: 'mac' }),
    def('native.quit', '結束 App', 'native', 'native', ['Mod+KeyQ'], { ...fixed, typing: 'works', platform: 'mac' }),
    def('native.reload', '重新整理（已停用）', 'native', 'native', ['F5', 'Mod+KeyR'], {
        ...fixed, typing: 'works', platform: 'win', status: 'disabled', hint: '避免盤中誤按讓畫面重新載入',
    }),
    def('native.print', '列印（已停用）', 'native', 'native', ['Mod+KeyP'], { ...fixed, typing: 'works', platform: 'win', status: 'disabled' }),
];

const BY_ID = new Map(SHORTCUTS.map((d) => [d.id, d]));
export const defById = (id: string) => BY_ID.get(id);

export const forPlatform = (platform: Platform) => SHORTCUTS.filter((d) => !d.platform || d.platform === platform);

export type Overrides = Readonly<Record<string, readonly string[]>>;

export function effectiveKeys(d: ShortcutDef, overrides: Overrides): readonly string[] {
    return overrides[d.id] ?? d.keys;
}

export const isEditable = (d: ShortcutDef) => d.tier !== 'fixed' && !d.gesture;

// ---- 改鍵檢查 ----

// 兩平台都保留：編輯與焦點操作
const RESERVED_BOTH: Record<string, string> = {
    Escape: '關閉與取消',
    Enter: '確認與送出',
    Tab: '切換焦點',
    'Shift+Tab': '切換焦點',
    Space: '按鈕操作',
    Backspace: '刪除文字',
    Delete: '刪除文字',
    ArrowUp: '清單移動',
    ArrowDown: '清單移動',
    ArrowLeft: '游標移動',
    ArrowRight: '游標移動',
    'Mod+KeyC': '複製',
    'Mod+KeyV': '貼上',
    'Mod+KeyX': '剪下',
    'Mod+KeyA': '全選',
};

const RESERVED: Record<Platform, Record<string, string>> = {
    mac: {
        'Mod+KeyQ': '結束 App',
        'Mod+KeyW': '關閉視窗',
        'Mod+KeyH': '隱藏 App',
        'Mod+KeyM': '最小化',
        'Mod+Digit0': '回到主視窗',
        'Mod+Tab': '切換 App',
        'Mod+Space': '系統搜尋',
        'Mod+Alt+KeyH': '隱藏其他 App',
        'Ctrl+Mod+KeyF': '全螢幕',
        'Mod+Shift+Slash': '系統說明選單',
        'Ctrl+Space': '切換輸入法',
    },
    win: {
        F5: '重新整理（已停用）',
        'Mod+KeyR': '重新整理（已停用）',
        'Mod+Shift+KeyR': '重新整理（已停用）',
        'Mod+KeyP': '列印（已停用）',
        'Mod+KeyF': '頁內尋找',
        F3: '頁內尋找',
        F12: '開發者工具',
        'Mod+Shift+KeyI': '開發者工具',
        'Alt+F4': '關閉視窗',
        'Alt+Tab': '切換 App',
        'Alt+Space': '視窗選單',
        'Mod+Space': '切換輸入法',
    },
};

export function reservedReason(chord: string, platform: Platform): string | null {
    const c = baseChord(chord);
    return RESERVED_BOTH[c] ?? RESERVED[platform][c] ?? null;
}

// 兩個作用範圍會不會同時收到同一個按鍵
function scopesOverlap(a: Scope, b: Scope): boolean {
    if (a === b) return true;
    // 系統選單攔在網頁之前，跟所有範圍都衝突
    if (a === 'native' || b === 'native') return true;
    // 對話框開著時鍵盤歸對話框；全域鍵（⌘K、⌘/）在對話框外才作用 —
    // 但同一個鍵會讓使用者混淆，一律視為衝突
    return a === 'global' || b === 'global' || a === 'dialog' || b === 'dialog';
}

export type BindingCheck =
    | { level: 'ok' }
    | { level: 'note'; message: string } // 可以用，但先提醒
    | { level: 'confirm'; message: string; note?: string } // 有風險，要使用者確認
    | { level: 'conflict'; message: string; other: ShortcutDef } // 跟可改的項目衝突，可取代
    | { level: 'block'; message: string }; // 不能用

const RISK_TEXT: Partial<Record<Risk, string>> = {
    direction: '下單方向',
    lock: '委託線鎖定',
};

export function checkBinding(d: ShortcutDef, chord: string, overrides: Overrides, platform: Platform): BindingCheck {
    if (!isEditable(d)) return { level: 'block', message: `「${d.label}」是固定按鍵，不開放修改` };
    const parsed = parseChord(chord);
    if (!parsed || parsed.twice) return { level: 'block', message: '無法辨識這個按鍵' };
    const text = chordText(chord, platform);

    const reserved = reservedReason(chord, platform);
    if (reserved) return { level: 'block', message: `${text} 保留給「${reserved}」，請換一個鍵` };

    const strong = strongModifierCount(chord);
    // 影響誤拖保護：至少一個 ⌘／Ctrl／⌥／Alt
    if (d.risk === 'lock' && strong === 0) {
        return { level: 'block', message: '委託線鎖定要搭配 ⌘／Ctrl 或 ⌥／Alt，避免誤觸後委託線可被拖動' };
    }
    // 切方向：維持單鍵操作，但只接受字母（不用數字、方向鍵、功能鍵）
    if (d.risk === 'direction' && strong === 0 && !/^(Shift\+)?Key[A-Z]$/.test(chord)) {
        return { level: 'block', message: '切換買賣方向只能用字母，或搭配 ⌘／Ctrl、⌥／Alt' };
    }
    // 單獨的 Shift＋非字母容易跟打字混淆（例如 ? ! +）
    if (strong === 0 && parsed.mods.includes('Shift') && !/^Key[A-Z]$/.test(parsed.code)) {
        return { level: 'block', message: 'Shift 只能搭配字母；其他按鍵請加 ⌘／Ctrl 或 ⌥／Alt' };
    }

    for (const other of forPlatform(platform)) {
        if (other.id === d.id || other.gesture || other.status === 'disabled') continue;
        if (!effectiveKeys(other, overrides).some((k) => baseChord(k) === chord)) continue;
        if (!scopesOverlap(d.scope, other.scope)) continue;
        const where = `「${other.label}」（${SCOPE_LABEL[other.scope]}）`;
        if (!isEditable(other) || other.risk !== 'none') {
            return { level: 'block', message: `${text} 已用於${where}，這個項目不能被取代，請換一個鍵` };
        }
        return { level: 'conflict', message: `${text} 已用於${where}`, other };
    }

    if (d.risk !== 'none') {
        return {
            level: 'confirm',
            message: `這個鍵會操作「${RISK_TEXT[d.risk] ?? d.label}」。確定改成 ${text}？`,
            note: d.risk === 'direction' ? '只換按鍵：仍然只切方向、不送單，也只作用在目前選取的下單面板。' : undefined,
        };
    }
    if (strong === 0) {
        return { level: 'note', message: `${text} 是單鍵：焦點在輸入框時不會觸發；開中文輸入法時要先點一下面板` };
    }
    return { level: 'ok' };
}

// 從 localStorage 讀回的覆寫值：去掉未知項目、固定鍵、格式錯誤與現在已不合法的鍵
export function sanitizeOverrides(raw: unknown, platform: Platform): Record<string, string[]> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
        const d = defById(id);
        if (!d || !isEditable(d) || !Array.isArray(keys)) continue;
        const valid = keys.filter((k): k is string => typeof k === 'string' && isValidChord(k) && !k.endsWith('*2'));
        if (valid.length !== keys.length || valid.length > 2) continue;
        out[id] = valid;
    }
    // 第二輪：逐項確認現在仍合法（例如之後新增了保留鍵，或兩個覆寫撞到同一鍵）；
    // 不合法的回到預設
    for (const id of Object.keys(out)) {
        const d = defById(id)!;
        const others = { ...out };
        delete others[id];
        const bad = out[id]!.some((k) => {
            const level = checkBinding(d, k, others, platform).level;
            return level === 'block' || level === 'conflict';
        });
        if (bad) delete out[id];
    }
    return out;
}

// ---- 提示頁：目前可不可以用 ----

export type Availability =
    | { state: 'now' }
    | { state: 'elsewhere'; reason: string }
    | { state: 'off'; reason: string }
    | { state: 'reserved' }
    | { state: 'disabled' };

export interface AvailabilityContext {
    panel: string | null; // 目前選取的面板類型
    escCancelAll: boolean;
    role: 'main' | 'popout';
}

export function availability(d: ShortcutDef, ctx: AvailabilityContext): Availability {
    if (d.status === 'reserved') return { state: 'reserved' };
    if (d.status === 'disabled') return { state: 'disabled' };
    if (d.window === 'main' && ctx.role !== 'main') return { state: 'elsewhere', reason: '只在主視窗' };
    if (d.requires === 'escCancelAll' && !ctx.escCancelAll) return { state: 'off', reason: '未啟用' };
    if (d.scope === 'global' || d.scope === 'native') return { state: 'now' };
    if (d.scope === 'dialog') return { state: 'elsewhere', reason: '對話框開著時' };
    if (ctx.panel && PANEL_SCOPE[ctx.panel] === d.scope) return { state: 'now' };
    const label = SCOPE_LABEL[d.scope];
    // 英文開頭的名稱（Agent 面板）前面補空格
    return { state: 'elsewhere', reason: /^[A-Za-z]/.test(label) ? `選取 ${label}時` : `選取${label}時` };
}
