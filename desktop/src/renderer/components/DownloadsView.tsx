/**
 * 本地模型库视图。
 *
 * 上：Ollama 运行状态 + 启停按钮
 * 中：搜索 / 仅显示已下载
 * 下：预设卡片（下载 / 取消 / 删除，带内联确认）+ 已安装（其他）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';

import type {
  LocalModelInfo,
  LocalModelPreset,
  ProviderStatus,
  PullProgress,
} from '../../shared/types.js';
import { getApi } from '../hooks/useProviderStatus.js';
import {
  CHINESE_LEVEL_META,
  errorText,
  findInstalled,
  formatBytes,
  formatPercent,
} from '../utils.js';

export interface DownloadsViewProps {
  providerStatus: ProviderStatus | null;
  onProviderRefresh: () => Promise<void>;
  onActivePullChange: (active: boolean) => void;
}

interface PullRow {
  progress: PullProgress;
  active: boolean;
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <div className="status-cell">
      <span className="micro">{label}</span>
      <span className="status-value" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

function ChineseRating({ level }: { level: LocalModelPreset['chineseLevel'] }): JSX.Element {
  const meta = CHINESE_LEVEL_META[level];
  return (
    <span className="status-cell">
      <span className="micro">中文能力</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <span className="chinese-blocks">
          {[1, 2, 3].map((index) => (
            <i key={index} className={`cn-block${index <= meta.blocks ? ' is-on' : ''}`} />
          ))}
        </span>
        <span className="micro">{meta.label}</span>
      </span>
    </span>
  );
}

export function DownloadsView(props: DownloadsViewProps): JSX.Element {
  const { providerStatus, onProviderRefresh, onActivePullChange } = props;

  const [presets, setPresets] = useState<LocalModelPreset[]>([]);
  const [installed, setInstalled] = useState<LocalModelInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>('');
  const [pulls, setPulls] = useState<Record<string, PullRow>>({});
  const [query, setQuery] = useState<string>('');
  const [onlyInstalled, setOnlyInstalled] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<string>('');
  const [busyName, setBusyName] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [ollamaBusy, setOllamaBusy] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const api = getApi();
      const [presetList, localList] = await Promise.all([
        api.listModelPresets(),
        api.listLocalModels(),
      ]);
      setPresets(presetList);
      setInstalled(localList);
      setLoadError('');
    } catch (err: unknown) {
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 订阅一次下载进度，按模型名路由到对应卡片
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = getApi().onPullProgress((progress: PullProgress) => {
        setPulls((prev) => ({
          ...prev,
          [progress.model]: { progress, active: !progress.done && !progress.error },
        }));

        if (progress.done || progress.error) {
          setNotice(
            progress.error
              ? `${progress.model} 下载失败：${progress.error}`
              : `${progress.model} 下载完成`,
          );
          void reload();
          void onProviderRefresh();
        }
      });
    } catch (err: unknown) {
      setLoadError(errorText(err));
    }
    return () => {
      if (off) off();
    };
  }, [reload, onProviderRefresh]);

  const activePulls = useMemo(
    () => Object.values(pulls).filter((row) => row.active).length,
    [pulls],
  );

  useEffect(() => {
    onActivePullChange(activePulls > 0);
  }, [activePulls, onActivePullChange]);

  // 下载完成的条目从进度表里清掉，避免卡片上残留 100% 的进度条
  useEffect(() => {
    if (!installed.length) return;
    setPulls((prev) => {
      const next: Record<string, PullRow> = {};
      let changed = false;
      for (const [name, row] of Object.entries(prev)) {
        const isInstalled = installed.some((model) => model.name === name);
        if (isInstalled && !row.active) {
          changed = true;
          continue;
        }
        next[name] = row;
      }
      return changed ? next : prev;
    });
  }, [installed]);

  const filteredPresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return presets.filter((preset) => {
      if (onlyInstalled && !findInstalled(installed, preset)) return false;
      if (!q) return true;
      return (
        preset.name.toLowerCase().includes(q) ||
        preset.displayName.toLowerCase().includes(q) ||
        preset.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [presets, installed, onlyInstalled, query]);

  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return installed.filter((model) => {
      if (q && !model.name.toLowerCase().includes(q) && !model.family.toLowerCase().includes(q)) {
        return false;
      }
      return !presets.some((preset) => findInstalled([model], preset));
    });
  }, [installed, presets, query]);

  const handlePull = useCallback(
    async (name: string): Promise<void> => {
      setBusyName(name);
      setNotice('');
      try {
        const result = await getApi().pullModel(name);
        if (!result.started) {
          setNotice(result.error ? `无法开始下载：${result.error}` : '下载未能启动');
          return;
        }
        setPulls((prev) => ({
          ...prev,
          [name]: {
            progress: {
              model: name,
              status: '准备下载…',
              completedBytes: 0,
              totalBytes: 0,
              percent: 0,
              done: false,
            },
            active: true,
          },
        }));
      } catch (err: unknown) {
        setNotice(`无法开始下载：${errorText(err)}`);
      } finally {
        setBusyName('');
      }
    },
    [],
  );

  const handleCancel = useCallback(async (name: string): Promise<void> => {
    try {
      await getApi().cancelPull(name);
      setPulls((prev) => ({
        ...prev,
        [name]: prev[name]
          ? { progress: { ...prev[name].progress, status: '已取消' }, active: false }
          : prev[name],
      }));
      setNotice(`${name} 已取消`);
    } catch (err: unknown) {
      setNotice(`取消失败：${errorText(err)}`);
    }
  }, []);

  const handleDelete = useCallback(
    async (name: string): Promise<void> => {
      setBusyName(name);
      try {
        const result = await getApi().deleteModel(name);
        setNotice(result.ok ? `${name} 已删除` : `删除失败：${result.error ?? '未知错误'}`);
        if (result.ok) await reload();
      } catch (err: unknown) {
        setNotice(`删除失败：${errorText(err)}`);
      } finally {
        setConfirmDelete('');
        setBusyName('');
      }
    },
    [reload],
  );

  const handleOllama = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      setOllamaBusy(true);
      setNotice('');
      try {
        const api = getApi();
        const result = action === 'start' ? await api.startOllama() : await api.stopOllama();
        setNotice(result.message || (result.ok ? '操作完成' : '操作失败'));
        await onProviderRefresh();
        if (action === 'start' && result.ok) await reload();
      } catch (err: unknown) {
        setNotice(`操作失败：${errorText(err)}`);
      } finally {
        setOllamaBusy(false);
      }
    },
    [onProviderRefresh, reload],
  );

  return (
    <div className="view-scroll">
      <div className="view-pad">
        <div className="view-head">
          <span className="view-title">本地模型库</span>
          <span className="view-sub">下载后在本地推理，云端 token 消耗随之下降</span>
          <span style={{ flex: '1 1 auto' }} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void reload()} disabled={loading}>
            刷新列表
          </button>
        </div>

        <section className="panel-block">
          <div className="panel-block-title">
            <h3>Ollama 运行环境</h3>
            <span className="micro" style={{ marginLeft: 'auto' }}>
              HOST {providerStatus?.host || '—'}
            </span>
          </div>

          <div className="status-strip">
            <StatusCell
              label="INSTALLED"
              value={providerStatus?.ollamaInstalled ? '已安装' : '未安装'}
              tone={providerStatus?.ollamaInstalled ? 'var(--cyan)' : 'var(--danger)'}
            />
            <StatusCell
              label="RUNNING"
              value={providerStatus?.ollamaRunning ? '运行中' : '未运行'}
              tone={providerStatus?.ollamaRunning ? 'var(--cyan)' : 'var(--amber)'}
            />
            <StatusCell label="VERSION" value={providerStatus?.ollamaVersion || '—'} />
            <StatusCell label="本地模型数" value={String(installed.length)} />
            <span style={{ flex: '1 1 auto' }} />
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
          </div>

          {providerStatus && !providerStatus.ollamaInstalled ? (
            <div className="hint" style={{ marginTop: '10px' }}>
              未检测到 Ollama。请先安装后再回到本页下载模型：
              <span
                className="hint-link"
                onClick={() => void getApi().openExternal('https://ollama.com/download')}
              >
                https://ollama.com/download
              </span>
            </div>
          ) : null}

          {notice ? (
            <div className="hint" style={{ marginTop: '9px', color: 'var(--cyan)' }}>
              {notice}
            </div>
          ) : null}
        </section>

        <div className="filter-row">
          <span className="search-box">
            <input
              className="input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按名称 / 标签过滤，例如 qwen、7b、code"
              aria-label="过滤模型"
            />
          </span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={onlyInstalled}
              onChange={(event) => setOnlyInstalled(event.target.checked)}
            />
            <span className="check-box" />
            <span className="micro">仅显示已下载</span>
          </label>
          <span style={{ flex: '1 1 auto' }} />
          <span className="micro">
            预设 {filteredPresets.length}/{presets.length} · 已安装 {installed.length}
          </span>
        </div>

        {loading ? (
          <div className="empty-note">正在读取模型列表…</div>
        ) : loadError ? (
          <div className="empty-note" style={{ color: 'var(--danger)', borderColor: 'var(--line-danger)' }}>
            读取失败：{loadError}
          </div>
        ) : (
          <>
            <div className="card-grid">
              {filteredPresets.map((preset) => {
                const model = findInstalled(installed, preset);
                const pull = pulls[preset.name];
                const pulling = pull?.active === true;
                const percent = pull ? Math.min(100, Math.max(0, pull.progress.percent)) : 0;

                return (
                  <article key={preset.name} className={`model-card${model ? ' is-installed' : ''}`}>
                    <div className="model-card-head">
                      <div style={{ minWidth: 0 }}>
                        <div className="model-card-name">{preset.displayName}</div>
                        <div className="model-card-id">{preset.name}</div>
                      </div>
                      {preset.recommended ? <span className="ribbon">推荐</span> : null}
                    </div>

                    <p className="model-card-desc">{preset.description}</p>

                    <div className="spec-row">
                      <span className="spec">
                        <span className="micro">参数量</span>
                        <span className="spec-value">{preset.parameterSize}</span>
                      </span>
                      <span className="spec">
                        <span className="micro">下载体积</span>
                        <span className="spec-value">{preset.downloadSize}</span>
                      </span>
                      <span className="spec">
                        <span className="micro">内存需求</span>
                        <span className="spec-value">≥ {preset.ramGb} GB</span>
                      </span>
                      {model ? (
                        <span className="spec">
                          <span className="micro">本机体积</span>
                          <span className="spec-value">{formatBytes(model.sizeBytes)}</span>
                        </span>
                      ) : null}
                      <ChineseRating level={preset.chineseLevel} />
                    </div>

                    {preset.tags.length > 0 ? (
                      <div className="tag-row">
                        {preset.tags.map((tag) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {pull ? (
                      <div className="progress-wrap">
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${percent}%` }} />
                        </div>
                        <div className="progress-meta">
                          <span>{formatPercent(percent)}</span>
                          <span>
                            {formatBytes(pull.progress.completedBytes)} /{' '}
                            {pull.progress.totalBytes > 0 ? formatBytes(pull.progress.totalBytes) : '未知'}
                          </span>
                          <span style={{ flex: '1 1 auto' }} />
                          {pull.active ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => void handleCancel(preset.name)}
                            >
                              取消
                            </button>
                          ) : (
                            <span className="micro">{pull.progress.error ? '失败' : '结束'}</span>
                          )}
                        </div>
                        <span className="progress-status" title={pull.progress.status}>
                          {pull.progress.status}
                        </span>
                      </div>
                    ) : null}

                    <div className="card-actions">
                      {model ? (
                        <>
                          <span className="pill pill-ok">已安装</span>
                          {confirmDelete === preset.name ? (
                            <span className="confirm-inline">
                              <span className="micro micro-danger">确认删除？</span>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={busyName === preset.name}
                                onClick={() => void handleDelete(preset.name)}
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => setConfirmDelete('')}
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => setConfirmDelete(preset.name)}
                            >
                              删除
                            </button>
                          )}
                        </>
                      ) : pulling ? (
                        <span className="micro micro-cyan">下载中…</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busyName === preset.name}
                          onClick={() => void handlePull(preset.name)}
                        >
                          下载
                        </button>
                      )}
                      <span style={{ flex: '1 1 auto' }} />
                      <span className="micro">{preset.name.split(':')[1] ?? 'latest'}</span>
                    </div>
                  </article>
                );
              })}
            </div>

            {filteredPresets.length === 0 ? (
              <div className="empty-note">没有匹配的预设模型，试试清空搜索或取消「仅显示已下载」。</div>
            ) : null}

            <section className="panel-block" style={{ marginTop: '22px' }}>
              <div className="panel-block-title">
                <h3>已安装（其他）</h3>
                <span className="micro" style={{ marginLeft: 'auto' }}>
                  不在预设清单中的本地模型
                </span>
              </div>

              {others.length === 0 ? (
                <div className="empty-note">没有额外的本地模型。</div>
              ) : (
                <div className="tool-list">
                  {others.map((model) => (
                    <div className="tool-row" key={model.name}>
                      <span className="tool-name" style={{ fontFamily: 'var(--mono)' }}>
                        {model.name}
                      </span>
                      <span className="micro">{model.parameterSize || '—'}</span>
                      <span className="micro">{formatBytes(model.sizeBytes)}</span>
                      <span className="micro">{model.quantization || '—'}</span>
                      <span className="micro">{model.family || '—'}</span>
                      {model.mediaGeneration ? <span className="pill pill-tool">媒体生成</span> : null}
                      {confirmDelete === model.name ? (
                        <span className="confirm-inline">
                          <span className="micro micro-danger">确认删除？</span>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busyName === model.name}
                            onClick={() => void handleDelete(model.name)}
                          >
                            删除
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete('')}>
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setConfirmDelete(model.name)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default DownloadsView;
