# Semantic Router v0.4

## 原理

1. 本地 embedding 模型把用户任务和每个 intent 的说明分别转换为数字向量。
2. 程序计算用户向量与所有 intent 向量的 cosine similarity（余弦相似度）。数值越接近 `1`，含义越接近。
3. 最高分的 intent 映射为 `local`、`cloud` 或 `tool`。

`tool` 表示应先调用外部能力，例如文件系统、图片生成器或设备控制接口；它不是直接调用云模型。

## 使用的 embedding 模型

`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`

这是一个可在本地运行的多语言 sentence embedding 模型，适合中文和入门演示。第一次加载时会下载模型；之后会从本地缓存加载。

## 安装与运行

```powershell
D:\AI\envs\llm-dev\Scripts\python.exe -m pip install -r requirements-v0.4.txt
D:\AI\envs\llm-dev\Scripts\python.exe semantic_router_v0_4.py
D:\AI\envs\llm-dev\Scripts\python.exe semantic_router_v0_4.py --interactive
```

如果第一条命令提示 Python 启动失败，请先安装 Python 3.12，或用一个存在的 Python 重新创建 `llm-dev` 虚拟环境，再执行安装。

## 测试样例与预期

| 任务 | 预期 intent | 预期 route |
| --- | --- | --- |
| 说你好 | `text_simple` | `local` |
| 翻译 hello | `text_simple` | `local` |
| 写 Python | `code` | `local` |
| 设计百万并发系统 | `system_design` | `cloud` |
| 读取 D 盘 TEST.py | `file_operation` | `tool` |
| 生成 1080p 图片 | `image_generation` | `tool` |
| 控制机械臂 | `device_control` | `tool` |

## 保留旧版本

原有 `token_router.py`（v0.2）没有修改。v0.4 是独立文件，方便并排比较和回退。
