/**
 * 底部输入台。
 *
 * 布局（从左到右）：提示文案 → 预测路由 → 模型选择 chip → 发送按钮。
 * 模型选择入口固定贴在发送按钮左侧，浮层向上展开（见 ModelPicker）。
 */

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';

import type { AppSettings, CloudSettings, ProviderStatus, Route } from '../../shared/types.js';
import { getApi } from '../hooks/useProviderStatus.js';
import { CLOUD_SENTINEL, ROUTE_META, type ViewKey } from '../utils.js';
import { ModelPicker } from './ModelPicker.js';

export interface RoutePreviewState {
  route: Route;
  confidence: number;
  signalScore: number;
  model: string;
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  running: boolean;
  settings: AppSettings | null;
  providerStatus: ProviderStatus | null;
  onSend: (text: string) => void;
  onNavigate: (view: ViewKey) => void;
  onPickLocalModel: (name: string) => void;
  onPickCloud: () => void;
}

const PLACEHOLDERS = [
  '描述你的任务，AI Router 会自动拆解成本地 / 云端 / 工具子任务…',
  '例如：把这份需求拆成接口设计 + 测试用例，能本地的就别走云端。',
];

export function Composer(props: ComposerProps): JSX.Element {
  const {
    value,
    onChange,
    running,
    settings,
    providerStatus,
    onSend,
    onNavigate,
    onPickLocalModel,
    onPickCloud,
  } = props;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState<RoutePreviewState | null>(null);
  const [previewFailed, setPreviewFailed] = useState<boolean>(false);
  const placeholderRef = useRef<number>(Math.floor(Math.random() * PLACEHOLDERS.length));

  // 自动增高（上限 200px）
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(200, node.scrollHeight)}px`;
  }, [value]);

  // 输入时防抖预测路由（450ms）
  useEffect(() => {
    const text = value.trim();
    if (text.length < 4) {
      setPreview(null);
      setPreviewFailed(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const decision = await getApi().route(text);
          if (cancelled) return;
          setPreview({
            route: decision.route,
            confidence: decision.confidence,
            signalScore: decision.analysis.signalScore,
            model: decision.model,
          });
          setPreviewFailed(false);
        } catch {
          if (cancelled) return;
          // 预测失败不打扰用户：静默隐藏
          setPreview(null);
          setPreviewFailed(true);
        }
      })();
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  const cloud: CloudSettings = settings?.cloud ?? {
    apiKey: '',
    baseUrl: '',
    model: '',
    mergeModel: '',
    temperature: 0.7,
  };

  const canSend = value.trim().length > 0 && !running;

  const submit = (): void => {
    if (!canSend) return;
    const text = value.trim();
    setPreview(null);
    setPreviewFailed(false);
    onSend(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value);
  };

  return (
    <div className="composer">
      <div className="composer-frame">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDERS[placeholderRef.current]}
          rows={1}
          spellCheck={false}
          disabled={running}
          aria-label="输入任务"
        />

        <div className="composer-bar">
          <span className="composer-hint">
            {running ? 'EXECUTING…' : 'ENTER 发送 · SHIFT+ENTER 换行'}
          </span>

          <span className="composer-bar-spacer" />

          <span
            className="route-preview"
            title={preview ? `理由：${preview.signalScore.toFixed(1)} 分权重信号` : '输入后自动预测路由'}
          >
            {preview ? (
              <>
                <span className="micro">预测</span>
                <span className={`pill ${ROUTE_META[preview.route].cls}`}>
                  {ROUTE_META[preview.route].label}
                </span>
                <span className="micro">
                  CLOUD SCORE {preview.signalScore >= 0 ? '+' : ''}
                  {preview.signalScore.toFixed(1)}
                </span>
                <span className="micro">置信 {Math.round(preview.confidence * 100)}%</span>
              </>
            ) : previewFailed ? (
              <span className="micro">预测不可用</span>
            ) : (
              <span className="micro">路由预测待命</span>
            )}
          </span>

          <ModelPicker
            localModel={settings?.localModel ?? ''}
            cloud={cloud}
            providerStatus={providerStatus}
            disabled={running}
            onPickLocal={onPickLocalModel}
            onPickCloud={onPickCloud}
            onNavigate={onNavigate}
          />

          <span className="send-wrap">
            <button
              type="button"
              className="send-button"
              onClick={submit}
              disabled={!canSend}
              title={running ? '任务执行中，暂不支持中断' : '发送（Enter）'}
            >
              {running ? (
                <>
                  <span className="send-spinner" />
                  <span>停止</span>
                </>
              ) : (
                <>
                  <span>发送</span>
                  <SendIcon />
                </>
              )}
            </button>
          </span>
        </div>
      </div>

      <div className="composer-hint" style={{ marginTop: '7px', display: 'flex', gap: '14px' }}>
        <span>本地模型：{settings?.localModel === CLOUD_SENTINEL ? '云端接管' : settings?.localModel || '未设置'}</span>
        <span>云端模型：{cloud.model || '未配置'}</span>
        <span>OLLAMA：{providerStatus?.host || '未检测'}</span>
      </div>
    </div>
  );
}

function SendIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.6 7h10.4" />
      <path d="M8.2 3.2L12 7l-3.8 3.8" />
    </svg>
  );
}

export default Composer;
