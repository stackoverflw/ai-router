"""Semantic Router v0.4：用本地 embedding 做语义路由。"""

from __future__ import annotations

import numpy as np
from sentence_transformers import SentenceTransformer


# 这个模型体积较小，支持中文；首次运行会下载到本机缓存，之后可离线复用。
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

# 每个 intent 只需要一句“能力说明”。模型会将它们和用户请求转换为向量。
INTENT_REGISTRY = {
    "text_simple": {
        "description": "简单问答、打招呼、翻译、解释概念、日常聊天",
        "route": "local",
    },
    "code": {
        "description": "编写、修改、调试或分析 Python 和其他程序代码",
        "route": "local",
    },
    "system_design": {
        "description": "设计高并发、分布式、大规模系统架构和技术方案",
        "route": "cloud",
    },
    "file_operation": {
        "description": "读取、搜索、修改、整理电脑中的文件和文件夹",
        "route": "tool",
    },
    "image_generation": {
        "description": "生成、绘制、编辑图片、照片或其他视觉内容",
        "route": "tool",
    },
    "device_control": {
        "description": "控制机器人、机械臂、摄像头、传感器或现实世界设备",
        "route": "tool",
    },
}


def cosine_similarity(vector_a: np.ndarray, vector_b: np.ndarray) -> float:
    """计算两个向量夹角的相似度；越接近 1，语义越相近。"""
    return float(np.dot(vector_a, vector_b) / (np.linalg.norm(vector_a) * np.linalg.norm(vector_b)))


class SemanticRouter:
    def __init__(self) -> None:
        # 加载 embedding 模型。它不生成回答，只负责把文本“编码”为数字向量。
        self.model = SentenceTransformer(MODEL_NAME)
        self.intent_names = list(INTENT_REGISTRY)
        descriptions = [INTENT_REGISTRY[name]["description"] for name in self.intent_names]

        # 注册表通常不变，所以只在启动时编码一次，后续每次路由都可直接复用。
        self.intent_vectors = self.model.encode(descriptions, convert_to_numpy=True)

    def route(self, user_input: str) -> dict:
        # 1. 将用户的一句话编码成与注册表相同维度的向量。
        request_vector = self.model.encode(user_input, convert_to_numpy=True)

        # 2. 逐个计算相似度，找出最像的 intent。
        scores = {
            name: cosine_similarity(request_vector, vector)
            for name, vector in zip(self.intent_names, self.intent_vectors)
        }
        best_intent = max(scores, key=scores.get)

        # 3. intent 本身不决定实现细节，只映射出 local / cloud / tool 路径。
        return {
            "intent": best_intent,
            "route": INTENT_REGISTRY[best_intent]["route"],
            "similarity": scores[best_intent],
            "scores": scores,
        }


def print_result(text: str, result: dict) -> None:
    print(f"任务: {text}")
    print(f"识别意图: {result['intent']}")
    print(f"最高相似度: {result['similarity']:.3f}")
    print(f"路由结果: {result['route']}")


TEST_CASES = [
    "说你好",
    "把 hello 翻译成中文",
    "帮我写一个 Python 排序函数",
    "设计一个支持百万并发的分布式系统",
    "读取 D 盘的 TEST.py",
    "生成一张 1080p 的图片",
    "控制机械臂把杯子拿起来",
]


if __name__ == "__main__":
    router = SemanticRouter()
    print(f"使用 embedding 模型: {MODEL_NAME}\n")

    # 直接运行时执行指定样例；加 --interactive 可改为输入一条自己的任务。
    import sys
    if "--interactive" in sys.argv:
        user_input = input("请输入任务：")
        print_result(user_input, router.route(user_input))
    else:
        for case in TEST_CASES:
            print_result(case, router.route(case))
            print("-" * 40)
