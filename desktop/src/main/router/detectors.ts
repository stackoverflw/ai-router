/**
 * 信号检测器：与 `ai_router/signals.py` 一一对应。
 *
 * 每个检测器只回答一个具体的、可验证的问题，并给出可读证据。
 * 符号约定：**负权重推向本地，正权重推向云端。**
 */

import {
  WEIGHTS,
  containsAny,
  countActionVerbs,
  countClauses,
  countConstraints,
  extractDeliverableCounts,
  extractOutputScale,
  normalise,
} from './signals.js';
import type { Signal } from '../../shared/types.js';

export type Detector = (text: string, raw: string) => Signal[];

const signal = (name: string, family: string, weight: number, evidence: string): Signal => ({
  name,
  family,
  weight,
  evidence,
});

// ============================================================
// 本地强项技能
// ============================================================

export const LOCAL_SKILLS: Array<{ skill: string; patterns: string[]; reason: string }> = [
  {
    skill: 'translation',
    patterns: ['翻译', '译成', '翻成', 'translate', '帮我译'],
    reason: '翻译是本地小模型的稳定能力',
  },
  {
    skill: 'definition',
    patterns: ['什么是', '是什么意思', '是什么', '定义', '介绍一下', '概念'],
    reason: '名词解释 / 概念定义属基础问答',
  },
  {
    skill: 'simple_explain',
    patterns: ['解释一下', '简单解释', '通俗解释', '举个例子', '什么意思', '怎么用'],
    reason: '要求通俗解释，不需要系统方案',
  },
  {
    skill: 'unit_conversion',
    patterns: ['换算', '转换成摄氏', '转换成华氏', '等于多少', '折合', 'convert'],
    reason: '单位换算属确定性单点问题',
  },
  {
    skill: 'greeting_chitchat',
    patterns: ['你好', '您好', 'hi', 'hello', '在吗', '谢谢', '你是谁', '早上好', '晚上好'],
    reason: '寒暄 / 闲聊无实质计算量',
  },
  {
    skill: 'short_writing',
    patterns: [
      '写一段', '写一句', '写个笑话', '起个名字', '取个名字', '写个标题',
      '写一封邮件', '写邮件', '润色', '改写成', '改写一下', '列个清单', '列一个清单',
      '写个总结', '写一条', '写个祝福', '写个朋友圈', 'slogan', '标语',
    ],
    reason: '短文案创作属本地能力范围',
  },
  {
    skill: 'basic_script',
    patterns: [
      'hello world', '冒泡', '排序函数', '写一个函数', '写个函数',
      '写一个python', '写个python', '写一个脚本', '写个脚本', '小脚本',
      '读取文件', '读取一个文件', '字典', '列表去重', '九九乘法表', '斐波那契',
      '正则', '写一个正则', '正则表达式', '写个sql', '写一个sql', '写个函数',
    ],
    reason: '单文件小片段编程属本地能力范围',
  },
  {
    skill: 'summarise_short',
    patterns: [
      '总结一下这段', '总结这段', '概括一下下面', '提炼要点', '提取关键词',
      '提取摘要', '摘要一下', '总结一下下面', '概括一下这', '起个标题',
    ],
    reason: '对短文本做摘要，本地可承担',
  },
  {
    skill: 'everyday_consult',
    patterns: [
      '怎么办', '怎么处理', '有什么技巧', '给点建议', '有什么建议', '推荐几', '推荐三个',
      '推荐五', '有什么好吃', '怎么选', '哪个好', '怎么写', '怎么做', '怎么拒绝',
      '怎么安排', '推荐一下', '有没有', '可以吗', '多少小时', '还剩多少',
    ],
    reason: '日常生活咨询属单点请求，本地足够',
  },
  {
    skill: 'personal_planning',
    patterns: [
      '个人', '我的', '一周', '三人份', '作息', '菜单', '礼物', '清单', '习惯',
      '晨间', '番茄钟', '自我介绍', '面试',
    ],
    reason: '个人事务安排，无系统级复杂度',
  },
  {
    skill: 'software_howto',
    patterns: [
      'git ', 'docker ', 'linux', 'shell', 'bash', '命令行', 'ffmpeg', 'sed ', 'awk',
      'vim', 'ssh', 'nginx', 'mysql', 'redis', 'npm', 'pip ', 'conda', 'cmake',
      'git怎么', 'docker怎么',
    ],
    reason: '单条工具命令 / 开发操作是本地强项',
  },
  {
    skill: 'note_writing',
    patterns: ['便签', '提醒我', '记一下', '帮我记', '待办', 'to-do', 'todo'],
    reason: '便签 / 待办属极短产出',
  },
];

const DEFINITION_EXCLUSIONS = [
  '赛程', '比分', '航班', '股价', '汇率', '天气', '报价', '价格', '热搜', '新闻',
];

export function matchLocalSkills(userInput: string): Array<{ skill: string; reason: string }> {
  const text = normalise(userInput);
  const hits: Array<{ skill: string; reason: string }> = [];

  for (const entry of LOCAL_SKILLS) {
    if (!containsAny(text, entry.patterns)) continue;
    if (entry.skill === 'definition' && containsAny(text, DEFINITION_EXCLUSIONS)) continue;
    hits.push({ skill: entry.skill, reason: entry.reason });
  }

  return hits;
}

// ============================================================
// 检测器
// ============================================================

export const DETECTORS: Detector[] = [
  // ---- 长度 ----
  (text) => {
    const length = text.length;
    if (length <= 18) {
      return [signal('very_short_request', 'length', WEIGHTS.very_short_request, `请求仅 ${length} 字，属极短单点请求`)];
    }
    if (length <= 40) {
      return [signal('short_request', 'length', WEIGHTS.short_request, `请求 ${length} 字，属短请求`)];
    }
    return [];
  },

  // ---- 单句 ----
  (text, raw) => {
    if (countClauses(raw) <= 1 && text.length <= 70) {
      return [signal('single_clause', 'structure', WEIGHTS.single_clause, '单句诉求，无并列子任务')];
    }
    return [];
  },

  // ---- 明确要短回答 ----
  (text) => {
    if (
      containsAny(text, ['一句话', '一句', '简短回答', '简单说', '用一句话', '短一点', '只回答', '直接回答', '不用解释', '简明', '简洁']) ||
      containsAny(text, ['翻译成中文', '翻译成英文', '译成中文', '译成英文', '翻成中文', '翻成英文', 'translate'])
    ) {
      return [signal('short_explicit_answer_expected', 'structure', WEIGHTS.short_explicit_answer_expected, '用户明确期望简短输出')];
    }
    return [];
  },

  // ---- 短材料 ----
  (text, raw) => {
    if (raw.length <= 800 && containsAny(text, ['如下', '以下', '这段', '下面这段', '帮我改', '帮我翻译'])) {
      return [signal('short_attached_material', 'length', WEIGHTS.short_attached_material, '附带材料较短，本地上下文可容纳')];
    }
    return [];
  },

  // ---- 输出规模 ----
  (text, raw) => {
    const { equivalent, matched } = extractOutputScale(raw);
    if (equivalent >= 40000) {
      return [signal('huge_output_scale', 'output_scale', WEIGHTS.huge_output_scale, `要求输出约 ${equivalent} 字规模（${matched}），本地无法一次性完成`)];
    }
    if (equivalent >= 4000) {
      return [signal('large_output_scale', 'output_scale', WEIGHTS.large_output_scale, `要求输出约 ${equivalent} 字规模（${matched}）`)];
    }
    if (equivalent >= 1800) {
      return [signal('medium_output_scale', 'output_scale', WEIGHTS.medium_output_scale, `要求输出约 ${equivalent} 字规模（${matched}）`)];
    }

    // 没有具体数字但规模明确的表达（"长篇小说""白皮书"）。
    // 这一段曾经在移植时漏掉，导致长格式请求的分数被低估——保留注释以防再次丢失。
    if (containsAny(text, ['长篇小说', '长篇', '连载', '百万字', '万字', '完整论文', '完整小说', '白皮书', '系列文章', '整套'])) {
      return [signal('large_output_scale', 'output_scale', WEIGHTS.large_output_scale, '要求长格式 / 超长内容输出')];
    }

    return [];
  },

  // ---- 输入长度 ----
  (_text, raw) => {
    if (raw.length >= 6000) {
      return [signal('very_long_prompt', 'context_scale', WEIGHTS.very_long_prompt, `输入约 ${raw.length} 字符，需要大上下文窗口`)];
    }
    if (raw.length >= 1200) {
      return [signal('long_prompt', 'context_scale', WEIGHTS.long_prompt, `输入约 ${raw.length} 字符`)];
    }
    return [];
  },

  // ---- 附加材料 ----
  (text, raw) => {
    if (!containsAny(text, ['这份', '这段', '这个文件', '这批', '这些', '以上', '如下', '附件', '全文', '源码', '日志', '数据集', '聊天记录', '整个'])) {
      return [];
    }
    if (raw.length >= 4000) {
      return [signal('huge_attached_material', 'context_scale', WEIGHTS.huge_attached_material, '需处理超大段附加材料')];
    }
    if (raw.length >= 800) {
      return [signal('attached_material', 'context_scale', WEIGHTS.attached_material, '需处理较长附加材料')];
    }
    return [];
  },

  // ---- 交付物数量 ----
  (_text, raw) => {
    const out: Signal[] = [];
    for (const count of extractDeliverableCounts(raw)) {
      if (count >= 4) {
        out.push(signal('many_deliverables', 'deliverables', WEIGHTS.many_deliverables, `要求 ${count} 个不同产出，需系统性展开`));
      } else if (count >= 2) {
        out.push(signal('multiple_deliverables', 'deliverables', WEIGHTS.multiple_deliverables, `要求 ${count} 个不同产出`));
      }
      break;
    }
    const numbered = (raw.match(/(?:^|\n)\s*(?:[0-9]{1,2}[.)、]|[（(][0-9]{1,2}[）)])/g) ?? []).length;
    if (numbered >= 5) {
      out.push(signal('numbered_plan', 'structure', WEIGHTS.numbered_plan, '用户已列出多项编号子任务'));
    }
    return out;
  },

  // ---- 复合任务 ----
  (text, raw) => {
    const out: Signal[] = [];
    const actions = countActionVerbs(text);
    const clauses = countClauses(raw);
    const smallScale = containsAny(text, ['简单', '简单点', '小', '一小段', '短一点', '极简', '一句话', '简略', '大致']);

    if (actions >= 4) {
      out.push(signal('many_actions', 'compound', WEIGHTS.many_actions, `请求包含约 ${actions} 类不同动作，需多步编排`));
    } else if (actions >= 3 && !smallScale) {
      out.push(signal('compound_actions', 'compound', WEIGHTS.compound_actions, `请求包含约 ${actions} 类不同动作`));
    } else if (actions >= 2 && clauses >= 3 && !smallScale) {
      out.push(signal('compound_actions', 'compound', WEIGHTS.compound_actions, `请求包含约 ${actions} 类动作、${clauses} 个并列小句`));
    } else if (clauses >= 4) {
      out.push(signal('multi_clause_task', 'compound', WEIGHTS.multi_clause_task, `请求含 ${clauses} 个并列小句`));
    }

    if ((raw.match(/、/g) ?? []).length >= 3) {
      out.push(signal('compound_actions', 'compound', WEIGHTS.compound_actions, '请求以枚举方式列出多项必须交付的内容'));
    }

    if (countConstraints(text) >= 4) {
      out.push(signal('constraint_density', 'compound', WEIGHTS.constraint_density, '含多处并存的硬性约束，需权衡取舍'));
    }

    return out;
  },

  // ---- 工程规模 ----
  (text) => {
    if (
      containsAny(text, [
        '整个项目', '完整项目', '大型项目', '大型代码库', '多模块', '全栈',
        '整个仓库', '整个代码库', '生产级', '企业级', '重构整个', '源码分析',
        '完整系统', '整个系统', '全部源代码', '整个代码', '完整的多',
        '多商家', '多租户', '遗留', '可发布的库', '打包和ci', '打包与ci', '发布流程', '重构',
      ]) ||
      (containsAny(text, ['开发', '重构', '搭建', '构建', '改造']) &&
        containsAny(text, ['后台', '管理系统', '平台', '服务', '模块', '项目', '库']))
    ) {
      return [signal('software_engineering_scale', 'domain_engineering', WEIGHTS.software_engineering_scale, '任务规模达到多模块 / 生产级工程级别')];
    }
    return [];
  },

  // ---- 系统架构 ----
  (text) => {
    if (containsAny(text, ['架构', '系统设计', '技术方案', '平台设计', '中台', '技术选型', '顶层设计'])) {
      return [signal('system_architecture', 'domain_engineering', WEIGHTS.system_architecture, '要求系统 / 架构级方案设计')];
    }
    if (containsAny(text, ['设计', '方案', '搭建', '构建']) &&
        containsAny(text, ['系统', '平台', '服务', '框架', '引擎', '中台'])) {
      return [signal('system_architecture', 'domain_engineering', WEIGHTS.system_architecture, '要求设计一个系统 / 平台级方案')];
    }
    return [];
  },

  // ---- 分布式规模 ----
  (text) => {
    if (containsAny(text, ['分布式', '微服务', '高并发', '高可用', '容灾', '负载均衡', '集群', '分库分表', '横向扩展', '异地多活', '服务网格', 'k8s', 'kubernetes', '消息队列', 'kafka'])) {
      return [signal('distributed_scale', 'domain_engineering', WEIGHTS.distributed_scale, '涉及分布式 / 高并发工程约束')];
    }
    if (/(百万|千万|亿|十万|上万|百万级|千万级|亿级)(用户|并发|请求|qps|tps|条|级)/.test(text)) {
      return [signal('distributed_scale', 'domain_engineering', WEIGHTS.distributed_scale, '涉及百万级以上规模指标')];
    }
    return [];
  },

  // ---- 模型训练 ----
  (text) => {
    if (containsAny(text, ['训练一个', '训练模型', '训练ai', '训练人工智能', '训练大模型', '训练语言模型', '模型训练', '微调', 'finetune', 'fine-tune', 'fine tune', '预训练', 'lora', 'qlora', '蒸馏', 'rlhf', 'dpo', '分布式训练', '多gpu', 'megatron', 'deepspeed'])) {
      return [signal('model_training', 'domain_ai', WEIGHTS.model_training, '涉及模型训练 / 微调，需要数据与算力方案')];
    }
    return [];
  },

  // ---- 数据管道 ----
  (text) => {
    if (containsAny(text, ['爬虫', '爬取', '抓取', '批量下载', 'etl', '数据清洗', '数据管道', '流处理', '批处理', '归档', '导入到', '导出到', '数据导入', '建立索引', '建索引'])) {
      return [signal('data_pipeline_scale', 'domain_data', WEIGHTS.data_pipeline_scale, '要求构建数据处理管道')];
    }
    if (containsAny(text, ['遍历', '扫描', '全盘', '整个硬盘', '所有文件']) ||
        /\d+(?:\.\d+)?(?:tb|gb|pb)/.test(text) ||
        containsAny(text, ['tb级', '海量数据', '百万文件', '千万条', '百万行', '万行'])) {
      return [signal('data_pipeline_scale', 'domain_data', WEIGHTS.data_pipeline_scale, '要求遍历 / 处理大规模数据')];
    }
    return [];
  },

  // ---- 安全审计 ----
  (text) => {
    if (containsAny(text, ['安全审计', '渗透测试', '漏洞扫描', '等保', '合规审计', '代码审计', '安全评估', '风控', '权限模型', '越权', '依赖风险', '漏洞', '加固', '密钥管理']) ||
        (containsAny(text, ['审查', '审计', '评估']) && containsAny(text, ['风险', '安全', '权限', '越权', '隐私']))) {
      return [signal('security_audit', 'domain_engineering', WEIGHTS.security_audit, '安全 / 审计类任务要求高可靠性')];
    }
    return [];
  },

  // ---- 调研 ----
  (text) => {
    if (containsAny(text, ['调研', '综述', '文献', '行业分析', '市场分析', '竞品分析', '商业计划', '可行性研究', '投资分析', '研究报告', '白皮书', '写一篇论文', '学术', '格局', '趋势分析', '市场格局', '竞争格局', '赛道'])) {
      return [signal('deep_research', 'domain_research', WEIGHTS.deep_research, '要求调研 / 综述级深度内容')];
    }
    return [];
  },

  // ---- 深度推理 ----
  (text) => {
    if (containsAny(text, ['证明', '推导', '反证', '归谬', '逻辑链', '根因', '因果链', '多步推理', '数学建模', '演绎', '归纳推理', '严谨证明', '逻辑谜题', '推理链', '唯一解', '线性规划', '动态规划', '最优化', '博弈论', '形式化'])) {
      return [signal('deep_reasoning', 'domain_reasoning', WEIGHTS.deep_reasoning, '要求形式化 / 长链推理')];
    }
    return [];
  },

  // ---- 严谨分析 ----
  (text) => {
    if (
      containsAny(text, ['深入分析', '深度分析', '全面分析', '系统分析', '多维度', '多角度', '严谨分析', '详细分析', '专业分析', '批判性', '权衡', '取舍', '利弊', '优劣对比', '深度剖析', '复盘']) ||
      (containsAny(text, ['深入', '深度', '全面', '系统性', '专业', '严谨']) &&
        containsAny(text, ['分析', '评估', '比较', '研究', '拆解', '梳理']))
    ) {
      return [signal('rigorous_analysis', 'domain_reasoning', WEIGHTS.rigorous_analysis, '要求深度 / 系统性的分析论证')];
    }
    return [];
  },

  // ---- 精确数学 ----
  (text) => {
    if (containsAny(text, ['精确计算', '准确计算', '积分', '微分', '极限', '矩阵运算', '解方程', '求导', '概率分布', '统计显著', '证明不等式', '蒙特卡洛'])) {
      return [signal('math_with_precision', 'domain_reasoning', WEIGHTS.math_with_precision, '要求精确数学推导 / 计算')];
    }
    return [];
  },

  // ---- 媒体生成 ----
  (text) => {
    if (containsAny(text, ['视频', '短片', '动画', 'mv', '剪一个', '剪辑一段', '生成图片', '画一张', '画一个', '出图', '生图', '作图', '海报', '插画', '立绘', '配音', '语音合成', '朗读', '读出来', 'tts', '音频', '配乐', '音乐', '歌曲', '唱一段'])) {
      return [signal('media_generation', 'domain_media', WEIGHTS.media_generation, '涉及图片 / 视频 / 音频生成能力')];
    }
    return [];
  },

  // ---- 开放创意 ----
  (text) => {
    if (containsAny(text, ['造一个', '造一台', '造一辆', '造一艘', '发明', '从零设计', '从零构建', '从零搭建', '构想', '设想', '世界观', '设定集', '桌游', '动画企划', '剧本杀', '分镜', '企划'])) {
      return [signal('open_ended_invention', 'domain_creative', WEIGHTS.open_ended_invention, '开放式创意 / 发明设计，需要多部件与取舍论证')];
    }
    if (/(造|设计|构想|策划|搭建)\s*[一二两三四五六七八九十0-9]*\s*(个|台|辆|艘|套|款|种)/.test(text)) {
      const personal = containsAny(text, ['个人', '我的', '一份', '一周', '三分钟', '番茄钟', '菜单', '清单', '作息', '礼物', '名字', '计划', '表格']);
      if (!personal) {
        return [signal('open_ended_invention', 'domain_creative', WEIGHTS.open_ended_invention, '开放式设计任务，需要多部件与取舍论证')];
      }
    }
    return [];
  },

  // ---- 长格式创意 ----
  (text) => {
    if (containsAny(text, ['小说', '剧本', '故事集', '世界观', '连载', '长篇', '章节', '小说大纲', '推理小说', '科幻小说', '专栏', '系列文章', '每期一篇', '分集'])) {
      return [signal('long_form_creative', 'domain_creative', WEIGHTS.long_form_creative, '长格式创意写作')];
    }
    return [];
  },

  // ---- 实时信息 ----
  (text) => {
    const freshness =
      containsAny(text, ['今天', '现在', '最新', '实时', '当前', '昨天', '本周', '本月', '今年', '刚刚', '近期', '最近的', '这几天', '这周末', '下周', '最近']) ||
      /最近[一二三四五六七八九十0-9]+(天|周|个月|年)/.test(text);
    const query = containsAny(text, ['股价', '汇率', '天气', '新闻', '比分', '赛程', '航班', '快递', '热搜', '报价', '价格', '多少钱', '查一下', '查询', '帮我查', '状况', '情况怎么样', '行情']);

    if (freshness && query) {
      return [signal('realtime_info', 'external', WEIGHTS.realtime_info, '需要实时 / 外部事实，本地模型无法提供')];
    }
    if (containsAny(text, ['主流', '市面', '市场']) && containsAny(text, ['报价', '价格', '行情', '多少钱'])) {
      return [signal('realtime_info', 'external', WEIGHTS.realtime_info, '询问当下市场行情，本地模型无法提供')];
    }
    return [];
  },

  // ---- 文件 / 设备操作 ----
  (text, raw) => {
    if (
      containsAny(text, ['删除文件', '重命名', '移动文件', '复制到', '整理文件夹', '批量修改文件名', '打开文件', '保存到', '导出到', '执行命令', '运行命令', 'shell', 'powershell', '定时任务', '守护进程', '部署到服务器', '上传到', '控制机械臂', '控制设备']) ||
      /[a-z]:\\/i.test(raw)
    ) {
      return [signal('file_system_operation', 'external', WEIGHTS.file_system_operation, '需要真实文件 / 设备操作能力')];
    }
    return [];
  },

  // ---- 工具 / 接口调用 ----
  (text) => {
    if (
      containsAny(text, ['调用接口', '调用api', '调api', '接入api', '对接接口', 'webhook', '调用第三方', '使用插件', '调用工具', '定时执行', '调用我们', '调用内部', '内部接口', '业务接口', '批量更新', '批量写入', '批量提交']) ||
      (containsAny(text, ['调用', '接入', '对接', '集成']) && containsAny(text, ['接口', 'api', '系统', '服务', '库存', '订单']))
    ) {
      return [signal('tool_invocation', 'external', WEIGHTS.tool_invocation, '要求调用外部工具 / 接口')];
    }
    return [];
  },

  // ---- 语言 ----
  (_text, raw) => {
    const cjk = Array.from(raw).filter((char) => char >= '\u4e00' && char <= '\u9fff').length;
    if (raw.length >= 200 && cjk / Math.max(1, raw.length) < 0.15) {
      return [signal('non_chinese_heavy', 'language', WEIGHTS.non_chinese_heavy, '请求以非中文为主，需较强多语言能力')];
    }
    return [];
  },

  // ---- 高可靠性 ----
  (text) => {
    if (containsAny(text, ['生产环境', '不能出错', '必须准确', '零容错', '要上线', '直接影响', '合规要求', '法律意见', '医疗建议', '投资建议', '诊断', '用药'])) {
      return [signal('reliability_critical', 'risk', WEIGHTS.reliability_critical, '要求高可靠性 / 零容错，风险超出本地小模型')];
    }
    return [];
  },

  // ---- 事实准确性 ----
  (text) => {
    if (
      containsAny(text, ['引用出处', '参考文献', 'citation', '给出出处', '来源链接', '引用规范', '原文出处', '数据来源']) ||
      (containsAny(text, ['事实', '历史', '法律条文', '条款', '政策', '规定']) && containsAny(text, ['准确', '核实', '查证', '完整列出', '逐条']))
    ) {
      return [signal('truthfulness_critical', 'risk', WEIGHTS.truthfulness_critical, '要求可溯源的事实准确性')];
    }
    return [];
  },
];

// ============================================================
// 高风险领域
// ============================================================

export const HIGH_STAKES_MARKERS = [
  '体检报告', '诊断', '用药', '吃什么药', '病情', '症状', '医嘱', '健康建议',
  '起诉状', '诉讼', '法律意见', '合同条款', '合同', '合规意见', '判例', '条款', '协议',
  '投资建议', '资产配置', '理财建议', '风险评估', '投资', '基金', '股票',
  '生产环境变更', '上线方案', '安全审计', '渗透测试',
];

DETECTORS.push((text) => {
  if (containsAny(text, HIGH_STAKES_MARKERS)) {
    return [signal('high_stakes_domain', 'risk', WEIGHTS.high_stakes_domain, '属于医疗 / 法律 / 投资 / 生产等高风险领域')];
  }
  return [];
});

export function collectSignals(userInput: string): Signal[] {
  const raw = userInput ?? '';
  const text = normalise(raw);
  return DETECTORS.flatMap((detector) => detector(text, raw));
}
