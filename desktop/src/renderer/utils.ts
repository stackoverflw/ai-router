/**
 * 渲染进程共用的小工具：格式化与纯函数。
 *
 * 放在独立文件里，避免各组件重复实现字节 / 时长 / token 的显示规则。
 */

import type { LocalModelInfo, LocalModelPreset, Route, TaskGraph, TaskNode } from '../shared/types.js';

// ============================================================
// 哨兵值：本地模型选择器里代表"走云端"
// ============================================================

export const CLOUD_SENTINEL = '__cloud__';

// ============================================================
// 路由元信息
// ============================================================

export interface RouteMeta {
  label: string;
  /** 用于 pill-local / pill-cloud / pill-tool */
  cls: string;
}

export const ROUTE_META: Record<Route, RouteMeta> = {
  local: { label: '本地', cls: 'pill-local' },
  cloud: { label: '云端', cls: 'pill-cloud' },
  tool: { label: '工具', cls: 'pill-tool' },
};

export function routeClass(route: Route): string {
  return route === 'local' ? 'local' : route === 'cloud' ? 'cloud' : 'tool';
}

/** 路线色，用于内联 SVG / 条形图。 */
export function routeColor(route: Route): string {
  if (route === 'local') return '#5eead4';
  if (route === 'cloud') return '#f5b544';
  return '#a78bfa';
}

/** 生成 n 个采样柱，用于路由摘要里的迷你可视化。 */
export function routeBars(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 12);
}

// ============================================================
// 数字格式化
// ============================================================

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.0s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.round(n).toLocaleString('en-US');
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped.toFixed(clamped >= 10 ? 0 : 1)}%`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// ============================================================
// 任务图：分层
// ============================================================

export interface DagLayer {
  index: number;
  nodes: TaskNode[];
}

/**
 * 由 deps 推出每个节点的层号（无依赖 = 第 0 层），再按层分组。
 *
 * 主进程的 TaskGraph 只给出 layerSizes，节点顺序即拓扑序，
 * 这里做一次防御性重算，避免节点顺序变化时界面错位。
 */
export function buildLayers(graph: TaskGraph): DagLayer[] {
  const depth = new Map<string, number>();
  const byId = new Map<string, TaskNode>();
  for (const node of graph.nodes) byId.set(node.id, node);

  const resolve = (node: TaskNode, seen: Set<string>): number => {
    const cached = depth.get(node.id);
    if (cached !== undefined) return cached;
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    let level = 0;
    for (const dep of node.deps) {
      const parent = byId.get(dep);
      if (!parent) continue;
      level = Math.max(level, resolve(parent, seen) + 1);
    }
    seen.delete(node.id);
    depth.set(node.id, level);
    return level;
  };

  for (const node of graph.nodes) resolve(node, new Set<string>());

  const maxLevel = graph.nodes.reduce((acc, node) => Math.max(acc, depth.get(node.id) ?? 0), 0);
  const layers: DagLayer[] = [];
  for (let i = 0; i <= maxLevel; i += 1) {
    const nodes = graph.nodes.filter((node) => (depth.get(node.id) ?? 0) === i);
    if (nodes.length) layers.push({ index: i, nodes });
  }
  return layers;
}

/** 找出与某个节点直接相连的上下游节点 id，用于高亮。 */
export function neighborsOf(graph: TaskGraph, nodeId: string): string[] {
  const result = new Set<string>();
  for (const node of graph.nodes) {
    if (node.id === nodeId) {
      for (const dep of node.deps) result.add(dep);
      continue;
    }
    if (node.deps.includes(nodeId)) result.add(node.id);
  }
  return [...result];
}

// ============================================================
// 模型库
// ============================================================

/**
 * 已安装模型与预设的匹配。
 *
 * 先精确匹配，再退化为忽略 `:tag` 的匹配（Ollama 里 `qwen2.5` 与 `qwen2.5:7b` 可能是同一个）。
 */
export function findInstalled(
  installed: readonly LocalModelInfo[],
  preset: LocalModelPreset,
): LocalModelInfo | undefined {
  const exact = installed.find((entry) => entry.name === preset.name);
  if (exact) return exact;
  const base = preset.name.split(':')[0];
  return installed.find((entry) => entry.name.split(':')[0] === base);
}

export const CHINESE_LEVEL_META: Record<LocalModelPreset['chineseLevel'], { label: string; blocks: number }> = {
  excellent: { label: '优秀', blocks: 3 },
  good: { label: '良好', blocks: 2 },
  fair: { label: '一般', blocks: 1 },
};

// ============================================================
// 视图中转
// ============================================================

export type ViewKey = 'chat' | 'downloads' | 'settings';

/** 里程碑提示文案（当前没有流式文本，用过程提示替代空内容）。 */
export function progressHint(graph: TaskGraph | undefined, running: boolean): string {
  if (!running) return graph ? `已生成 ${graph.nodes.length} 个任务节点` : '';
  if (!graph) return '正在分析任务并规划执行图…';
  return `正在执行任务图（${graph.nodes.length} 个节点）…`;
}

/**
 * 收尾文本清理。
 *
 * 少数情况下后端会把合并结果原样带回，但也可能带上 `FINAL:` 之类的前缀或
 * 多余的 markdown 代码围栏包裹；这里只做最小清理，不改写内容。
 */
export function cleanFinalText(text: string, graph?: TaskGraph): string {
  let out = (text ?? '').trim();
  const prefixed = /^(final|answer|结果|最终结果)\s*[:：]\s*/i.exec(out);
  if (prefixed) out = out.slice(prefixed[0].length).trim();
  if (out.length > 3 && out.startsWith('```') && out.endsWith('```')) {
    const lines = out.split('\n');
    const fenceLang = lines[0].replace(/`/g, '').trim();
    if (lines.length > 2 && !/^(ts|tsx|js|jsx|json|python|bash|sh|sql|html|css|diff|text)$/i.test(fenceLang)) {
      out = lines.slice(1, -1).join('\n').trim();
    }
  }
  if (!out && graph) return `任务图已执行完成，共 ${graph.nodes.length} 个节点。`;
  return out;
}
