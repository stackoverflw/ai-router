/**
 * 对话主视图。
 *
 * 结构：顶部状态条 → 警告横幅（必要时）→ 消息列表 / 空状态 → 底部输入台。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { AppSettings, ProviderStatus } from '../../shared/types.js';
import type { ExecutionViewModel } from '../hooks/useExecution.js';
import { CLOUD_SENTINEL, type ViewKey } from '../utils.js';
import { Composer } from './Composer.js';
import { MessageBubble } from './MessageBubble.js';
import { TaskDagPanel } from './TaskDagPanel.js';

export interface ChatViewProps {
  execution: ExecutionViewModel;
  providerStatus: ProviderStatus | null;
  providerLoading: boolean;
  settings: AppSettings | null;
  onNavigate: (view: ViewKey) => void;
  onPickLocalModel: (name: string) => void;
  onPickCloud: () => void;
}

const EXAMPLE_PROMPTS: Array<{ title: string; prompt: string }> = [
  {
    title: '复杂推理交给云端',
    prompt: '帮我设计一个支持多租户的权限模型，给出表结构和关键校验逻辑，并说明取舍。',
  },
  {
    title: '能本地就本地',
    prompt: '把下面这段需求改写成更清晰的产品描述，尽量用本地模型完成，不要走云端。',
  },
  {
    title: '多模态任务编排',
    prompt: '请帮我生成一个含有千早爱音的视频。',
  },
];

function StatusItem({
  dotClass,
  label,
  value,
}: {
  dotClass: string;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <span className="provider-item">
      <span className={`dot ${dotClass}`} />
      <span className="micro">{label}</span>
      <span className="micro" style={{ color: 'var(--text)' }}>
        {value}
      </span>
    </span>
  );
}

function WarnIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5L21 19.5H3z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 16.7v.6" />
    </svg>
  );
}

export function ChatView(props: ChatViewProps): JSX.Element {
  const {
    execution,
    providerStatus,
    providerLoading,
    settings,
    onNavigate,
    onPickLocalModel,
    onPickCloud,
  } = props;

  const [draft, setDraft] = useState<string>('');
  const listRef = useRef<HTMLDivElement | null>(null);

  const { messages, running } = execution;
  const lastIndex = messages.length - 1;

  const liveId = useMemo<string | null>(() => {
    if (!running) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [running, messages]);

  const scrollKey = `${messages.length}:${execution.events.length}:${running ? '1' : '0'}`;

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [scrollKey]);

  const handleSend = useCallback(
    (text: string): void => {
      setDraft('');
      void execution.run(text);
    },
    [execution],
  );

  const localNeedsCloud = providerStatus !== null && !providerStatus.ollamaRunning && !providerStatus.cloudConfigured;
  const noOllamaAtAll = providerStatus !== null && !providerStatus.ollamaInstalled;
  const noLocalModel = providerStatus !== null && providerStatus.ollamaRunning && (settings?.localModel ?? '').length === 0;
  const cloudMode = settings?.localModel === CLOUD_SENTINEL;

  return (
    <>
      <header className="topbar">
        <div className="topbar-row">
          <span className="topbar-title">
            AI <span>ROUTER</span>
          </span>
          <span className="topbar-sep" />
          <span className="micro">LOCAL ⇄ CLOUD 任务编排台</span>
          <span className="topbar-spacer" />
          <span className="chip" title="当前选用的模型入口在输入框右下角">
            <span className={`dot ${cloudMode ? 'dot-warn' : providerStatus?.ollamaRunning ? 'dot-ok' : 'dot-off'}`} />
            <span className="micro">{cloudMode ? 'CLOUD' : 'LOCAL'}</span>
            <span style={{ fontFamily: 'var(--mono)' }}>
              {cloudMode
                ? settings?.cloud.model || '未配置云端模型'
                : settings?.localModel || '未选择本地模型'}
            </span>
          </span>
        </div>

        <div className="topbar-row">
          <div className="provider-row">
            {providerLoading && !providerStatus ? (
              <span className="provider-item">
                <span className="dot dot-pulse" />
                <span className="micro">检测运行环境中…</span>
              </span>
            ) : (
              <>
                <StatusItem
                  dotClass={providerStatus?.ollamaRunning ? 'dot-ok' : providerStatus?.ollamaInstalled ? 'dot-warn' : 'dot-off'}
                  label="OLLAMA"
                  value={
                    providerStatus?.ollamaRunning
                      ? `运行中${providerStatus.ollamaVersion ? ` · ${providerStatus.ollamaVersion}` : ''}`
                      : providerStatus?.ollamaInstalled
                        ? '已安装未运行'
                        : '未安装'
                  }
                />
                <StatusItem
                  dotClass={providerStatus?.cloudConfigured ? 'dot-ok' : 'dot-warn'}
                  label="CLOUD API"
                  value={providerStatus?.cloudConfigured ? `已配置 · ${settings?.cloud.model || ''}`.trim() : '未配置'}
                />
                <StatusItem
                  dotClass={providerStatus?.ffmpegAvailable ? 'dot-ok' : 'dot-off'}
                  label="FFMPEG"
                  value={providerStatus?.ffmpegAvailable ? '可用' : '不可用'}
                />
                <StatusItem
                  dotClass={providerStatus ? 'dot-ok' : 'dot-off'}
                  label="HOST"
                  value={providerStatus?.host || '—'}
                />
              </>
            )}
          </div>
          <span className="topbar-spacer" />
          {messages.length > 0 ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={execution.clear}
              disabled={running}
              title="清空当前会话记录"
            >
              清空会话
            </button>
          ) : null}
        </div>
      </header>

      <div className="chat-body">
        {localNeedsCloud ? (
          <div className="warning-banner">
            <span className="warning-banner-icon">
              <WarnIcon />
            </span>
            <span className="warning-banner-text">
              <span className="warning-banner-title">NO INFERENCE BACKEND · 没有可用的推理后端</span>
              <span className="warning-banner-desc">
                {noOllamaAtAll
                  ? '本机未检测到 Ollama，且云端 API 也未配置。请先安装并启动 Ollama，或配置一个 OpenAI 兼容的云端 API。'
                  : 'Ollama 未运行，且云端 API 未配置。请启动 Ollama，或配置云端 API 后再发送任务。'}
              </span>
            </span>
            <span className="warning-banner-actions">
              <button type="button" className="btn btn-sm" onClick={() => onNavigate('settings')}>
                启动 / 配置
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onNavigate('downloads')}>
                去下载本地模型
              </button>
            </span>
          </div>
        ) : null}

        {noLocalModel ? (
          <div className="warning-banner" style={{ background: 'linear-gradient(90deg, rgba(94,234,212,.09), rgba(94,234,212,.02))', borderColor: 'var(--line)' }}>
            <span className="warning-banner-icon" style={{ color: 'var(--cyan)' }}>
              <WarnIcon />
            </span>
            <span className="warning-banner-text">
              <span className="warning-banner-title" style={{ color: 'var(--cyan)' }}>
                NO LOCAL MODEL · 尚未选择本地模型
              </span>
              <span className="warning-banner-desc" style={{ color: 'rgba(94,234,212,.8)' }}>
                Ollama 已在运行，但还没有默认本地模型。可在输入框右下角的模型入口里选择，或先下载一个。
              </span>
            </span>
            <span className="warning-banner-actions">
              <button type="button" className="btn btn-sm" onClick={() => onNavigate('downloads')}>
                浏览模型库
              </button>
            </span>
          </div>
        ) : null}

        {messages.length === 0 ? (
          <div className="hero">
            <div className="hero-mark">
              AI <em>ROUTER</em>
            </div>
            <p className="hero-sub">
              把一句话任务拆成 DAG：能在本地跑的就留在本地，难的、要深推理的交给云端，需要真实媒体的交给工具。
              并行执行后合并成一份结果，省下的是云端 token。
            </p>
            <div className="hero-grid">
              {EXAMPLE_PROMPTS.map((item, index) => (
                <button
                  key={item.prompt}
                  type="button"
                  className="hero-card"
                  onClick={() => setDraft(item.prompt)}
                >
                  <span className="hero-card-idx">
                    EXAMPLE {String(index + 1).padStart(2, '0')} · {item.title}
                  </span>
                  <span>{item.prompt}</span>
                </button>
              ))}
            </div>
            <span className="micro">
              点击示例可填入输入框 · 发送前会先预测路由（本地 / 云端 / 工具）
            </span>
          </div>
        ) : (
          <div className="message-list" ref={listRef}>
            {messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                live={running && message.id === liveId && index === lastIndex}
                nodeStatus={execution.nodeStatus}
                nodeOutputs={execution.nodeOutputs}
                nodeErrors={execution.nodeErrors}
                events={execution.events}
                layerIndex={execution.layerIndex}
                layerTotal={execution.layerTotal}
                onNavigate={onNavigate}
              />
            ))}

            {running && execution.activeGraph ? (
              <div className="msg msg-assistant">
                <div className="msg-head">
                  <span className="msg-role">AI ROUTER · 编排中</span>
                  <span className="pill pill-local dot-pulse">执行中</span>
                  <span className="micro">
                    {execution.currentPrompt ? `目标：${execution.currentPrompt}` : ''}
                  </span>
                </div>
                <TaskDagPanel
                  graph={execution.activeGraph}
                  nodeStatus={execution.nodeStatus}
                  nodeOutputs={execution.nodeOutputs}
                  nodeErrors={execution.nodeErrors}
                  events={execution.events}
                  layerIndex={execution.layerIndex}
                  layerTotal={execution.layerTotal}
                  historical={false}
                  defaultOpen
                />
              </div>
            ) : null}

            {running && liveId === null && !execution.activeGraph ? (
              <div className="msg msg-assistant">
                <div className="msg-head">
                  <span className="msg-role">AI ROUTER · 助手</span>
                  <span className="pill pill-local dot-pulse">规划中</span>
                </div>
                <div className="msg-bubble">
                  <span className="micro">正在分析任务并规划执行图…</span>
                  <span className="msg-cursor" />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        running={running}
        settings={settings}
        providerStatus={providerStatus}
        onSend={handleSend}
        onNavigate={onNavigate}
        onPickLocalModel={onPickLocalModel}
        onPickCloud={onPickCloud}
      />
    </>
  );
}

export default ChatView;
