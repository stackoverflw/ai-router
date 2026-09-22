/**
 * 任务 DAG 面板：按拓扑层从左到右展示节点，实时反映 pending / running / ok / failed。
 *
 * 连接线用 CSS 伪元素画虚线（不做 SVG 几何计算），
 * 层与层之间是简单的短横线提示 + 缓慢流动的 dash 动画。
 */

import type { JSX } from 'react';

import type { TaskGraph, TaskNode, Route } from '../../shared/types.js';
import type { LogEntry, NodeStatus } from '../hooks/useExecution.js';
import { buildLayers, ROUTE_META, routeClass, truncate } from '../utils.js';

export interface TaskDagPanelProps {
  graph: TaskGraph;
  nodeStatus: Record<string, NodeStatus>;
  nodeOutputs: Record<string, string>;
  nodeErrors: Record<string, string>;
  events: LogEntry[];
  layerIndex: number;
  layerTotal: number;
  /** 消息内的历史图（已完成）：隐藏实时日志并在头部标注"已完成"。 */
  historical: boolean;
  defaultOpen: boolean;
}

const STATUS_TEXT: Record<NodeStatus, string> = {
  pending: '等待',
  running: '执行中',
  ok: '完成',
  failed: '失败',
};

const STATUS_CLS: Record<NodeStatus, string> = {
  pending: 'micro',
  running: 'micro micro-cyan',
  ok: 'micro micro-cyan',
  failed: 'micro micro-danger',
};

const KIND_LABEL: Record<TaskNode['kind'], string> = {
  chat: 'CHAT',
  analysis: 'ANALYSIS',
  code: 'CODE',
  copy: 'COPY',
  codec: 'CODEC',
  media: 'MEDIA',
  info: 'INFO',
  merge: 'MERGE',
};

function RoutePill({ route }: { route: Route }): JSX.Element {
  const meta = ROUTE_META[route];
  return <span className={`pill ${meta.cls}`}>{meta.label}</span>;
}

export function TaskDagPanel(props: TaskDagPanelProps): JSX.Element {
  const {
    graph,
    nodeStatus,
    nodeOutputs,
    nodeErrors,
    events,
    layerIndex,
    layerTotal,
    historical,
    defaultOpen,
  } = props;

  const layers = buildLayers(graph);
  const doneCount = graph.nodes.filter((node) => nodeStatus[node.id] === 'ok').length;
  const failedCount = graph.nodes.filter((node) => nodeStatus[node.id] === 'failed').length;

  return (
    <details className="dag" open={defaultOpen}>
      <summary className="collapse-head" style={{ listStyle: 'none' }}>
        <span className={`collapse-caret${defaultOpen ? ' is-open' : ''}`}>▸</span>
        <span>TASK DAG · 任务编排图</span>
        <span className="collapse-right">
          {historical ? '已完成' : layerTotal > 0 ? `层 ${Math.max(1, layerIndex + 1)}/${layerTotal}` : '待规划'}
          {' · '}
          {graph.nodes.length} 节点 · {doneCount} 完成
          {failedCount > 0 ? ` · ${failedCount} 失败` : ''}
        </span>
      </summary>

      <div className="dag-head">
        <span className="micro">ROUTE</span>
        <span className="chip chip-ghost">{graph.planner || 'planner'}</span>
        <div className="dag-legend">
          <span className="legend-item">
            <i className="legend-swatch legend-local" />
            <span className="micro">本地</span>
          </span>
          <span className="legend-item">
            <i className="legend-swatch legend-cloud" />
            <span className="micro">云端</span>
          </span>
          <span className="legend-item">
            <i className="legend-swatch legend-tool" />
            <span className="micro">工具</span>
          </span>
        </div>
      </div>

      <div className="dag-layers">
        {layers.map((layer) => (
          <div className="dag-layer" key={`layer-${layer.index}`}>
            <div className="dag-layer-head">
              <span className="micro micro-cyan">LAYER {String(layer.index).padStart(2, '0')}</span>
              <span className="micro">{layer.nodes.length} 节点</span>
            </div>
            {layer.nodes.map((node) => {
              const status: NodeStatus = nodeStatus[node.id] ?? 'pending';
              const output = nodeOutputs[node.id];
              const error = nodeErrors[node.id];
              return (
                <article
                  key={node.id}
                  className={`dag-node route-${routeClass(node.route)} status-${status}`}
                  title={error ? `失败原因：${error}` : node.prompt}
                >
                  <div className="dag-node-top">
                    <span className="dag-node-id">{node.id}</span>
                    <span className="dag-node-id">·</span>
                    <span className="dag-node-id">{KIND_LABEL[node.kind]}</span>
                    <span className={STATUS_CLS[status]}>{STATUS_TEXT[status]}</span>
                  </div>
                  <div className="dag-node-title">{node.title}</div>
                  <div className="dag-node-top" style={{ marginBottom: 0, marginTop: '4px' }}>
                    <RoutePill route={node.route} />
                    <span className="dag-node-model" title={node.model}>
                      {node.model || '—'}
                    </span>
                  </div>
                  {typeof node.confidence === 'number' && node.confidence > 0 ? (
                    <div className="micro" style={{ marginTop: '5px' }}>
                      CONF {Math.round(node.confidence * 100)}% · {node.strategy || 'direct'}
                    </div>
                  ) : null}
                  {error ? (
                    <div className="dag-output" style={{ color: 'rgba(255,150,150,.9)' }}>
                      {truncate(error, 160)}
                    </div>
                  ) : output ? (
                    <div className="dag-output">{truncate(output, 180)}</div>
                  ) : null}
                  {node.pruneReasons.length > 0 ? (
                    <div className="micro micro-amber" style={{ marginTop: '5px' }}>
                      剪枝 {node.pruneReasons.length} 项
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ))}
      </div>

      <div className="dag-stats">
        <div className="dag-stat">
          <span className="micro">本地节点</span>
          <span className="num">{graph.routeCounts.local ?? 0}</span>
        </div>
        <div className="dag-stat">
          <span className="micro">云端节点</span>
          <span className="num" style={{ color: 'var(--amber)' }}>
            {graph.routeCounts.cloud ?? 0}
          </span>
        </div>
        <div className="dag-stat">
          <span className="micro">工具节点</span>
          <span className="num" style={{ color: 'var(--violet)' }}>
            {graph.routeCounts.tool ?? 0}
          </span>
        </div>
        <div className="dag-stat">
          <span className="micro">层数</span>
          <span className="num">{graph.layerSizes.length}</span>
        </div>
      </div>

      {graph.notes.length > 0 || graph.warnings.length > 0 || events.length > 0 ? (
        <div className="dag-log">
          {graph.notes.map((note) => (
            <div className="dag-log-line" key={`note-${note}`}>
              <span className="dag-log-tag micro micro-cyan">NOTE</span>
              <span>{note}</span>
            </div>
          ))}
          {graph.warnings.map((warning) => (
            <div className="dag-log-line" key={`warn-${warning}`}>
              <span className="dag-log-tag micro micro-amber">WARN</span>
              <span>{warning}</span>
            </div>
          ))}
          {!historical
            ? events.map((entry) => (
                <div className="dag-log-line" key={`ev-${entry.id}`}>
                  <span
                    className={`dag-log-tag micro${
                      entry.kind === 'node_failed' || entry.kind === 'warning'
                        ? ' micro-danger'
                        : entry.kind === 'node_done'
                          ? ' micro-cyan'
                          : ''
                    }`}
                  >
                    {String(entry.at % 100000).padStart(5, '0')}
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))
            : null}
        </div>
      ) : null}

      {graph.nodes.some((node) => node.modality !== 'text') ? (
        <div className="micro micro-amber">
          含非文本模态节点：
          {[...new Set(graph.nodes.filter((n) => n.modality !== 'text').map((n) => n.modality))].join(' / ')}
          {' '}
          ({graph.nodes.filter((n) => n.modality !== 'text').map((n) => n.id).join(', ')})
        </div>
      ) : null}

      {!historical && layerTotal > 0 ? (
        <div className="micro">
          PROGRESS{' '}
          <span className="num">
            {doneCount + failedCount}/{graph.nodes.length}
          </span>
          {' '}节点已返回 · 当前第{' '}
          <span className="num">{Math.max(1, layerIndex + 1)}</span>
          {' '}层
        </div>
      ) : null}
    </details>
  );
}

export default TaskDagPanel;
