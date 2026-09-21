import tiktoken


encoder = tiktoken.get_encoding("cl100k_base")


# ---------- Token 估算 ----------

def estimate_tokens(text):
    return len(encoder.encode(text))


def estimate_output_tokens(text):
    # 简单、短回答
    simple_words = [
        "你好",
        "谢谢",
        "翻译",
        "什么意思",
        "解释一下",
        "简单回答",
    ]

    if any(word in text for word in simple_words):
        return 50

    # 长文本生成
    long_words = [
        "小说",
        "作文",
        "文章",
        "报告",
        "论文",
        "详细介绍",
    ]

    if any(word in text for word in long_words):
        return 1500

    # 代码 / 系统 / 技术任务
    technical_words = [
        "设计",
        "分析",
        "实现",
        "系统",
        "方案",
        "代码",
        "架构",
        "程序",
        "项目",
        "后端",
        "算法",
    ]

    if any(word in text for word in technical_words):
        return 1000

    return 300


# ---------- 复杂度评分 ----------

def complexity_score(text):

    score = 0

    # 系统设计 / 架构
    if any(word in text for word in [
        "设计",
        "架构",
        "方案",
        "系统",
    ]):
        score += 3

    # 分析类任务
    if any(word in text for word in [
        "分析",
        "比较",
        "评估",
        "推理",
    ]):
        score += 2

    # 编程类任务
    if any(word in text for word in [
        "实现",
        "代码",
        "编写",
        "程序",
        "算法",
    ]):
        score += 2

    # 多步骤任务
    if any(word in text for word in [
        "同时",
        "流程",
        "步骤",
        "解决方案",
        "先",
        "然后",
        "最后",
    ]):
        score += 2

    # 大规模任务
    if any(word in text for word in [
        "百万",
        "千万",
        "亿",
        "1TB",
        "1T",
        "大规模",
        "高并发",
        "分布式",
    ]):
        score += 3

    return score


# ---------- Router ----------

def token_router(user_input):

    input_tokens = estimate_tokens(user_input)

    output_tokens = estimate_output_tokens(user_input)

    estimated_total = input_tokens + output_tokens

    complexity = complexity_score(user_input)

    # 最终决策
    if estimated_total > 500:
        route = "cloud"

    elif complexity >= 5:
        route = "cloud"

    else:
        route = "local"

    return (
        route,
        input_tokens,
        output_tokens,
        estimated_total,
        complexity,
    )


# ---------- 测试 ----------

if __name__ == "__main__":

    user_input = input("请输入任务：")

    (
        route,
        input_tokens,
        output_tokens,
        total,
        complexity,
    ) = token_router(user_input)

    print("\n========== Token Router ==========")

    print(f"输入 Token: {input_tokens}")
    print(f"预计输出 Token: {output_tokens}")
    print(f"预计总 Token: {total}")
    print(f"复杂度评分: {complexity}")
    print(f"路由结果: {route}")