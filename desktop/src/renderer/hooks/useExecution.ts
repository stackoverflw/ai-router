/**
 * 执行编排 hook。
 *
 * 负责：
 *  - 持有会话消息列表（ChatMessage）
 *  - 订阅 onExecutionEvent，把事件流折叠成"实时任务图 + 节点状态 + 日志"
 *  - run(prompt) 完成后把 ExecutionReport 追加为一条 assistant 消息
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ChatMessage,
  ExecutionEvent,
  ExecutionReport,
  TaskGraph,
} from '../../shared/types.js';
import { getApi } from './useProviderStatus.js';

export type NodeStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface LogEntry {
  id: number;
  kind: ExecutionEvent['kind'];
  message: string;
  at: number;
  nodeId?: string;
}

export interface SessionTotals {
  localTokens: number;
  cloudTokens: number;
  savedTokens: number;
  runs: number;
}

export interface ExecutionViewModel {
  messages: ChatMessage[];
  running: boolean;
  activeGraph: TaskGraph | null;
  nodeStatus: Record<string, NodeStatus>;
  nodeOutputs: Record<string, string>;
  nodeErrors: Record<string, string>;
  layerIndex: number;
  layerTotal: number;
  events: LogEntry[];
  totals: SessionTotals;
  /** 当前正在跑的提示词，用于输入框与状态条展示。 */
  currentPrompt: string;
  run: (prompt: string) => Promise<void>;
  clear: () => void;
}

const MAX_LOG = 120;
const MAX_OUTPUT_CHARS = 600;

const KIND_LABEL: Record<ExecutionEvent['kind'], string> = {
  plan: 'PLAN',
  layer_start: 'LAYER',
  node_start: 'START',
  node_done: 'DONE',
  node_failed: 'FAIL',
  quality_fail: 'Q-GATE',
  escalated: 'ESCALATE',
  warning: 'WARN',
  done: 'DONE',
};

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}…`;
}

/** 把事件转成一行可读日志。 */
export function describeEvent(event: ExecutionEvent): string {
  const kind = KIND_LABEL[event.kind];
  const node = event.nodeId ? `[${event.nodeId}] ` : '';
  if (event.message) return `${kind} ${node}${event.message}`;
  if (event.kind === 'plan' && event.graph) {
    return `${kind} 生成任务图：${event.graph.nodes.length} 个节点 / ${event.graph.layerSizes.length} 层`;
  }
  if (event.kind === 'layer_start') {
    return `${kind} 第 ${(event.layerIndex ?? 0) + 1} 层开始（共 ${event.layerTotal ?? '?'} 层）`;
  }
  return `${kind} ${node}`.trim();
}

export function useExecution(): ExecutionViewModel {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState<boolean>(false);
  const [activeGraph, setActiveGraph] = useState<TaskGraph | null>(null);
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeStatus>>({});
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, string>>({});
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  const [layerIndex, setLayerIndex] = useState<number>(-1);
  const [layerTotal, setLayerTotal] = useState<number>(0);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [totals, setTotals] = useState<SessionTotals>({
    localTokens: 0,
    cloudTokens: 0,
    savedTokens: 0,
    runs: 0,
  });
  const [currentPrompt, setCurrentPrompt] = useState<string>('');

  const logSeq = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  /** run() 在 Promise 结束后需要读取"本次执行的最终图"，因此用 ref 镜像最新值。 */
  const activeGraphRef = useRef<TaskGraph | null>(null);

  useEffect(() => {
    activeGraphRef.current = activeGraph;
  }, [activeGraph]);

  useEffect(() => {
    let api;
    try {
      api = getApi();
    } catch {
      return;
    }

    const off = api.onExecutionEvent((event: ExecutionEvent) => {
      // 只处理属于当前这次运行的事件；空闲时到达的事件（例如上一次的收尾）忽略。
      if (!runningRef.current) return;

      setEvents((prev) => {
        const next: LogEntry = {
          id: (logSeq.current += 1),
          kind: event.kind,
          message: describeEvent(event),
          at: event.at || Date.now(),
          nodeId: event.nodeId,
        };
        const merged = [...prev, next];
        return merged.length > MAX_LOG ? merged.slice(merged.length - MAX_LOG) : merged;
      });

      switch (event.kind) {
        case 'plan': {
          if (event.graph) {
            const graph = event.graph;
            setActiveGraph(graph);
            setLayerTotal(graph.layerSizes.length);
            setLayerIndex(-1);
            setNodeStatus(() => {
              const init: Record<string, NodeStatus> = {};
              for (const node of graph.nodes) init[node.id] = 'pending';
              return init;
            });
            setNodeOutputs({});
            setNodeErrors({});
          }
          break;
        }
        case 'layer_start': {
          setLayerIndex(typeof event.layerIndex === 'number' ? event.layerIndex : -1);
          if (typeof event.layerTotal === 'number') setLayerTotal(event.layerTotal);
          break;
        }
        case 'node_start': {
          if (!event.nodeId) break;
          const id = event.nodeId;
          setNodeStatus((prev) => {
            const next: Record<string, NodeStatus> = { ...prev };
            next[id] = 'running';
            return next;
          });
          break;
        }
        case 'node_done': {
          if (!event.nodeId) break;
          const id = event.nodeId;
          setNodeStatus((prev) => {
            const next: Record<string, NodeStatus> = { ...prev };
            next[id] = 'ok';
            return next;
          });
          if (event.output) {
            setNodeOutputs((prev) => ({ ...prev, [id]: clip(event.output ?? '') }));
          }
          break;
        }
        case 'node_failed': {
          if (!event.nodeId) break;
          const id = event.nodeId;
          setNodeStatus((prev) => {
            const next: Record<string, NodeStatus> = { ...prev };
            next[id] = 'failed';
            return next;
          });
          setNodeErrors((prev) => ({ ...prev, [id]: event.message ?? '执行失败' }));
          break;
        }
        default:
          break;
      }
    });

    return off;
  }, []);

  const run = useCallback(async (prompt: string): Promise<void> => {
    const text = prompt.trim();
    if (!text || runningRef.current) return;

    const userMessage: ChatMessage = {
      id: makeId('u'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };

    runningRef.current = true;
    setCurrentPrompt(text);
    setRunning(true);
    setActiveGraph(null);
    setNodeStatus({});
    setNodeOutputs({});
    setNodeErrors({});
    setLayerIndex(-1);
    setLayerTotal(0);
    setEvents([]);
    setMessages((prev) => [...prev, userMessage]);

    try {
      const report = await getApi().run(text);
      const assistant: ChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        content: report.finalText,
        createdAt: Date.now(),
        report,
        graph: activeGraphRef.current ?? undefined,
      };
      setMessages((prev) => [...prev, assistant]);
      setTotals((prev) => ({
        localTokens: prev.localTokens + report.localTokens,
        cloudTokens: prev.cloudTokens + report.cloudTokens,
        savedTokens: prev.savedTokens + report.savedTokens,
        runs: prev.runs + 1,
      }));
    } catch (err: unknown) {
      const assistant: ChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        graph: activeGraphRef.current ?? undefined,
      };
      setMessages((prev) => [...prev, assistant]);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setCurrentPrompt('');
    }
  }, []);

  const clear = useCallback((): void => {
    if (runningRef.current) return;
    setMessages([]);
    setActiveGraph(null);
    setNodeStatus({});
    setNodeOutputs({});
    setNodeErrors({});
    setLayerIndex(-1);
    setLayerTotal(0);
    setEvents([]);
    setTotals({ localTokens: 0, cloudTokens: 0, savedTokens: 0, runs: 0 });
  }, []);

  return {
    messages,
    running,
    activeGraph,
    nodeStatus,
    nodeOutputs,
    nodeErrors,
    layerIndex,
    layerTotal,
    events,
    totals,
    currentPrompt,
    run,
    clear,
  };
}

/** 从报告里推出一条摘要文本，供气泡折叠区使用。 */
export function summarizeReport(report: ExecutionReport): string {
  const okCount = report.tasks.filter((task) => task.ok).length;
  return `${okCount}/${report.tasks.length} 个节点成功 · 合并策略 ${report.mergeStrategy || '默认'}`;
}
