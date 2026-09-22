"""
AI Router Benchmark v0.5

作用：
批量测试 Router 的路由判断是否正确。

核心思想：
我们提前给每个任务一个“标准答案”，
然后让 Router 自己判断，最后比较两者。
"""

from router import router, analyze_task
from statistics import mean, median
# =========================
# 测试数据
# =========================

TEST_CASES = [

    # ========================================================
    # 1. 简单任务 —— LOCAL
    # ========================================================

    ("帮我翻译巴黎圣母院", "local"),
    ("把 hello 翻译成中文", "local"),
    ("解释一下什么是 Python", "local"),
    ("什么是 HTTP", "local"),
    ("什么是机器学习", "local"),
    ("解释一下什么是 API", "local"),
    ("写一个 Python Hello World", "local"),
    ("帮我写一个冒泡排序", "local"),
    ("写一个 Python 函数计算平均值", "local"),
    ("帮我写一封请假邮件", "local"),

    # ========================================================
    # 2. 简单任务的边界 —— LOCAL
    # ========================================================

    ("分析一下什么是人工智能", "local"),
    ("分析一下 Python 和 Java 的区别", "local"),
    ("比较一下 TCP 和 UDP", "local"),
    ("优化一下这段简单 Python 代码", "local"),
    ("解释一下数据库索引", "local"),
    ("帮我写一个简单的 HTTP 请求", "local"),
    ("写一个简单的文件读取脚本", "local"),
    ("写一个简单的 Flask 示例", "local"),
    ("拟合一个金融函数", "local"),
    ("写一篇 800 字作文", "local"),

    # ========================================================
    # 3. 明显复杂任务 —— CLOUD
    # ========================================================

    ("训练一个 AI 模型", "cloud"),
    ("帮我训练一个大语言模型", "cloud"),
    ("设计一个高并发电商系统", "cloud"),
    ("设计一个支持百万用户的分布式系统", "cloud"),
    ("设计一个微服务架构", "cloud"),
    ("设计一个高并发支付系统", "cloud"),
    ("设计一个大规模 AI 推理平台", "cloud"),
    ("设计一个多 GPU 大模型训练系统", "cloud"),
    ("帮我完成一个 ChatGPT 模型训练", "cloud"),

    # ========================================================
    # 4. 大型工程 —— CLOUD
    # ========================================================

    ("分析一个大型项目的全部源代码", "cloud"),
    ("重构整个大型代码库", "cloud"),
    ("帮我完成一个完整的生产级系统", "cloud"),
    ("设计一个完整的企业级后端系统", "cloud"),
    ("开发一个大型全栈项目", "cloud"),
    ("设计一个生产级 AI 服务平台", "cloud"),
    ("分析一个大型软件项目的架构并提出优化方案", "cloud"),
    ("设计一个高可靠性的生产环境系统", "cloud"),
    ("对整个项目进行安全审计", "cloud"),
    ("设计一个支持高并发的数据库架构", "cloud"),

    # ========================================================
    # 5. 大量数据 / 工具操作 —— CLOUD
    # ========================================================

    ("遍历 1TB 硬盘寻找指定文件", "cloud"),
    ("扫描百万个文件并找出重复文件", "cloud"),
    ("分析海量数据并生成完整报告", "cloud"),
    ("遍历整个项目目录并分析所有源码", "cloud"),
    ("处理一个 TB 级数据集", "cloud"),
    ("设计一个海量数据处理系统", "cloud"),
    ("写一个程序扫描整个服务器上的文件", "cloud"),
    ("执行一个完整的数据清洗和分析流程", "cloud"),
    ("分析一个大型数据库并优化性能", "cloud"),
    ("写一部长篇小说，至少十万字", "cloud"),
]


def run_benchmark():

    correct = 0

    local_to_cloud = 0
    cloud_to_local = 0
    actual_cloud_count = 0
    latencies = []

    print("=" * 70)
    print("AI Router Benchmark v0.6")
    print("=" * 70)

    for i, (task, expected) in enumerate(TEST_CASES, 1):
        analysis = analyze_task(task)

        # 真正执行完整 Router
        actual, reason, elapsed = router(task)
        latencies.append(elapsed)

        if actual == "cloud":
            actual_cloud_count += 1

        ok = actual == expected

        if ok:
            correct += 1

        # 统计两种不同类型的错误
        if expected == "cloud" and actual == "local":
            cloud_to_local += 1

        elif expected == "local" and actual == "cloud":
            local_to_cloud += 1

        symbol = "✓" if ok else "✗"

        print(
            f"{symbol} {i:02d}. "
            f"{actual.upper():5} | "
            f"期望={expected.upper():5} | "
            f"score={analysis.cloud_score:2d} | "
            f"{task}"
        )       

        if not ok:
            print(f"    原因: {reason}")

    total = len(TEST_CASES)

    accuracy = correct / total * 100

    cloud_count = sum(
        1
        for _, expected in TEST_CASES
        if expected == "cloud"
    )

    local_count = total - cloud_count

    print("\n" + "=" * 70)
    print("Benchmark 结果")
    print("=" * 70)

    print(f"总任务数: {total}")
    print(f"正确: {correct}")
    print(f"错误: {total - correct}")
    print(f"准确率: {accuracy:.1f}%")

    print()
    print(f"真实 LOCAL: {local_count}")
    print(f"真实 CLOUD: {cloud_count}")

    print()
    print("错误类型:")
    print(f"CLOUD → LOCAL: {cloud_to_local}")
    print(f"LOCAL → CLOUD: {local_to_cloud}")

    print()
    # 实际 Cloud Ratio 才能反映 Router 的成本倾向，不能用测试集的标注替代。
    print(f"Cloud Ratio: {actual_cloud_count / total * 100:.1f}% ({actual_cloud_count}/{total})")
    print(f"Router 平均延迟: {mean(latencies) * 1000:.1f} ms")
    print(f"Router P50 延迟: {median(latencies) * 1000:.1f} ms")
    print(f"Router 最大延迟: {max(latencies) * 1000:.1f} ms")

    print("=" * 70)


if __name__ == "__main__":
    run_benchmark()
