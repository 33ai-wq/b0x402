# b0x402 — x402 seller Dockerfile for Fly.io
# Multi-stage not needed; this is a small FastAPI service.

FROM python:3.12-slim

WORKDIR /app

# Install build deps first (cached layer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Python deps — requirements pinned
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source (minimal — no .env, no __pycache__, etc; .dockerignore handles)
COPY . .

# Run as non-root user for hardening
RUN useradd -m -u 1000 b0x70 && chown -R b0x70:b0x70 /app
USER b0x70

# Expose port 8080 (matches main.py default)
EXPOSE 8080

# Production-ish uvicorn: 1 worker (invoice manager is thread-safe,
# multi-process would duplicate nonce state across workers)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
