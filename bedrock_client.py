import os

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

# Credentials come from boto3's default chain: env vars, ~/.aws, or the EC2 instance role
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "global.anthropic.claude-opus-4-6-v1")

SYSTEM_PROMPT = (
    "You are a helpful, friendly general-purpose assistant. "
    "Answer clearly and concisely. Use Markdown for code, lists and emphasis when it helps."
)

# Context window: only the newest messages that fit this many (estimated) tokens are sent
CONTEXT_MAX_TOKENS = int(os.environ.get("CONTEXT_MAX_TOKENS", "8000"))
# Rough estimate. English is ~4 characters per token. Other scripts (e.g. Armenian) use more
# tokens per character, so 3 errs on the safe side.
CHARS_PER_TOKEN = 3
# Fixed cost per message (role markers etc.)
TOKENS_PER_MESSAGE = 4

session = boto3.Session(region_name=AWS_REGION)
bedrock = session.client("bedrock-runtime")


def estimate_tokens(text):
    return len(text) // CHARS_PER_TOKEN + TOKENS_PER_MESSAGE


def trim_history(history, max_tokens=CONTEXT_MAX_TOKENS):
    """Keep the newest messages that fit in max_tokens; older ones are dropped.

    The newest message is always kept. The result always starts with a user turn,
    because the Converse API requires the conversation to begin with one.
    """
    kept = []
    used = 0
    for message in reversed(history):
        cost = estimate_tokens(message["content"])
        if kept and used + cost > max_tokens:
            break
        kept.append(message)
        used += cost
    kept.reverse()

    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def to_bedrock_messages(history):
    """Convert [{"role": "user"|"assistant", "content": "..."}] into Converse API format."""
    return [
        {"role": m["role"], "content": [{"text": m["content"]}]}
        for m in history
        if m.get("role") in ("user", "assistant") and m.get("content", "").strip()
    ]


def stream_chat(history, max_tokens=2048, temperature=0.5):
    """Yield event dicts: {"type": "text"|"done"|"error", ...}."""
    try:
        response = bedrock.converse_stream(
            modelId=MODEL_ID,
            system=[{"text": SYSTEM_PROMPT}],
            messages=to_bedrock_messages(history),
            inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
        )

        usage = {}
        for event in response["stream"]:
            if "contentBlockDelta" in event:
                text = event["contentBlockDelta"]["delta"].get("text")
                if text:
                    yield {"type": "text", "text": text}
            elif "metadata" in event:
                usage = event["metadata"].get("usage", {})

        yield {"type": "done", "usage": usage}

    except NoCredentialsError:
        yield {"type": "error", "message": "AWS credentials not found. Run: aws configure"}

    except ClientError as error:
        err = error.response["Error"]
        yield {"type": "error", "message": f"{err['Code']}: {err['Message']}"}

    except Exception as error:
        yield {"type": "error", "message": f"Unexpected error: {error}"}
