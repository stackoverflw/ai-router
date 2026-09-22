"""本地语义任务判定器：Reranker 优先，Embedding 为降级方案。

它不生成回答，也不绑定任何云端服务；职责只是理解请求的任务属性。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any


# mMARCO MiniLM 是较小的多语言 Cross-Encoder，中文任务可直接使用。
# 首次加载需要下载模型；下载完成后 Hugging Face 缓存可离线复用。
RERANKER_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


@dataclass(frozen=True)
class TaskProfile:
    """一个任务类别及完成它对模型能力的要求。"""

    intent: str
    description: str
    route: str
    complexity: int
    reasoning_need: int
    capability_need: int


# 描述使用完整句子，而非关键词表。Reranker 判断“请求是否属于这个能力画像”。
TASK_PROFILES = (
    TaskProfile("simple_chat", "日常聊天、问候、简短常识问答或直接翻译；答案短，不需要规划。", "local", 1, 1, 1),
    TaskProfile("concept_explanation", "解释一个基础概念、术语或技术原理；要求通俗、准确，但不需要系统方案。", "local", 2, 2, 2),
    TaskProfile("short_writing", "写一封邮件、一段话或篇幅有限的短文、作文；题目明确，不要求长篇结构。", "local", 2, 2, 2),
    TaskProfile("small_programming", "编写、解释或修改一个独立的小函数、示例程序或简短脚本；范围清晰。", "local", 3, 2, 3),
    TaskProfile("focused_problem", "解决一个范围明确的单点计算、函数拟合或基础数据问题；不涉及大型数据集或完整报告。", "local", 3, 3, 3),
    TaskProfile("creative_design", "开放式创意设计或发明任务，需要提出多个部件、约束、取舍和完整设计方案。", "cloud", 5, 4, 5),
    TaskProfile("deep_analysis", "需要比较多种方案、分析原因、给出有依据的评估、规划或优化建议。", "cloud", 5, 5, 5),
    TaskProfile("software_engineering", "开发、重构、审查或分析多模块、生产级或完整的软件工程项目。", "cloud", 7, 6, 7),
    TaskProfile("system_architecture", "设计高并发、分布式、微服务、企业级或高可靠系统架构，并说明关键取舍。", "cloud", 8, 7, 8),
    TaskProfile("model_training", "训练、微调、部署或评估机器学习和大语言模型，需要数据、算力和实验方案。", "cloud", 8, 7, 8),
    TaskProfile("large_data_or_tools", "扫描大量文件、处理 TB 级数据、执行多步工具流程或生成大规模分析报告。", "cloud", 8, 6, 8),
    TaskProfile("long_form_content", "创作长篇小说、完整论文、白皮书或超长文本，需要持续结构和大量输出。", "cloud", 6, 4, 6),
)


@dataclass
class SemanticDecision:
    intent: str
    complexity: int
    reasoning_need: int
    capability_need: int
    recommendation: str
    confidence: float
    backend: str
    scores: dict[str, float]
    unavailable_reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _softmax(values: list[float]) -> list[float]:
    maximum = max(values)
    exps = [math.exp(value - maximum) for value in values]
    total = sum(exps)
    return [value / total for value in exps]


class SemanticTaskJudge:
    """只在第一次判定时加载模型，避免模型不可用时阻塞普通 Router 启动。"""

    def __init__(self) -> None:
        self._backend: str | None = None
        self._model: Any = None
        self._profile_vectors: Any = None
        self._error: str | None = None

    def _load(self) -> None:
        if self._backend is not None or self._error is not None:
            return

        try:
            from sentence_transformers import CrossEncoder

            self._model = CrossEncoder(RERANKER_MODEL, max_length=256)
            self._backend = "cross_encoder"
            return
        except Exception as error:  # 模型未安装、缓存缺失或首次下载失败都可降级。
            reranker_error = f"Reranker 不可用：{type(error).__name__}"

        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(EMBEDDING_MODEL)
            descriptions = [profile.description for profile in TASK_PROFILES]
            self._profile_vectors = self._model.encode(
                descriptions,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
            self._backend = "embedding_fallback"
        except Exception as error:
            self._error = f"{reranker_error}；Embedding 不可用：{type(error).__name__}"

    def classify(self, user_input: str) -> SemanticDecision | None:
        """返回语义结论；本地模型都不可用时返回 None，让路由器走安全兜底。"""
        self._load()
        if self._error is not None:
            return None

        assert self._backend is not None
        descriptions = [profile.description for profile in TASK_PROFILES]

        if self._backend == "cross_encoder":
            # Cross-Encoder 同时阅读“请求 + 候选能力画像”，比向量相似度更像判断。
            raw_scores = [float(score) for score in self._model.predict([(user_input, text) for text in descriptions])]
            probabilities = _softmax(raw_scores)
        else:
            request_vector = self._model.encode(
                user_input,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
            raw_scores = [float(vector.dot(request_vector)) for vector in self._profile_vectors]
            probabilities = _softmax(raw_scores)

        best_index = max(range(len(raw_scores)), key=raw_scores.__getitem__)
        profile = TASK_PROFILES[best_index]
        named_scores = {
            item.intent: round(probability, 4)
            for item, probability in zip(TASK_PROFILES, probabilities)
        }

        return SemanticDecision(
            intent=profile.intent,
            complexity=profile.complexity,
            reasoning_need=profile.reasoning_need,
            capability_need=profile.capability_need,
            recommendation=profile.route,
            confidence=round(probabilities[best_index], 4),
            backend=self._backend,
            scores=named_scores,
        )

    @property
    def unavailable_reason(self) -> str | None:
        self._load()
        return self._error


if __name__ == "__main__":
    judge = SemanticTaskJudge()
    for task in ("帮我造一个小型太空船", "写一个 Python Hello World", "设计高并发支付系统"):
        decision = judge.classify(task)
        print(task)
        print(decision.as_dict() if decision else judge.unavailable_reason)
