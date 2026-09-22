/**
 * AI Router 渲染进程根组件。
 *
 * 负责三件事：
 *  1. 视图切换（对话 / 下载 / 设置）与应用级设置加载
 *  2. 把提供商状态与执行 hook 的产物分发给各视图
 *  3. 模型选择的写回（本地模型写 settings.localModel，云端写哨兵值）
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { AppSettings } from '../shared/types.js';
import { ChatView } from './components/ChatView.js';
import { DownloadsView } from './components/DownloadsView.js';
import { SettingsView } from './components/SettingsView.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { useExecution } from './hooks/useExecution.js';
import { getApi, useProviderStatus } from './hooks/useProviderStatus.js';
import { CLOUD_SENTINEL, errorText, type ViewKey } from './utils.js';

export default function App(): JSX.Element {
  const { status: providerStatus, loading: providerLoading, refresh: refreshProvider } = useProviderStatus();
  const execution = useExecution();

  const [view, setView] = useState<ViewKey>('chat');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [bootError, setBootError] = useState<string>('');
  const [pulling, setPulling] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await getApi().getSettings();
        if (!cancelled) {
          setSettings(loaded);
          setBootError('');
        }
      } catch (err: unknown) {
        if (!cancelled) setBootError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 写回设置。IPC 失败不回滚本地状态（界面保持用户的选择），
   * 但会把错误抛给调用方以便展示。
   */
  const persist = useCallback(async (next: AppSettings): Promise<void> => {
    setSettings(next);
    const result = await getApi().saveSettings(next);
    if (!result.ok) {
      throw new Error(result.error ?? '保存设置失败');
    }
  }, []);

  const handlePickLocalModel = useCallback(
    (name: string): void => {
      if (!settings) return;
      void persist({ ...settings, localModel: name }).catch((err: unknown) => {
        setBootError(`保存本地模型选择失败：${errorText(err)}`);
      });
    },
    [persist, settings],
  );

  const handlePickCloud = useCallback((): void => {
    if (!settings) return;
    void persist({ ...settings, localModel: CLOUD_SENTINEL }).catch((err: unknown) => {
      setBootError(`切换到云端失败：${errorText(err)}`);
    });
  }, [persist, settings]);

  const handleSettingsSaved = useCallback((next: AppSettings): void => {
    setSettings(next);
  }, []);

  const handleNavigate = useCallback((next: ViewKey): void => {
    setView(next);
  }, []);

  const handleActivePullChange = useCallback((active: boolean): void => {
    setPulling(active);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar view={view} onChange={setView} hasActivePull={pulling} />

      <main className="app-main">
        {bootError ? (
          <div className="warning-banner" style={{ margin: '12px 22px 0' }}>
            <span className="warning-banner-text">
              <span className="warning-banner-title">BRIDGE WARNING</span>
              <span className="warning-banner-desc">{bootError}</span>
            </span>
            <span className="warning-banner-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBootError('')}>
                忽略
              </button>
            </span>
          </div>
        ) : null}

        {view === 'chat' ? (
          <ChatView
            execution={execution}
            providerStatus={providerStatus}
            providerLoading={providerLoading}
            settings={settings}
            onNavigate={handleNavigate}
            onPickLocalModel={handlePickLocalModel}
            onPickCloud={handlePickCloud}
          />
        ) : null}

        {view === 'downloads' ? (
          <DownloadsView
            providerStatus={providerStatus}
            onProviderRefresh={refreshProvider}
            onActivePullChange={handleActivePullChange}
          />
        ) : null}

        {view === 'settings' ? (
          <SettingsView
            settings={settings}
            providerStatus={providerStatus}
            onProviderRefresh={refreshProvider}
            onSettingsSaved={handleSettingsSaved}
          />
        ) : null}

        <StatusBar
          providerStatus={providerStatus}
          localModel={settings?.localModel ?? ''}
          cloudModel={settings?.cloud.model ?? ''}
          totals={execution.totals}
          running={execution.running}
          pulling={pulling}
        />
      </main>
    </div>
  );
}
