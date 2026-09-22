/**
 * IPC 注册：渲染进程唯一的能力入口。
 */

import { BrowserWindow, ipcMain, shell } from 'electron';

import type {
  AppSettings,
  CloudSettings,
  ConnectionTestResult,
  ProviderStatus,
} from '../../shared/types.js';
import { IPC } from '../../shared/types.js';
import {
  MODEL_PRESETS,
  cancelPull,
  deleteModel,
  findOllamaBinary,
  isOllamaRunning,
  listLocalModels,
  ollamaVersion,
  pullModel,
  startOllama,
  stopOllama,
} from '../config/ollama.js';
import { getCachedSettings, loadSettings, saveSettings } from '../config/settings.js';
import { createTextBackend, createToolBackend, detectFfmpeg, toolAvailable } from './backends.js';
import { decide } from '../router/analyze.js';
import { plan } from '../router/planner.js';
import { Executor } from '../router/executor.js';

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const text = createTextBackend();
  const tools = createToolBackend();

  // ==========================================================
  // 路由
  // ==========================================================

  ipcMain.handle(IPC.route, async (_event, prompt: string) => {
    const settings = getCachedSettings();
    const installed = (await listLocalModels(settings.ollamaHost)).map((model) => model.name);

    return decide(prompt, {
      localModel: settings.localModel,
      installedModels: installed,
    });
  });

  // ==========================================================
  // 执行
  // ==========================================================

  ipcMain.handle(IPC.run, async (_event, prompt: string) => {
    const settings = getCachedSettings();
    const installed = (await listLocalModels(settings.ollamaHost)).map((model) => model.name);

    const graph = plan(prompt, {
      installedModels: installed,
      localModel: settings.localModel,
      toolAvailable,
    });

    const window = getWindow();

    const executor = new Executor({
      text,
      tools,
      maxConcurrency: 4,
      onEvent: (event) => {
        // 事件流用于界面实时展示任务图进度。
        window?.webContents.send(IPC.executionEvent, event);
      },
    });

    return executor.run(graph);
  });

  // ==========================================================
  // 模型
  // ==========================================================

  ipcMain.handle(IPC.listLocalModels, async () => {
    const settings = getCachedSettings();
    return listLocalModels(settings.ollamaHost);
  });

  ipcMain.handle(IPC.listModelPresets, () => MODEL_PRESETS);

  ipcMain.handle(IPC.pullModel, async (_event, name: string) => {
    const settings = getCachedSettings();
    const window = getWindow();

    // 不 await：下载是长任务，进度通过事件推送。
    void pullModel(name, settings.ollamaHost, (progress) => {
      window?.webContents.send(IPC.pullProgress, progress);
    });

    return { started: true };
  });

  ipcMain.handle(IPC.cancelPull, async (_event, name: string) => {
    cancelPull(name);
  });

  ipcMain.handle(IPC.deleteModel, async (_event, name: string) => {
    const settings = getCachedSettings();
    return deleteModel(name, settings.ollamaHost);
  });

  // ==========================================================
  // 提供商状态
  // ==========================================================

  ipcMain.handle(IPC.providerStatus, async (): Promise<ProviderStatus> => {
    const settings = getCachedSettings();
    const installedBinary = Boolean(findOllamaBinary());
    const running = await isOllamaRunning(settings.ollamaHost);
    const version = running ? await ollamaVersion(settings.ollamaHost) : '';
    const ffmpeg = await detectFfmpeg();

    return {
      ollamaInstalled: installedBinary,
      ollamaRunning: running,
      ollamaVersion: version,
      host: settings.ollamaHost,
      cloudConfigured: Boolean(settings.cloud.apiKey && settings.cloud.baseUrl && settings.cloud.model),
      ffmpegAvailable: ffmpeg,
      tools: {
        video_generate: toolAvailable('video_generate'),
        image_generate: toolAvailable('image_generate'),
        audio_synthesize: toolAvailable('audio_synthesize'),
        media_compose: toolAvailable('media_compose') || ffmpeg,
        web_search: toolAvailable('web_search'),
      },
    };
  });

  // ==========================================================
  // Ollama 进程托管
  // ==========================================================

  ipcMain.handle(IPC.startOllama, async () => {
    const settings = getCachedSettings();
    return startOllama(settings.ollamaHost);
  });

  ipcMain.handle(IPC.stopOllama, async () => stopOllama());

  // ==========================================================
  // 设置
  // ==========================================================

  ipcMain.handle(IPC.getSettings, async () => loadSettings());

  ipcMain.handle(IPC.saveSettings, async (_event, next: AppSettings) => {
    try {
      await saveSettings(next);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(
    IPC.testCloudConnection,
    async (_event, cloud: CloudSettings): Promise<ConnectionTestResult> => {
      if (!cloud.apiKey || !cloud.baseUrl || !cloud.model) {
        return { ok: false, message: '请先填写 API Key、Base URL 与模型名。', latencyMs: 0, models: [] };
      }

      const started = Date.now();

      try {
        const response = await fetch(`${cloud.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cloud.apiKey}`,
          },
          body: JSON.stringify({
            model: cloud.model,
            messages: [{ role: 'user', content: '只回复两个字：可用' }],
            max_tokens: 16,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        const latencyMs = Date.now() - started;

        if (!response.ok) {
          const body = await response.text();
          return {
            ok: false,
            message: `HTTP ${response.status}：${body.slice(0, 200)}`,
            latencyMs,
            models: [],
          };
        }

        // 顺便拉一次模型列表，方便用户确认模型名是否写对。
        let models: string[] = [];
        try {
          const listResponse = await fetch(`${cloud.baseUrl.replace(/\/$/, '')}/models`, {
            headers: { Authorization: `Bearer ${cloud.apiKey}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (listResponse.ok) {
            const payload = (await listResponse.json()) as { data?: Array<{ id?: string }> };
            models = (payload.data ?? []).map((entry) => entry.id ?? '').filter(Boolean).slice(0, 50);
          }
        } catch {
          /* 列表接口不是所有厂商都支持，失败不影响连通性结论 */
        }

        return { ok: true, message: '连接成功。', latencyMs, models };
      } catch (error) {
        return {
          ok: false,
          message: `连接失败：${(error as Error).message}`,
          latencyMs: Date.now() - started,
          models: [],
        };
      }
    },
  );

  // ==========================================================
  // 系统
  // ==========================================================

  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    // 只允许打开 http(s)，避免被当成任意协议的执行入口。
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });
}
