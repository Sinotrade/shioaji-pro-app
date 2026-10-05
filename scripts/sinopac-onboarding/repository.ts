// 整個行程共用同一份流程狀態：Vite 在行程內重建 server 時，新的 service 接得上舊流程（gateway 的 context 也掛 globalThis）。
// 狀態只有已遮罩的收碼目標、條款、方案、倒數與計數，沒有帳密、生日、OTP、金鑰（型別見 service.ts 的 SessionState）。
import {
  createInMemoryOnboardingRepository,
  type OnboardingRepository,
} from "./service";

const g = globalThis as typeof globalThis & {
  __sinopacOnboardingRepository?: OnboardingRepository;
};

/** 以 `createOnboardingService({ repository: sharedOnboardingRepository() })` 注入。 */
export function sharedOnboardingRepository(): OnboardingRepository {
  return (g.__sinopacOnboardingRepository ??=
    createInMemoryOnboardingRepository());
}
