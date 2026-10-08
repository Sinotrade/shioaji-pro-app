import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

const SIM = 'http://127.0.0.1:21322|simulation';
const mocks = vi.hoisted(() => ({
    place: vi.fn(),
    ensure: vi.fn(),
    prime: vi.fn(),
    search: vi.fn(),
    snapshots: vi.fn(),
    notify: vi.fn(),
    capture: vi.fn(),
    env: 'http://127.0.0.1:21322|simulation' as string | null,
    accounts: {} as Record<'S' | 'F', Account | undefined>,
    live: true,
    simulation: true,
    list: [] as Account[],
    tradeable: true,
    cachedMetadata: false,
    tickTime: '',
    snapTime: '',
    ticks: {} as Record<string, string | undefined>,
    quoted: [] as (string | null)[],
    snaps: {} as Record<string, number | undefined>,
    snapErr: {} as Record<string, string | undefined>,
    refresh: vi.fn(),
    refreshAccounts: vi.fn(),
    accountLoadError: false,
    queries: {} as Record<string, () => Promise<unknown>>,
}));
vi.mock('../hooks/use-stream', () => ({
    useQuote: (code: string | null) => {
        mocks.quoted.push(code);
        return code && mocks.ticks[code] ? { tick: { close: mocks.ticks[code], date: mocks.tickTime.split('T')[0], time: mocks.tickTime.split('T')[1] } } : undefined;
    },
    useTradingLive: () => mocks.live,
}));
// 依 key 回對應商品的快照收盤價（不是依位置）
vi.mock('../hooks/use-query', () => ({
    useQuery: (fetcher: () => Promise<unknown>, key: string, enabled = true) => {
        mocks.queries[key] = fetcher;
        return { data: enabled && mocks.snaps[key] !== undefined ? { close: mocks.snaps[key], datetime: mocks.snapTime } : undefined, error: mocks.snapErr[key] ?? null, refresh: mocks.refresh };
    },
}));
vi.mock('../lib/trade', () => ({ placeQuickOrder: mocks.place, notify: mocks.notify }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: mocks.ensure, primeContract: mocks.prime, useContract: (code: string) => mocks.cachedMetadata ? contracts[code] : undefined }));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/shioaji', async (orig) => ({ ...(await orig<object>()), fetchSnapshots: mocks.snapshots }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => mocks.env }));
vi.mock('../lib/order-account', () => ({
    captureSelectedAccount: mocks.capture,
    isSelectedAccountUnchanged: (a: Account) => a === mocks.accounts[a.account_type as 'S' | 'F'],
    ACCOUNT_CHANGED_MESSAGE: '確認期間帳戶已變更或不可用，未送出，請重新確認',
}));

vi.mock('../lib/account-store', () => ({
    useAccounts: () => ({ accounts: mocks.list, selectedStock: mocks.accounts.S, selectedFutures: mocks.accounts.F }),
    refreshAccounts: mocks.refreshAccounts,
    getAccountState: () => ({ loadError: mocks.accountLoadError }),
}));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => ({ simulation: mocks.simulation }) }));
vi.mock('../lib/account-tradable', () => ({ canTrade: () => mocks.tradeable }));

import { SimTestOrderSection } from './settings-test-order';
import * as css from './settings-test-order.css';

const stockAccount: Account = { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: '', username: '甲' };
const futuresAccount: Account = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: true, person_id: '', username: '乙' };
const fut = (code: string, name: string, extra: object = {}) => ({
    code, name, security_type: 'FUT', exchange: 'TAIFEX', limit_up: 55000, limit_down: 45000, tick: 1, ...extra,
});
const contracts: Record<string, Record<string, unknown>> = {
    '2890': { code: '2890', name: '永豐金', security_type: 'STK', limit_up: 2700, limit_down: 2210, tick: 5 },
    '2317': { code: '2317', name: '鴻海', security_type: 'STK', limit_up: 250, limit_down: 200, tick: 0.5 },
    TXFR1: fut('TXFR1', '臺股期貨', { target_code: 'TXFJ6' }),
    TXFR2: fut('TXFR2', '臺股期貨'),
    MXFR1: fut('MXFR1', '小型臺指'),
    MXFR2: fut('MXFR2', '小型臺指'),
    TMFR1: fut('TMFR1', '微型臺指'),
    TMFR2: fut('TMFR2', '微型臺指'),
    CDFR1: fut('CDFR1', '台積電期貨', { limit_up: 2700, limit_down: 2210, tick: 5 }),
};
const sug = (code: string, extra: object = {}) => {
    const c = contracts[code]!;
    return { code, name: c.name, security_type: c.security_type, exchange: '', detail: '', contract: c, ...extra };
};
const hon = { code: '2317', name: '鴻海', security_type: 'STK', exchange: 'TSE', detail: '股票' };
const SEARCH: Record<string, object[]> = {
    鴻海: [hon],
    // 實測只回小台；這裡另外加 TXFR1 是為了測別名去重
    台指: [sug('MXFR1'), sug('TXFR1')],
    台積電期: [sug('CDFR1')],
};

const TRADE = { order: { id: 'abcdef1234567890', seqno: '000123' }, status: { id: 'ORD-1', status: 'Submitted' } };

let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.env = SIM;
    mocks.accounts = { S: stockAccount, F: futuresAccount };
    mocks.live = true;
    mocks.simulation = true;
    mocks.list = [stockAccount, futuresAccount];
    mocks.accountLoadError = false;
    mocks.refreshAccounts.mockReset().mockResolvedValue(undefined);
    mocks.tradeable = true;
    mocks.tickTime = mocks.snapTime = "";
    mocks.cachedMetadata = false;
    mocks.snapErr = {};
    mocks.ticks = { '2890': '2455', TXFR1: '50000', MXFR1: '50010', CDFR1: '2460', '2317': '220' };
    mocks.quoted = [];
    mocks.snaps = {};
    mocks.queries = {};
    mocks.capture.mockImplementation((t: 'S' | 'F') => mocks.accounts[t]);
    mocks.ensure.mockImplementation(async (code: string) => {
        if (!contracts[code]) throw new Error('404');
        return contracts[code];
    });
    mocks.search.mockImplementation(async (q: string) => SEARCH[q] ?? []);
    mocks.place.mockImplementation(async (...args) => { args[4].beforeSend(); return TRADE; });
});
afterEach(async () => {
    if (view) await act(async () => { for (const b of view!.root.findAllByType('button').filter(b => textOf(b) === '我已核對委託')) b.props.onClick(); });
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
});

const text = () => JSON.stringify(view!.toJSON());
const textOf = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const render = async () => { await act(async () => { view = create(createElement(SimTestOrderSection)); }); };
// 現價與送出是不同操作，依可見名稱找現價按鈕。
const buttons = () => view!.root.findAll((n) => n.type === 'button' && String(n.props.className).includes(css.sendBtn));
const currentPrices = () => view!.root.findAll((n) => n.type === 'button' && textOf(n) === '現價');
const icons = (n: ReactTestInstance) => n.findAll((x) => x.type === 'svg').map((x) => String(x.props.className));
const products = () => view!.root.findAll((n) => n.type === 'input' && n.props.role === 'combobox');
const prices = () => view!.root.findAll((n) => n.type === 'input' && n.props.inputMode === 'decimal');
const rowStatus = (i: number) => view!.root.findAll((n) => n.type === 'span' && n.props.role === 'status' && n.props.id)[i]!;
const options = () => view!.root.findAll((n) => typeof n.type === 'string' && n.props.role === 'option');
const optionTexts = () => options().map(textOf);
const click = async (i: number) => { await act(async () => { await buttons()[i]!.props.onClick(); }); };
const setPrice = async (i: number, value: string) => { await act(async () => { prices()[i]!.props.onChange({ target: { value } }); }); };
const focusPrice = async (i: number) => { await act(async () => { prices()[i]!.props.onFocus(); }); };
const blurPrice = async (i: number) => { await act(async () => { prices()[i]!.props.onBlur(); }); };
const type = async (i: number, value: string) => {
    await act(async () => { products()[i]!.props.onChange({ target: { value } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
};
const pickOption = async (i: number) => {
    await act(async () => {
        options()[i]!.props.onMouseDown({ button: 0, preventDefault() {} });
        options()[i]!.props.onClick();
    });
};
const key = async (i: number, k: string, ime: { isComposing?: boolean; keyCode?: number } = {}) => {
    await act(async () => {
        products()[i]!.props.onKeyDown({ key: k, keyCode: ime.keyCode ?? 0, nativeEvent: { isComposing: !!ime.isComposing }, preventDefault() {} });
    });
};

it('labels product fields by market and verification, with live prices and no search on mount', async () => {
    await render();
    // 只看畫面文字（text() 含 aria-label 等 props，永遠含「商品」「價位」）
    const visible = textOf(view!.root);
    expect(visible).toContain('委託價');
    // 別名背後的實際送單代碼不用 hover 就看得到
    expect(visible).toContain('2890');
    expect(visible).toContain('TXFR1');
    expect(products().map((i) => i.props.value)).toEqual(['永豐金', '台指近']);
    expect(prices().map((i) => i.props.value)).toEqual(['2,455', '50,000']);
    expect(products().every((i) => i.props['aria-expanded'] === false)).toBe(true);
    // 清單收起時 aria-controls 不指向不存在的元素
    expect(products().every((i) => i.props['aria-controls'] === undefined)).toBe(true);
    // 兩列控制項的名稱聽得出是哪個商品
    expect(prices().map((i) => i.props['aria-label'])).toEqual(['永豐金 價位', '台指近 價位']);
    // 簡短的可見操作仍要帶出商品、方向與數量。
    for (const [i, product] of ['永豐金 2890', '台指近 TXFR1'].entries()) {
        expect(buttons()[i]!.props['aria-label']).toContain(product);
        expect(buttons()[i]!.props['aria-label']).toContain('買進');
        expect(buttons()[i]!.props['aria-label']).toContain(i === 0 ? '1 張' : '1 口');
    }
    expect(buttons().map((b) => textOf(b))).toEqual(['測試', '測試']);
    for (const b of buttons()) expect(b.props['aria-label'].startsWith(textOf(b))).toBe(true);
    expect(currentPrices()).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mocks.search).not.toHaveBeenCalled();
});

it('sends 1 lot of 2890 at the live trade price with the captured stock account', async () => {
    await render();
    await click(0);
    expect(mocks.ensure).toHaveBeenCalledWith('2890', 'STK');
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith('S');
    const [contract, action, price, qty, opts] = mocks.place.mock.calls[0]!;
    expect(contract.code).toBe('2890');
    expect([action, price, qty]).toEqual(['Buy', 2455, 1]);
    expect(opts.account).toBe(stockAccount);
    expect(opts.bypassRisk).toBeUndefined();
    expect(opts.source).toBeUndefined();
    // 成功也寫進常駐的 live region，VoiceOver 才唸得到
    // 回顯實際送出的方向／數量／價格，委託號用 seqno（與下單面板一致）
    expect(textOf(rowStatus(0).findByProps({ className: css.resultHeading }))).toMatch(/^已送出 · 回應 \d+ ms$/);
    expect(textOf(rowStatus(0).findByProps({ className: css.resultDetails }))).toBe('買進 1 張 · 送出委託價 2,455 · 委託 000123');
    expect(icons(rowStatus(0))[0]).toContain('lucide-circle-check');
    expect(rowStatus(0).props.className).toContain(css.statusOk);
    expect(mocks.notify).not.toHaveBeenCalled();
});

it('sends 1 contract of TXFR1 at 50000 with the captured futures account', async () => {
    await render();
    await click(1);
    expect(mocks.ensure).toHaveBeenCalledWith('TXFR1', 'FUT');
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith('F');
    const [contract, action, price, qty, opts] = mocks.place.mock.calls[0]!;
    expect(contract.code).toBe('TXFR1');
    expect([action, price, qty]).toEqual(['Buy', 50000, 1]);
    expect(opts.account).toBe(futuresAccount);
    expect(text()).toContain('已送出');
});

it.each([
    ['２１．５０', '21.50', '21.50', 21.5],
    ['２１．', '21.', '21.', 21],
])('preserves editable precision for %s while formatting only the displayed price', async (typed, raw, formatted, numeric) => {
    const previous = contracts['2890'];
    contracts['2890'] = { ...previous, limit_up: 23.65, limit_down: 19.35, tick: 0.05 };
    mocks.ticks['2890'] = '21.5';
    try {
        await render();
        expect(prices()[0]!.props.value).toBe('21.5');
        await focusPrice(0);
        expect(prices()[0]!.props.value).toBe('21.5');
        await setPrice(0, typed);
        expect(prices()[0]!.props.value).toBe(raw);
        await setPrice(0, '-2460');
        expect(prices()[0]!.props.value).toBe(raw);
        await blurPrice(0);
        expect(prices()[0]!.props.value).toBe(formatted);
        await focusPrice(0);
        expect(prices()[0]!.props.value).toBe(raw);
        await blurPrice(0);
        await click(0);
        expect(mocks.place).toHaveBeenCalledTimes(1);
        expect(mocks.place.mock.calls[0]![2]).toBe(numeric);
    } finally {
        contracts['2890'] = previous!;
    }
});

it.each([
    ['４９，０００．００', '49000.00', '49,000.00'],
    ['４９，０００．', '49000.', '49,000.'],
])('preserves grouping and unfinished decimals for %s across price focus and blur', async (typed, raw, formatted) => {
    await render();
    expect(prices()[1]!.props.value).toBe('50,000');
    await focusPrice(1);
    expect(prices()[1]!.props.value).toBe('50000');
    await setPrice(1, typed);
    expect(prices()[1]!.props.value).toBe(raw);
    await blurPrice(1);
    expect(prices()[1]!.props.value).toBe(formatted);
    await focusPrice(1);
    expect(prices()[1]!.props.value).toBe(raw);
    await blurPrice(1);
    await click(1);
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(mocks.place.mock.calls[0]![2]).toBe(49000);
});

it('keeps the submitted futures price in the receipt when the next quote changes the input', async () => {
    mocks.ticks.TXFR1 = '49000';
    await render();
    await click(1);
    expect(mocks.place.mock.calls[0]![2]).toBe(49000);
    mocks.ticks.TXFR1 = '48993';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[1]!.props.value).toBe('48,993');
    expect(textOf(rowStatus(1).findByProps({ className: css.resultDetails }))).toBe('買進 1 口 · 送出委託價 49,000 · 委託 000123');
    expect(mocks.place).toHaveBeenCalledTimes(1);
});

it('omits response timing when a successful wrapper never reports beforeSend', async () => {
    mocks.place.mockResolvedValue(TRADE);
    await render();
    await click(0);
    expect(textOf(rowStatus(0).findByProps({ className: css.resultHeading }))).toBe('已送出');
    expect(textOf(rowStatus(0).findByProps({ className: css.resultDetails }))).toBe('買進 1 張 · 送出委託價 2,455 · 委託 000123');
    expect(textOf(rowStatus(0))).not.toContain('回應');
});

it('uses the edited price, ignores non-numeric input and refuses a zero price', async () => {
    await render();
    await setPrice(0, '2500');
    await click(0);
    expect(mocks.place.mock.calls[0]![2]).toBe(2500);
    mocks.place.mockClear();
    await setPrice(0, 'abc');
    expect(prices()[0]!.props.value).toBe('2,500');
    // 全形數字與千分位逗號照收
    await setPrice(0, '２，４６０');
    expect(prices()[0]!.props.value).toBe('2,460');
    await setPrice(0, '0');
    await click(0);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(textOf(buttons()[0]!)).toBe('請輸入價位');

});

it('refuses a price off the tick grid without changing it', async () => {
    await render();
    await setPrice(0, '2454');
    await click(0);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text()).toContain('未送出：價格不符合跳動單位（最近的是 2455）');
    expect(prices()[0]!.props.value).toBe('2,454');
});

it('refuses a price outside the limit band', async () => {
    await render();
    await setPrice(1, '60000');
    await click(1);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text()).toContain('未送出：價格超出漲跌停（45000～55000）');
    await setPrice(1, '40000');
    await click(1);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text()).toContain('未送出：價格超出漲跌停（45000～55000）');
    expect(mocks.notify).not.toHaveBeenCalled();
});

it('classifies a contract lookup failure as 未送出', async () => {
    mocks.ensure.mockRejectedValue(new Error('404'));
    await render();
    await click(0);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text()).toContain('未送出：無法取得商品 2890：404');
    expect(text()).not.toContain('結果未知');
    expect(mocks.notify).not.toHaveBeenCalled();
});

it.each([
    ['security type', { security_type: 'FUT' }],
    ['code', { code: '2331' }],
])('refuses at send time when the resolved contract has a different %s', async (_, patch) => {
    // 真的 ensureContract 命中快取時只看 code、不看 type，送出前必須自己比對
    mocks.ensure.mockImplementation(async (c: string) => (c === '2890' ? { ...contracts['2890'], ...patch } : contracts[c]));
    await render();
    await click(0);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text()).toContain('未送出：此商品不支援測試單');
});

it.each(['http://127.0.0.1:21322|production', null])('refuses to send when the env is %s', async (env) => {
    mocks.env = env;
    await render();
    await click(0);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.place).not.toHaveBeenCalled();
    expect(textOf(buttons()[0]!)).toBe('非模擬環境');
});

it('refuses without a captured account for that market', async () => {
    mocks.accounts = { S: undefined, F: futuresAccount };
    await render();
    await click(0);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(textOf(buttons()[0]!)).toBe('未選帳戶');
});

it('beforeSend throws once the env or account changes after capture', async () => {
    await render();
    await click(0);
    const opts = mocks.place.mock.calls[0]![4];
    expect(opts.isAccountCurrent()).toBe(true);
    expect(() => opts.beforeSend()).not.toThrow();
    mocks.env = 'http://127.0.0.1:21322|production';
    expect(() => opts.beforeSend()).toThrow('伺服器或模式已切換');
    // 同為 simulation 但 base 不同（sidecar 換 port）也算切換
    mocks.env = 'http://127.0.0.1:21323|simulation';
    expect(() => opts.beforeSend()).toThrow('伺服器或模式已切換');
    mocks.env = SIM;
    mocks.accounts = { ...mocks.accounts, S: { ...stockAccount, account_id: 'OTHER' } };
    expect(() => opts.beforeSend()).toThrow('確認期間帳戶已變更或不可用，未送出，請重新確認');
    expect(opts.isAccountCurrent()).toBe(false);
});

it('returns to idle silently when the confirmation is cancelled', async () => {
    const cancelled = new Error('cancelled');
    cancelled.name = 'OrderConfirmCancelled';
    mocks.place.mockRejectedValue(cancelled);
    await render();
    await click(0);
    expect(text()).not.toContain('結果未知');
    expect(text()).not.toContain('cancelled');
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(buttons()[0]!.props['aria-disabled']).toBe(false);
});

// mutationNotStarted 涵蓋本機拒絕與券商回 Failed（委託已到券商但被拒），所以用「未成立」。
it.each(['風控封鎖', '委託被拒絕（Failed）'])('reports a flagged refusal %s as 未成立', async message => {
    mocks.place.mockRejectedValue(Object.assign(new Error(message), { mutationNotStarted: true }));
    await render();
    await click(0);
    expect(textOf(rowStatus(0))).toBe(`未成立：${message}`);
    expect(rowStatus(0).props.className).toContain(css.statusError);
    expect(textOf(buttons()[0]!)).toBe('測試');
    expect(mocks.notify).not.toHaveBeenCalled();
});

it('reports any other failure as 結果未知, and keeps it through later edits', async () => {
    mocks.place.mockRejectedValue(new Error('timeout'));
    await render();
    await click(0);
    expect(textOf(rowStatus(0))).toContain('結果未知：timeout。請到「委託」核對是否已成立，確認前不要再按「測試」');
    // 外觀和可修正重試的錯誤不同：不同 class、不同圖示
    expect(rowStatus(0).props.className).toContain(css.statusUnknown);
    expect(rowStatus(0).props.className).not.toContain(css.statusError);
    expect(icons(rowStatus(0))).toEqual([expect.stringContaining(css.unknownIcon)]);
    expect(mocks.notify).not.toHaveBeenCalled();
    // 「勿重送」不能因為打字、離開商品框或改價就消失
    await type(0, '鴻');
    await act(async () => { products()[0]!.props.onBlur(); });
    await setPrice(0, '2460');
    expect(textOf(rowStatus(0))).toContain('結果未知');
});

it('clears a local refusal once the price is edited', async () => {
    await render();
    await setPrice(0, '2454');
    await click(0);
    expect(textOf(rowStatus(0))).toContain('價格不符合跳動單位');
    await setPrice(0, '2455');
    expect(textOf(rowStatus(0))).toBe('');
});

it('disables both rows, including the product inputs, while one is sending', async () => {
    let resolve!: (v: unknown) => void;
    mocks.place.mockReturnValue(new Promise((r) => { resolve = r; }));
    await render();
    await setPrice(1, '49000');
    let pending!: Promise<void>;
    await act(async () => { pending = buttons()[0]!.props.onClick(); });
    expect(buttons().map((b) => b.props['aria-disabled'])).toEqual([true, true]);
    expect(products().map((i) => i.props.disabled)).toEqual([true, true]);
    // 價位也鎖住：畫面上的價格就是送出／確認中的那個
    expect(prices().map((i) => i.props.disabled)).toEqual([true, true]);
    expect(currentPrices().map(b => b.props.disabled)).toEqual([true, true]);
    await act(async () => currentPrices()[1]!.props.onClick());
    expect(prices()[1]!.props.value).toBe('49,000');
    expect(text()).toContain('傳送中…');
    // 另一列為什麼停用，要有看得到的原因
    expect(textOf(view!.root)).toContain('有一筆測試單傳送中，完成前暫停送出');
    // 送出中再觸發任一列也不會重送
    await act(async () => { await buttons()[0]!.props.onClick(); await buttons()[1]!.props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(TRADE); await pending; });
    expect(buttons().map((b) => b.props['aria-disabled'])).toEqual([false, false]);
    expect(products().map((i) => i.props.disabled)).toEqual([false, false]);
    expect(prices().map((i) => i.props.disabled)).toEqual([false, false]);
    expect(currentPrices().map(b => b.props.disabled)).toEqual([false, false]);
    expect(textOf(view!.root)).not.toContain('暫停送出');
});

it('stays disabled after a remount (tab switch / reopen) while the earlier order is still in flight', async () => {
    let resolve!: (v: unknown) => void;
    mocks.place.mockReturnValue(new Promise((r) => { resolve = r; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = buttons()[0]!.props.onClick(); });
    try {
        await act(async () => view!.unmount());
        await render();
        expect(buttons().map((b) => b.props['aria-disabled'])).toEqual([true, true]);
        expect(textOf(view!.root)).toContain('有一筆測試單傳送中，完成前暫停送出');
        await act(async () => { await buttons()[1]!.props.onClick(); });
        expect(mocks.place).toHaveBeenCalledTimes(1);
    } finally {
        await act(async () => { resolve(TRADE); await pending; });
    }
    expect(buttons().map((b) => b.props['aria-disabled'])).toEqual([false, false]);
});

it('falls back to the snapshot close of each product, looked up by key', async () => {
    mocks.ticks = { TXFR1: '50000' };
    mocks.snaps = {
        'settings-test-order-snap:TXFR1': 49000,
        'settings-test-order-snap:2890': 2450,
        'settings-test-order-snap:2317': 210,
    };
    await render();
    expect(prices().map((i) => i.props.value)).toEqual(['2,450', '50,000']);
    // 來源仍能由價位框的輔助說明區分。
    expect(prices().map(input => textOf(view!.root.findByProps({
        id: input.props['aria-describedby'].split(' ')[0],
    })))).toEqual(['快照價', '成交價']);
    await click(0);
    expect(mocks.place.mock.calls[0]![2]).toBe(2450);
    await type(0, '鴻海');
    await pickOption(0);
    expect(prices()[0]!.props.value).toBe('210');
});

it('snapshot fetcher looks up the selected product by code or target code, and follows a product switch', async () => {
    await render();
    expect(Object.keys(mocks.queries).sort()).toEqual(['settings-test-order-snap:2890', 'settings-test-order-snap:TXFR1']);
    // 連續月：快照 code 是實際月份
    mocks.snapshots.mockResolvedValueOnce([{ code: 'TXFJ6', close: 49000 }]);
    await expect(mocks.queries['settings-test-order-snap:TXFR1']!()).resolves.toMatchObject({ close: 49000 });
    expect(mocks.ensure).toHaveBeenLastCalledWith('TXFR1', 'FUT');
    expect(mocks.snapshots).toHaveBeenLastCalledWith([contracts.TXFR1]);
    // 股票：快照 code 就是代碼
    mocks.snapshots.mockResolvedValueOnce([{ code: '2890', close: 2450 }]);
    await expect(mocks.queries['settings-test-order-snap:2890']!()).resolves.toMatchObject({ close: 2450 });
    // 換商品後 fetcher 綁新商品；綁著舊商品的話收盤後會帶入別的商品的價格
    await type(0, '鴻海');
    await pickOption(0);
    mocks.snapshots.mockResolvedValueOnce([{ code: '2317', close: 210 }]);
    await expect(mocks.queries['settings-test-order-snap:2317']!()).resolves.toMatchObject({ close: 210 });
    expect(mocks.ensure).toHaveBeenLastCalledWith('2317', 'STK');
    expect(mocks.snapshots).toHaveBeenLastCalledWith([contracts['2317']]);
});

it('leaves the price empty and refuses to send when no trade price is known', async () => {
    mocks.ticks = {};
    await render();
    expect(prices()[0]!.props.value).toBe('');
    expect(prices()[0]!.props.placeholder).toBe('等待成交價');
    // 還沒有價格不是使用者打錯
    await click(0);
    expect(textOf(buttons()[0]!)).toBe('等待價格');
    expect(mocks.place).not.toHaveBeenCalled();
    // 沒在失敗時，點進價位框不重查快照
    await act(async () => { prices()[0]!.props.onFocus(); });
    expect(mocks.refresh).not.toHaveBeenCalled();
});

it('says the snapshot failed and retries it when the user focuses the price box', async () => {
    mocks.ticks = {};
    mocks.snapErr = { 'settings-test-order-snap:2890': 'offline' };
    await render();
    expect(prices()[0]!.props.placeholder).toBe('無法取得成交價');
    expect(prices()[1]!.props.placeholder).toBe('等待成交價');
    await click(0);
    expect(textOf(buttons()[0]!)).toBe('等待價格');
    expect(mocks.place).not.toHaveBeenCalled();
    await act(async () => { prices()[0]!.props.onFocus(); });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    // 有 tick 之後就不必再查
    mocks.ticks = { '2890': '2455' };
    await act(async () => { view!.update(createElement(SimTestOrderSection)); });
    await act(async () => { prices()[0]!.props.onFocus(); });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

it('disables the send buttons while trading is not LIVE and says why in visible text', async () => {
    mocks.live = false;
    await render();
    expect(buttons().map((b) => b.props['aria-disabled'])).toEqual([true, true]);
    // 停用原因要是看得到的文字，不只放在 title。
    expect(textOf(view!.root)).toContain('行情或交易狀態未連線，暫停送出測試單');
    mocks.live = true;
    mocks.simulation = true;
    mocks.list = [stockAccount, futuresAccount];
    mocks.tradeable = true;
    mocks.tickTime = mocks.snapTime = "";
    mocks.cachedMetadata = false;
    await act(async () => { view!.update(createElement(SimTestOrderSection)); });
    expect(buttons().map((b) => b.props['aria-disabled'])).toEqual([false, false]);
    expect(textOf(view!.root)).not.toContain('未連線');
});

it('keeps the whole test-order block (title, rows, hints) inside one labelled region', async () => {
    mocks.live = false;
    await render();
    // 卡片就是這個 region：外面不留任何東西
    expect(Array.isArray(view!.toJSON())).toBe(false);
    const region = view!.root.findByType('section');
    const head = region.find((n) => n.type === 'span' && n.props.id === region.props['aria-labelledby']);
    expect(textOf(head)).toBe('測試單');
    const inside = (n: ReactTestInstance) => region.findAll((x) => x === n).length === 1;
    expect([...products(), ...prices(), ...buttons()].every(inside)).toBe(true);
    const visible = textOf(region);
    expect(visible).toContain('行情或交易狀態未連線，暫停送出測試單');
    expect(visible).toContain('模擬環境');
});

it('keeps an edited price when the next tick arrives; clearing it follows the live price again', async () => {
    await render();
    await setPrice(0, '2400');
    mocks.ticks = { ...mocks.ticks, '2890': '2460' };
    await act(async () => { view!.update(createElement(SimTestOrderSection)); });
    expect(prices()[0]!.props.value).toBe('2,400');
    await setPrice(0, '');
    expect(prices()[0]!.props.value).toBe('2,460');
});

it('keeps quote source descriptions available when a current quote becomes a fixed price', async () => {
    await render();
    expect(currentPrices()).toHaveLength(2);
    const description = () => prices()[0]!.props['aria-describedby'].split(' ')
        .map((id: string) => textOf(view!.root.findByProps({ id }))).join(' ');
    expect(description()).toContain('成交價');
    expect(currentPrices()[0]!.props['aria-label']).toBe('現價：帶入成交價（目前 2455）');
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(description()).toContain('固定委託價');
    mocks.ticks = { ...mocks.ticks, '2890': '2460' };
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('2,455');
    expect(currentPrices()[0]!.props['aria-label']).toBe('現價：帶入成交價（目前 2460）');
    expect(description()).toContain('固定委託價');
});

it('copies the current quote once, keeps that price through later ticks, and permits a manual override', async () => {
    await render();
    expect(currentPrices()).toHaveLength(2);
    expect(currentPrices().map(b => b.props.disabled)).toEqual([false, false]);
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('2,455');
    mocks.ticks['2890'] = '2460';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('2,455');
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('2,460');
    await setPrice(0, '2400');
    mocks.ticks['2890'] = '2470';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('2,400');
    expect(currentPrices()).toHaveLength(2);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.snapshots).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    await click(0);
    expect(mocks.place.mock.calls[0]![2]).toBe(2400);
});

it.each([undefined, '0'])('keeps the current-price action unavailable without a positive quote: %s', async close => {
    mocks.ticks['2890'] = close;
    await render();
    expect(currentPrices()).toHaveLength(2);
    expect(currentPrices().map(b => b.props.disabled)).toEqual([true, false]);
    expect(currentPrices()[0]!.props['aria-label']).toBe('現價：尚無可用報價');
    // 手動價仍可送出，現價按鈕不能以無效報價覆蓋它。
    await setPrice(0, '2455');
    expect(currentPrices()[0]!.props.disabled).toBe(true);
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('2,455');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.snapshots).not.toHaveBeenCalled();
    await click(0);
    expect(mocks.place.mock.calls[0]![2]).toBe(2455);
});

it('keeps current-price selection disabled until the searched product is explicitly accepted', async () => {
    await render();
    await setPrice(0, '2400');
    await type(0, '鴻海');
    expect(currentPrices().map(b => b.props.disabled)).toEqual([true, false]);
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('2,400');
    expect(products()[0]!.props.value).toBe('鴻海');
    await pickOption(0);
    expect(currentPrices()[0]!.props.disabled).toBe(false);
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('220');
    mocks.ticks['2317'] = '225';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('220');
    await click(0);
    expect(mocks.place.mock.calls[0]![0].code).toBe('2317');
    expect(mocks.place.mock.calls[0]![2]).toBe(220);
});

it('binds each row to its market and only resolves aliases in futures', async () => {
    mocks.search.mockResolvedValue([hon, sug('CDFR1')]);
    await render();
    await type(0, '台指');
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('2317');
    expect(mocks.ensure).not.toHaveBeenCalled();
    await pickOption(0);
    await type(1, '混合');
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('CDFR1');
    await pickOption(0);
    await click(1);
    expect(mocks.place.mock.calls[0]![4].account).toBe(futuresAccount);
});

it('switching products resets an edited price and clears the previous product result', async () => {
    await render();
    await setPrice(0, '2400');
    await click(0);
    expect(text()).toContain('已送出');
    await type(0, '鴻海');
    await pickOption(0);
    expect(mocks.prime).not.toHaveBeenCalled();
    expect(products()[0]!.props.value).toBe('鴻海');
    expect(prices()[0]!.props.value).toBe('220');
    // 上一個商品的「已送出」不能掛在新商品那一列
    expect(text()).not.toContain('已送出');
    await click(0);
    expect(mocks.ensure).toHaveBeenCalledWith('2317', 'STK');
    expect(mocks.place.mock.calls[1]![0].code).toBe('2317');
    expect(mocks.place.mock.calls[1]![2]).toBe(220);
    expect(mocks.place.mock.calls[1]![4].account).toBe(stockAccount);
});

it('an option suggestion goes out with the futures account', async () => {
    const opt = { code: 'TXO23000J6', name: '臺指選擇權', security_type: 'OPT', exchange: 'TAIFEX', limit_up: 900, limit_down: 1, tick: 1 };
    contracts[opt.code] = opt;
    mocks.ticks[opt.code] = '120';
    mocks.search.mockResolvedValue([sug(opt.code)]);
    try {
        await render();
        await type(1, '台指選擇權');
        await pickOption(0);
        await click(1);
        expect(mocks.capture).toHaveBeenCalledWith('F');
        const [contract, , price, , opts] = mocks.place.mock.calls[0]!;
        expect(contract.code).toBe(opt.code);
        expect(price).toBe(120);
        expect(opts.account).toBe(futuresAccount);
    } finally {
        delete contracts[opt.code];
    }
});

it('preserves unpicked text through Tab and blur and cannot send the old product', async () => {
    await render();
    await type(0, '鴻海');
    await key(0, 'Tab');
    await act(async () => products()[0]!.props.onBlur?.());
    expect(products()[0]!.props.value).toBe('鴻海');
    expect(textOf(buttons()[0]!)).toBe('請選商品');
    await click(0);
    expect(mocks.place).not.toHaveBeenCalled();
});

it('drops index, warrant and combo suggestions', async () => {
    mocks.search.mockResolvedValue([
        { code: 'IX0001', name: '發行量加權股價指數', security_type: 'IND', exchange: 'TSE', detail: '指數' },
        { code: '030001', name: '永豐金甲購', security_type: 'WRT', exchange: 'TSE', detail: '認購' },
        sug('TXFR1', { code: 'TXFI6/J6', name: '台指價差', contract: { ...contracts.TXFR1, code: 'TXFI6/J6', combo: { code: 'TXFI6/J6', legs: [], combo_type: 'spread' } } }),
        { code: '2890', name: '永豐金', security_type: 'STK', exchange: 'TSE', detail: '股票' },
    ]);
    await render();
    await type(0, 'zz');
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('2890');
});

it('refuses at send time when the resolved contract is a combo', async () => {
    mocks.search.mockResolvedValue([{ code: 'TXFSP', name: '台指價差', security_type: 'FUT', exchange: 'TAIFEX', detail: '期貨' }]);
    mocks.ensure.mockImplementation(async (code: string) =>
        code === 'TXFSP' ? { ...contracts.TXFR1, code: 'TXFSP', combo: { code: 'TXFSP', legs: [], combo_type: 'spread' } } : contracts[code]);
    mocks.ticks.TXFSP = '50000';
    await render();
    await type(1, '價差');
    await pickOption(0);
    await click(1);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text()).toContain('此商品不支援測試單');
});

it('ignores an older search result that arrives after a newer one', async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    mocks.search.mockImplementation((q: string) => new Promise((r) => { pending[q] = r; }));
    await render();
    await type(0, '鴻');
    await type(0, '鴻海');
    expect(Object.keys(pending)).toEqual(['鴻', '鴻海']);
    await act(async () => { pending['鴻海']!([hon]); });
    await act(async () => { pending['鴻']!([{ code: '1101', name: '台泥', security_type: 'STK', exchange: 'TSE', detail: '股票' }]); });
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('2317');
});

it.each([
    ['台指', 'TXFR1', '台指近'],
    ['臺指', 'TXFR1', '台指近'],
    ['台指近', 'TXFR1', '台指近'],
    ['台指期貨', 'TXFR1', '台指近'],
    ['台指近月', 'TXFR1', '台指近'],
    ['台指次月', 'TXFR2', '台指次'],
    ['大台指', 'TXFR1', '台指近'],
    ['大台次', 'TXFR2', '台指次'],
    ['小台', 'MXFR1', '小台近'],
    ['小台指', 'MXFR1', '小台近'],
    ['小台指期', 'MXFR1', '小台近'],
    ['小台指次', 'MXFR2', '小台次'],
    ['大台指次', 'TXFR2', '台指次'],
    ['微台指', 'TMFR1', '微台近'],
    ['微台指次', 'TMFR2', '微台次'],
    ['微台次', 'TMFR2', '微台次'],
])('alias %s puts %s first', async (q, code, label) => {
    await render();
    await type(1, q);
    expect(mocks.ensure).toHaveBeenCalledWith(code, 'FUT');
    expect(optionTexts()[0]).toContain(code);
    expect(optionTexts()[0]).toContain(label);
    // 去重：searchProducts 也回同一商品時只出現一次
    expect(optionTexts().filter((t) => t.includes(code))).toHaveLength(1);
});

it.each(['台指選擇權', '期', '台積電期'])('%s does not hit a futures alias', async (q) => {
    await render();
    await type(1, q);
    expect(mocks.search).toHaveBeenCalledWith(q, 8);
    expect(mocks.ensure).not.toHaveBeenCalled();
});

it('a missing alias contract or a failed search still lists the rest', async () => {
    mocks.ensure.mockImplementation(async (c: string) => {
        if (c === 'TMFR2' || !contracts[c]) throw new Error('404');
        return contracts[c];
    });
    await render();
    await type(1, '微台');
    expect(optionTexts().some((t) => t.includes('TMFR1'))).toBe(true);
    expect(optionTexts().some((t) => t.includes('TMFR2'))).toBe(false);
    mocks.search.mockRejectedValue(new Error('offline'));
    await type(1, '台指');
    expect(optionTexts()[0]).toContain('TXFR1');
});

it('says the search failed instead of 找不到 when the lookup errors', async () => {
    mocks.search.mockRejectedValue(new Error('offline'));
    await render();
    await type(0, 'zz');
    expect(options()).toHaveLength(0);
    expect(text()).toContain('搜尋失敗（伺服器沒有回應），請稍後再打一次');
    expect(text()).not.toContain('找不到');
});

it('hides stale suggestions immediately and rejects their retained mouse handler', async () => {
    await render();
    await type(0, '鴻海');
    const stale = options()[0]!.props.onClick;
    await act(async () => products()[0]!.props.onChange({ target: { value: '鴻' } }));
    expect(options()).toHaveLength(0);
    await act(async () => stale());
    expect(products()[0]!.props.value).toBe('鴻');
    expect(textOf(buttons()[0]!)).toBe('請選商品');
    await act(async () => products()[0]!.props.onCompositionStart());
    expect(options()).toHaveLength(0);
});

it('does not search (or flash 找不到) while the IME is still composing', async () => {
    await render();
    await act(async () => { products()[0]!.props.onCompositionStart(); });
    await type(0, 'ㄊㄞˊ');
    expect(mocks.search).not.toHaveBeenCalled();
    expect(text()).not.toContain('找不到');
    await act(async () => { products()[0]!.props.onCompositionEnd(); });
    await type(1, '台指');
    expect(mocks.search).toHaveBeenCalledWith('台指', 8);
    expect(optionTexts()[0]).toContain('TXFR1');
});

it('arrow keys move (and wrap) the highlighted suggestion; a new result starts from the top', async () => {
    await render();
    await type(1, '台指');
    expect(products()[1]!.props['aria-controls']).toBe(view!.root.find((n) => n.props.role === 'listbox').props.id);
    expect(options()[0]!.props['aria-selected']).toBe(true);
    await key(1, 'ArrowUp');
    expect(options().at(-1)!.props['aria-selected']).toBe(true);
    await key(1, 'ArrowDown');
    await key(1, 'ArrowDown');
    expect(options()[1]!.props['aria-selected']).toBe(true);
    expect(products()[1]!.props['aria-activedescendant']).toBe(options()[1]!.props.id);
    await type(1, '台');
    expect(options()[0]!.props['aria-selected']).toBe(true);
    await key(1, 'ArrowDown');
    await key(1, 'Enter');
    expect(products()[1]!.props.value).toBe('台指次');
});

it('mouse hover moves the same highlight Enter uses; only the primary button picks', async () => {
    await render();
    await type(1, '台指');
    expect(optionTexts()).toHaveLength(3);
    await act(async () => { options()[2]!.props.onMouseMove(); });
    expect(options().map((o) => o.props['aria-selected'])).toEqual([false, false, true]);
    // 右鍵：只擋掉 blur，不換商品（選取在 click，只有主鍵觸發）
    const down = { button: 2, preventDefault: vi.fn() };
    await act(async () => { options()[1]!.props.onMouseDown(down); });
    expect(down.preventDefault).toHaveBeenCalled();
    expect(products()[1]!.props.value).toBe('台指');
    await key(1, 'Enter');
    expect(products()[1]!.props.value).toBe('小台近');
});

it('shows a no-match hint only for the query that actually came back', async () => {
    await render();
    await type(0, 'nothing');
    expect(options()).toHaveLength(0);
    // 提示放在常駐的 live region 裡：說可以怎麼打，也說明哪些商品被排除
    expect(textOf(view!.root.findAll((n) => n.type === 'div' && n.props.role === 'status')[0]!)).toBe('找不到「nothing」。可打代碼（2890）、名稱或簡稱（台指、小台、微台）；指數、權證、組合商品不支援測試單');
    await act(async () => { products()[0]!.props.onChange({ target: { value: '鴻海' } }); });
    expect(text()).not.toContain('找不到');
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(optionTexts()[0]).toContain('2317');
});

it('shortens month contracts to the alias wording so the month is not cut off; other names stay full', async () => {
    const mxf = fut('MXFJ6', '小型臺指期貨 202610');
    contracts.MXFJ6 = mxf;
    mocks.ticks.MXFJ6 = '50020';
    mocks.search.mockResolvedValue([sug('MXFJ6'), sug('CDFR1')]);
    try {
        await render();
        // 選取後才替右側代碼讓位，打字時不縮窄搜尋框
        expect(products()[1]!.props.style?.paddingRight).toContain(`${'TXFR1'.length}ch`);
        await type(1, 'MXF');
        expect(products()[1]!.props.style).toBeUndefined();
        expect(optionTexts()[0]).toContain('小台 202610');
        expect(optionTexts()[1]).toContain('台積電期貨');
        // 全名仍可在 hover 看到
        expect(options()[0]!.findByProps({ className: css.optionName }).props.title).toBe('小型臺指期貨 202610');
        await pickOption(0);
        expect(products()[1]!.props.value).toBe('小台 202610');
        expect(products()[1]!.props.style?.paddingRight).toContain(`${'MXFJ6'.length}ch`);
        expect(prices()[1]!.props.value).toBe('50,020');
    } finally {
        delete contracts.MXFJ6;
    }
});


it('names markets and describes the selected full product and code', async () => {
    await render();
    expect(products().map(p => p.props['aria-label'])).toEqual(['證券商品', '期貨商品']);
    for (const [i, full] of ['永豐金 2890', '臺股期貨 TXFR1'].entries()) {
        const ids = products()[i]!.props['aria-describedby'].split(' ');
        expect(ids.map((id: string) => textOf(view!.root.findByProps({ id }))).join(' ')).toContain(full);
    }
});

it('locks an unknown row through retries, product changes and remount until acknowledged', async () => {
    mocks.place.mockRejectedValue(new Error('timeout'));
    await render();
    await click(0);
    expect(textOf(buttons()[0]!)).toBe('待核對');
    await click(0);
    await type(0, '鴻海'); await pickOption(0); await click(0);
    expect(text()).toContain('結果未知');
    mocks.search.mockResolvedValue([sug('2890')]);
    await type(0, '永豐金'); await pickOption(0); await click(0);
    await act(async () => view!.unmount()); await render(); await click(0);
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(textOf(rowStatus(0))).not.toContain('回應');
    await act(async () => view!.root.findAllByType('button').find(b => textOf(b) === '我已核對委託')!.props.onClick());
    expect(textOf(buttons()[0]!)).toBe('測試');
});

it.each([
    ['environment', '非模擬環境'], ['connection', '未連線'], ['stock missing', '無證券帳戶'],
    ['futures missing', '無期貨帳戶'], ['selection', '未選帳戶'], ['unavailable selection', '未選帳戶'],
    ['unsigned', '帳戶未簽署'], ['query', '請選商品'], ['price missing', '等待價格'], ['price invalid', '請輸入價位'],
])('shows focusable disabled reason for %s', async (condition, reason) => {
    let row = 0;
    if (condition === 'environment') { mocks.simulation = false; mocks.live = false; mocks.list = []; }
    if (condition === 'connection') { mocks.live = false; mocks.list = []; }
    if (condition === 'stock missing') { mocks.list = [futuresAccount]; mocks.accounts.S = undefined; }
    if (condition === 'futures missing') { mocks.list = [stockAccount]; mocks.accounts.F = undefined; row = 1; }
    if (condition === 'selection') mocks.accounts.S = undefined;
    if (condition === 'unavailable selection') mocks.accounts.S = { ...stockAccount, account_id: 'missing' };
    if (condition === 'unsigned') mocks.tradeable = false;
    if (condition === 'price missing') mocks.ticks = {};
    await render();
    if (condition === 'query') await type(0, '未知');
    if (condition === 'price invalid') await setPrice(0, '0');
    const b = buttons()[row]!;
    expect(textOf(b)).toBe(reason);
    expect(b.props['aria-disabled']).toBe(true);
    expect(b.props.disabled).toBeUndefined();
    await click(row); expect(mocks.place).not.toHaveBeenCalled();
    if (condition === 'unsigned') expect(textOf(view!.root)).toContain('尚未完成 API 簽署或模擬測試。若是先登入才完成簽署，請登出後重新登入，簽署才會生效。');
});

it('uses a newer snapshot rather than an old tick and then follows a newer tick', async () => {
    mocks.tickTime = '2026-10-08T09:00:00';
    mocks.snapTime = '2026-10-08T13:30:00';
    mocks.snaps = { 'settings-test-order-snap:2890': 2500 };
    await render(); expect(prices()[0]!.props.value).toBe('2,500');
    mocks.tickTime = '2026-10-08T13:31:00';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('2,455');
});

it('copies the freshest snapshot or tick while later source changes leave the fixed price intact', async () => {
    mocks.tickTime = '2026-10-08T09:00:00';
    mocks.snapTime = '2026-10-08T13:30:00';
    mocks.snaps = { 'settings-test-order-snap:2890': 2500 };
    await render();
    await setPrice(0, '2400');
    expect(currentPrices()[0]!.props['aria-label']).toBe('現價：帶入快照價（目前 2500）');
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('2,500');
    mocks.tickTime = '2026-10-08T13:31:00';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('2,500');
    expect(currentPrices()[0]!.props['aria-label']).toBe('現價：帶入成交價（目前 2455）');
    await act(async () => currentPrices()[0]!.props.onClick());
    expect(prices()[0]!.props.value).toBe('2,455');
    expect(mocks.snapshots).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    await click(0);
    expect(mocks.place.mock.calls[0]![2]).toBe(2455);
});

it('times only beforeSend to resolve, excluding the confirmation wait, and shows the duration inline', async () => {
    const now = vi.spyOn(performance, 'now');
    let time = 0; now.mockImplementation(() => time);
    mocks.place.mockImplementation(async (...args) => { time = 10000; args[4].beforeSend(); time = 10123; return TRADE; });
    try {
        await render(); await click(0);
        expect(textOf(rowStatus(0))).toContain('· 回應 123 ms');
        expect(mocks.notify).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
});

it('hides current suggestions during IME composition and rechecks a retained pick handler', async () => {
    await render(); await type(0, '鴻海');
    const retained = options()[0]!.props.onClick;
    await act(async () => products()[0]!.props.onCompositionStart());
    expect(options()).toHaveLength(0);
    await act(async () => retained());
    expect(products()[0]!.props['data-searching']).toBe(true);
    await click(0); expect(mocks.place).not.toHaveBeenCalled();
    await act(async () => products()[0]!.props.onCompositionEnd());
    await key(0, 'Enter'); await click(0);
    expect(mocks.place.mock.calls[0]![0].code).toBe('2317');
});

it('Enter respects both IME event forms before explicitly accepting a futures product', async () => {
    await render(); await type(1, '台指');
    await key(1, 'Enter', { isComposing: true, keyCode: 13 });
    expect(products()[1]!.props.value).toBe('台指');
    await key(1, 'Enter', { keyCode: 229 });
    expect(products()[1]!.props.value).toBe('台指');
    await key(1, 'Enter'); await click(1);
    expect(mocks.place.mock.calls[0]![0].code).toBe('TXFR1');
});

it.each(['已有待確認的委託', 'timeout'])('classifies an unflagged %s as unknown without response timing', async message => {
    mocks.place.mockRejectedValue(new Error(message));
    await render(); await click(0);
    expect(textOf(buttons()[0]!)).toBe('待核對');
    expect(text()).toContain('結果未知'); expect(textOf(rowStatus(0))).not.toContain('回應');
});

it('does not show response timing for a mutationNotStarted error even after beforeSend', async () => {
    mocks.place.mockImplementation(async (...args) => { args[4].beforeSend(); throw Object.assign(new Error('拒絕'), { mutationNotStarted: true }); });
    await render(); await click(0);
    expect(text()).toContain('未成立'); expect(textOf(rowStatus(0))).not.toContain('回應');
});

it('sends the default 2890 stock as one lot at 21.5 and reports the order and response time', async () => {
    const previous = contracts['2890'];
    contracts['2890'] = { code: '2890', name: '永豐金', security_type: 'STK', limit_up: 23.65, limit_down: 19.35, tick: 0.05 };
    mocks.ticks['2890'] = '21.5';
    try {
        await render();
        await setPrice(0, '21.4');
        await act(async () => currentPrices()[0]!.props.onClick());
        await focusPrice(0);
        expect(prices()[0]!.props.value).toBe('21.5');
        await blurPrice(0);
        await click(0);
        expect(mocks.place.mock.calls[0]!.slice(0, 4)).toEqual([contracts['2890'], 'Buy', 21.5, 1]);
        expect(textOf(rowStatus(0).findByProps({ className: css.resultHeading }))).toMatch(/^已送出 · 回應 \d+ ms$/);
        expect(textOf(rowStatus(0).findByProps({ className: css.resultDetails }))).toBe('買進 1 張 · 送出委託價 21.5 · 委託 000123');
    } finally { contracts['2890'] = previous!; }
});


it.each([[0, '2454'], [1, '60000']])('shows invalid price reason before sending row %s when contract metadata is cached', async (row, price) => {
    mocks.cachedMetadata = true;
    await render(); await setPrice(row, price);
    expect(textOf(buttons()[row]!)).toBe('請輸入價位');
    expect(buttons()[row]!.props['aria-disabled']).toBe(true);
    await click(row); expect(mocks.place).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
});

it('explains product input separately for stock and futures rows', async () => {
    await render();
    const help = textOf(view!.root.findByType('details'));
    expect(help).toContain('證券可輸入股票名稱或代碼');
    expect(help).toContain('期貨也可輸入簡稱（台指、小台、微台）');
});


it('keeps the order effect visible while collapsing supplementary help', async () => {
    await render();
    const help = view!.root.findByType('details');
    expect(help.props.open).toBeUndefined();
    expect(textOf(help.findByType('summary'))).toBe('測試規則與簽署');
    expect(help.findAllByType('button')).toHaveLength(0);
    expect(help.findAllByType('input')).toHaveLength(0);
    const schedule = view!.root.findByProps({ className: css.testSchedule });
    expect(textOf(schedule)).toBe('資格驗證時段：開盤日 08:00–20:00（台北時間）');
    expect(help.findAll(n => n === schedule)).toHaveLength(0);
    const guidance = view!.root.findByProps({ className: css.guidance });
    expect(textOf(guidance)).toContain('按下即買進 1 張／1 口限價 ROD，可能立即成交');
    expect(help.findAll(n => n === guidance)).toHaveLength(0);
    expect(help.findAllByType('li')).toHaveLength(6);
    const footer = help.findByProps({ className: css.helpFooter });
    expect(textOf(footer)).toContain('未成交的請到「委託」刪單');
    expect(textOf(footer)).toContain('已成交的請到「持倉」平倉');
    expect(buttons()[0]!.props.title).toContain('買進 1 張');
    expect(buttons()[1]!.props.title).toContain('買進 1 口');
    expect(buttons().map(b => textOf(b))).toEqual(['測試', '測試']);
});

it('provides the correct market signing links and qualification prerequisites in expandable rules', async () => {
    await render();
    const help = view!.root.findByType('details');
    expect(help.findAllByType('a').map(link => [textOf(link), link.props.href])).toEqual([
        ['證券簽署', 'https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/'],
        ['期貨簽署', 'https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/'],
        ['官方測試規則', 'https://sinotrade.github.io/zh/tutor/prepare/terms/'],
    ]);
    const rules = textOf(help);
    expect(rules).toContain('測試前，先完成 API 電子交易風險預告書暨使用同意書');
    expect(rules).toContain('以模擬環境登入');
    expect(rules).toContain('API 金鑰須有「交易」權限');
    expect(rules).toContain('Shioaji 版本須為 1.2 以上');
    expect(rules).toContain('08:00–18:00 不限制 IP 地區');
    expect(rules).toContain('18:00–20:00 僅限台灣 IP');
    expect(rules).toContain('證券與期貨須各自完成下單測試');
    expect(rules).toContain('兩次測試請間隔至少 1 秒');
    expect(rules).toContain('數小時內會開通');
    expect(rules).toContain('重新登入後再查詢');
    expect(mocks.place).not.toHaveBeenCalled();
});

it('shows verification for the selected account and follows refreshed selections', async () => {
    mocks.accounts.F = { ...futuresAccount, signed: false };
    await render();
    const badge = (market: string, status: string) => view!.root.findByProps({ 'aria-label': `${market}帳戶${status}驗證` });
    expect(textOf(badge('證券', '已通過'))).toBe('通過');
    expect(icons(badge('證券', '已通過'))[0]).toContain('lucide-shield-check');
    expect(textOf(badge('期貨', '尚未通過'))).toBe('未通過');
    expect(icons(badge('期貨', '尚未通過'))[0]).toContain('lucide-shield-alert');
    expect(badge('證券', '已通過').props.title).toBe('證券帳戶已通過驗證');
    expect(badge('期貨', '尚未通過').props.title).toBe('期貨帳戶尚未通過驗證');
    mocks.accounts.S = { ...stockAccount, signed: undefined } as unknown as Account;
    mocks.accounts.F = { ...futuresAccount, signed: true };
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(textOf(badge('證券', '尚未通過'))).toBe('未通過');
    expect(textOf(badge('期貨', '已通過'))).toBe('通過');
    mocks.accounts.S = undefined; mocks.list = [futuresAccount];
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(textOf(view!.root.findByProps({ 'aria-label': '證券無帳戶' }))).toBe('無帳戶');
});

const refreshStatus = () => view!.root.findByProps({ title: '重新取得帳戶驗證狀態' });

it('refreshes verification once, shows progress, and preserves the current order inputs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-08T05:06:07.000Z'));
    mocks.accounts.F = { ...futuresAccount, signed: false };
    let finish!: () => void;
    mocks.refreshAccounts.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await render();
    await setPrice(0, '2500');
    let request!: Promise<void>;
    await act(async () => {
        request = refreshStatus().props.onClick();
        void refreshStatus().props.onClick();
    });
    expect(mocks.refreshAccounts).toHaveBeenCalledTimes(1);
    expect(refreshStatus().props.disabled).toBe(true);
    expect(textOf(refreshStatus())).toBe('更新中…');
    const progress = view!.root.findByProps({ className: css.headerActions }).findByProps({ role: 'status' });
    expect(textOf(progress)).toBe('正在更新驗證狀態…');
    await act(async () => {
        mocks.accounts.F = { ...futuresAccount, signed: true };
        finish();
        await request;
    });
    expect(refreshStatus().props.disabled).toBe(false);
    expect(textOf(view!.root.findByProps({ 'aria-label': '期貨帳戶已通過驗證' }))).toBe('通過');
    const completed = view!.root.findByProps({ 'aria-label': '驗證狀態已更新' });
    expect(completed.props.role).toBe('status');
    expect(textOf(completed)).toBe('已更新 13:06:07');
    const updatedAt = completed.findByType('time');
    expect(updatedAt.props.dateTime).toBe('2026-10-08T05:06:07.000Z');
    expect(textOf(updatedAt)).toBe('13:06:07');
    expect(prices()[0]!.props.value).toBe('2,500');
    expect(products().map(p => p.props.value)).toEqual(['永豐金', '台指近']);
    expect(mocks.place).not.toHaveBeenCalled();
});

it.each(['store error', 'rejection'])('reports a failed verification refresh and permits retry: %s', async failure => {
    mocks.refreshAccounts.mockImplementation(async () => {
        if (failure === 'rejection') throw new Error('offline');
        mocks.accountLoadError = true;
    });
    await render();
    await act(async () => { await refreshStatus().props.onClick(); });
    expect(textOf(view!.root)).toContain('更新失敗，保留上次狀態。請稍後再試。');
    expect(view!.root.findAllByProps({ 'aria-label': '驗證狀態已更新' })).toHaveLength(0);
    expect(refreshStatus().props.disabled).toBe(false);
    expect(textOf(view!.root.findByProps({ 'aria-label': '證券帳戶已通過驗證' }))).toBe('通過');
    mocks.refreshAccounts.mockImplementation(async () => { mocks.accountLoadError = false; });
    await act(async () => { await refreshStatus().props.onClick(); });
    expect(view!.root.findByProps({ 'aria-label': '驗證狀態已更新' }).props.role).toBe('status');
    expect(textOf(view!.root)).not.toContain('更新失敗');
    expect(mocks.place).not.toHaveBeenCalled();
});

it('keeps an unresolved order locked through verification refresh, new quotes, current-price selection and price focus or blur', async () => {
    mocks.place.mockRejectedValueOnce(new Error('network response lost'));
    await render();
    await click(0);
    expect(textOf(buttons()[0]!)).toBe('待核對');
    await act(async () => { await refreshStatus().props.onClick(); });
    expect(view!.root.findByProps({ 'aria-label': '驗證狀態已更新' }).props.role).toBe('status');
    expect(textOf(buttons()[0]!)).toBe('待核對');
    expect(textOf(rowStatus(0))).toContain('結果未知');
    mocks.ticks['2890'] = '2460';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    await focusPrice(0);
    expect(prices()[0]!.props.value).toBe('2460');
    await blurPrice(0);
    expect(prices()[0]!.props.value).toBe('2,460');
    await act(async () => currentPrices()[0]!.props.onClick());
    mocks.ticks['2890'] = '2465';
    await act(async () => view!.update(createElement(SimTestOrderSection)));
    expect(prices()[0]!.props.value).toBe('2,460');
    expect(textOf(buttons()[0]!)).toBe('待核對');
    expect(textOf(rowStatus(0))).toContain('結果未知');
    await click(0);
    expect(mocks.place).toHaveBeenCalledTimes(1);
});

// 欄寬與斷點由實際瀏覽器驗收；react-test-renderer 不會計算 CSS 版面。
it('keeps the selected contract code visible and accepts an eight-digit edited price', async () => {
    mocks.ticks.TXFR1 = '48980'; await render();
    expect(products()[1]!.props.value).toBe('台指近');
    expect(view!.root.findAllByProps({ className: css.productCode }).map(textOf)).toEqual(['2890', 'TXFR1']);
    expect(prices()[1]!.props.value).toBe('48,980');
    await setPrice(1, '12345678'); expect(prices()[1]!.props.value).toBe('12,345,678');
});

it.each(['success', 'refused', 'unknown', 'contract failure'])('notifies an unmounted row for %s while preserving unknown locks', async outcome => {
    let resolve!: (value: typeof TRADE) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<typeof TRADE>((yes, no) => { resolve = yes; reject = no; });
    if (outcome === 'contract failure') mocks.ensure.mockImplementation(() => pending);
    else mocks.place.mockImplementation(() => pending);
    await render();
    let request!: Promise<void>;
    await act(async () => { request = buttons()[0]!.props.onClick(); });
    await act(async () => view!.unmount()); view = undefined;
    await act(async () => {
        if (outcome === 'success') resolve(TRADE);
        else reject(Object.assign(new Error('test failure'), outcome === 'refused' ? { mutationNotStarted: true } : {}));
        await request;
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]![0].title).toBe(outcome === 'success' ? '測試單已送出' : outcome === 'unknown' ? '測試單結果未知' : outcome === 'refused' ? '測試單未成立' : '測試單未送出');
    if (outcome === 'success') {
        expect(mocks.notify.mock.calls[0]![0].body).toBe('永豐金 2890：已送出：買進 1 張 @ 2455（委託 000123）');
    }
    await render();
    if (outcome === 'unknown') {
        expect(textOf(buttons()[0]!)).toBe('待核對');
        expect(textOf(rowStatus(0))).toContain('結果未知');
        await click(0); expect(mocks.place).toHaveBeenCalledTimes(1);
    } else expect(textOf(buttons()[0]!)).toBe('測試');
});
