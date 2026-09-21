import requests
import json


OLLAMA_URL = "http://localhost:11434/api/generate"


def ask_local_model(prompt):

    data = {
        "model":"qwen3:4b",
        "prompt":prompt,
        "stream":False,
        "options":{
            "think":False,
            "temperature":0,
            "num_predict":2,
            "num_ctx":128
    }
}

    response = requests.post(
        OLLAMA_URL,
        json=data
    )

    response.raise_for_status()

    return response.json()["response"]


def extract_json(text):

    import re

    matches = re.findall(
        r'\{[\s\S]*?\}',
        text
    )

    if not matches:
        raise Exception("没有找到JSON")

    # 从后往前尝试解析
    for item in reversed(matches):

        try:
            return json.loads(item)

        except:
            continue

    raise Exception("没有有效JSON")

def decide_route(info):

    """
    Python决策层
    """

    capability = info.get(
        "local_capability",
        0
    )

    tokens = info.get(
        "estimated_tokens",
        0
    )

    difficulty = info.get(
        "difficulty",
        ""
    )


    if capability >= 0.7:
        return "local"


    if tokens > 1000:
        return "cloud"


    if difficulty == "hard":
        return "cloud"


    return "local"

def router(user_input):


    prompt = f"""
你是AI路由器。

判断任务：

local:
简单问题、简单代码、翻译

cloud:
复杂系统设计、高难度推理、大型代码


只输出：
local 或 cloud


任务:
{user_input}
"""


    result = ask_local_model(prompt)


    print("\n原始输出:")
    print(result)


    try:

        data = extract_json(result)

        return data


    except Exception as e:

        return {
            "route":"local",
            "confidence":0,
            "estimated_tokens":0,
            "difficulty":"unknown",
            "local_capability":0,
            "reason":f"JSON解析失败:{e}"
        }




if __name__ == "__main__":


    user_input=input("请输入任务:")

    analysis = router(user_input)

    final_route = decide_route(analysis)

    analysis["final_route"] = final_route

    result = analysis


    print("\nAI判断:")

    print(
        json.dumps(
            result,
            indent=4,
            ensure_ascii=False
        )
    )


    if result["route"]=="cloud":

        print("\n下一步:")
        print("调用云模型")

    else:

        print("\n下一步:")
        print("本地模型处理")