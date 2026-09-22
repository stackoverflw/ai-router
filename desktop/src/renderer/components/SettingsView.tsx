/**
 * 设置视图。
 *
 * 云端接入 / 本地模型 / 工具能力 / 关于。
 * 所有写入都通过 saveSettings，测试连接走 testCloudConnection。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type {
  AppSettings,
  ConnectionTestResult,
  LocalModelInfo,
  ProviderStatus,
} from '../../shared/types.js';
import { getApi } from '../hooks/useProviderStatus.js';
import { CLOUD_SENTINEL, errorText } from '../utils.js';

export interface SettingsViewProps {
  settings: AppSettings | null;
  providerStatus: ProviderStatus | null;
  onProviderRefresh: () => Promise<void>;
  onSettingsSaved: (settings: AppSettings) => void;
}

/** 工具能力的展示定义；键名与 ProviderStatus.tools 对应。 */
const TOOL_ROWS: Array<{ key: string; label: string }> = [
  { key: 'videoGeneration', label: '视频生成' },
  { key: 'imageGeneration', label: '图片生成' },
  { key: 'speechSynthesis', label: '语音合成' },
  { key: 'mediaCompose', label: '媒体合成（ffmpeg）' },
  { key: 'retrieval', label: '检索' },
  { key: 'webSearch', label: '联网搜索' },
];

const TOOL_ALIASES: Record<string, string[]> = {
  videoGeneration: ['video', 'videoGeneration', 'video_generation'],
  imageGeneration: ['image', 'imageGeneration', 'image_generation'],
  speechSynthesis: ['tts', 'speech', 'speechSynthesis', 'speech_synthesis'],
  mediaCompose: ['ffmpeg', 'mediaCompose', 'media_compose', 'compose'],
  retrieval: ['retrieval', 'retrieve', 'rag'],
  webSearch: ['webSearch', 'web_search', 'search'],
};

function toolAvailable(tools: Record<string, boolean>, key: string): boolean {
  const aliases = TOOL_ALIASES[key] ?? [key];
  for (const alias of aliases) {
    if (tools[alias] === true) return true;
  }
  return false;
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { settings, providerStatus, onProviderRefresh, onSettingsSaved } = props;

  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [localModels, setLocalModels] = useState<LocalModelInfo[]>([]);
  const [showKey, setShowKey] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string>('');
  const [savedAt, setSavedAt] = useState<number>(0);
  const [saving, setSaving] = useState<boolean>(false);
  const [ollamaNotice, setOllamaNotice] = useState<string>('');
  const [ollamaBusy, setOllamaBusy] = useState<boolean>(false);

  const savedTimer = useRef<number | null>(null);

  // 设置到达后同步到本地草稿（只在 props 变化时覆盖，避免打断输入）
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getApi().listLocalModels();
        if (!cancelled) setLocalModels(list);
      } catch {
        if (!cancelled) setLocalModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerStatus?.ollamaRunning]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const patchCloud = useCallback((patch: Partial<AppSettings['cloud']>): void => {
    setDraft((prev) => (prev ? { ...prev, cloud: { ...prev.cloud, ...patch } } : prev));
  }, []);

  const patchRoot = useCallback((patch: Partial<Omit<AppSettings, 'cloud'>>): void => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await getApi().saveSettings(draft);
      if (!result.ok) {
        setTestError(result.error ? `保存失败：${result.error}` : '保存失败');
        return;
      }
      onSettingsSaved(draft);
      setTestError('');
      setSavedAt(Date.now());
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSavedAt(0), 2300);
      await onProviderRefresh();
    } catch (err: unknown) {
      setTestError(`保存失败：${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }, [draft, onProviderRefresh, onSettingsSaved]);

  const handleTest = useCallback(async (): Promise<void> => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    setTestError('');
    try {
      const result = await getApi().testCloudConnection(draft.cloud);
      setTestResult(result);
    } catch (err: unknown) {
      setTestError(errorText(err));
    } finally {
      setTesting(false);
    }
  }, [draft]);

  const handleOllama = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      setOllamaBusy(true);
      setOllamaNotice('');
      try {
        const api = getApi();
        const result = action === 'start' ? await api.startOllama() : await api.stopOllama();
        setOllamaNotice(result.message || (result.ok ? '操作完成' : '操作失败'));
        await onProviderRefresh();
      } catch (err: unknown) {
        setOllamaNotice(`操作失败：${errorText(err)}`);
      } finally {
        setOllamaBusy(false);
      }
    },
    [onProviderRefresh],
  );

  if (!draft) {
    return (
      <div className="view-scroll">
        <div className="view-pad">
          <div className="empty-note">正在读取设置…</div>
        </div>
      </div>
    );
  }

  const cloud = draft.cloud;
  const tools = providerStatus?.tools ?? {};

  return (
    <div className="view-scroll">
      <div className="view-pad">
        <div className="view-head">
          <span className="view-title">设置</span>
          <span className="view-sub">云端接入 · 本地模型 · 工具能力</span>
          <span style={{ flex: '1 1 auto' }} />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          {savedAt > 0 ? <span className="saved-toast">✓ 已保存</span> : null}
        </div>

        {testError ? (
          <div className="empty-note" style={{ color: 'var(--danger)', borderColor: 'var(--line-danger)', marginBottom: '16px' }}>
            {testError}
          </div>
        ) : null}

        {/* ---------------- 云端模型接入 ---------------- */}
        <section className="panel-block">
          <div className="panel-block-title">
            <h3>云端模型接入</h3>
            <span className={`pill ${providerStatus?.cloudConfigured ? 'pill-ok' : 'pill-bad'}`}>
              {providerStatus?.cloudConfigured ? '已配置' : '未配置'}
            </span>
          </div>

          <div className="form-grid">
            <label className="field">
              <span className="micro">API KEY</span>
              <span className="input-affix">
                <input
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  value={cloud.apiKey}
                  onChange={(event) => patchCloud({ apiKey: event.target.value })}
                  placeholder="sk-..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="affix-button" onClick={() => setShowKey((prev) => !prev)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </span>
            </label>

            <label className="field">
              <span className="micro">BASE URL</span>
              <input
                className="input"
                value={cloud.baseUrl}
                onChange={(event) => patchCloud({ baseUrl: event.target.value })}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span className="micro">模型名</span>
              <input
                className="input"
                value={cloud.model}
                onChange={(event) => patchCloud({ model: event.target.value })}
                placeholder="deepseek-chat"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span className="micro">合并模型（可选）</span>
              <input
                className="input"
                value={cloud.mergeModel}
                onChange={(event) => patchCloud({ mergeModel: event.target.value })}
                placeholder="留空则复用上面的模型"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span className="micro">TEMPERATURE</span>
              <input
                className="input"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={cloud.temperature}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  patchCloud({ temperature: Number.isFinite(next) ? next : 0 });
                }}
              />
            </label>

            <div className="field field-full">
              <span className="hint">
                兼容任何 OpenAI 兼容端点，例如 OpenAI（
                <code>https://api.openai.com/v1</code>）、DeepSeek（
                <code>https://api.deepseek.com/v1</code>）、Moonshot、智谱、通义等；填各自文档给出的
                Base URL 与模型名即可。API Key 仅保存在本机配置文件中。
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' }}>
            <button type="button" className="btn btn-sm" onClick={() => void handleTest()} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void handleSave()} disabled={saving}>
              保存
            </button>
            {testResult ? (
              <span className={`pill ${testResult.ok ? 'pill-ok' : 'pill-bad'}`}>
                {testResult.ok ? '连接正常' : '连接失败'}
              </span>
            ) : null}
            {testResult ? <span className="micro">延迟 {testResult.latencyMs} ms</span> : null}
          </div>

          {testResult ? (
            <div className="result-lines">
              <div className="result-line">
                <span className="micro">{testResult.ok ? 'OK' : 'FAIL'}</span>
                <span>{testResult.message || '（无返回信息）'}</span>
              </div>
              {testResult.models.length > 0 ? (
                <div className="result-line">
                  <span className="micro">MODELS({testResult.models.length})</span>
                  <span>{testResult.models.join(' · ')}</span>
                </div>
              ) : (
                <div className="result-line">
                  <span className="micro">MODELS</span>
                  <span>该端点未返回模型列表</span>
                </div>
              )}
            </div>
          ) : null}
        </section>

        {/* ---------------- 本地模型 ---------------- */}
        <section className="panel-block">
          <div className="panel-block-title">
            <h3>本地模型</h3>
            <span className={`pill ${providerStatus?.ollamaRunning ? 'pill-ok' : 'pill-bad'}`}>
              {providerStatus?.ollamaRunning ? 'OLLAMA 运行中' : providerStatus?.ollamaInstalled ? '已安装未运行' : '未安装'}
            </span>
            <span className="micro" style={{ marginLeft: 'auto' }}>
              {providerStatus?.ollamaVersion || ''}
            </span>
          </div>

          <div className="form-grid">
            <label className="field">
              <span className="micro">OLLAMA HOST</span>
              <input
                className="input"
                value={draft.ollamaHost}
                onChange={(event) => patchRoot({ ollamaHost: event.target.value })}
                placeholder="http://127.0.0.1:11434"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span className="micro">默认本地模型</span>
              <select
                className="select"
                value={draft.localModel}
                onChange={(event) => patchRoot({ localModel: event.target.value })}
              >
                <option value={CLOUD_SENTINEL}>云端接管（不使用本地模型）</option>
                {localModels.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name}
                    {model.parameterSize ? ` · ${model.parameterSize}` : ''}
                  </option>
                ))}
                {localModels.length === 0 ? <option value="">（未检测到本地模型）</option> : null}
              </select>
            </label>

            <label className="field">
              <span className="micro">界面语言</span>
              <select
                className="select"
                value={draft.language}
                onChange={(event) => patchRoot({ language: event.target.value })}
              >
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={ollamaBusy || providerStatus?.ollamaRunning === true}
              onClick={() => void handleOllama('start')}
            >
              启动 Ollama
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={ollamaBusy || providerStatus?.ollamaRunning !== true}
              onClick={() => void handleOllama('stop')}
            >
              停止 Ollama
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void getApi().openExternal('https://ollama.com/download')}
            >
              打开下载页
            </button>
            {ollamaNotice ? <span className="micro micro-cyan">{ollamaNotice}</span> : null}
          </div>

          {providerStatus && !providerStatus.ollamaInstalled ? (
            <div className="hint" style={{ marginTop: '11px' }}>
              未检测到 Ollama：请到
              <span
                className="hint-link"
                onClick={() => void getApi().openExternal('https://ollama.com/download')}
              >
                官网下载安装
              </span>
              后重启本应用；安装完成后本页的启动按钮即可托管其后台进程。
            </div>
          ) : (
            <div className="hint" style={{ marginTop: '11px' }}>
              本地模型在「下载」页管理；选择哪个作为默认模型，会决定路由时本地节点的实际执行者。
            </div>
          )}
        </section>

        {/* ---------------- 工具能力 ---------------- */}
        <section className="panel-block">
          <div className="panel-block-title">
            <h3>工具能力</h3>
            <span className="micro" style={{ marginLeft: 'auto' }}>
              只读 · 由主进程检测
            </span>
          </div>

          <div className="tool-list">
            {TOOL_ROWS.map((row) => {
              const available = toolAvailable(tools, row.key);
              return (
                <div className="tool-row" key={row.key}>
                  <span className="tool-name">{row.label}</span>
                  <span className="micro">{row.key}</span>
                  <span className={`pill ${available ? 'pill-ok' : 'pill-mute'}`}>
                    {available ? '已配置' : '未配置'}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="hint" style={{ marginTop: '11px' }}>
            媒体生成（视频 / 图片 / 语音）依赖外部服务，需要自行配置对应的 API 后才能生效；
            未配置时相关节点会明确标记为「未配置」，本应用不会伪造任何媒体结果。
            {providerStatus?.ffmpegAvailable
              ? ' 已检测到 ffmpeg，可用于本地媒体合成。'
              : ' 未检测到 ffmpeg，媒体合成节点不可用。'}
          </p>
        </section>

        {/* ---------------- 关于 ---------------- */}
        <section className="panel-block">
          <div className="panel-block-title">
            <h3>关于</h3>
          </div>
          <div className="about-lines">
            <span>
              <span className="about-key">APP</span> AI Router 桌面端
            </span>
            <span>
              <span className="about-key">VERSION</span> 0.7.0
            </span>
            <span>
              <span className="about-key">PURPOSE</span>{' '}
              把一句任务拆成 DAG，能本地完成的部分留在本地模型上执行，只把真正需要深推理或强能力的关键部分交给云端模型，从而在保证质量的前提下省下云端 token。
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

export default SettingsView;
