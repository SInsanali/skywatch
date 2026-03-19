FROM python:3.9-slim

LABEL maintainer="SInsanali"
LABEL description="Self-hosted flight tracker"

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash skywatch

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY skywatch.py .
COPY config.yaml .
COPY static/ static/

RUN chown -R skywatch:skywatch /app

USER skywatch

ENV PYTHONUNBUFFERED=1

EXPOSE 8078

CMD ["python", "skywatch.py"]
