FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/app/data \
    AWS_REGION=us-east-1 \
    BEDROCK_MODEL_ID=global.anthropic.claude-opus-4-6-v1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py db.py bedrock_client.py ./
COPY templates ./templates
COPY static ./static

# Run as non-root; /app/data holds the SQLite DB and should be a mounted volume
RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app/data
USER appuser

VOLUME ["/app/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

# One worker (SQLite-friendly) with threads so several chats can stream at once.
# Long timeout because streamed answers can take a while.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--worker-class", "gthread", "--threads", "8", "--timeout", "300", "--access-logfile", "-", "app:app"]
