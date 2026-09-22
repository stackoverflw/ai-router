# Semantic Router v0.5 测试记录

测试日期：2026-09-22

## 实际执行状态

未伪造 benchmark 结果。本机可发现的两个 Python 虚拟环境：

- `D:\AI\envs\llm-dev`
- `D:\AI\.venv`

都在启动时引用已经不存在的 `C:\Users\18918\AppData\Local\Programs\Python\Python312\python.exe`，因此无法导入依赖、下载 Cross-Encoder 或执行 `benchmark_router.py`。

`git diff --check` 已通过；完成的是静态核查，不是模型运行验证。

## 环境恢复后执行

```powershell
cd D:\AI\projects\ai-router
D:\AI\envs\llm-dev\Scripts\python.exe -m pip install -r requirements-v0.4.txt
D:\AI\envs\llm-dev\Scripts\python.exe router.py --test
D:\AI\envs\llm-dev\Scripts\python.exe benchmark_router.py
```

## 要记录的指标

`benchmark_router.py` 将输出：准确率、`CLOUD → LOCAL`、`LOCAL → CLOUD`、实际 `Cloud Ratio`、平均 Router 延迟、P50 延迟和最大延迟。

首次模型加载的下载时间会显著拉高一次延迟；应另行记录预热后第二次 benchmark 的数据。
