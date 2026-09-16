FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATABASE_PATH=/data/sudoku.db

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app/ app/

# Run unprivileged; /data is where the compose volume is mounted and must be
# owned by this user before the volume is first created.
RUN useradd --system --uid 10001 --home-dir /app sudoku \
 && mkdir -p /data && chown sudoku:sudoku /data
USER sudoku
VOLUME /data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"

# --proxy-headers: trust X-Forwarded-* from the nginx container in front.
CMD ["uvicorn", "app.main:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
