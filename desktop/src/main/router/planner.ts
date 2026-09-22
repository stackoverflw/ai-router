/**
 * 任务分解（TypeScript 移植版）。
 *
 * 与 `ai_router/planner.py` 对应。真实负载下用户不会只输入一个问题，
 * 本模块负责把一条提示词拆成"本地 / 云端 / 工具"混合执行的 DAG。
 *
 * 关键约束：**绝不把媒体生成任务交给文本模型。**
 * 无论是 4B 本地模型还是云端大模型，都无法产出视频/图片/音频文件，
 * 这类节点必须标记为 tool 并交给专用服务。
 */

import type { Modality, NodeKind, TaskGraph, TaskNode } from '../../shared/types.js';
import { analyzeTask, chooseLocalModel, decide, estimateTokens, profileFor } from './analyze.js';
import { detectMediaModality } from './signals.js';
import { canHandleShard, LOCAL_SHARD_KINDS } from './capability.js';

// ============================================================
// 工具链映射
// ============================================================

export const MEDIA_TOOL_BY_INTENT: Record<string, string> = {
  video: 'video_generate',
  image: 'image_generate',
  audio: 'audio_synthesize',
};

/** 媒体工具的配置状态由主进程注入（避免这里直接依赖环境变量）。 */
export type ToolAvailability = (tool: string) => boolean;

// ============================================================
// 节点构造
// ============================================================

interface NodeInit {
  kind?: NodeKind;
  modality?: Modality;
  deps?: string[];
  tool?: string;
  toolArgs?: Record<string, unknown>;
}

function makeNode(id: string, title: string, prompt: string, init: NodeInit = {}): TaskNode {
  return {
    id,
    title,
    prompt,
    kind: init.kind ?? 'chat',
    modality: init.modality ?? 'text',
    deps: init.deps ?? [],
    route: 'cloud',
    model: '',
    confidence: 0,
    strategy: '',
    pruneReasons: [],
    tool: init.tool ?? '',
    toolArgs: init.toolArgs ?? {},
  };
}

// ============================================================
// 是否需要分解
// ============================================================

const DECOMPOSE_SIGNALS = new Set([
  'media_generation',
  'many_actions',
  'compound_actions',
  'many_deliverables',
  'multiple_deliverables',
  'numbered_plan',
  'constraint_density',
  'large_output_scale',
  'huge_output_scale',
  'medium_output_scale',
  'deep_research',
  'system_architecture',
  'software_engineering_scale',
  'model_training',
  'data_pipeline_scale',
]);

export function shouldDecompose(userInput: string): { needed: boolean; reasons: string[] } {
  const analysis = analyzeTask(userInput);
  const reasons: string[] = [];

  for (const entry of analysis.signals) {
    if (DECOMPOSE_SIGNALS.has(entry.name)) {
      reasons.push(`${entry.name}：${entry.evidence}`);
    }
  }

  if (analysis.hardCloud) reasons.push(`硬约束：${analysis.hardCloudReason}`);

  return { needed: reasons.length > 0, reasons };
}

// ============================================================
// 枚举切分
// ============================================================

const FRAGMENT_MARKERS = ['并且', '然后', '同时', '以及', '还要', '最后', '接着', '另外'];

export function splitEnumeration(userInput: string, maxParts = 6): string[] {
  const text = userInput.trim();

  // 顿号枚举："定位、栏目结构、录制流程、推广节奏都要"
  if ((text.match(/、/g) ?? []).length >= 3) {
    const trimmed = text.replace(/[都要都需请帮我一并全部]+$/, '');
    const marker = Math.max(trimmed.lastIndexOf('：'), trimmed.lastIndexOf(':'));
    if (marker >= 0) {
      const head = trimmed.slice(0, marker + 1);
      const parts = trimmed
        .slice(marker + 1)
        .split('、')
        .map((part) => part.trim())
        .filter((part) => part.length >= 2);
      if (parts.length >= 2) {
        return parts.slice(0, maxParts).map((part) => head + part);
      }
    }
  }

  const rawParts = text
    .split(/[，,；;。！!？?]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (const part of rawParts) {
    let cleaned = part;
    for (const marker of FRAGMENT_MARKERS) {
      if (cleaned.startsWith(marker)) cleaned = cleaned.slice(marker.length).trim();
    }
    if (cleaned.length >= 3) parts.push(cleaned);
  }

  return parts.length >= 2 ? parts.slice(0, maxParts) : [text];
}

// ============================================================
// 媒体任务图
// ============================================================

const GENERATION_PROMPT_TEMPLATE =
  '以下是一份视频/图像生成规格说明。请把它整理成一条适合直接提交给' +
  '生成模型使用的创作提示词（中文，一段话，包含主体、场景、风格、镜头、光线、时长节奏），' +
  '不要输出任何解释或多段结构。\n\n规格说明：\n{spec}';

function buildMediaGraph(
  userInput: string,
  intent: string,
  toolAvailable: (tool: string) => boolean,
): TaskGraph {
  const tool = MEDIA_TOOL_BY_INTENT[intent];
  const nodes: TaskNode[] = [];

  nodes.push(
    makeNode('spec', '设计内容规格',
      `为用户需求设计一份可执行的${intent}内容规格。必须包含：整体主题与情绪、` +
      '分段场景（每段给出画面内容与时长）、镜头与节奏建议、风格与色调、时长总长。' +
      `用简洁的条目化结构输出。\n\n用户需求：${userInput}`,
      { kind: 'analysis' }),
  );

  nodes.push(
    makeNode('gen_prompt', '编写生成提示词', GENERATION_PROMPT_TEMPLATE, {
      kind: 'copy',
      deps: ['spec'],
    }),
  );

  nodes.push(
    makeNode('generate', `调用${intent}生成工具`, '{gen_prompt}', {
      kind: 'media',
      modality: intent as Modality,
      deps: ['gen_prompt'],
      tool,
      toolArgs: { prompt: '{gen_prompt}', modality: intent },
    }),
  );

  nodes.push(
    makeNode('assemble', '合成与导出', '{generate}', {
      kind: 'codec',
      modality: intent as Modality,
      deps: ['generate'],
      tool: 'media_compose',
      toolArgs: { source: '{generate}', modality: intent },
    }),
  );

  if (intent === 'video') {
    nodes.push(
      makeNode('caption', '撰写标题与简介',
        '根据以下内容规格，写三段东西：1) 一个不超过 20 字的视频标题；' +
        '2) 一段不超过 80 字的视频简介；3) 三条不超过 15 字的平台标签。' +
        `直接输出，不要解释。\n\n用户需求：${userInput}\n内容规格：{spec}`,
        { kind: 'copy', deps: ['spec'] }),
    );

    nodes.push(
      makeNode('final', '汇总交付', '{assemble}\n\n{caption}', {
        kind: 'merge',
        deps: ['assemble', 'caption'],
      }),
    );
  } else {
    nodes.push(
      makeNode('final', '汇总交付', '{assemble}', { kind: 'merge', deps: ['assemble'] }),
    );
  }

  return {
    goal: userInput,
    nodes,
    planner: 'heuristic',
    notes: [
      `媒体意图=${intent}，生成工具=${tool}` +
        (toolAvailable(tool) ? '（已配置）' : '（未配置，将给出接入指引）'),
    ],
    warnings: [],
    layerSizes: [],
    routeCounts: { local: 0, cloud: 0, tool: 0 },
  };
}

// ============================================================
// 通用任务图
// ============================================================

function buildGenericGraph(userInput: string): TaskGraph {
  const parts = splitEnumeration(userInput);
  const nodes: TaskNode[] = [];
  const notes: string[] = [];

  if (parts.length <= 1) {
    nodes.push(makeNode('main', '主任务', userInput, { kind: 'chat' }));
    notes.push('未发现可切分的独立子任务，作为单节点处理。');
  } else {
    parts.forEach((part, index) => {
      nodes.push(makeNode(`part${index + 1}`, `子任务 ${index + 1}`, part, { kind: 'chat' }));
    });
    nodes.push(
      makeNode(
        'final',
        '汇总交付',
        parts.map((_, index) => `{part${index + 1}}`).join('\n\n'),
        { kind: 'merge', deps: parts.map((_, index) => `part${index + 1}`) },
      ),
    );
    notes.push(`按标点切出 ${parts.length} 个独立子任务。`);
  }

  return {
    goal: userInput,
    nodes,
    planner: 'heuristic',
    notes,
    warnings: [],
    layerSizes: [],
    routeCounts: { local: 0, cloud: 0, tool: 0 },
  };
}

// ============================================================
// 校验
// ============================================================

export function validateGraph(graph: TaskGraph): string[] {
  const problems: string[] = [];
  const ids = graph.nodes.map((node) => node.id);

  if (new Set(ids).size !== ids.length) problems.push('存在重复的节点 id');

  const known = new Set(ids);
  for (const node of graph.nodes) {
    for (const dep of node.deps) {
      if (!known.has(dep)) problems.push(`节点 ${node.id} 依赖了不存在的 ${dep}`);
    }
    if (node.deps.includes(node.id)) problems.push(`节点 ${node.id} 依赖自己`);
  }

  const terminals = graph.nodes.filter(
    (node) => !graph.nodes.some((other) => other.deps.includes(node.id)),
  );
  if (terminals.length > 1 && !graph.nodes.some((node) => node.kind === 'merge')) {
    problems.push('存在多个终端节点但缺少汇总节点');
  }

  // 环检测
  const remaining = new Map(graph.nodes.map((node) => [node.id, new Set(node.deps)]));
  const resolved = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((dep) => resolved.has(dep)));
    if (!ready.length) {
      problems.push('任务图存在循环依赖');
      break;
    }
    for (const [id] of ready) {
      remaining.delete(id);
      resolved.add(id);
    }
  }

  return problems;
}

// ============================================================
// 预判路由
// ============================================================

const LOCAL_SHARD_PROMPT_LIMIT = 700;

const VETO_FAMILIES = new Set([
  'domain_engineering', 'domain_ai', 'domain_data', 'domain_research',
  'domain_reasoning', 'domain_media', 'domain_creative', 'external', 'risk',
]);

function localShardVerdict(
  node: TaskNode,
  profile: ReturnType<typeof profileFor>,
): { ok: boolean; reason: string } {
  if (!LOCAL_SHARD_KINDS.has(node.kind)) {
    return { ok: false, reason: `节点类型 ${node.kind} 不在本地分片白名单内` };
  }

  if (node.prompt.length > LOCAL_SHARD_PROMPT_LIMIT) {
    return {
      ok: false,
      reason: `节点 prompt 长 ${node.prompt.length} 字，超出本地分片上限 ${LOCAL_SHARD_PROMPT_LIMIT}，说明任务本身已复杂`,
    };
  }

  const analysis = analyzeTask(node.prompt);
  if (analysis.hardCloud) {
    return { ok: false, reason: `本地硬约束：${analysis.hardCloudReason}` };
  }

  const veto = Array.from(
    new Set(
      analysis.signals
        .filter((entry) => VETO_FAMILIES.has(entry.family) && entry.weight > 0)
        .map((entry) => entry.name),
    ),
  );
  if (veto.length) {
    return { ok: false, reason: `命中需云端能力特征：${veto.join('、')}` };
  }

  const upstreamText = node.deps.map((dep) => `{${dep}}`).join('\n');
  const expectedOutput = Math.max(200, Math.min(Math.round(estimateTokens(node.prompt) * 2), 900));

  return canHandleShard(profile, { upstreamText, expectedOutputTokens: expectedOutput });
}

export interface PreRouteOptions {
  installedModels: readonly string[];
  localModel?: string;
}

export function preRoute(graph: TaskGraph, options: PreRouteOptions): TaskGraph {
  const installed = options.installedModels;
  const chosen = chooseLocalModel(installed);
  const modelName = options.localModel || chosen || 'qwen3:4b';
  const profile = profileFor(modelName);
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const node of graph.nodes) {
    node.pruneReasons = [];

    // 1. 工具与媒体
    if (node.tool || node.kind === 'media' || node.kind === 'codec') {
      node.route = 'tool';
      node.confidence = 1;
      node.strategy = 'tool_required';
      if (node.kind === 'media') node.pruneReasons.push('媒体生成必须由专用工具完成');
      continue;
    }

    // 2. 本地分片
    const verdict = localShardVerdict(node, profile);
    if (verdict.ok) {
      node.route = 'local';
      node.model = modelName;
      node.confidence = 0.75;
      node.strategy = 'local_shard';
      node.pruneReasons.push(`分片型任务（kind=${node.kind}），本地可承担`);
      continue;
    }

    // 3. 汇总
    if (node.kind === 'merge') {
      const shortDelivery =
        node.deps.length > 0 &&
        node.deps.length <= 3 &&
        node.deps.every((dep) => {
          const upstream = nodeMap.get(dep);
          return upstream && upstream.route === 'local' && (upstream.kind === 'copy' || upstream.kind === 'chat');
        });

      if (shortDelivery) {
        node.route = 'local';
        node.model = modelName;
        node.confidence = 0.7;
        node.strategy = 'local_merge';
        node.pruneReasons.push('上游全为本地短产出，汇总下放本地以省 token');
      } else {
        node.route = 'cloud';
        node.confidence = 0.9;
        node.strategy = 'merge_needs_global_view';
        node.pruneReasons.push('汇总需要全局视野，交由云端完成');
      }
      continue;
    }

    // 4. 交给路由内核
    const decision = decide(node.prompt, { localModel: modelName, installedModels: installed });
    node.route = decision.route;
    node.confidence = decision.confidence;
    node.strategy = decision.strategy;
    node.model = decision.model || (decision.route === 'local' ? modelName : '');
    if (decision.analysis.hardCloud) node.pruneReasons.push(decision.analysis.hardCloudReason);
    node.pruneReasons.push(decision.reason);
  }

  graph.routeCounts = {
    local: graph.nodes.filter((node) => node.route === 'local').length,
    cloud: graph.nodes.filter((node) => node.route === 'cloud').length,
    tool: graph.nodes.filter((node) => node.route === 'tool').length,
  };
  graph.layerSizes = computeLayers(graph).map((layer) => layer.length);

  return graph;
}

// ============================================================
// 拓扑分层
// ============================================================

export function computeLayers(graph: TaskGraph): TaskNode[][] {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const remaining = new Map(graph.nodes.map((node) => [node.id, new Set(node.deps)]));
  const resolved = new Set<string>();
  const layers: TaskNode[][] = [];

  while (remaining.size) {
    let ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((dep) => resolved.has(dep)))
      .map(([id]) => id)
      .sort();

    if (!ready.length) {
      // 环路保护：按声明顺序降级，保证执行器总能推进。
      ready = [...remaining.keys()].sort();
      graph.warnings.push('任务图存在循环依赖，已按声明顺序降级执行。');
    }

    layers.push(ready.map((id) => nodeMap.get(id)!));

    for (const id of ready) {
      remaining.delete(id);
      resolved.add(id);
    }
  }

  return layers;
}

// ============================================================
// 主入口
// ============================================================

export interface PlanOptions {
  toolAvailable?: ToolAvailability;
  installedModels?: readonly string[];
  localModel?: string;
}

export function plan(userInput: string, options: PlanOptions = {}): TaskGraph {
  const goal = (userInput ?? '').trim();
  if (!goal) throw new Error('用户输入为空，无法规划');

  const toolAvailable = options.toolAvailable ?? (() => false);
  const intent = detectMediaModality(goal);

  let graph: TaskGraph;

  if (intent) {
    graph = buildMediaGraph(goal, intent, toolAvailable);
  } else {
    const { needed, reasons } = shouldDecompose(goal);
    graph = buildGenericGraph(goal);
    if (needed) {
      graph.notes.push('分解依据（启发式）：' + reasons.slice(0, 4).join('；'));
    }
  }

  graph.warnings.push(...validateGraph(graph));
  preRoute(graph, {
    installedModels: options.installedModels ?? [],
    localModel: options.localModel,
  });

  return graph;
}
