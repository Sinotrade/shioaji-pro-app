import {
    type OnboardingAccountType,
    type OnboardingPermission,
    type OnboardingPlan,
} from './types';

export const PERMISSION_ORDER: OnboardingPermission[] = ['quote', 'account', 'trade', 'prod'];
export const PERMISSION_LABELS: Record<OnboardingPermission, string> = {
    quote: '行情／資料',
    account: '帳務',
    trade: '交易',
    prod: '正式環境',
};
export const ACCOUNT_TYPE_ORDER: OnboardingAccountType[] = ['stock', 'futures', 'overseas'];
export const ACCOUNT_TYPE_LABELS: Record<OnboardingAccountType, string> = {
    stock: '證券戶',
    futures: '期貨戶',
    overseas: '海外股票',
};

/** 預設四項權限全開（含交易）；開放交易仍要使用者勾選風險確認才能送出。 */
const DEFAULT_PERMISSIONS: Record<OnboardingPermission, boolean> = {
    quote: true,
    account: true,
    trade: true,
    prod: true,
};

/** 畫面上的表單狀態；送出前才用 planFromForm 轉成共用契約的 OnboardingPlan。 */
export interface PlanForm {
    permissions: Record<OnboardingPermission, boolean>;
    accountTypes: Record<OnboardingAccountType, boolean>;
    ipMode: OnboardingPlan['ip']['mode'];
    /** 只在限制 IP 時送出；切回無限制 IP 時保留已輸入的值，方便再切回來。 */
    ips: string[];
    name: string;
    expiresOn: string;
    /** 只存在畫面上的風險確認，不送到伺服器。 */
    tradeAck: boolean;
}

function pad(value: number) {
    return String(value).padStart(2, '0');
}

export function toDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(from: Date, days: number): Date {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}

export function addOneYear(from: Date): Date {
    return new Date(from.getFullYear() + 1, from.getMonth(), from.getDate());
}

export function createPlanForm(now: Date = new Date()): PlanForm {
    return {
        permissions: { ...DEFAULT_PERMISSIONS },
        // 帳戶類型全選；表單上沒有的類型由 driver 略過。
        accountTypes: { stock: true, futures: true, overseas: true },
        // 一般家用與行動網路的 IP 會變動，預設不限制。
        ipMode: 'unlimited',
        // IP 沒有可靠的偵測來源，不預填：預填錯誤的 IP 會建立出用不了的金鑰。
        ips: [''],
        // 預設名稱帶上申請日（月日），之後在 API 管理頁比較好分辨是哪一次申請的。
        name: `ShioajiPro${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
        expiresOn: toDateKey(addOneYear(now)),
        tradeAck: false,
    };
}

export function planFromForm(form: PlanForm): OnboardingPlan {
    return {
        name: form.name.trim(),
        expiresOn: form.expiresOn,
        permissions: { ...form.permissions },
        accountTypes: ACCOUNT_TYPE_ORDER.filter((type) => form.accountTypes[type]),
        ip:
            form.ipMode === 'restricted'
                ? { mode: 'restricted', addresses: form.ips.map((ip) => ip.trim()).filter(Boolean) }
                : { mode: 'unlimited', addresses: [] },
    };
}

export function permissionLabels(permissions: readonly OnboardingPermission[]): string[] {
    return PERMISSION_ORDER.filter((key) => permissions.includes(key)).map(
        (key) => PERMISSION_LABELS[key],
    );
}

export function enabledPermissions(plan: OnboardingPlan): OnboardingPermission[] {
    return PERMISSION_ORDER.filter((key) => plan.permissions[key]);
}
