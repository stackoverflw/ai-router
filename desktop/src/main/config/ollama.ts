/**
 * Ollama 进程托管与模型管理。
 *
 * 设计取舍：**不把 700MB 的 ollama.exe 塞进仓库**，而是：
 *
 * 1. 检测本机是否已安装 Ollama（PATH 或常见安装目录）；
 * 2. 已安装但未运行时，由应用负责拉起 `ollama serve`（并且只拉起我们自己启动的进程，
 *    用户手动开的服务不会被误杀）；
 * 3. 未安装时返回明确的安装引导，界面据此提示用户。
 *
 * 这样既满足"把 Ollama 打包进软件"的使用体验，又不会让仓库膨胀到无法维护。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LocalModelInfo, LocalModelPreset, PullProgress } from '../../shared/types.js';

const DEFAULT_HOST = 'http://127.0.0.1:11434';

/** 候选可执行文件位置。 */
function candidatePaths(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Ollama', 'ollama.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama');
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', path.join(home, '.local', 'bin', 'ollama'));
  }

  return candidates;
}

export function findOllamaBinary(): string | null {
  for (const candidate of candidatePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ============================================================
// HTTP 辅助
// ============================================================

async function requestJson<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function isOllamaRunning(host = DEFAULT_HOST): Promise<boolean> {
  try {
    await requestJson(`${host}/api/tags`, undefined, 2500);
    return true;
  } catch {
    return false;
  }
}

export async function ollamaVersion(host = DEFAULT_HOST): Promise<string> {
  try {
    const data = await requestJson<{ version?: string }>(`${host}/api/version`, undefined, 2500);
    return data.version ?? '';
  } catch {
    return '';
  }
}

interface OllamaTagEntry {
  name?: string;
  model?: string;
  size?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

export async function listLocalModels(host = DEFAULT_HOST): Promise<LocalModelInfo[]> {
  try {
    const data = await requestJson<{ models?: OllamaTagEntry[] }>(`${host}/api/tags`, undefined, 5000);
    return (data.models ?? []).map((entry) => ({
      name: entry.name ?? entry.model ?? 'unknown',
      sizeBytes: entry.size ?? 0,
      parameterSize: entry.details?.parameter_size ?? '',
      quantization: entry.details?.quantization_level ?? '',
      family: entry.details?.family ?? '',
      // Ollama 中的文本模型一律不具备媒体生成能力。
      mediaGeneration: false,
      contextWindow: 0,
    }));
  } catch {
    return [];
  }
}

// ============================================================
// 进程托管
// ============================================================

let managedProcess: ChildProcess | null = null;

export interface StartResult {
  ok: boolean;
  message: string;
}

/** 启动 `ollama serve`。已经在运行时不重复启动。 */
export async function startOllama(host = DEFAULT_HOST): Promise<StartResult> {
  if (await isOllamaRunning(host)) {
    return { ok: true, message: 'Ollama 已在运行。' };
  }

  const binary = findOllamaBinary();
  if (!binary) {
    return {
      ok: false,
      message:
        '未检测到 Ollama。请先从 https://ollama.com/download 安装，安装后回到本页点击"检测"。',
    };
  }

  if (managedProcess && !managedProcess.killed) {
    return { ok: true, message: 'Ollama 正在启动中，请稍候刷新。' };
  }

  try {
    managedProcess = spawn(binary, ['serve'], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });

    managedProcess.on('exit', () => {
      managedProcess = null;
    });
  } catch (error) {
    return { ok: false, message: `启动 Ollama 失败：${(error as Error).message}` };
  }

  // 最多等 20 秒，确认端口真的起来了。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isOllamaRunning(host)) {
      return { ok: true, message: 'Ollama 已启动。' };
    }
  }

  return { ok: false, message: 'Ollama 启动超时，请手动运行 `ollama serve` 后重试。' };
}

/** 停止由本应用启动的 Ollama。用户自己开的服务不会被杀掉。 */
export async function stopOllama(): Promise<StartResult> {
  if (!managedProcess || managedProcess.killed) {
    return { ok: false, message: '当前没有由本应用启动的 Ollama 进程，未做任何操作。' };
  }

  const stopping = managedProcess;
  managedProcess = null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        stopping.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
      resolve({ ok: true, message: '已强制停止 Ollama。' });
    }, 5000);

    stopping.once('exit', () => {
      clearTimeout(timer);
      resolve({ ok: true, message: '已停止 Ollama。' });
    });

    try {
      stopping.kill();
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, message: `停止失败：${(error as Error).message}` });
    }
  });
}

// ============================================================
// 模型下载
// ============================================================

const activePulls = new Map<string, AbortController>();

/** 下载（拉取）模型，边拉边通过 onProgress 回调进度。 */
export async function pullModel(
  name: string,
  host: string,
  onProgress: (progress: PullProgress) => void,
): Promise<{ started: boolean; error?: string }> {
  if (activePulls.has(name)) {
    return { started: false, error: '该模型正在下载中。' };
  }

  const controller = new AbortController();
  activePulls.set(name, controller);

  try {
    const response = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      activePulls.delete(name);
      return { started: false, error: `下载请求失败：HTTP ${response.status}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 流式解析 NDJSON：每行一个进度对象。
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (typeof parsed.error === 'string') {
          onProgress({
            model: name,
            status: 'error',
            completedBytes: 0,
            totalBytes: 0,
            percent: 0,
            done: true,
            error: parsed.error,
          });
          activePulls.delete(name);
          return { started: false, error: parsed.error };
        }

        const completed = Number(parsed.completed ?? 0);
        const total = Number(parsed.total ?? 0);
        const status = String(parsed.status ?? '');

        onProgress({
          model: name,
          status,
          completedBytes: completed,
          totalBytes: total,
          percent: total > 0 ? Math.min(100, Math.round((completed / total) * 1000) / 10) : 0,
          done: status === 'success',
        });
      }
    }

    onProgress({
      model: name,
      status: 'success',
      completedBytes: 0,
      totalBytes: 0,
      percent: 100,
      done: true,
    });

    return { started: true };
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? '已取消下载。' : (error as Error).message;
    onProgress({
      model: name,
      status: 'cancelled',
      completedBytes: 0,
      totalBytes: 0,
      percent: 0,
      done: true,
      error: message,
    });
    return { started: false, error: message };
  } finally {
    activePulls.delete(name);
  }
}

export function cancelPull(name: string): void {
  activePulls.get(name)?.abort();
  activePulls.delete(name);
}

export async function deleteModel(name: string, host: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${host}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

// ============================================================
// 内置模型库
// ============================================================

/**
 * 精选模型清单。
 *
 * 只收录在中文任务上确实可用、且体积/收益比合理的开源模型。
 * `ramGb` 是"能跑起来"的经验值（含 KV cache 余量），用于给用户提示。
 */
export const MODEL_PRESETS: LocalModelPreset[] = [
  {
    name: 'qwen2.5:0.5b',
    displayName: 'Qwen2.5 0.5B',
    parameterSize: '0.5B',
    downloadSize: '约 0.4 GB',
    ramGb: 2,
    description: '极小体积，只适合问候、单句翻译、单位换算。低配机器保底选择。',
    tags: ['极速', '保底'],
    chineseLevel: 'fair',
  },
  {
    name: 'qwen2.5:1.5b',
    displayName: 'Qwen2.5 1.5B',
    parameterSize: '1.5B',
    downloadSize: '约 1.0 GB',
    ramGb: 3,
    description: '短文案、简单问答表现不错，中文比同尺寸英文模型好很多。',
    tags: ['轻量'],
    chineseLevel: 'good',
  },
  {
    name: 'llama3.2:1b',
    displayName: 'Llama 3.2 1B',
    parameterSize: '1B',
    downloadSize: '约 1.2 GB',
    ramGb: 3,
    description: '英文任务响应快；中文能力弱于 Qwen 系列，中文场景不推荐。',
    tags: ['英文优先'],
    chineseLevel: 'fair',
  },
  {
    name: 'qwen2.5:3b',
    displayName: 'Qwen2.5 3B',
    parameterSize: '3B',
    downloadSize: '约 1.9 GB',
    ramGb: 5,
    description: '性价比很高：名词解释、短代码、摘要都能稳定完成。',
    tags: ['性价比'],
    chineseLevel: 'good',
  },
  {
    name: 'qwen3:4b',
    displayName: 'Qwen3 4B',
    parameterSize: '4B',
    downloadSize: '约 2.3 GB',
    ramGb: 6,
    description: 'AI Router 的默认本地模型。原生支持思考链，简单任务判断与执行都稳。',
    tags: ['推荐', '默认'],
    chineseLevel: 'excellent',
    recommended: true,
  },
  {
    name: 'gemma3:4b',
    displayName: 'Gemma 3 4B',
    parameterSize: '4B',
    downloadSize: '约 3.3 GB',
    ramGb: 8,
    description: '支持读图（多模态输入），但同样不具备图片/视频生成能力。',
    tags: ['多模态输入'],
    chineseLevel: 'good',
  },
  {
    name: 'qwen2.5-coder:7b',
    displayName: 'Qwen2.5 Coder 7B',
    parameterSize: '7B',
    downloadSize: '约 4.7 GB',
    ramGb: 10,
    description: '本地代码专用。单文件级别的编写与排错可以在本地完成。',
    tags: ['代码'],
    chineseLevel: 'good',
  },
  {
    name: 'qwen2.5:7b',
    displayName: 'Qwen2.5 7B',
    parameterSize: '7B',
    downloadSize: '约 4.7 GB',
    ramGb: 10,
    description: '通用中文能力显著提升，可以承接更长的文案与更细的指令。',
    tags: ['均衡'],
    chineseLevel: 'excellent',
  },
  {
    name: 'deepseek-r1:7b',
    displayName: 'DeepSeek-R1 7B',
    parameterSize: '7B',
    downloadSize: '约 4.7 GB',
    ramGb: 10,
    description: '蒸馏推理模型，适合数学与逻辑题，但速度明显慢于同尺寸通用模型。',
    tags: ['推理'],
    chineseLevel: 'good',
  },
  {
    name: 'qwen3:8b',
    displayName: 'Qwen3 8B',
    parameterSize: '8B',
    downloadSize: '约 5.2 GB',
    ramGb: 12,
    description: '本地能力的上限选择：可与云端分工承担更复杂的分析与写作。',
    tags: ['高质量'],
    chineseLevel: 'excellent',
  },
  {
    name: 'deepseek-r1:14b',
    displayName: 'DeepSeek-R1 14B',
    parameterSize: '14B',
    downloadSize: '约 9.0 GB',
    ramGb: 18,
    description: '消费级显卡可跑的最强推理档位；内存不足时会被系统换页拖慢。',
    tags: ['强推理', '高占用'],
    chineseLevel: 'good',
  },
];

export { DEFAULT_HOST };
