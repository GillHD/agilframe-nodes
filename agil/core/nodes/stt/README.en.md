# Standalone speech-to-text node

[Русский](README.md) · **English**

The `agil/node-stt:0.1.0` container receives audio from Core and transcribes it on the CPU with `faster-whisper`. It uses a preloaded model directory mounted read-only. The worker loads the model into memory before starting its HTTP server and reuses it for subsequent requests.

## Run the worker

1. Prepare a CTranslate2 model directory with `model.bin`, `config.json`, `tokenizer.json`, and the vocabulary files for the model. The container user with UID 65532 needs read access.
2. In `agil/core/nodes/stt`, set `STT_MODEL_DIR` in a local `.env` file to the absolute path of the model directory on the host. Set `AGIL_STT_TOKEN` to a dedicated secret for Core requests. Port `8090` binds to `127.0.0.1` by default. If Core runs on another host, set `STT_LISTEN_IP` to an interface Core can reach.
3. Run `docker compose up -d --build` and check `docker compose ps`. The `/readyz` endpoint reports readiness after the model has loaded.
4. In Core, set `STT_PROVIDER=remote`, `AGIL_STT_URL=http://127.0.0.1:8090/v1`, and `AGIL_STT_KEY` to the same value as `AGIL_STT_TOKEN`. Use the worker's address if it runs on another host. Core sends audio to `POST /v1/audio/transcriptions`. With `PRIVACY_MODE=local`, Core requires the built-in `STT_PROVIDER=local` worker.

The worker processes one request at a time. It accepts up to 9 MiB per multipart request and up to 120 seconds of decoded audio. Its response contains text, language, and segment timestamps. The model and audio stay in your environment. When replacing the container, reuse the model directory to avoid downloading the model again.

## Run an image from a registry

If your CI publishes an STT image to a registry, take its digest from the build report and set `STT_IMAGE` in `.env` to a value such as `ghcr.io/<owner>/<repo>/stt@sha256:<digest>`. Prepare the model and token, then run `docker compose up -d --no-build`.

For installation from the infrastructure dashboard, pull the same image by digest on the agent host and tag it with the local name expected by the module catalog. Set `STT_IMAGE_SOURCE=local` in the `stt` section of `module-env.json`.

```sh
docker pull ghcr.io/OWNER/REPO/stt@sha256:DIGEST
docker tag ghcr.io/OWNER/REPO/stt@sha256:DIGEST agil/node-stt:0.1.0
```

Check worker readiness in the dashboard after the model loads. The Core documentation covers SBOMs and image signature verification. [Builds and CI](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/ci.md)

## Install from the infrastructure dashboard

1. Connect the agent to Docker Engine on the selected node. Prepare the model directory on the **Docker host** with read access for UID 65532.
2. Create an `stt` section in `module-env.json` in the agent state directory. Restrict file access to the agent user and set the fields listed below.
3. Prepare an image tagged `agil/node-stt:0.1.0`. Set `STT_IMAGE_SOURCE=local` if you built it with `docker compose build stt` or loaded it with `docker load`. Keep `pull` if the image is available in a registry the node can access. For installation managed by the agent, building the image is sufficient.
4. In the dashboard, open **Infrastructure**, select the node, and open **Modules**. Install STT and wait for the worker to report that it is running and healthy. Set the worker URL and token in Core as described in the Compose setup. To use the node's status as an availability check, set its ID in the tenant editor under **Session → Transcription**.

| Field in `stt` | Purpose |
| --- | --- |
| `STT_MODEL_DIR` | Absolute path to the prepared model on the Docker host. The agent mounts it read-only at `/models/whisper`. |
| `AGIL_STT_TOKEN` | Dedicated Core token stored on the node. |
| `AGIL_STT_PREVIOUS_TOKEN` | Previous token accepted during a Core update. Remove it after rotation. |
| `STT_LISTEN_IP` | IP address to bind port 8090 to. The default is `127.0.0.1`. When Core runs on another host, use a private interface address. |
| `STT_DOCKER_NETWORK` | Name of an operator-created private Docker network. Core can use the worker container name and port 8090 if both share the network. |
| `STT_IMAGE_SOURCE` | `pull` by default, or `local` for an image already loaded with the catalog tag. |

Restarting the worker preserves its settings and model directory. To change the model directory, bind address, or token, update the local file and reinstall the module.

## Rotate the worker token

1. On the node, set the new token in `AGIL_STT_TOKEN` and temporarily retain the old token in `AGIL_STT_PREVIOUS_TOKEN`. With Compose, set these values in `.env`. With the agent, set them in the `stt` section of `module-env.json`.
2. Recreate the worker with the same model mount. Wait for `/readyz` to report readiness.
3. Update `AGIL_STT_KEY` on the Core replicas. Verify transcription in a room.
4. Remove `AGIL_STT_PREVIOUS_TOKEN` and recreate the worker again. The old token should now receive HTTP 401. Check the new token and captions.

The worker accepts both tokens while you update the Core replicas. Recreating a single worker can briefly interrupt processing. For continuous processing, update workers one at a time and verify readiness after each update.

## Check captions in a browser

Confirm that `/readyz` responds. Enable transcription in the tenant settings and join the same room from two browsers. In the first browser, grant microphone access, enable captions, and provide consent if prompted. Speak a test phrase and confirm that the second participant sees it in captions.
