FROM python:3.11-slim-bookworm@sha256:ef56ae98435cc40d8a27020b0b32a9941515acd5840f0fba34858bb34dd362d1

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 OMP_NUM_THREADS=2
RUN pip install --no-cache-dir faster-whisper==1.2.1
WORKDIR /app
COPY packages/ai/scripts/local/faster_whisper_worker.py nodes/stt/worker.py ./
USER 65532:65532
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/readyz', timeout=2).close()"]
ENTRYPOINT ["python", "worker.py"]
