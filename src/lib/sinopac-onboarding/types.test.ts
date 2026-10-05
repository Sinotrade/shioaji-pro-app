import { describe, expect, it } from 'vitest';
import {
  isBirthday8,
  isIpv4,
  isTaiwanIdFormat,
  validateOnboardingPlan,
  type OnboardingPlan,
} from './types';

// 本地時間，與 validateOnboardingPlan／isBirthday8 的 dateKey 計算一致。
const NOW = new Date(2026, 9, 5, 12, 0, 0);

const PLAN: OnboardingPlan = {
  name: '週報同步',
  expiresOn: '2027-12-31',
  permissions: { quote: false, account: true, trade: false, prod: true },
  accountTypes: ['stock', 'overseas'],
  ip: { mode: 'restricted', addresses: ['203.0.113.42', '198.51.100.7'] },
};

const withPlan = (patch: Partial<OnboardingPlan>): OnboardingPlan => ({ ...PLAN, ...patch });
const errorKeys = (plan: OnboardingPlan) => Object.keys(validateOnboardingPlan(plan, NOW));

describe('isTaiwanIdFormat', () => {
  // 只驗格式，刻意使用檢查碼不成立的值，避免測資看起來像真實證號。
  it.each(['A123456780', 'a223456789', 'F189999999', 'A812345678', 'Z912345678', ' B123456789 '])(
    '接受 %j',
    (value) => expect(isTaiwanIdFormat(value)).toBe(true),
  );

  it.each([
    ['', '空字串'],
    ['A12345678', '少一碼'],
    ['A1234567890', '多一碼'],
    ['1234567890', '沒有英文字母'],
    ['AA23456789', '第二碼不是數字'],
    ['A323456789', '第二碼 3 不是性別／居留碼'],
    ['A023456789', '第二碼 0'],
    ['A723456789', '第二碼 7'],
    ['A12345678X', '尾碼不是數字'],
    ['Ａ123456789', '全形英文字母'],
    ['A１23456789', '全形數字'],
    ['A123 456789', '中間有空白'],
  ])('拒絕 %j（%s）', (value) => expect(isTaiwanIdFormat(value)).toBe(false));
});

describe('isBirthday8', () => {
  it.each(['19900101', '19000101', '20000229', '19960229', '20261005'])('接受 %s', (value) =>
    expect(isBirthday8(value, NOW)).toBe(true),
  );

  it.each([
    ['18991231', '早於 1900'],
    ['19900230', '2 月沒有 30 日'],
    ['19000229', '1900 不是閏年'],
    ['20010229', '2001 不是閏年'],
    ['19901301', '13 月'],
    ['19900001', '0 月'],
    ['19900100', '0 日'],
    ['19900132', '1 月沒有 32 日'],
    ['19900431', '4 月沒有 31 日'],
    ['20261006', '晚於 now'],
    ['20270101', '未來年份'],
    ['1990-01-01', '含分隔符號'],
    ['1990010', '只有 7 碼'],
    ['199001011', '9 碼'],
    ['', '空字串'],
    ['１９９００１０１', '全形數字'],
    [' 19900101', '前面有空白'],
  ])('拒絕 %j（%s）', (value) => expect(isBirthday8(value, NOW)).toBe(false));
});

describe('isIpv4', () => {
  it.each(['0.0.0.0', '203.0.113.42', '255.255.255.255', '10.0.0.1'])('接受 %s', (value) =>
    expect(isIpv4(value)).toBe(true),
  );

  it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', '1.2.3.256', 'abc', '', '::1', '1.2.3.-4', '1.2.3.4/24'])(
    '拒絕 %j',
    (value) => expect(isIpv4(value)).toBe(false),
  );
});

describe('validateOnboardingPlan', () => {
  it('合法方案沒有任何錯誤', () => {
    expect(validateOnboardingPlan(PLAN, NOW)).toEqual({});
  });

  describe('交易權限與 IP 模式（不再互相限制）', () => {
    const trade = { quote: false, account: false, trade: true, prod: false };

    it('交易＋無限制 IP 通過：動態 IP 的使用者只能不限制 IP', () => {
      expect(validateOnboardingPlan(withPlan({ permissions: trade, ip: { mode: 'unlimited', addresses: [] } }), NOW)).toEqual({});
      const permissions = { quote: true, account: true, trade: true, prod: true };
      expect(errorKeys(withPlan({ permissions, ip: { mode: 'unlimited', addresses: [] } }))).toEqual([]);
    });

    it('交易＋限制 IP 通過', () => {
      expect(errorKeys(withPlan({ permissions: trade }))).toEqual([]);
    });

    it.each([
      ['有交易', trade],
      ['無交易', PLAN.permissions],
    ])('無限制 IP（%s）不檢查殘留的位址內容', (_label, permissions) => {
      const plan = withPlan({ permissions, ip: { mode: 'unlimited', addresses: ['not-an-ip'] } });
      expect(errorKeys(plan)).toEqual([]);
    });
  });

  describe('名稱（最多 15 個字元）', () => {
    it('剛好 15 個字元通過，16 個被擋', () => {
      expect(errorKeys(withPlan({ name: '一二三四五六七八九十一二三四五' }))).toEqual([]);
      expect(errorKeys(withPlan({ name: 'a'.repeat(15) }))).toEqual([]);
      const errors = validateOnboardingPlan(withPlan({ name: 'a'.repeat(16) }), NOW);
      expect(Object.keys(errors)).toEqual(['name']);
      expect(errors.name).toBe('名稱最多 15 個字元。');
    });

    it('前後空白不計入長度', () => {
      expect(errorKeys(withPlan({ name: `  ${'a'.repeat(15)}  ` }))).toEqual([]);
    });

    it.each(['', '   '])('空白名稱 %j 被擋', (name) => {
      expect(validateOnboardingPlan(withPlan({ name }), NOW).name).toBe('請輸入名稱。');
    });

    it.each(['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb'])('名稱內含控制字元 %j 被擋', (name) => {
      expect(validateOnboardingPlan(withPlan({ name }), NOW).name).toBe(
        '名稱不能包含換行或其他控制字元。',
      );
    });
  });

  describe('到期日（YYYY-MM-DD 的真實日曆日期，且晚於今天）', () => {
    it.each(['2026-10-06', '2027-12-31', '2028-02-29'])('接受 %s', (expiresOn) =>
      expect(errorKeys(withPlan({ expiresOn }))).toEqual([]),
    );

    it.each([
      '2027-02-30',
      '2027-02-29',
      '2100-02-29',
      '2027-04-31',
      '2027-13-01',
      '2027-00-10',
      '2027-01-00',
      '2027-1-1',
      '2027/01/01',
      '20271231',
      '',
      '明年',
    ])('日期格式或日曆不合法 %j', (expiresOn) =>
      expect(validateOnboardingPlan(withPlan({ expiresOn }), NOW).expiresOn).toBe('請選擇有效的到期日。'),
    );

    it.each(['2026-10-05', '2026-10-04', '2020-01-01'])('今天或更早 %s 被擋', (expiresOn) =>
      expect(validateOnboardingPlan(withPlan({ expiresOn }), NOW).expiresOn).toBe('到期日要晚於今天。'),
    );
  });

  describe('IP 位址（限制 IP 模式，1 到 5 組 IPv4）', () => {
    const restricted = (addresses: string[]) => withPlan({ ip: { mode: 'restricted', addresses } });

    it('1 組與 5 組通過', () => {
      expect(errorKeys(restricted(['203.0.113.42']))).toEqual([]);
      expect(errorKeys(restricted(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5']))).toEqual([]);
    });

    it('空清單與 6 組被擋', () => {
      expect(errorKeys(restricted([]))).toEqual(['ip']);
      expect(errorKeys(restricted(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6']))).toEqual(['ip']);
    });

    it.each(['256.1.1.1', '1.2.3', '203.0.113.42/24', '::1', 'example.com', ''])(
      '清單中夾帶不合法位址 %j 被擋',
      (bad) => {
        const errors = validateOnboardingPlan(restricted(['203.0.113.42', bad]), NOW);
        expect(Object.keys(errors)).toEqual(['ip']);
        expect(errors.ip).toBe('請輸入正確的 IPv4 位址，例如 203.0.113.42。');
      },
    );
  });

  describe('權限與帳戶', () => {
    it('四個權限都沒勾被擋', () => {
      const permissions = { quote: false, account: false, trade: false, prod: false };
      expect(Object.keys(validateOnboardingPlan(withPlan({ permissions }), NOW))).toEqual(['permissions']);
    });

    it('沒有任何帳戶類型被擋', () => {
      expect(Object.keys(validateOnboardingPlan(withPlan({ accountTypes: [] }), NOW))).toEqual(['accountTypes']);
    });
  });

  it('多個欄位同時錯誤時一次回報', () => {
    const plan: OnboardingPlan = {
      name: '',
      expiresOn: '2027-02-30',
      permissions: { quote: false, account: false, trade: false, prod: false },
      accountTypes: [],
      ip: { mode: 'restricted', addresses: [] },
    };
    expect(errorKeys(plan).sort()).toEqual(['accountTypes', 'expiresOn', 'ip', 'name', 'permissions']);
  });
});
