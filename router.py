import requests
import time

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen3:4b"

def ask_router(prompt):
    data = {
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "keep_alive": -1,
        "options": {
            "temperature": 0,
            "num_predict": 5,
            "num_ctx": 512
        }
    }

    response = requests.post(
        OLLAMA_URL,
        json=data,
        timeout=30
    )

    response.raise_for_status()

    return response.json()["response"].strip()


def router(user_input):

    prompt = f"""
判断下面的用户任务应该使用 LOCAL 还是 CLOUD。

LOCAL：
简单任务，本地小模型可以完成。

CLOUD：
复杂任务、本地小模型容易失败的任务、
需要大量推理或大量生成的任务。

只允许输出：
LOCAL
或者
CLOUD

不要解释，不要输出其他内容。

用户任务：
{user_input}
"""

    start = time.perf_counter()

    raw = ask_router(prompt)

    elapsed = time.perf_counter() - start

    text = raw.upper()

    if "CLOUD" in text:
        route = "cloud"
    elif "LOCAL" in text:
        route = "local"
    else:
        route = "cloud"

    return route, raw, elapsed


if __name__ == "__main__":

    user_input = input("请输入任务：")

    route, raw, elapsed = router(user_input)

    print("\n========== Router ==========")

    print("\n模型原始输出:")
    print(raw)

    print("\n最终路由:")
    print(route)

    print(f"\nRouter耗时: {elapsed:.3f} 秒")