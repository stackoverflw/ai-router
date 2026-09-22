/**
 * 提供商状态：Ollama / 云端 / ffmpeg / 工具能力。
 *
 * 侧栏、状态栏、设置页、下载页都依赖这份状态，
 * 因此这里同时导出访问 preload 桥的统一入口 `getApi()`，
 * 避免每个组件各自处理 `window.aiRouter` 可能缺失的情况。
 */

import { useCallback, useEffect, useState } from 'react';

import type { AiRouterApi, ProviderStatus } from '../../shared/types.js';

declare global {
  interface Window {
    /** preload 注入的 IPC 桥；在极少数情况下（例如纯浏览器预览）可能不存在。 */
    aiRouter?: AiRouterApi;
  }
}

/** 取 preload 桥；不存在时抛出可读错误，由调用方自行 try/catch。 */
export function getApi(): AiRouterApi {
  const api = window.aiRouter;
  if (!api) {
    throw new Error('未检测到桌面端 IPC 桥（window.aiRouter），请在 Electron 中运行本应用。');
  }
  return api;
}

export interface ProviderStatusView {
  status: ProviderStatus | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

export function useProviderStatus(): ProviderStatusView {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const api = getApi();
      const next = await api.providerStatus();
      setStatus(next);
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}
