// scripts/vite-plugin-sinopac-onboarding.ts
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { createOnboardingRouteHandler } from './sinopac-onboarding/routes';
import type { OnboardingService } from './sinopac-onboarding/service';

export interface EnvInput {
  apiKey: string;
  secretKey: string;
  production?: boolean;
  caPath?: string;
  caPasswd?: string;
}

export const defaultEnvPath = () => path.resolve(process.cwd(), '.env');

/** 新建 .env 時的整份內容。 */
export function buildEnvContent(input: EnvInput): string {
  const lines = [
    '# ── Shioaji credentials (自動產生存檔) ──────────────────────────────────',
    '# 由 Shioaji Pro 自動寫入；請勿將 .env 提交至公開版本控制',
    `SJ_API_KEY=${String(input.apiKey).trim()}`,
    `SJ_SEC_KEY=${String(input.secretKey).trim()}`,
    '',
    '# 運行環境（模擬環境或正式環境）',
    `SJ_PRODUCTION=${input.production ? 'true' : 'false'}`,
  ];

  if (input.caPath) {
    lines.push(`SJ_CA_PATH=${input.caPath}`);
  }
  if (input.caPasswd) {
    lines.push(`SJ_CA_PASSWD=${input.caPasswd}`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface EnvWatcher {
  unwatch(path: string): unknown;
  add(path: string): unknown;
}

/** 就地換掉該變數的每一行（保留 export 前綴與 CRLF），整份都沒有才附加在最後。 */
function setEnvVar(content: string, name: string, value: string): string {
  const line = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${name}[ \\t]*=.*$`, 'gm');
  let found = false;
  const next = content.replace(line, (_match, prefix: string) => {
    found = true;
    return `${prefix}${name}=${value}`;
  });
  if (found) return next;
  return `${next}${next === '' || next.endsWith('\n') ? '' : '\n'}${name}=${value}\n`;
}

/** 精靈存檔：已有 .env 只換兩個金鑰行，沒有就建立；寫入前後暫停 Vite 的 .env 監看，避免 server 重啟與頁面重載。 */
export function saveKeysToEnv(
  keys: { apiKey: string; secretKey: string },
  options: {
    envPath?: string;
    getWatcher?: () => EnvWatcher | undefined;
    resumeDelayMs?: number;
  } = {},
): { envPath: string; resumed: Promise<void> } {
  const envPath = options.envPath ?? defaultEnvPath();
  const apiKey = String(keys.apiKey).trim();
  const secretKey = String(keys.secretKey).trim();
  // 值直接寫進 .env，含空白或換行會多出別的變數，一律拒絕。
  if (!/^\S+$/.test(apiKey) || !/^\S+$/.test(secretKey)) {
    throw new Error('invalid key value');
  }

  try {
    options.getWatcher?.()?.unwatch(envPath);
  } catch {
    // 暫停失敗也要寫入：最壞情況是 Vite 重啟、頁面重載。
  }
  let resumed: Promise<void> = Promise.resolve();
  try {
    const exists = fs.existsSync(envPath);
    // .env 是 symlink 時讀寫實際的檔案，rename 才不會把連結換成一般檔案；監看仍用 envPath。
    const target = exists ? fs.realpathSync(envPath) : envPath;
    const next = exists
      ? setEnvVar(setEnvVar(fs.readFileSync(target, 'utf8'), 'SJ_API_KEY', apiKey), 'SJ_SEC_KEY', secretKey)
      : buildEnvContent({ apiKey, secretKey, production: false });
    // 先寫暫存檔再 rename：中途失敗不會留下寫一半的 .env；最後一律收緊成 0600（含原本就存在的檔案）。
    const tmpPath = `${target}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, next, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, target);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
    fs.chmodSync(target, 0o600);
  } finally {
    // 寫入失敗也要恢復監看；延遲一下讓這次寫入的檔案事件先過去。
    resumed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          options.getWatcher?.()?.add(envPath);
        } catch {
          // 恢復失敗不蓋掉原本的結果。
        }
        resolve();
      }, options.resumeDelayMs ?? 1000);
      timer.unref();
    });
  }
  return { envPath, resumed };
}

export interface SinopacOnboardingPluginOptions {
  /** 覆寫 .env 路徑（測試用）；預設為 process.cwd()/.env。 */
  envPath?: string;
}

export function vitePluginSinopacOnboarding(options: SinopacOnboardingPluginOptions = {}): Plugin {
  return {
    name: 'vite-plugin-sinopac-onboarding',
    // 只在 dev server 掛載：build／preview 不得出現這些端點。
    apply: 'serve',
    configureServer(server) {
      const keyEnvPath = options.envPath ?? defaultEnvPath(); // 存檔位置與 /key 回報的路徑用同一個值
      let service: Promise<OnboardingService> | undefined;
      const getService = () =>
        (service ??= (async () => {
          // 動態 import 的模組只能 value-import 相對路徑與 node:，bare import 會被提升到 config 載入時執行。
          const [{ createOnboardingService }, { localOnboardingGateway }, { sharedOnboardingRepository }] =
            await Promise.all([
              import('./sinopac-onboarding/service'),
              import('./sinopac-onboarding/gateway'),
              import('./sinopac-onboarding/repository'),
            ]);
          return createOnboardingService({
            gateway: localOnboardingGateway,
            // repository 掛 globalThis：Vite 重啟（重建 plugin）後 /status 仍能還原進行中的流程。
            repository: sharedOnboardingRepository(),
            // 與回應同一個請求內存檔：用戶端斷線也不會弄丟只顯示一次的 Secret。
            saveCredentials: async (keys) => {
              saveKeysToEnv(keys, { envPath: keyEnvPath, getWatcher: () => server.watcher });
            },
          });
        })().catch((error: unknown) => {
          service = undefined;
          throw error;
        }));

      server.middlewares.use(createOnboardingRouteHandler({ getService, envPath: keyEnvPath }));
    },
  };
}
