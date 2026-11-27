"""Local STT HTTP worker for AGIL Core's multipart transcription adapter."""
import hmac
import io
import json
import os
import re
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import chain
from pathlib import Path
from threading import BoundedSemaphore

import av
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper_worker import transcribe


MAX_BODY_BYTES = 9 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = 120 * SAMPLE_RATE


def read_audio(data):
    samples = []
    count = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    with av.open(io.BytesIO(data)) as container:
        for frame in chain(container.decode(audio=0), (None,)):
            for converted in resampler.resample(frame):
                count += converted.samples
                if count > MAX_SAMPLES:
                    raise ValueError("audio duration exceeds 120 seconds")
                samples.append(converted.to_ndarray().reshape(-1))
    if not samples:
        raise ValueError("empty audio stream")
    return np.concatenate(samples).astype(np.float32) / 32768.0


class SttHandler(BaseHTTPRequestHandler):
    timeout = 10
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def reply(self, status, data, *, close=False):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if close:
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path in ("/healthz", "/readyz"):
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not_found"}, close=True)

    def do_POST(self):
        if self.path != "/v1/audio/transcriptions":
            self.reply(404, {"error": "not_found"}, close=True)
            return
        authorization = self.headers.get("Authorization", "").encode("utf-8")
        authorized = False
        for credential in self.server.authorizations:
            authorized |= hmac.compare_digest(authorization, credential)
        if not authorized:
            self.reply(401, {"error": "unauthorized"}, close=True)
            return
        if self.headers.get_content_type() != "multipart/form-data" or self.headers.get("Transfer-Encoding"):
            self.reply(415, {"error": "multipart_required"}, close=True)
            return
        length = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"[0-9]{1,9}", length):
            self.reply(411, {"error": "length_required"}, close=True)
            return
        if not 0 < int(length) <= MAX_BODY_BYTES:
            self.reply(413, {"error": "body_too_large"}, close=True)
            return
        if not self.server.inference.acquire(blocking=False):
            self.reply(503, {"error": "worker_busy"}, close=True)
            return
        try:
            header = f"Content-Type: {self.headers['Content-Type']}\r\n\r\n".encode("utf-8")
            form = BytesParser().parsebytes(header + self.rfile.read(int(length)))
            fields = {
                part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
                for part in form.get_payload() if part.get_content_disposition() == "form-data"
            } if form.is_multipart() else {}
            audio = fields.get("file")
            language = fields.get("language") or b""
            if not audio or (language and not re.fullmatch(rb"[a-z]{2,3}", language)):
                self.reply(400, {"error": "invalid_transcription_request"})
                return
            try:
                waveform = read_audio(audio)
            except (ValueError, IndexError, av.error.FFmpegError):
                self.reply(400, {"error": "invalid_audio"})
                return
            try:
                result = transcribe(self.server.model, waveform, language.decode("ascii") or None)
            except ValueError:
                self.reply(400, {"error": "invalid_transcription_request"})
                return
            self.reply(200, {
                "text": " ".join(segment["text"] for segment in result["segments"]),
                "language": result["language"],
                "duration": result["durationSec"],
                "segments": result["segments"],
            })
        finally:
            self.server.inference.release()


def main():
    model_path = Path(os.environ.get("STT_MODEL_PATH", "/models/whisper-small"))
    token = os.environ.get("AGIL_STT_TOKEN", "").strip()
    if not token:
        raise SystemExit("AGIL_STT_TOKEN is required")
    previous_token = os.environ.get("AGIL_STT_PREVIOUS_TOKEN", "").strip()
    if not all((model_path / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
        raise SystemExit("A complete offline model is required in STT_MODEL_PATH")
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
    with ThreadingHTTPServer(("0.0.0.0", 8090), SttHandler) as server:
        server.authorizations = tuple(
            f"Bearer {value}".encode("utf-8") for value in (token, previous_token) if value
        )
        server.model = model
        server.inference = BoundedSemaphore(1)
        server.serve_forever()


if __name__ == "__main__":
    main()
