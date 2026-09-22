/**
 * 路由内核（TypeScript 移植版）。
 *
 * 与 `ai_router/` 下的 Python 实现一一对应，并通过
 * `desktop/scripts/parity-check.mjs` 对 234 条评测集做逐条一致性校验，
 * 确保桌面端不需要 Python 运行时也能得到相同的路由结论。
 *
 * 移植时必须保留的两个"坑"（Python 版本踩过）：
 *
 * 1. **不要用 `字面量A(字面量B)` 形态的正则。** 在本机 Python 3.12 上，
 *    这种模式在中文文本上会静默匹配失败。JS 正则没有这个问题，
 *    但为保持一致的行为与可读性，这里统一用"先定位数字、再取窗口"的方式。
 * 2. **字符类与交替不能混用。** Python 版本曾把 `[生成视频制作视频]` 当成
 *    单字候选，导致几乎任何句子都被判成"要生成视频"。JS 里同样如此，
 *    所以媒体动词一律写成交替 `A|B|C`。
 */

// 本模块只负责特征提取与权重定义，因此不需要从 shared 引入类型。

// ============================================================
// 阈值（与 ai_router/config.py 的校准结果保持一致）
// ============================================================

export const THRESHOLDS = {
  /** 云端分数 <= 此值且有本地证据 → 本地 */
  localMax: 0.0,
  /** 云端分数 >= 此值 → 云端 */
  cloudMin: 0.5,
  /** 判断是否为"明显简单"时允许的正向证据上限 */
  simplePositiveLimit: 0.0,
};

// ============================================================
// 文本预处理
// ============================================================

export function normalise(text: string): string {
  return (text ?? '').toLowerCase().replace(/[\s\u3000]+/g, '');
}

/** 纯 ASCII 短词用词边界匹配，避免 "mv" 命中 "MVC"。 */
export function containsAny(text: string, words: readonly string[]): boolean {
  for (const word of words) {
    if (/^[a-z0-9]{1,6}$/.test(word)) {
      const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`);
      if (pattern.test(text)) return true;
    } else if (text.includes(word)) {
      return true;
    }
  }
  return false;
}

export function countAny(text: string, words: readonly string[]): number {
  return words.reduce((total, word) => total + (containsAny(text, [word]) ? 1 : 0), 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// 中文数字
// ============================================================

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const CN_UNITS: Record<string, number> = {
  十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000,
};

export function parseCnNumber(text: string): number {
  if (!text) return 0;

  let total = 0;
  let section = 0;
  let current = 0;

  for (const char of text) {
    if (char in CN_DIGITS) {
      current = CN_DIGITS[char];
    } else if (char in CN_UNITS) {
      const unit = CN_UNITS[char];
      if (unit >= 10000) {
        section = (section + current) * unit;
        total += section;
        section = 0;
      } else {
        section += (current || 1) * unit;
      }
      current = 0;
    } else {
      return 0;
    }
  }

  return total + section + current;
}

// ============================================================
// 输出规模
// ============================================================

const SCALE_MULTIPLIER: Record<string, number> = {
  字: 1, 字符: 1, 词: 1.5,
  页: 500, 章: 1500, 节: 800, 回: 1500, 集: 1200, 篇: 800,
  分钟: 220, 小时: 13200, 秒: 4,
};

const NUMBER_RE = /[0-9][0-9,.]*/g;
const CN_NUMBER_CHARS = '一二两三四五六七八九十百千万亿';
const MAGNITUDE_CHARS = '千万亿';

export interface ScaleResult {
  equivalent: number;
  matched: string;
}

/** 提取请求显式要求的输出规模（折算成"字"）。 */
export function extractOutputScale(text: string): ScaleResult {
  let best = 0;
  let matched = '';

  const consider = (value: number, unit: string, raw: string): void => {
    if (value <= 0) return;
    const equivalent = Math.round(value * (SCALE_MULTIPLIER[unit] ?? 1));
    if (equivalent > best) {
      best = equivalent;
      matched = raw;
    }
  };

  const scan = (start: number, end: number): void => {
    const window = text.slice(end, end + 10);

    let offset = 0;
    while (offset < window.length && (window[offset] === ' ' || window[offset] === '\u3000')) offset += 1;

    let magnitude = '';
    if (offset < window.length && MAGNITUDE_CHARS.includes(window[offset])) {
      magnitude = window[offset];
      offset += 1;
    }
    while (offset < window.length && (window[offset] === ' ' || window[offset] === '\u3000')) offset += 1;

    const rest = window.slice(offset);
    const unit = Object.keys(SCALE_MULTIPLIER)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => rest.startsWith(candidate));

    if (!unit) return;

    const raw = text.slice(start, end);
    let value: number;

    if (/^[0-9][0-9,.]*$/.test(raw)) {
      value = Number.parseFloat(raw.replace(/,/g, ''));
      if (!Number.isFinite(value)) return;
    } else {
      value = parseCnNumber(raw);
    }

    if (magnitude === '千') value *= 1000;
    else if (magnitude === '万') value *= 10000;
    else if (magnitude === '亿') value *= 100000000;

    consider(value, unit, raw + magnitude + unit);
  };

  for (const match of text.matchAll(NUMBER_RE)) {
    if (match.index !== undefined) scan(match.index, match.index + match[0].length);
  }

  const cnRunRe = new RegExp(`[${CN_NUMBER_CHARS}]+`, 'g');
  for (const match of text.matchAll(cnRunRe)) {
    if (match.index !== undefined) scan(match.index, match.index + match[0].length);
  }

  return { equivalent: best, matched };
}

// ============================================================
// 交付物数量
// ============================================================

const QUANTIFIERS = '个种套版条份篇张';
// 6 是实测下限："五个不同的营销方案"里名词在第 6 位。
const NOUN_WINDOW = 6;
const NOUN_FAR_WINDOW = 10;

/** 显式枚举动词：说明数量词修饰的是产出清单，而不是泛指修饰。 */
const ENUMERATION_VERBS = ['列出', '列举', '罗列', '分别给出', '分别提供', '各给', '各写'];

/**
 * 交付物名词。**顺序即优先级**：越靠前越可能是短语中心语。
 *
 * 刻意不收录"方法 / 技巧 / 措施"这类泛指词：
 * "给我三个避免拖延的小技巧"是**一条**请求，不是三份交付物；
 * "列出六种降低服务器成本的做法"才是六份。
 * 差别在动词（"列出" vs "给我"），靠名词表区分不了，因此模糊名词一律不收。
 */
const DELIVERABLE_NOUNS = [
  '方案', '思路', '角度', '路线', '方向', '选项', '备选',
  '文案', '版本', '做法', '策略', '素材', '变体', '渠道', '架构',
];

/** 找出"N 个方案 / 四种路线"这类交付物数量要求。 */
export function extractDeliverableCounts(text: string): number[] {
  const results: number[] = [];
  const length = text.length;
  // 距离上限取决于是否显式枚举："列出六种…的做法"可以放宽，
  // "给我三个避免拖延的小技巧"只能近距离匹配。
  const maxOffset = ENUMERATION_VERBS.some((verb) => text.includes(verb))
    ? NOUN_FAR_WINDOW
    : NOUN_WINDOW;

  const rankAt = (probe: number): number => {
    for (let rank = 0; rank < DELIVERABLE_NOUNS.length; rank += 1) {
      if (text.startsWith(DELIVERABLE_NOUNS[rank], probe)) return rank;
    }
    return -1;
  };

  const atRun = (start: number, end: number): void => {
    let index = end;
    if (index < length && QUANTIFIERS.includes(text[index])) index += 1;

    const raw = text.slice(start, end);
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : parseCnNumber(raw);
    if (value < 2) return;

    let bestRank: number | null = null;

    for (let offset = 0; offset < maxOffset; offset += 1) {
      const probe = index + offset;
      if (probe >= length) break;
      if ('，。；、！？：（）()[]{}'.includes(text[probe])) break;

      const rank = rankAt(probe);
      if (rank < 0) continue;

      if (bestRank === null || rank < bestRank) {
        bestRank = rank;
        if (bestRank === 0) break;
      }
    }

    if (bestRank !== null) results.push(value);
  };

  for (const match of text.matchAll(NUMBER_RE)) {
    if (match.index !== undefined) atRun(match.index, match.index + match[0].length);
  }

  const cnRunRe = new RegExp(`[${CN_NUMBER_CHARS}]+`, 'g');
  for (const match of text.matchAll(cnRunRe)) {
    if (match.index !== undefined) atRun(match.index, match.index + match[0].length);
  }

  return results;
}

// ============================================================
// 结构特征
// ============================================================

const ACTION_VERBS = [
  '生成', '创作', '设计', '实现', '开发', '编写', '写', '做', '画', '制作',
  '翻译', '总结', '摘要', '分析', '比较', '对比', '评估', '优化', '重构', '审查',
  '调研', '整理', '列出', '列举', '推导', '计算', '规划', '拆解', '转写', '配音',
  '剪辑', '合并', '输出', '导出', '解释', '介绍', '部署', '训练', '微调', '爬',
  '扫描', '遍历', '搭建', '构建', '改造',
  '分类', '归类', '统计', '汇总', '归纳', '提炼', '提取', '挖掘', '核对',
  '校对', '校验', '验证', '排查', '定位', '追踪', '复盘', '盘点', '归档',
  '清洗', '建模', '改写', '润色', '扩写', '缩写', '精简', '排版', '制表',
  '检索', '查阅', '访谈', '测试', '压测', '监控', '接入', '迁移', '拆分',
];

const CONSTRAINT_MARKERS = [
  '必须', '需要', '不要', '不能', '禁止', '要求', '限制', '保证', '确保',
  '至少', '不超过', '符合', '满足',
];

export function countActionVerbs(text: string): number {
  return ACTION_VERBS.reduce((total, verb) => total + (text.includes(verb) ? 1 : 0), 0);
}

export function countClauses(text: string): number {
  return text
    .split(/[，,；;。！!？?\n]+/)
    .filter((part) => part.trim().length >= 6).length;
}

export function countConstraints(text: string): number {
  return countAny(text, CONSTRAINT_MARKERS);
}

// ============================================================
// 媒体意图
// ============================================================

/**
 * 媒体生成短语（强证据）。
 * 必须写成交替而不是字符类：字符类会把"生成视频"拆成单字候选，
 * 导致几乎任何句子都被判成视频任务。
 */
const STRONG_MEDIA_PHRASES: Record<string, string[]> = {
  video: [
    '生成视频', '制作视频', '做视频', '做个视频', '剪个视频', '剪一个视频',
    '生成一个视频', '生成一段视频', '制作一段视频', '做个短片', '剪个短片',
    '生成动画', '动画化', '生成mv', '做个mv', '做个动画', '生成一段动画',
  ],
  image: [
    '生成图片', '生成图像', '生成一张图', '画一张', '画一个', '画个',
    '出图', '生图', '作图', '生成插画', '生成海报', '画一幅', '生成立绘',
    '生成头像', '画张',
  ],
  audio: [
    '语音合成', '配音', '生成旁白', '朗读出来', '读出来',
    '生成音乐', '生成歌曲', '生成语音', '生成一段音频',
  ],
};

const MEDIA_NOUNS: Record<string, string[]> = {
  video: ['视频', '短片', '动画', '微电影', '宣传片'],
  image: ['图片', '图像', '插画', '海报', '立绘', '配图'],
  audio: ['语音', '配音', '音频', '朗读', '音乐', '歌曲', '旁白'],
};

const GEN_VERBS = ['生成', '制作', '做', '剪', '合成', '输出', '搞', '扣'];

/** 识别请求是否要求生成媒体，返回 video / image / audio 或空串。 */
export function detectMediaModality(userInput: string): string {
  const text = normalise(userInput);

  for (const intent of ['video', 'image', 'audio']) {
    if (STRONG_MEDIA_PHRASES[intent].some((phrase) => text.includes(phrase))) return intent;
  }

  for (const intent of ['video', 'image', 'audio']) {
    for (const noun of MEDIA_NOUNS[intent]) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(noun, from);
        if (at < 0) break;
        const window = text.slice(Math.max(0, at - 24), at + noun.length);
        if (GEN_VERBS.some((verb) => window.includes(verb))) return intent;
        from = at + noun.length;
      }
    }
  }

  return '';
}

// ============================================================
// 信号权重
// ============================================================

export const WEIGHTS: Record<string, number> = {
  // 本地友好（负）
  very_short_request: -2.4,
  short_request: -1.2,
  single_clause: -1.0,
  short_explicit_answer_expected: -1.4,
  known_local_skill: -2.6,
  local_skill_neutralised: 1.6,
  short_attached_material: -0.9,
  single_point_skill: -2.0,
  // 输出规模
  medium_output_scale: 1.6,
  large_output_scale: 4.5,
  huge_output_scale: 7.5,
  // 上下文规模
  long_prompt: 1.6,
  very_long_prompt: 3.2,
  attached_material: 2.0,
  huge_attached_material: 3.0,
  // 交付物
  multiple_deliverables: 1.6,
  many_deliverables: 2.6,
  numbered_plan: 1.4,
  // 复合
  compound_actions: 2.2,
  many_actions: 3.2,
  multi_clause_task: 1.0,
  constraint_density: 1.8,
  // 领域：工程
  software_engineering_scale: 4.6,
  system_architecture: 4.0,
  distributed_scale: 3.4,
  model_training: 5.0,
  data_pipeline_scale: 3.8,
  security_audit: 3.0,
  // 领域：研究
  deep_research: 3.6,
  deep_reasoning: 3.0,
  rigorous_analysis: 2.4,
  math_with_precision: 3.2,
  high_stakes_domain: 8.0,
  // 领域：创意 / 媒体
  media_generation: 6.5,
  open_ended_invention: 3.0,
  long_form_creative: 5.0,
  // 外部
  realtime_info: 4.5,
  file_system_operation: 3.2,
  tool_invocation: 3.0,
  // 语言 / 风险
  non_chinese_heavy: 0.6,
  reliability_critical: 2.6,
  truthfulness_critical: 2.2,
};
