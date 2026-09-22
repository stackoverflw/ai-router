/**
 * 执行后端适配器。
 *
 * 把"路由内核"与"真实模型/工具"解耦：
 * 内核（router / planner / executor）只依赖接口，
 * 这里负责实现本地 Ollama 调用、云端 OpenAI 兼容调用、以及工具调用。
 */

import { spawn } from 'node:child_process';

import type { TextBackend, ToolBackend } from '../router/executor.js';
import type { AppSettings } from '../../shared/types.js';
import { getCachedSettings } from '../config/settings.js';

// ============================================================
// 文本生成
// ============================================================

interface OllamaChatResponse {
  message?: { content?: string };
  response?: string;
}

/** 去掉 Qwen3 / DeepSeek-R1 的思考段，避免把推理过程当成答案。 */
export function stripThinking(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  if (cleaned.toLowerCase().includes('<think')) {
    const parts = cleaned.split(/<\/think(?:ing)?>/i);
    cleaned = parts[parts.length - 1];
  }
  return cleaned.trim();
}

async function callLocalModel(
  prompt: string,
  model: string,
  host: string,
  system = '',
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  // 本地大模型在 CPU 上可能很慢，给足时间。
  const timer = setTimeout(() => controller.abort(), 600_000);

  try {
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama 返回 HTTP ${response.status}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content ?? data.response ?? '';
    return stripThinking(content);
  } finally {
    clearTimeout(timer);
  }
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function callCloudModel(
  prompt: string,
  settings: AppSettings,
  options: { system?: string; model?: string } = {},
): Promise<string> {
  const { cloud } = settings;

  if (!cloud.apiKey || !cloud.baseUrl || !cloud.model) {
    throw new Error('云端未配置：请在设置页填入 API Key、Base URL 与模型名。');
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);

  try {
    const response = await fetch(`${cloud.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloud.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || cloud.model,
        messages,
        temperature: cloud.temperature ?? 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`云端返回 HTTP ${response.status}：${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as OpenAiChatResponse;
    return (data.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

export function createTextBackend(): TextBackend {
  return {
    callLocal: (prompt, model) =>
      callLocalModel(prompt, model, getCachedSettings().ollamaHost),

    callCloud: (prompt, options) => callCloudModel(prompt, getCachedSettings(), options),

    cloudConfigured: () => {
      const { cloud } = getCachedSettings();
      return Boolean(cloud.apiKey && cloud.baseUrl && cloud.model);
    },
  };
}

// ============================================================
// 工具
// ============================================================

export interface ToolCallResult {
  ok: boolean;
  text: string;
  error: string;
  notConfigured: boolean;
}

/** 从环境变量与设置里解析工具的配置。 */
function toolEnv(tool: string, suffix: string): string {
  return (process.env[`AI_ROUTER_TOOL_${tool.toUpperCase()}_${suffix}`] ?? '').trim();
}

export function toolAvailable(tool: string): boolean {
  if (tool === 'media_compose') return Boolean(toolEnv(tool, 'COMMAND')) || hasFfmpeg();
  if (tool === 'file_read') return true;
  return Boolean(toolEnv(tool, 'URL') || toolEnv(tool, 'COMMAND'));
}

let ffmpegChecked = false;
let ffmpegPresent = false;

export function hasFfmpeg(): boolean {
  if (ffmpegChecked) return ffmpegPresent;
  ffmpegChecked = true;

  try {
    // `where` / `which` 是同步且极快的探测方式。
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const result = spawn(probe, ['ffmpeg'], { stdio: 'ignore', windowsHide: true });
    result.on('error', () => {
      ffmpegPresent = false;
    });
    result.on('exit', (code) => {
      ffmpegPresent = code === 0;
    });
  } catch {
    ffmpegPresent = false;
  }

  // 探测是异步的，先返回"未知即 false"；下次调用会拿到缓存结果。
  return ffmpegPresent;
}

/** 异步确认 ffmpeg 是否可用（用于状态展示，避免误报）。 */
export async function detectFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      const child = spawn(probe, ['ffmpeg'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => {
        ffmpegPresent = code === 0;
        ffmpegChecked = true;
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

const SETUP_HINTS: Record<string, string> = {
  video_generate:
    '视频生成需要接入外部服务。可设置环境变量 AI_ROUTER_TOOL_VIDEO_GENERATE_URL 与 _KEY 指向云端视频 API，' +
    '或指向本地 ComfyUI（http://127.0.0.1:8188/prompt）。接口约定：POST JSON {prompt, modality, duration}，返回 {url} 或 {artifacts:[]}。',
  image_generate:
    '图片生成需要接入外部服务。可指向本地 Stable Diffusion WebUI（http://127.0.0.1:7860/sdapi/v1/txt2img），' +
    '或任意 OpenAI 兼容的图片接口。',
  audio_synthesize:
    '语音合成需要接入 TTS 服务。可以用命令模式，例如 AI_ROUTER_TOOL_AUDIO_SYNTHESIZE_COMMAND=edge-tts --text "{prompt}" --write-media {output}。',
  media_compose: '媒体合成需要 ffmpeg。安装后设置 AI_ROUTER_TOOL_MEDIA_COMPOSE_COMMAND=ffmpeg -y -i {input} {output}。',
  web_search: '检索能力需要接入搜索服务：设置 AI_ROUTER_TOOL_WEB_SEARCH_URL 与 _KEY。',
};

function setupHint(tool: string): string {
  return SETUP_HINTS[tool] ?? `工具 ${tool} 尚未配置。`;
}

function extractText(payload: unknown): { text: string; artifacts: string[] } {
  if (typeof payload === 'string') return { text: payload, artifacts: [] };
  if (!payload || typeof payload !== 'object') return { text: String(payload), artifacts: [] };

  const record = payload as Record<string, unknown>;
  const artifacts: string[] = [];
  const texts: string[] = [];

  for (const key of ['artifacts', 'images', 'files', 'outputs', 'urls']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') artifacts.push(item);
        else if (item && typeof item === 'object') {
          const nested = item as Record<string, unknown>;
          for (const sub of ['url', 'path', 'file', 'image', 'video']) {
            if (typeof nested[sub] === 'string') {
              artifacts.push(nested[sub] as string);
              break;
            }
          }
        }
      }
    }
  }

  for (const key of ['url', 'output', 'output_url', 'video', 'video_url', 'image', 'audio', 'path', 'file']) {
    if (typeof record[key] === 'string') artifacts.push(record[key] as string);
  }

  for (const key of ['text', 'message', 'result', 'revised_prompt']) {
    if (typeof record[key] === 'string') texts.push(record[key] as string);
  }

  return { text: texts.join('\n'), artifacts: [...new Set(artifacts)] };
}

async function callHttpTool(tool: string, payload: Record<string, unknown>): Promise<ToolCallResult> {
  const url = toolEnv(tool, 'URL');
  const key = toolEnv(tool, 'KEY');

  if (!url) {
    return { ok: false, text: '', error: `${tool} 未配置接口地址。\n${setupHint(tool)}`, notConfigured: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, text: '', error: `${tool} 返回 HTTP ${response.status}`, notConfigured: false };
    }

    const body = (await response.json()) as unknown;
    const { text, artifacts } = extractText(body);

    if (!text && !artifacts.length) {
      return { ok: false, text: '', error: `${tool} 返回了空结果`, notConfigured: false };
    }

    return {
      ok: true,
      text: artifacts.length ? `${text}\n产物：\n${artifacts.join('\n')}`.trim() : text,
      error: '',
      notConfigured: false,
    };
  } catch (error) {
    return { ok: false, text: '', error: `${tool} 调用失败：${(error as Error).message}`, notConfigured: false };
  } finally {
    clearTimeout(timer);
  }
}

function runShell(command: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function createToolBackend(): ToolBackend {
  return {
    async call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
      const prompt = String(args.prompt ?? args.source ?? args.query ?? '');

      // ---- 媒体生成 ----
      if (tool === 'video_generate' || tool === 'image_generate' || tool === 'audio_synthesize') {
        const modality = tool.split('_')[0];
        const command = toolEnv(tool, 'COMMAND');

        if (command) {
          const outputPath = String(args.output ?? '');
          const expanded = command
            .replace(/\{prompt\}/g, prompt)
            .replace(/\{input\}/g, prompt)
            .replace(/\{output\}/g, outputPath);
          const result = await runShell(expanded, 600_000);
          if (result.code !== 0) {
            return { ok: false, text: '', error: `${tool} 退出码 ${result.code}：${result.stderr.slice(0, 300)}`, notConfigured: false };
          }
          return { ok: true, text: result.stdout.trim(), error: '', notConfigured: false };
        }

        return callHttpTool(tool, { prompt, modality, duration: args.duration });
      }

      // ---- 媒体合成 ----
      if (tool === 'media_compose') {
        const command = toolEnv(tool, 'COMMAND');
        const ffmpeg = await detectFfmpeg();

        if (!command && !ffmpeg) {
          // 上游已有产物就直接交付，并说明没有做二次处理——不假装成功，也不无谓失败。
          const artifact = prompt
            .split('\n')
            .map((line) => line.trim())
            .find((line) => /^(https?:\/\/|[A-Za-z]:\\|\/)/.test(line));

          if (artifact) {
            return {
              ok: true,
              text: `上游产物直接交付（未做二次合成，因为本机缺少 ffmpeg）：\n${artifact}`,
              error: '',
              notConfigured: false,
            };
          }

          return {
            ok: false,
            text: '',
            error: `未检测到 ffmpeg，无法做拼接 / 压制 / 转码。\n${setupHint(tool)}`,
            notConfigured: true,
          };
        }

        if (!command) {
          return {
            ok: true,
            text: '检测到本机已安装 ffmpeg，已具备媒体合成能力；上游返回的是链接，交由用户下载后合成。',
            error: '',
            notConfigured: false,
          };
        }

        const expanded = command.replace(/\{input\}/g, prompt).replace(/\{output\}/g, String(args.output ?? ''));
        const result = await runShell(expanded, 600_000);
        return result.code === 0
          ? { ok: true, text: result.stdout.trim(), error: '', notConfigured: false }
          : { ok: false, text: '', error: `media_compose 退出码 ${result.code}：${result.stderr.slice(0, 300)}`, notConfigured: false };
      }

      // ---- 检索 ----
      if (tool === 'web_search') {
        return callHttpTool(tool, { query: prompt, limit: 5 });
      }

      return { ok: false, text: '', error: `未实现的工具：${tool}`, notConfigured: false };
    },
  };
}
