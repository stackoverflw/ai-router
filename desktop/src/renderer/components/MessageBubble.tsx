/**
 * 消息气泡。
 *
 * 用户消息：右对齐的窄切角面板；
 * 助手消息：整宽 + 左侧强调线 + 角色微标签，下方挂路由摘要条与可折叠 DAG 面板。
 */

import type { JSX } from 'react';

import type { ChatMessage } from '../../shared/types.js';
import type { LogEntry, NodeStatus } from '../hooks/useExecution.js';
import { cleanFinalText } from '../utils.js';
import {
  formatClock,
  formatDuration,
  formatTokens,
  progressHint,
  ROUTE_META,
  type ViewKey,
} from '../utils.js';
import { TaskDagPanel } from './TaskDagPanel.js';

export interface MessageBubbleProps {
  message: ChatMessage;
  /** 这条消息正在实时执行（最后一条 assistant 且 run 进行中）。 */
  live: boolean;
  nodeStatus: Record<string, NodeStatus>;
  nodeOutputs: Record<string, string>;
  nodeErrors: Record<string, string>;
  events: LogEntry[];
  layerIndex: number;
  layerTotal: number;
  onNavigate: (view: ViewKey) => void;
}

function RoutingBar({ message }: { message: ChatMessage }): JSX.Element | null {
  const { graph, report } = message;
  if (!graph && !report) return null;

  const local = graph?.routeCounts.local ?? report?.tasks.filter((t) => t.route === 'local').length ?? 0;
  const cloud = graph?.routeCounts.cloud ?? report?.tasks.filter((t) => t.route === 'cloud').length ?? 0;
  const tool = graph?.routeCounts.tool ?? report?.tasks.filter((t) => t.route === 'tool').length ?? 0;

  return (
    <div className="routing-bar">
      <div className="routing-cell">
        <span className="micro micro-cyan">LOCAL</span>
        <span className="routing-value" style={{ color: 'var(--cyan)' }}>
          {local}
        </span>
      </div>
      <div className="routing-cell">
        <span className="micro micro-amber">CLOUD</span>
        <span className="routing-value" style={{ color: 'var(--amber)' }}>
          {cloud}
        </span>
      </div>
      <div className="routing-cell">
        <span className="micro micro-violet">TOOL</span>
        <span className="routing-value" style={{ color: 'var(--violet)' }}>
          {tool}
        </span>
      </div>
      <div className="routing-cell">
        <span className="micro">TOKEN SAVING</span>
        <span className="routing-value" style={{ color: 'var(--cyan)' }}>
          {report ? formatTokens(report.savedTokens) : '—'}
        </span>
      </div>
      <div className="routing-cell">
        <span className="micro">ELAPSED</span>
        <span className="routing-value">{report ? formatDuration(report.totalElapsedS) : '—'}</span>
      </div>
      <div className="routing-cell">
        <span className="micro">LOCAL / CLOUD TOKENS</span>
        <span className="routing-value">
          {report ? `${formatTokens(report.localTokens)} / ${formatTokens(report.cloudTokens)}` : '—'}
        </span>
      </div>
      {graph ? (
        <div className="routing-cell">
          <span className="micro">PLANNER</span>
          <span className="routing-value" style={{ fontSize: '11px' }}>
            {graph.planner || 'default'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ReportWarnings({ message }: { message: ChatMessage }): JSX.Element | null {
  const warnings = message.report?.warnings ?? [];
  if (!warnings.length) return null;
  return (
    <div className="dag-log">
      {warnings.map((warning) => (
        <div className="dag-log-line" key={warning}>
          <span className="dag-log-tag micro micro-amber">WARN</span>
          <span>{warning}</span>
        </div>
      ))}
    </div>
  );
}

export function MessageBubble(props: MessageBubbleProps): JSX.Element {
  const {
    message,
    live,
    nodeStatus,
    nodeOutputs,
    nodeErrors,
    events,
    layerIndex,
    layerTotal,
    onNavigate,
  } = props;

  const isUser = message.role === 'user';
  const roleLabel = isUser ? 'OPERATOR · 你' : 'AI ROUTER · 助手';
  const finalText = cleanFinalText(message.content, message.graph);
  const showCursor = !isUser && (message.streaming === true || (live && !finalText && !message.error));

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-head">
        <span className="msg-role">{roleLabel}</span>
        <span className="msg-time">{formatClock(message.createdAt)}</span>
        {message.report ? (
          <span className="pill pill-mute">
            {message.report.tasks.filter((task) => task.ok).length}/{message.report.tasks.length} 节点成功
          </span>
        ) : null}
        {live ? <span className="pill pill-local dot-pulse">运行中</span> : null}
      </div>

      <div className="msg-bubble">
        {finalText}
        {showCursor ? (
          <>
            {finalText ? null : <span className="micro">{progressHint(message.graph, live)}</span>}
            <span className="msg-cursor" />
          </>
        ) : null}
      </div>

      {message.error ? (
        <div className="msg-error">
          <span className="micro micro-danger">EXECUTION ERROR</span>
          <div style={{ marginTop: '3px' }}>{message.error}</div>
          <div className="micro" style={{ marginTop: '5px' }}>
            可在「设置」中检查云端 API 配置，或在「下载」中启动 Ollama 后重试。
            <button
              type="button"
              className="popover-action"
              style={{ marginLeft: '8px' }}
              onClick={() => onNavigate('settings')}
            >
              去设置
            </button>
          </div>
        </div>
      ) : null}

      {!isUser ? <RoutingBar message={message} /> : null}

      {!isUser && message.graph ? (
        <TaskDagPanel
          graph={message.graph}
          nodeStatus={live ? nodeStatus : {}}
          nodeOutputs={live ? nodeOutputs : {}}
          nodeErrors={live ? nodeErrors : {}}
          events={live ? events : []}
          layerIndex={live ? layerIndex : -1}
          layerTotal={live ? layerTotal : message.graph.layerSizes.length}
          historical={!live}
          defaultOpen={false}
        />
      ) : null}

      {!isUser ? <ReportWarnings message={message} /> : null}
    </div>
  );
}

export default MessageBubble;

/** 路由图例，供 ChatView 在需要时复用。 */
export const ROUTE_LEGEND: Array<{ key: keyof typeof ROUTE_META; label: string }> = [
  { key: 'local', label: '本地' },
  { key: 'cloud', label: '云端' },
  { key: 'tool', label: '工具' },
];
