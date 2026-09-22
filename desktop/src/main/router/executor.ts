/**
 * 并行执行器（TypeScript 移植版）。
 *
 * 与 `ai_router/executor.py` 对应：按拓扑层并发执行，
 * 本地节点带质量闸门，不合格时升级云端重跑，最后由汇总节点合成。
 */

import type {
  ExecutionEvent,
  ExecutionReport,
  Route,
  TaskGraph,
  TaskNode,
  TaskResult,
} from '../../shared/types.js';
import { checkOutputQuality } from './capability.js';
import { computeLayers } from './planner.js';

// ============================================================
// 执行后端接口
// ============================================================

/** 文本生成后端。由主进程按用户设置实现（本地 Ollama / 云端 OpenAI 兼容）。 */
export interface TextBackend {
  callLocal(prompt: string, model: string): Promise<string>;
  callCloud(prompt: string, options?: { system?: string; model?: string }): Promise<string>;
  cloudConfigured(): boolean;
}

/** 工具后端。 */
export interface ToolBackend {
  call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; error: string; notConfigured: boolean }>;
}

export interface ExecutorOptions {
  text: TextBackend;
  tools: ToolBackend;
  maxConcurrency?: number;
  enableQualityGate?: boolean;
  allowEscalation?: boolean;
  minExpectedChars?: number;
  mergeInputLimit?: number;
  onEvent?: (event: ExecutionEvent) => void;
}

// ============================================================
// 模板渲染
// ============================================================

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * 把 `{node_id}` 替换为上游产出。
 *
 * 只替换已知的上游节点 id：早期实现替换"任意 {xxx}"，
 * 结果把工具提示里的 `{input}` / `{output}` 也吃掉，产生假告警。
 */
export function renderTemplate(template: string, outputs: Record<string, string>): string {
  if (!Object.keys(outputs).length) return template;
  return template.replace(PLACEHOLDER_RE, (match, key: string) =>
    key in outputs ? outputs[key] : match,
  );
}

// ============================================================
// 合并
// ============================================================

const MERGE_SYSTEM = [
  '你是一个结果汇总器。上游多个执行单元已经各自完成了一部分工作，',
  '请把它们整合成一份完整、连贯、可直接交付给用户的最终结果。',
  '要求：',
  '1. 不要罗列上游分别返回了什么，直接给出整合后的成品；',
  '2. 消除重复内容，统一术语与格式；',
  '3. 如果上游某一部分失败或缺失，明确说明该部分未能完成，不要编造；',
  '4. 保留所有关键事实与数值，不得改写或臆造。',
].join('\n');

function buildMergePrompt(node: TaskNode, graph: TaskGraph, outputs: Record<string, string>): string {
  const nodeMap = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  const blocks = node.deps.map((dep) => {
    const title = nodeMap.get(dep)?.title ?? dep;
    return `### ${title}（${dep}）\n${outputs[dep] ?? '（该部分未产出）'}`;
  });
  return `用户原始请求：${graph.goal}\n\n以下是各部分产出：\n\n${blocks.join('\n\n')}\n\n请整合成最终结果。`;
}

/** 不调用模型也能交付的合并方式（云端未配置或产出很短时使用）。 */
function deterministicMerge(node: TaskNode, graph: TaskGraph, outputs: Record<string, string>): string {
  const nodeMap = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  if (node.deps.length === 1) return outputs[node.deps[0]] ?? '（该部分未产出）';

  return node.deps
    .map((dep) => {
      const title = nodeMap.get(dep)?.title ?? dep;
      return `## ${title}\n${outputs[dep] ?? '（该部分未产出）'}`;
    })
    .join('\n\n');
}

// ============================================================
// 执行器
// ============================================================

export class Executor {
  private readonly options: Required<Omit<ExecutorOptions, 'onEvent'>> & { onEvent?: (event: ExecutionEvent) => void };

  constructor(options: ExecutorOptions) {
    this.options = {
      maxConcurrency: options.maxConcurrency ?? 4,
      enableQualityGate: options.enableQualityGate ?? true,
      allowEscalation: options.allowEscalation ?? true,
      minExpectedChars: options.minExpectedChars ?? 20,
      mergeInputLimit: options.mergeInputLimit ?? 12000,
      text: options.text,
      tools: options.tools,
      onEvent: options.onEvent,
    };
  }

  private emit(event: ExecutionEvent): void {
    this.options.onEvent?.(event);
  }

  // ---- 单节点 ----

  private async runTextNode(node: TaskNode, prompt: string): Promise<TaskResult> {
    const start = Date.now();
    const route: Route = node.route;

    try {
      const output =
        route === 'local'
          ? await this.options.text.callLocal(prompt, node.model || 'qwen3:4b')
          : await this.options.text.callCloud(prompt);

      return {
        nodeId: node.id,
        route,
        model: node.model || (route === 'local' ? 'local' : 'cloud'),
        output,
        ok: Boolean(output.trim()),
        elapsedS: (Date.now() - start) / 1000,
        error: '',
        estimatedTokens: estimateTokens(prompt) + estimateTokens(output),
      };
    } catch (error) {
      return {
        nodeId: node.id,
        route,
        model: node.model,
        output: '',
        ok: false,
        elapsedS: (Date.now() - start) / 1000,
        error: (error as Error).message,
        estimatedTokens: 0,
      };
    }
  }

  private async runToolNode(node: TaskNode, prompt: string): Promise<TaskResult> {
    const start = Date.now();

    const args: Record<string, unknown> = { ...node.toolArgs, prompt };
    if (node.tool === 'media_compose') args.source = prompt;
    if (node.tool === 'web_search') args.query = prompt;

    const result = await this.options.tools.call(node.tool, args);

    let text = result.text;
    if (!result.ok) {
      text = result.notConfigured
        ? `【该步骤未执行：能力未配置】\n${result.error}`
        : `【该步骤执行失败】\n${result.error}`;
    }

    return {
      nodeId: node.id,
      route: 'tool',
      model: `tool:${node.tool}`,
      output: text,
      ok: result.ok,
      elapsedS: (Date.now() - start) / 1000,
      error: result.error,
      estimatedTokens: 0,
    };
  }

  private async runMergeNode(
    node: TaskNode,
    graph: TaskGraph,
    outputs: Record<string, string>,
  ): Promise<TaskResult> {
    const start = Date.now();
    const prompt = buildMergePrompt(node, graph, outputs);

    if (prompt.length <= this.options.mergeInputLimit && node.route === 'local') {
      return {
        nodeId: node.id,
        route: 'local',
        model: 'deterministic_merge',
        output: deterministicMerge(node, graph, outputs),
        ok: true,
        elapsedS: (Date.now() - start) / 1000,
        error: '',
        estimatedTokens: 0,
      };
    }

    if (this.options.text.cloudConfigured()) {
      try {
        const output = await this.options.text.callCloud(prompt, { system: MERGE_SYSTEM });
        if (output.trim()) {
          return {
            nodeId: node.id,
            route: 'cloud',
            model: 'cloud-merge',
            output,
            ok: true,
            elapsedS: (Date.now() - start) / 1000,
            error: '',
            estimatedTokens: estimateTokens(prompt) + estimateTokens(output),
          };
        }
      } catch (error) {
        this.emit({
          kind: 'warning',
          at: Date.now(),
          nodeId: node.id,
          message: `云端合并失败，改用确定性合并：${(error as Error).message}`,
        });
      }
    }

    return {
      nodeId: node.id,
      route: 'local',
      model: 'deterministic_merge',
      output: deterministicMerge(node, graph, outputs),
      ok: true,
      elapsedS: (Date.now() - start) / 1000,
      error: '',
      estimatedTokens: 0,
    };
  }

  private async runNode(
    node: TaskNode,
    graph: TaskGraph,
    outputs: Record<string, string>,
  ): Promise<TaskResult> {
    const prompt = renderTemplate(node.prompt, outputs);

    this.emit({
      kind: 'node_start',
      at: Date.now(),
      nodeId: node.id,
      route: node.route,
      message: `${node.title}`,
    });

    if (node.route === 'tool') return this.runToolNode(node, prompt);
    if (node.kind === 'merge') return this.runMergeNode(node, graph, outputs);

    const result = await this.runTextNode(node, prompt);

    // 本地质量闸门 —— 不合格则升级云端重跑一次。
    if (result.ok && node.route === 'local' && this.options.enableQualityGate) {
      const verdict = checkOutputQuality(result.output, { minChars: this.options.minExpectedChars });
      if (!verdict.ok) {
        this.emit({
          kind: 'quality_fail',
          at: Date.now(),
          nodeId: node.id,
          message: `本地输出未通过质量闸门（${verdict.reason}）`,
        });

        if (this.options.allowEscalation && this.options.text.cloudConfigured()) {
          const start = Date.now();
          try {
            const output = await this.options.text.callCloud(prompt);
            if (output.trim()) {
              this.emit({
                kind: 'escalated',
                at: Date.now(),
                nodeId: node.id,
                message: '本地输出不合格，已升级云端重跑',
              });
              return {
                nodeId: node.id,
                route: 'cloud',
                model: 'cloud-escalated',
                output,
                ok: true,
                elapsedS: result.elapsedS + (Date.now() - start) / 1000,
                error: '',
                estimatedTokens: estimateTokens(prompt) + estimateTokens(output),
              };
            }
          } catch {
            /* 升级失败则保留本地结果 */
          }
        }
      }
    }

    return result;
  }

  // ---- 整图 ----

  async run(graph: TaskGraph): Promise<ExecutionReport> {
    const outputs: Record<string, string> = {};
    const results: TaskResult[] = [];
    const warnings = [...graph.warnings];
    let mergeStrategy = '';

    this.emit({ kind: 'plan', at: Date.now(), graph, message: `共 ${graph.nodes.length} 个节点` });

    const layers = computeLayers(graph);

    for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
      const layer = layers[layerIndex];

      this.emit({
        kind: 'layer_start',
        at: Date.now(),
        layerIndex: layerIndex + 1,
        layerTotal: layers.length,
        message: `第 ${layerIndex + 1}/${layers.length} 层，${layer.length} 个节点并行`,
      });

      // 层内并发，层数由信号量限制。
      const layerResults = await runWithConcurrency(
        layer,
        this.options.maxConcurrency,
        (node) => this.runNode(node, graph, outputs),
      );

      layer.forEach((node, index) => {
        const result = layerResults[index];
        outputs[node.id] = result.output;
        results.push(result);

        if (node.kind === 'merge') mergeStrategy = result.model || result.route;
        if (!result.ok) warnings.push(`节点 ${node.id}（${node.title}）失败：${result.error}`);

        this.emit({
          kind: result.ok ? 'node_done' : 'node_failed',
          at: Date.now(),
          nodeId: node.id,
          route: result.route,
          output: result.output,
          message: result.ok ? `${result.elapsedS.toFixed(2)}s` : result.error,
        });
      });
    }

    let finalText = '';
    for (const node of [...graph.nodes].reverse()) {
      if (node.kind === 'merge' && outputs[node.id]) {
        finalText = outputs[node.id];
        break;
      }
    }
    if (!finalText && results.length) finalText = results[results.length - 1].output;

    const localTokens = results.filter((r) => r.route === 'local').reduce((sum, r) => sum + r.estimatedTokens, 0);
    const cloudTokens = results.filter((r) => r.route === 'cloud').reduce((sum, r) => sum + r.estimatedTokens, 0);

    const report: ExecutionReport = {
      goal: graph.goal,
      finalText,
      tasks: results,
      localTokens,
      cloudTokens,
      savedTokens: localTokens,
      totalElapsedS: results.reduce((sum, r) => sum + r.elapsedS, 0),
      mergeStrategy,
      warnings,
    };

    this.emit({ kind: 'done', at: Date.now(), report, message: '执行完成' });

    return report;
  }
}

// ============================================================
// 并发工具
// ============================================================

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        // 单个节点失败不能拖垮整图。
        results[index] = {
          nodeId: 'unknown',
          route: 'cloud',
          model: '',
          output: '',
          ok: false,
          elapsedS: 0,
          error: (error as Error).message,
          estimatedTokens: 0,
        } as unknown as R;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    if (char >= '\u4e00' && char <= '\u9fff') cjk += 1;
  }
  return Math.round(cjk * 0.6 + (text.length - cjk) * 0.28) + 1;
}
