/**
 * 路由决策：与 `ai_router/router.py` 一一对应。
 *
 * 决策优先级::
 *
 *   1. 高风险领域且分数不为负      → CLOUD
 *   2. 硬约束（本地物理不可行）    → CLOUD
 *   3. 云端分数 >= cloudMin        → CLOUD
 *   4. 云端分数 <= localMax 且有本地证据 → LOCAL
 *   5. 其余                        → CLOUD（保守兜底）
 */

import type { Modality, RouteDecision, RoutingAnalysis, Signal } from '../../shared/types.js';
import { collectSignals, matchLocalSkills } from './detectors.js';
import {
  THRESHOLDS,
  WEIGHTS,
  detectMediaModality,
  extractOutputScale,
} from './signals.js';

// ============================================================
// 本地模型档案
// ============================================================

export interface LocalModelProfile {
  name: string;
  paramsB: number;
  modalities: Modality[];
  contextWindow: number;
  maxReliableOutput: number;
  nativeReasoning: boolean;
}

const LIBRARY: Record<string, LocalModelProfile> = {
  'qwen3:4b': { name: 'qwen3:4b', paramsB: 4, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 2048, nativeReasoning: true },
  'qwen3:8b': { name: 'qwen3:8b', paramsB: 8, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 3072, nativeReasoning: true },
  'qwen2.5:0.5b': { name: 'qwen2.5:0.5b', paramsB: 0.5, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 768, nativeReasoning: false },
  'qwen2.5:1.5b': { name: 'qwen2.5:1.5b', paramsB: 1.5, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 1280, nativeReasoning: false },
  'qwen2.5:3b': { name: 'qwen2.5:3b', paramsB: 3, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 2048, nativeReasoning: false },
  'qwen2.5:7b': { name: 'qwen2.5:7b', paramsB: 7, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 3072, nativeReasoning: false },
  'qwen2.5-coder:7b': { name: 'qwen2.5-coder:7b', paramsB: 7, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 4096, nativeReasoning: false },
  'llama3.2:1b': { name: 'llama3.2:1b', paramsB: 1, modalities: ['text', 'code'], contextWindow: 8192, maxReliableOutput: 1024, nativeReasoning: false },
  'llama3.2:3b': { name: 'llama3.2:3b', paramsB: 3, modalities: ['text', 'code'], contextWindow: 8192, maxReliableOutput: 2048, nativeReasoning: false },
  'gemma3:4b': { name: 'gemma3:4b', paramsB: 4, modalities: ['text', 'code', 'image'], contextWindow: 32768, maxReliableOutput: 2048, nativeReasoning: false },
  'deepseek-r1:7b': { name: 'deepseek-r1:7b', paramsB: 7, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 4096, nativeReasoning: true },
  'deepseek-r1:14b': { name: 'deepseek-r1:14b', paramsB: 14, modalities: ['text', 'code'], contextWindow: 32768, maxReliableOutput: 6144, nativeReasoning: true },
};

function inferProfile(name: string): LocalModelProfile {
  let params = 4;
  for (const token of ['0.5b', '1b', '1.5b', '3b', '4b', '7b', '8b', '14b', '32b', '70b']) {
    if (name.includes(token)) {
      params = Number.parseFloat(token.replace('b', ''));
      break;
    }
  }
  return {
    name,
    paramsB: params,
    modalities: ['text', 'code'],
    contextWindow: 8192,
    maxReliableOutput: Math.round(Math.min(4096, Math.max(512, params * 512))),
    nativeReasoning: name.includes('r1') || name.includes('thinking'),
  };
}

export function profileFor(modelName: string): LocalModelProfile {
  const name = (modelName ?? '').trim().toLowerCase();
  return LIBRARY[name] ?? inferProfile(name);
}

/** 在已安装模型里挑一个最合适的：先满足能力门槛，再选最小的。 */
export function chooseLocalModel(
  installed: readonly string[],
  options: { modality?: Modality; needsCode?: boolean; taskKind?: 'trivial' | 'generic' | 'quality' } = {},
): string | null {
  const modality = options.modality ?? 'text';
  const minimum = { trivial: 0, generic: 3, quality: 7 }[options.taskKind ?? 'generic'];

  const candidates = installed
    .map((name) => profileFor(name))
    .filter((profile) => profile.modalities.includes(modality))
    .filter((profile) => !options.needsCode || profile.modalities.includes('code'));

  if (!candidates.length) return null;

  if (options.needsCode) {
    const coders = candidates.filter((profile) => profile.name.includes('coder'));
    if (coders.length) return coders.sort((a, b) => a.paramsB - b.paramsB)[0].name;
  }

  const capable = candidates.filter((profile) => profile.paramsB >= minimum);
  const pool = capable.length ? capable : candidates;
  const sorted = [...pool].sort((a, b) => a.paramsB - b.paramsB);
  return capable.length ? sorted[0].name : sorted[sorted.length - 1].name;
}

// ============================================================
// Token 估算
// ============================================================

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    if (char >= '\u4e00' && char <= '\u9fff') cjk += 1;
  }
  const other = text.length - cjk;
  return Math.round(cjk * 0.6 + other * 0.28) + 1;
}

// ============================================================
// 分析
// ============================================================

const DOMAIN_FAMILIES = new Set([
  'domain_engineering', 'domain_ai', 'domain_data', 'domain_research',
  'domain_reasoning', 'domain_media', 'domain_creative', 'external', 'risk',
]);

const COMPOUND_FAMILIES = new Set(['compound', 'deliverables']);

const LOCAL_BLOCKING_FAMILIES = new Set([
  'domain_media', 'external', 'risk', 'domain_engineering', 'domain_ai', 'domain_data',
]);

const DIMENSION_SCALE = 0.7;

function emptyAnalysis(): RoutingAnalysis {
  return {
    complexity: 0,
    reasoningDepth: 0,
    outputScale: 0,
    codeOrSystem: 0,
    toolOrFile: 0,
    localCapacityRisk: 0,
    signals: [],
    signalScore: 0,
    hardCloud: false,
    hardCloudReason: '',
    clearlySimple: false,
  };
}

const DIMENSION_OF_FAMILY: Record<string, keyof RoutingAnalysis> = {
  output_scale: 'outputScale',
  context_scale: 'outputScale',
  deliverables: 'outputScale',
  compound: 'localCapacityRisk',
  domain_engineering: 'codeOrSystem',
  domain_ai: 'codeOrSystem',
  domain_data: 'toolOrFile',
  domain_research: 'reasoningDepth',
  domain_reasoning: 'reasoningDepth',
  domain_media: 'localCapacityRisk',
  domain_creative: 'complexity',
  external: 'toolOrFile',
  risk: 'localCapacityRisk',
  language: 'complexity',
};

function estimateExpectedOutputTokens(userInput: string, signals: readonly Signal[]): number {
  const { equivalent } = extractOutputScale(userInput);
  if (equivalent > 0) return Math.max(64, Math.round(equivalent * 0.7));

  const names = new Set(signals.map((entry) => entry.name));
  if (names.has('huge_output_scale')) return 30000;
  if (names.has('large_output_scale')) return 8000;
  if (names.has('medium_output_scale')) return 1200;
  if (names.has('long_form_creative')) return 6000;
  if (names.has('deep_research')) return 2500;
  if (names.has('system_architecture') || names.has('software_engineering_scale')) return 2000;
  if (names.has('short_explicit_answer_expected') || names.has('known_local_skill')) return 320;

  return Math.max(160, Math.min(1500, Math.round(estimateTokens(userInput) * 2.5)));
}

export interface AnalyzeOptions {
  localModel?: string;
  installedModels?: readonly string[];
  enablePruning?: boolean;
}

export function analyzeTask(userInput: string, options: AnalyzeOptions = {}): RoutingAnalysis {
  const analysis = emptyAnalysis();

  const signals = collectSignals(userInput);
  const names = new Set(signals.map((entry) => entry.name));
  const domainConflict = signals.some((entry) => DOMAIN_FAMILIES.has(entry.family));
  const compoundConflict = signals.some((entry) => COMPOUND_FAMILIES.has(entry.family));

  // ---- 本地技能调制 ----
  const skillHits = matchLocalSkills(userInput);
  if (skillHits.length) {
    const base = WEIGHTS.known_local_skill;
    const skillNames = skillHits.map((entry) => entry.skill).join('、');
    if (domainConflict || compoundConflict) {
      signals.push({
        name: 'known_local_skill',
        family: 'local_skill',
        weight: base * 0.3,
        evidence: `命中本地技能（${skillNames}）但存在领域/复合冲突，权重已下调：${skillHits[0].reason}`,
      });
    } else {
      signals.push({
        name: 'known_local_skill',
        family: 'local_skill',
        weight: base,
        evidence: `命中本地强项技能（${skillNames}）：${skillHits[0].reason}`,
      });
    }
  }

  // ---- 硬约束剪枝 ----
  if (options.enablePruning !== false) {
    let modelName = options.localModel ?? 'qwen3:4b';
    if (options.installedModels) {
      const chosen = chooseLocalModel(options.installedModels);
      if (chosen) modelName = chosen;
    }

    const profile = profileFor(modelName);
    const modality = (detectMediaModality(userInput) || 'text') as Modality;
    const expectedOutput = estimateExpectedOutputTokens(userInput, signals);

    const reasons: string[] = [];

    if ((modality === 'image' || modality === 'video' || modality === 'audio') && !profile.modalities.includes(modality)) {
      reasons.push(`本地模型 ${profile.name} 不具备 ${modality} 生成能力`);
    } else if (!profile.modalities.includes(modality)) {
      reasons.push(`本地模型 ${profile.name} 不支持 ${modality} 输出`);
    }

    const promptTokens = estimateTokens(userInput);
    const neededContext = promptTokens + expectedOutput + 256;
    if (neededContext > profile.contextWindow) {
      reasons.push(`上下文需求约 ${neededContext} tokens 超过 ${profile.name} 的 ${profile.contextWindow} 窗口`);
    }

    if (expectedOutput > profile.maxReliableOutput) {
      reasons.push(`预计输出 ${expectedOutput} tokens 超过 ${profile.name} 可靠上限 ${profile.maxReliableOutput}`);
    }

    if (names.has('file_system_operation') || names.has('tool_invocation')) {
      reasons.push('任务需要真实工具执行，本地文本模型无法完成');
    }

    if (names.has('many_actions')) {
      reasons.push('多步骤流程规划超出本地单轮流式任务的能力范围');
    }

    if (names.has('math_with_precision')) {
      reasons.push('要求精确数值计算，需交由云端或专业工具');
    }

    if (reasons.length) {
      analysis.hardCloud = true;
      analysis.hardCloudReason = reasons.join('；');
    }
  }

  // ---- 单点技能加成 ----
  const singlePoint = skillHits.length > 0 && !domainConflict && !compoundConflict && !analysis.hardCloud;
  if (singlePoint) {
    signals.push({
      name: 'single_point_skill',
      family: 'local_skill',
      weight: WEIGHTS.single_point_skill,
      evidence: '单一动作且无领域风险，属本地模型稳定胜任的范围',
    });
  }

  analysis.signals = signals;
  analysis.signalScore = Math.round(signals.reduce((total, entry) => total + entry.weight, 0) * 1000) / 1000;

  // ---- 六维分数（仅用于展示，路由不依赖它）----
  for (const entry of signals) {
    if (entry.weight <= 0) continue;
    const dimension = DIMENSION_OF_FAMILY[entry.family];
    if (!dimension) continue;
    const current = analysis[dimension] as number;
    (analysis[dimension] as number) = Math.round(current + entry.weight * DIMENSION_SCALE);
  }

  // ---- 是否属于高置信度简单任务 ----
  const positiveWeight = signals.filter((entry) => entry.weight > 0).reduce((total, entry) => total + entry.weight, 0);
  const blocking = signals.some((entry) => LOCAL_BLOCKING_FAMILIES.has(entry.family));
  analysis.clearlySimple = !analysis.hardCloud && positiveWeight <= 0 && !blocking;

  return analysis;
}

// ============================================================
// 决策
// ============================================================

function confidenceFromMargin(margin: number, score: number, steepness = 0.14): number {
  const raw = 1 / (1 + Math.pow(2.718281828, -steepness * Math.abs(margin)));
  const penalty = Math.min(0.2, Math.abs(score) * 0.004);
  return Math.max(0.35, Math.min(0.99, raw - penalty));
}

export interface DecideOptions extends AnalyzeOptions {
  localMax?: number;
  cloudMin?: number;
}

export function decide(userInput: string, options: DecideOptions = {}): RouteDecision {
  const localMax = options.localMax ?? THRESHOLDS.localMax;
  const cloudMin = options.cloudMin ?? THRESHOLDS.cloudMin;

  const analysis = analyzeTask(userInput, options);
  const score = analysis.signalScore;
  const evidence = Array.from(new Set(analysis.signals.map((entry) => entry.name))).join('、') || '未命中强特征';
  const families = new Set(analysis.signals.map((entry) => entry.family));

  // 1. 高风险领域
  if (families.has('risk') && score >= 0) {
    return {
      route: 'cloud',
      confidence: 0.97,
      reason: `[高风险领域] 命中高风险领域特征且信号分 ${score.toFixed(1)} >= 0，不做本地兜底；命中=${evidence}`,
      analysis,
      strategy: 'high_stakes_guard',
      model: '',
    };
  }

  // 2. 硬约束
  if (analysis.hardCloud) {
    return {
      route: 'cloud',
      confidence: 0.99,
      reason: `[硬约束] ${analysis.hardCloudReason}`,
      analysis,
      strategy: 'capability_prune',
      model: '',
    };
  }

  // 3. 明显云端
  if (score >= cloudMin) {
    return {
      route: 'cloud',
      confidence: confidenceFromMargin(score - cloudMin, score),
      reason: `[信号加权] 云端分数 ${score.toFixed(1)} >= ${cloudMin}；命中=${evidence}`,
      analysis,
      strategy: 'weighted_signals',
      model: '',
    };
  }

  // 4. 明显本地
  if (score <= localMax && analysis.clearlySimple) {
    const model = options.localModel ?? 'qwen3:4b';
    return {
      route: 'local',
      confidence: confidenceFromMargin(localMax - score, score, 0.3),
      reason: `[信号加权] 云端分数 ${score.toFixed(1)} <= ${localMax}，且有明确本地能力证据；命中=${evidence}`,
      analysis,
      strategy: 'weighted_signals',
      model,
    };
  }

  // 5. 保守兜底
  return {
    route: 'cloud',
    confidence: 0.5,
    reason: `[保守兜底] 云端分数 ${score.toFixed(1)} 落在不确定区间（${localMax} ~ ${cloudMin}），无法确认本地可靠性，转云端；命中=${evidence}`,
    analysis,
    strategy: 'conservative_default',
    model: '',
  };
}

/** 人类可读的多行解释，供界面展示。 */
export function explainRoute(userInput: string, options: DecideOptions = {}): string {
  const decision = decide(userInput, options);
  const analysis = decision.analysis;

  const lines = [
    `路由：${decision.route.toUpperCase()}（策略=${decision.strategy}，置信度=${decision.confidence.toFixed(2)}）`,
    `理由：${decision.reason}`,
    `云端分数：${analysis.signalScore.toFixed(1)}`,
    `六维：复杂度=${analysis.complexity} 推理=${analysis.reasoningDepth} 输出=${analysis.outputScale} ` +
      `代码/系统=${analysis.codeOrSystem} 工具/文件=${analysis.toolOrFile} 本地风险=${analysis.localCapacityRisk}`,
  ];

  if (decision.model) lines.push(`建议模型：${decision.model}`);
  return lines.join('\n');
}
