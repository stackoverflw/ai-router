import os
from openai import OpenAI


def create_cloud_client():
    """
    从 Windows 环境变量读取云端 API 配置。
    这样代码本身不需要绑定任何一家云厂商。
    """
    api_key = os.getenv("AI_CLOUD_API_KEY")
    base_url = os.getenv("AI_CLOUD_BASE_URL")
    model = os.getenv("AI_CLOUD_MODEL")

    if not api_key:
        raise RuntimeError("缺少 AI_CLOUD_API_KEY")

    if not base_url:
        raise RuntimeError("缺少 AI_CLOUD_BASE_URL")

    if not model:
        raise RuntimeError("缺少 AI_CLOUD_MODEL")

    client = OpenAI(
        api_key=api_key,
        base_url=base_url,
    )

    return client, model


def ask_cloud(prompt):
    """向用户配置的云端模型发送请求。"""
    client, model = create_cloud_client()

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "user", "content": prompt}
        ],
    )

    return response.choices[0].message.content


if __name__ == "__main__":
    answer = ask_cloud("只回答：云端连接成功")
    print(answer)