# Semantic Router v0.5

## 路由流程

```text
用户任务
  ├─ 明确高风险规则（大规模、系统级、工具级）──> CLOUD
  └─ Cross-Encoder：任务与能力画像逐对判断
        ├─ 可用 ──> intent + 复杂度/推理/能力需求 + LOCAL/CLOUD
        └─ 不可用 ──> multilingual embedding 降级
                       └─ 仍不可用 ──> 规则安全兜底
```

## 本地模型

- 首选：`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`。它读取“用户任务 + 候选任务能力画像”成对文本后评分，避免只做向量近邻。
- 降级：`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`。

模型均由 `semantic_task_judge.py` 延迟加载：Router 导入时不下载模型，模型不可用时也不会中断服务。

## 可观察输出

路由日志会包含：`intent`、复杂度、推理需求、能力需求、建议路径、置信度与使用的后端。`benchmark_router.py` 额外输出实际 Cloud Ratio、平均延迟、P50 延迟和最大延迟。

## 运行

```powershell
D:\AI\envs\llm-dev\Scripts\python.exe -m pip install -r requirements-v0.4.txt
D:\AI\envs\llm-dev\Scripts\python.exe benchmark_router.py
```

首次执行需要联网下载 Reranker；之后模型位于本机 Hugging Face 缓存中，可离线运行。
