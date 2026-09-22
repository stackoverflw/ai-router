/**
 * 模型选择器。
 *
 * 位于输入框右下角（紧贴发送按钮左侧）的紧凑 chip，点击后在**上方**展开浮层：
 *  - 本地模型组：来自 `listLocalModels()`（Ollama 未运行时为空）
 *  - 云端模型组：来自当前设置
 * 选择本地模型会写回 `settings.localModel`；选择云端写入哨兵值 `__cloud__`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { CloudSettings, LocalModelInfo, ProviderStatus } from '../../shared/types.js';
import { getApi } from '../hooks/useProviderStatus.js';
import {
  CLOUD_SENTINEL,
  errorText,
  formatBytes,
  type ViewKey,
} from '../utils.js';

export interface ModelPickerProps {
  localModel: string;
  cloud: CloudSettings;
  providerStatus: ProviderStatus | null;
  disabled: boolean;
  onPickLocal: (name: string) => void;
  onPickCloud: () => void;
  onNavigate: (view: ViewKey) => void;
}

function ChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      className={`model-chip-chevron${open ? ' is-open' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 7.5L6 4l3.5 3.5" />
    </svg>
  );
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const {
    localModel,
    cloud,
    providerStatus,
    disabled,
    onPickLocal,
    onPickCloud,
    onNavigate,
  } = props;

  const [open, setOpen] = useState<boolean>(false);
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string>('');

  const wrapRef = useRef<HTMLDivElement | null>(null);

  const ollamaRunning = providerStatus?.ollamaRunning === true;
  const usingCloud = localModel === CLOUD_SENTINEL;
  const cloudConfigured = providerStatus?.cloudConfigured === true && cloud.model.trim().length > 0;

  // 浮层打开的瞬间拉取本地模型列表（Ollama 未运行时不请求，直接给空列表）。
  useEffect(() => {
    if (!open) return;
    if (!ollamaRunning) {
      setModels([]);
      setLoading(false);
      setLoadError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void (async () => {
      try {
        const api = getApi();
        const list = await api.listLocalModels();
        if (!cancelled) setModels(list);
      } catch (err: unknown) {
        if (!cancelled) {
          setModels([]);
          setLoadError(errorText(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ollamaRunning]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const node = wrapRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const chipLabel = useMemo<string>(() => {
    if (usingCloud) return cloud.model.trim() || '云端模型未配置';
    if (!localModel) return '未选择本地模型';
    return localModel;
  }, [usingCloud, cloud.model, localModel]);

  const handleLocalPick = useCallback(
    (name: string): void => {
      setOpen(false);
      onPickLocal(name);
    },
    [onPickLocal],
  );

  const handleCloudPick = useCallback((): void => {
    setOpen(false);
    onPickCloud();
  }, [onPickCloud]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="model-chip"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={usingCloud ? `云端：${cloud.model || '未配置'}` : `本地：${chipLabel}`}
      >
        <span className={`dot ${usingCloud ? 'dot-warn' : ollamaRunning ? 'dot-ok' : 'dot-off'}`} />
        <span className="model-chip-name">{chipLabel}</span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div className="popover panel-cut" role="listbox" aria-label="选择模型">
          <div className="popover-section">
            <div className="popover-section-head">
              <span className="micro micro-cyan">本地模型 · LOCAL</span>
              <span className="micro" style={{ marginLeft: 'auto' }}>
                {ollamaRunning ? `OLLAMA ${providerStatus?.ollamaVersion || ''}`.trim() : 'OLLAMA 未运行'}
              </span>
            </div>

            {!ollamaRunning ? (
              <div className="popover-empty">
                本地推理不可用：Ollama 尚未运行。
                <div style={{ marginTop: '6px', display: 'flex', gap: '8px' }}>
                  <button type="button" className="popover-action" onClick={() => onNavigate('downloads')}>
                    尚无本地模型，去下载
                  </button>
                  <button type="button" className="popover-action" onClick={() => onNavigate('settings')}>
                    去设置启动
                  </button>
                </div>
              </div>
            ) : loading ? (
              <div className="popover-empty">正在读取本地模型…</div>
            ) : loadError ? (
              <div className="popover-empty" style={{ color: 'var(--danger)' }}>
                读取失败：{loadError}
              </div>
            ) : models.length === 0 ? (
              <div className="popover-empty">
                本机还没有任何 Ollama 模型。
                <div style={{ marginTop: '6px' }}>
                  <button type="button" className="popover-action" onClick={() => onNavigate('downloads')}>
                    尚无本地模型，去下载
                  </button>
                </div>
              </div>
            ) : (
              models.map((model) => {
                const active = !usingCloud && model.name === localModel;
                return (
                  <button
                    key={model.name}
                    type="button"
                    className={`popover-row${active ? ' is-active' : ''}`}
                    onClick={() => handleLocalPick(model.name)}
                  >
                    <span className="popover-row-main">
                      <span className="popover-row-name">{model.name}</span>
                      <span className="popover-row-meta">
                        {[model.parameterSize, formatBytes(model.sizeBytes), model.quantization, model.family]
                          .filter((part) => part.length > 0)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="pill pill-local">本地</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="popover-section">
            <div className="popover-section-head">
              <span className="micro micro-amber">云端模型 · CLOUD</span>
              <span className="micro" style={{ marginLeft: 'auto' }}>
                {cloudConfigured ? '已配置' : '未配置'}
              </span>
            </div>

            {cloudConfigured ? (
              <button
                type="button"
                className={`popover-row${usingCloud ? ' is-active' : ''}`}
                onClick={handleCloudPick}
              >
                <span className="popover-row-main">
                  <span className="popover-row-name">{cloud.model}</span>
                  <span className="popover-row-meta">{cloud.baseUrl}</span>
                </span>
                <span className="pill pill-cloud">云端</span>
              </button>
            ) : (
              <div className="popover-empty">
                云端 API 尚未配置（缺少 API Key 或模型名）。
                <div style={{ marginTop: '6px' }}>
                  <button type="button" className="popover-action" onClick={() => onNavigate('settings')}>
                    去设置
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="micro" style={{ marginTop: '10px', lineHeight: 1.7 }}>
            选择本地模型后，能本地完成的任务将不出网；选择云端则由云端模型接管全部文本节点。
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default ModelPicker;
