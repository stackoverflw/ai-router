/**
 * 设置持久化。
 *
 * 存放在 Electron 的 userData 目录，不写进仓库。
 * 云厂商 API Key 只保存在本机，且不打日志。
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AppSettings, CloudSettings } from '../../shared/types.js';

const DEFAULTS: AppSettings = {
  cloud: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    mergeModel: '',
    temperature: 0.3,
  },
  localModel: 'qwen3:4b',
  ollamaHost: 'http://127.0.0.1:11434',
  language: 'zh-CN',
};

let cache: AppSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function mergeSettings(partial: Partial<AppSettings> | null | undefined): AppSettings {
  const source = partial ?? {};
  return {
    ...DEFAULTS,
    ...source,
    cloud: { ...DEFAULTS.cloud, ...(source.cloud ?? {}) },
  };
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;

  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    cache = mergeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    // 文件不存在或损坏都回落到默认值，不让设置问题阻塞启动。
    cache = { ...DEFAULTS, cloud: { ...DEFAULTS.cloud } };
  }

  return cache;
}

export async function saveSettings(next: Partial<AppSettings>): Promise<AppSettings> {
  const merged = mergeSettings({ ...(cache ?? DEFAULTS), ...next });
  cache = merged;

  const target = settingsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(merged, null, 2), 'utf8');

  return merged;
}

export function getCachedSettings(): AppSettings {
  return cache ?? { ...DEFAULTS, cloud: { ...DEFAULTS.cloud } };
}

/** 云端是否已配置到可用状态。 */
export function isCloudConfigured(cloud: CloudSettings): boolean {
  return Boolean(cloud.apiKey && cloud.baseUrl && cloud.model);
}
