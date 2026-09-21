# Semantic Router v0.4 测试记录

测试日期：2026-09-21

## 运行状态

本机的 `D:\AI\envs\llm-dev\pyvenv.cfg` 指向
`C:\Users\18918\AppData\Local\Programs\Python\Python312\python.exe`，但该解释器不存在；
系统 Python launcher 也没有发现任何已安装的 Python。因此本次不能执行真实模型测试，未伪造结果。

## 待环境恢复后执行的命令

```powershell
cd D:\AI\projects\ai-router
D:\AI\envs\llm-dev\Scripts\python.exe -m pip install -r requirements-v0.4.txt
D:\AI\envs\llm-dev\Scripts\python.exe semantic_router_v0_4.py
```

## 覆盖的测试样例与期望路由

| 任务 | 期望 intent | 期望 route |
| --- | --- | --- |
| 说你好 | `text_simple` | `local` |
| 把 hello 翻译成中文 | `text_simple` | `local` |
| 帮我写一个 Python 排序函数 | `code` | `local` |
| 设计一个支持百万并发的分布式系统 | `system_design` | `cloud` |
| 读取 D 盘的 TEST.py | `file_operation` | `tool` |
| 生成一张 1080p 的图片 | `image_generation` | `tool` |
| 控制机械臂把杯子拿起来 | `device_control` | `tool` |

实际运行后，程序会同时打印识别出的 intent、最高 cosine similarity 和 route；请把该输出追加到本文件，作为真实测试结果。
