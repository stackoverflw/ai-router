"""可解释的本地 / 云端任务路由器。

核心设计：

用户任务
    ↓
硬约束检查
    ↓
Cross-Encoder 语义任务判定
    ↓
Embedding 降级 / 规则兜底
    ↓
LOCAL / CLOUD
    ↓
真正调用对应模型
"""

from dataclasses import dataclass
import re
import sys
import time

import requests

from cloud_provider import ask_cloud
from semantic_task_judge import SemanticTaskJudge


# ============================================================
# 基础配置
# ============================================================

OLLAMA_URL = "http://localhost:11434/api/generate"

# 真正负责回答 LOCAL 任务的模型
LOCAL_MODEL = "qwen2.5:0.5b"

# 语义模型在第一次使用时才加载，首次下载失败也不会使 Router 崩溃。
SEMANTIC_JUDGE = SemanticTaskJudge()


# ============================================================
# 路由分析结果
# ============================================================

@dataclass
class RoutingAnalysis:
    """保存一次任务分析结果，方便解释为什么这么路由。"""

    complexity: int = 0
    reasoning_depth: int = 0
    output_scale: int = 0
    code_or_system: int = 0
    tool_or_file: int = 0
    local_capacity_risk: int = 0

    # 明显简单任务
    simple_task: bool = False

    # 明显应该走云端
    hard_cloud_task: bool = False

    # 命中的特征
    matched_features: tuple[str, ...] = ()

    @property
    def cloud_score(self):
        """综合分数。

        分数越高，说明越不适合交给本地小模型。
        """

        return (
            self.complexity
            + self.reasoning_depth
            + self.output_scale
            + self.code_or_system
            + self.tool_or_file
            + self.local_capacity_risk
        )


# ============================================================
# 工具函数
# ============================================================

def contains_any(text, words):
    """判断文本是否包含任意关键词。"""

    return any(word in text for word in words)


def has_large_length_request(text):
    """
    判断是否明确要求很大的输出。

    例如：

    800字
    5000字
    10000字
    10万字

    普通“写一篇作文”不会命中。
    """

    return bool(
        re.search(
            r"(?:[1-9]\d{3,}|[一二三四五六七八九十百千万]+)\s*(?:字|词|章)",
            text
        )
    )


# ============================================================
# 任务分析
# ============================================================

def analyze_task(user_input):
    """
    根据任务本身分析复杂度。

    注意：

    这里不让一个小模型直接决定 LOCAL / CLOUD。

    先使用确定性的特征分析。
    """

    # 去掉空格，方便匹配
    text = user_input.lower().replace(" ", "")

    matched = []

    result = RoutingAnalysis()

    # ========================================================
    # 1. 明显简单任务
    # ========================================================

    simple_translation = contains_any(
        text,
        [
            "翻译",
            "译成",
            "翻成",
        ]
    )

    simple_explanation = contains_any(
        text,
        [
            "什么意思",
            "是什么意思",
            "是什么",
            "解释一下",
            "简单解释",
            "通俗解释",
            "介绍一下",
        ]
    )

    simple_writing = contains_any(
        text,
        [
            "写一篇作文",
            "写作文",
            "写个作文",
            "写一篇短文",
            "写一段话",
            "写一封邮件",
            "写邮件",
            "润色",
        ]
    )

    simple_code = (
        contains_any(
            text,
            [
                "python",
                "代码",
                "函数",
                "脚本",
            ]
        )
        and contains_any(
            text,
            [
                "简单",
                "示例",
                "入门",
                "hello world",
                "小程序",
            ]
        )
    )

    result.simple_task = (
        simple_translation
        or simple_explanation
        or simple_writing
        or simple_code
    )

    if result.simple_task:
        matched.append("明显简单任务")

    # ========================================================
    # 2. AI / 模型训练
    # ========================================================

    # 这是你刚才测试暴露出来的重要问题。
    #
    # “训练一个 AI”
    # “训练一个模型”
    # “微调一个大模型”
    #
    # 输入虽然很短，但任务复杂度非常高。

    if contains_any(
        text,
        [
            "训练一个ai",
            "训练ai",
            "训练人工智能",
            "训练模型",
            "模型训练",
            "训练大模型",
            "训练语言模型",
            "微调模型",
            "微调大模型",
            "finetune",
            "fine-tune",
            "fine tune",
        ]
    ):
        result.complexity += 5
        result.reasoning_depth += 2
        result.code_or_system += 2

        matched.append("AI模型训练")

    # ========================================================
    # 3. 系统 / 架构 / 分布式
    # ========================================================

    if contains_any(
        text,
        [
            "分布式",
            "微服务",
            "高并发",
            "百万并发",
            "千万并发",
            "亿级",
            "架构设计",
            "系统设计",
            "系统架构",
            "分布式系统",
            "服务架构",
        ]
    ):
        result.complexity += 5
        result.code_or_system += 3

        matched.append("大规模系统或架构")

    # 普通“设计”
    if (
        contains_any(
            text,
            [
                "设计",
                "架构",
                "方案",
                "系统",
                "平台",
            ]
        )
        and not result.simple_task
    ):
        result.complexity += 2

        matched.append("设计型任务")

    # 复杂系统设计
    if (
        contains_any(
            text,
            [
                "复杂",
                "企业级",
                "生产级",
            ]
        )
        and contains_any(
            text,
            [
                "设计",
                "架构",
                "系统",
                "方案",
            ]
        )
    ):
        result.complexity += 3

        matched.append("复杂系统设计")

    # ========================================================
    # 3.5. 系统级 / AI Infra 任务
    # ========================================================

    # 这一类任务有一个特点：
    # 用户输入可能很短，但实际工作量很大。
    #
    # 例如：
    # “分析一个大型项目的全部源代码”
    # “设计一个大规模 AI 推理平台”
    #
    # 不能只看输入长度，而要看任务规模和系统性质。

    if contains_any(
        text,
        [
            "大型项目",
            "大规模项目",
            "完整项目",
            "整个项目",
            "全部源代码",
            "大型系统",
            "大规模系统",
            "推理平台",
            "训练平台",
            "ai平台",
            "模型服务平台",
            "推理服务",
            "模型部署",
            "模型服务",
            "inference",
            "serving",
            "aiinfra",
            "infra",
        ]
    ):
        result.complexity += 3
        result.code_or_system += 3

        matched.append("系统级/AI Infra")

    # ========================================================
    # 4. 深度推理
    # ========================================================

    if contains_any(
        text,
        [
            "复杂推理",
            "证明",
            "推导",
            "权衡",
            "根因",
            "根因分析",
            "多维分析",
            "严谨分析",
            "深入分析",
        ]
    ):
        result.reasoning_depth += 3

        matched.append("深度推理")

    if (
        contains_any(
            text,
            [
                "比较",
                "评估",
                "分析",
                "优化",
            ]
        )
        and not result.simple_task
    ):
        result.reasoning_depth += 1

        matched.append("分析或评估")

    # ========================================================
    # 5. 输出规模
    # ========================================================

    # 普通作文不算长输出风险。

    if contains_any(
        text,
        [
            "长篇小说",
            "完整小说",
            "长篇",
            "万字",
            "十万字",
            "百万字",
            "连载",
        ]
    ):
        result.output_scale += 4

        matched.append("超长内容")

    elif has_large_length_request(text):
        result.output_scale += 3

        matched.append("明确大篇幅")

    elif contains_any(
        text,
        [
            "详细报告",
            "完整论文",
            "白皮书",
        ]
    ):
        result.output_scale += 2

        matched.append("长格式文档")

    # ========================================================
    # 6. 代码 / 工程
    # ========================================================

    if contains_any(
        text,
        [
            "重构整个",
            "完整项目",
            "大型代码库",
            "多模块",
            "全栈",
            "生产级",
            "源码分析",
            "完整系统",
        ]
    ):
        result.code_or_system += 3

        matched.append("大型代码或工程")

    elif contains_any(
        text,
        [
            "复杂代码",
            "复杂算法",
            "性能优化",
            "并发程序",
        ]
    ):
        result.code_or_system += 3

        matched.append("复杂代码")

    elif (
        contains_any(
            text,
            [
                "代码",
                "python",
                "java",
                "接口",
                "数据库",
            ]
        )
        and not simple_code
    ):
        result.code_or_system += 1

        matched.append("一般编程任务")

    # ========================================================
    # 7. 工具 / 文件操作
    # ========================================================

    if contains_any(
        text,
        [
            "遍历",
            "扫描",
            "硬盘",
            "目录",
            "文件",
            "上传",
            "下载",
            "调用接口",
            "运行命令",
            "执行命令",
        ]
    ):
        result.tool_or_file += 3

        matched.append("工具或文件操作")

    if contains_any(
        text,
        [
            "1t",
            "1tb",
            "tb",
            "百万文件",
            "海量",
        ]
    ):
        result.tool_or_file += 2

        matched.append("大规模数据")

    # ========================================================
    # 8. 多步骤 / 可靠性
    # ========================================================

    if contains_any(
        text,
        [
            "多步骤",
            "一步一步",
            "先",
            "然后",
            "最后",
            "端到端",
            "完整流程",
        ]
    ):
        result.local_capacity_risk += 2

        matched.append("多步骤规划")

    if contains_any(
        text,
        [
            "必须准确",
            "不能出错",
            "生产环境",
            "安全审计",
        ]
    ):
        result.local_capacity_risk += 2

        matched.append("高可靠性要求")

    # ========================================================
    # 9. 最终确定性判断
    # ========================================================

    result.hard_cloud_task = (
        result.complexity >= 5
        or result.output_scale >= 4
        or result.code_or_system >= 3
        or result.tool_or_file >= 5
        or (
            result.tool_or_file >= 3
            and result.local_capacity_risk >= 2
        )
        or (
            result.reasoning_depth >= 3
            and result.complexity >= 2
        )
    )

    result.matched_features = tuple(
        dict.fromkeys(matched)
    )

    return result


# ============================================================
# Ollama
# ============================================================

def ask_ollama(prompt, model, timeout=120, num_predict=None):
    """
    调用 Ollama。

    Router 判断和本地回答都通过这里访问 Ollama。
    """

    options = {
        "temperature": 0,
    }

    if num_predict is not None:
        options["num_predict"] = num_predict

    data = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "keep_alive": -1,
        "options": options,
    }

    response = requests.post(
        OLLAMA_URL,
        json=data,
        timeout=timeout,
    )

    response.raise_for_status()

    return response.json()["response"].strip()


# ============================================================
# 日志
# ============================================================

def format_reason(
    analysis,
    strategy,
    semantic_decision=None,
    fallback_reason=None,
):
    """生成可读的路由日志。"""

    details = (
        ", ".join(analysis.matched_features)
        or "未命中强特征"
    )

    reason = (
        f"策略={strategy}；"
        f"云端分数={analysis.cloud_score}；"
        f"复杂度={analysis.complexity}，"
        f"推理={analysis.reasoning_depth}，"
        f"输出={analysis.output_scale}，"
        f"代码/系统={analysis.code_or_system}，"
        f"工具/文件={analysis.tool_or_file}，"
        f"本地能力风险={analysis.local_capacity_risk}；"
        f"命中={details}"
    )

    if semantic_decision is not None:
        reason += (
            f"；语义判定={semantic_decision.intent}"
            f"（复杂度={semantic_decision.complexity}，"
            f"推理需求={semantic_decision.reasoning_need}，"
            f"能力需求={semantic_decision.capability_need}，"
            f"建议={semantic_decision.recommendation.upper()}，"
            f"置信度={semantic_decision.confidence:.2f}，"
            f"后端={semantic_decision.backend}）"
        )

    if fallback_reason:
        reason += f"；兜底原因={fallback_reason}"

    return reason


# ============================================================
# Router
# ============================================================

def router(user_input):
    """
    Router 主入口。

    优先级：

    1. 规则硬约束（高风险、大规模任务）→ CLOUD
    2. Cross-Encoder 语义判定 → LOCAL / CLOUD
    3. Embedding 语义降级 → LOCAL / CLOUD
    4. 模型不可用时，规则兜底

    规则不再承担“理解任务类别”的职责；它只处理明确的风险信号。
    """

    start = time.perf_counter()

    analysis = analyze_task(user_input)

    # --------------------------------------------------------
    # 第一优先级：强制 CLOUD
    # --------------------------------------------------------

    if analysis.hard_cloud_task:

        route = "cloud"

        raw = format_reason(
            analysis,
            "复杂任务保护",
        )

    else:
        semantic_decision = SEMANTIC_JUDGE.classify(user_input)

        if semantic_decision is not None:
            route = semantic_decision.recommendation
            raw = format_reason(
                analysis,
                "语义任务判定",
                semantic_decision=semantic_decision,
            )
        elif analysis.simple_task and analysis.cloud_score <= 2:
            # 模型环境失效时仍能服务最明确的低风险请求。
            route = "local"
            raw = format_reason(
                analysis,
                "规则兜底：明显简单任务",
                fallback_reason=SEMANTIC_JUDGE.unavailable_reason,
            )
        else:
            # 不能理解时保守地走云端，避免把未知任务交给 0.5B 回答模型。
            route = "cloud"
            raw = format_reason(
                analysis,
                "规则兜底：不确定走云端",
                fallback_reason=SEMANTIC_JUDGE.unavailable_reason,
            )

    elapsed = time.perf_counter() - start

    return route, raw, elapsed


# ============================================================
# 测试集
# ============================================================

REPRESENTATIVE_CASES = [

    # -------------------------
    # LOCAL
    # -------------------------

    (
        "请帮我写一篇作文",
        "local",
    ),

    (
        "把这句话翻译成英文：人工智能正在改变世界。",
        "local",
    ),

    (
        "什么是人工智能？",
        "local",
    ),

    (
        "解释一下 Python 是什么",
        "local",
    ),

    (
        "写一个简单 Python 函数，返回列表中的最大值。",
        "local",
    ),

    # 规则没有强特征，但语义上是开放式设计任务。
    (
        "帮我造一个小型太空船",
        "cloud",
    ),

    # -------------------------
    # CLOUD
    # -------------------------

    (
        "训练一个ai",
        "cloud",
    ),

    (
        "设计一个支持千万用户的分布式电商系统，"
        "说明缓存、数据库分片和容灾方案。",
        "cloud",
    ),

    (
        "遍历 1T 硬盘找出所有重复文件，"
        "执行扫描、汇总并生成报告。",
        "cloud",
    ),

    (
        "写一部长篇小说，至少十万字，"
        "包含完整世界观和多条人物线。",
        "cloud",
    ),

    (
        "设计一个支持多GPU训练的大模型系统",
        "cloud",
    ),
]


# ============================================================
# 回归测试
# ============================================================

def run_representative_tests():
    """
    运行代表性测试。

    注意：
    由于边界任务可能调用本地 judge，
    所以这个测试不一定完全是零耗时。
    """

    passed = 0

    for task, expected in REPRESENTATIVE_CASES:

        route, reason, elapsed = router(task)

        ok = route == expected

        if ok:
            passed += 1

        status = "通过" if ok else "失败"

        print(
            f"[{status}] "
            f"期望={expected}，"
            f"实际={route}：{task}"
        )

        print(
            f"  {reason}"
        )

        print(
            f"  耗时={elapsed:.3f}s"
        )

    print(
        f"\n结果："
        f"{passed}/{len(REPRESENTATIVE_CASES)} "
        f"通过"
    )

    return passed == len(REPRESENTATIVE_CASES)


# ============================================================
# 主程序
# ============================================================

if __name__ == "__main__":

    # python router.py --test
    #
    # 只运行测试，不调用最终云端模型。

    if "--test" in sys.argv:

        raise SystemExit(
            0 if run_representative_tests() else 1
        )

    # -------------------------
    # 正常运行
    # -------------------------

    user_input = input("请输入任务：")

    route, raw, elapsed = router(
        user_input
    )

    print(
        "\n========== Router =========="
    )

    print("路由依据:")
    print(raw)

    print("\n最终路由:")
    print(route)

    print(
        f"\nRouter耗时: {elapsed:.3f} 秒"
    )

    # ========================================================
    # 真正执行 LOCAL
    # ========================================================

    if route == "local":

        print(
            "\n→ 调用本地模型..."
        )

        try:

            answer = ask_ollama(
                user_input,
                LOCAL_MODEL,
                timeout=120,
            )

            print(
                "\n========== Local Answer =========="
            )

            print(answer)

        except requests.RequestException as error:

            print(
                f"\n本地模型调用失败：{error}"
            )

    # ========================================================
    # 真正执行 CLOUD
    # ========================================================

    else:

        print(
            "\n→ 调用云端模型..."
        )

        try:

            answer = ask_cloud(
                user_input
            )

            print(
                "\n========== Cloud Answer =========="
            )

            print(answer)

        except Exception as error:

            print(
                f"\n云端模型调用失败：{error}"
            )
