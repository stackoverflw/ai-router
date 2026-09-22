/**
 * 全应用共享类型契约。
 *
 * 这是渲染进程、preload 桥、主进程三方唯一的共同依赖：
 * 任何一方改动 IPC 数据形状，都必须先改这里。
 */

// ============================================================
// 路由
// ============================================================

/** 单个任务的执行位置。 */
export type Route = 'local' | 'cloud' | 'tool';

/** 任务节点类型。 */
export type NodeKind =
  | 'chat'
  | 'analysis'
  | 'code'
  | 'copy'
  | 'codec'
  | 'media'
  | 'info'
  | 'merge';

/** 输出模态。 */
export type Modality = 'text' | 'image' | 'video' | 'audio' | 'code' | 'file';

/** 一条可解释的路由证据。 */
export interface Signal {
  name: string;
  family: string;
  /** 正值推向云端，负值推向本地。 */
  weight: number;
  evidence: string;
}

/** 路由分析结果。 */
export interface RoutingAnalysis {
  complexity: number;
  reasoningDepth: number;
  outputScale: number;
  codeOrSystem: number;
  toolOrFile: number;
  localCapacityRisk: number;
  signals: Signal[];
  /** 信号加权总分，路由的实际判据。 */
  signalScore: number;
  hardCloud: boolean;
  hardCloudReason: string;
  clearlySimple: boolean;
}

/** 路由结论。 */
export interface RouteDecision {
  route: Route;
  confidence: number;
  reason: string;
  strategy: string;
  model: string;
  analysis: RoutingAnalysis;
}

// ============================================================
// 任务图
// ============================================================

export interface TaskNode {
  id: string;
  title: string;
  prompt: string;
  kind: NodeKind;
  modality: Modality;
  deps: string[];
  route: Route;
  model: string;
  confidence: number;
  strategy: string;
  pruneReasons: string[];
  tool: string;
  toolArgs: Record<string, unknown>;
}

export interface TaskGraph {
  goal: string;
  nodes: TaskNode[];
  planner: string;
  notes: string[];
  warnings: string[];
  layerSizes: number[];
  routeCounts: Record<Route, number>;
}

// ============================================================
// 执行
// ============================================================

export interface TaskResult {
  nodeId: string;
  route: Route;
  model: string;
  output: string;
  ok: boolean;
  elapsedS: number;
  error: string;
  estimatedTokens: number;
}

export interface ExecutionReport {
  goal: string;
  finalText: string;
  tasks: TaskResult[];
  localTokens: number;
  cloudTokens: number;
  savedTokens: number;
  totalElapsedS: number;
  mergeStrategy: string;
  warnings: string[];
}

/** 执行期事件，用于在界面上实时展示任务图进度。 */
export interface ExecutionEvent {
  kind:
    | 'plan'
    | 'layer_start'
    | 'node_start'
    | 'node_done'
    | 'node_failed'
    | 'quality_fail'
    | 'escalated'
    | 'warning'
    | 'done';
  at: number;
  nodeId?: string;
  message?: string;
  layerIndex?: number;
  layerTotal?: number;
  route?: Route;
  /** 该节点最终产出（done 事件带）。 */
  output?: string;
  graph?: TaskGraph;
  report?: ExecutionReport;
}

// ============================================================
// 模型
// ============================================================

export interface LocalModelInfo {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  family: string;
  /** 是否具备图像 / 视频 / 音频生成能力（文本模型一律 false）。 */
  mediaGeneration: boolean;
  contextWindow: number;
}

export interface LocalModelPreset {
  name: string;
  displayName: string;
  parameterSize: string;
  downloadSize: string;
  /** 需要的内存（GB），用于给用户提示。 */
  ramGb: number;
  description: string;
  tags: string[];
  /** 中文能力评级，用于推荐。 */
  chineseLevel: 'excellent' | 'good' | 'fair';
  recommended?: boolean;
}

export interface PullProgress {
  model: string;
  status: string;
  completedBytes: number;
  totalBytes: number;
  percent: number;
  done: boolean;
  error?: string;
}

// ============================================================
// 设置
// ============================================================

export interface CloudSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  mergeModel: string;
  temperature: number;
}

export interface AppSettings {
  cloud: CloudSettings;
  localModel: string;
  ollamaHost: string;
  /** 界面语言，目前仅支持 zh-CN。 */
  language: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  models: string[];
}

// ============================================================
// 会话
// ============================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** 这条回答的执行报告，用于在界面上展示路由与节省情况。 */
  report?: ExecutionReport;
  graph?: TaskGraph;
  error?: string;
  streaming?: boolean;
}

export interface ProviderStatus {
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  ollamaVersion: string;
  host: string;
  cloudConfigured: boolean;
  ffmpegAvailable: boolean;
  tools: Record<string, boolean>;
}

// ============================================================
// IPC 契约
// ============================================================

/** 渲染进程可调用的 API（由 preload 注入到 window.aiRouter）。 */
export interface AiRouterApi {
  // ---- 路由与执行 ----
  route(prompt: string): Promise<RouteDecision>;
  run(prompt: string): Promise<ExecutionReport>;

  /** 订阅执行事件，返回取消订阅函数。 */
  onExecutionEvent(handler: (event: ExecutionEvent) => void): () => void;

  // ---- 模型 ----
  listLocalModels(): Promise<LocalModelInfo[]>;
  listModelPresets(): Promise<LocalModelPreset[]>;

  /** 下载模型；返回取消函数。 */
  pullModel(name: string): Promise<{ started: boolean; error?: string }>;
  cancelPull(name: string): Promise<void>;
  deleteModel(name: string): Promise<{ ok: boolean; error?: string }>;
  onPullProgress(handler: (progress: PullProgress) => void): () => void;

  // ---- 提供商状态 ----
  providerStatus(): Promise<ProviderStatus>;

  // ---- Ollama 进程托管 ----
  startOllama(): Promise<{ ok: boolean; message: string }>;
  stopOllama(): Promise<{ ok: boolean; message: string }>;

  // ---- 设置 ----
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<{ ok: boolean; error?: string }>;
  testCloudConnection(cloud: CloudSettings): Promise<ConnectionTestResult>;

  // ---- 系统 ----
  openExternal(url: string): Promise<void>;
}

/** IPC 频道名。主进程与 preload 必须使用同一份常量。 */
export const IPC = {
  route: 'ai-router:route',
  run: 'ai-router:run',
  executionEvent: 'ai-router:execution-event',
  listLocalModels: 'ai-router:list-local-models',
  listModelPresets: 'ai-router:list-model-presets',
  pullModel: 'ai-router:pull-model',
  cancelPull: 'ai-router:cancel-pull',
  deleteModel: 'ai-router:delete-model',
  pullProgress: 'ai-router:pull-progress',
  providerStatus: 'ai-router:provider-status',
  startOllama: 'ai-router:start-ollama',
  stopOllama: 'ai-router:stop-ollama',
  getSettings: 'ai-router:get-settings',
  saveSettings: 'ai-router:save-settings',
  testCloudConnection: 'ai-router:test-cloud-connection',
  openExternal: 'ai-router:open-external',
} as const;
