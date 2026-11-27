# AgilFrame Nodes

[Русский](README.md) · **English**

Components for running AgilFrame media nodes. Each node registers with Core, reports its health, and receives management commands. Call participants connect over WebRTC to the assigned selective forwarding unit (SFU). When a relay is needed, traffic goes through TURN.

[AgilFrame project](https://github.com/GillHD/agilframe) · [Core](https://github.com/GillHD/agilframe-core)

## Components

| Component | Purpose |
| --- | --- |
| [Media node](agil/core/nodes/all-in-one/) | Container image and Docker Compose configuration for LiveKit SFU and coturn |
| [Speech-to-text](agil/core/nodes/stt/) | Speech-to-text (STT) worker |
| [Node Agent](agil/infra/node-agent/) | Node registration, status reporting, and handling commands from Core |

To publish media from an external device, use [AgilFrame Edge](https://github.com/GillHD/agilframe-edge).

## Run a media node

On a Linux host with Docker Engine 24+ and Docker Compose 2.24+, prepare a one-time enrollment token in Core.

```bash
cd agil/core/nodes/all-in-one
cp .env.example .env
chmod 600 .env
```

Set the Core URL (`AGIL_CORE_URL`), enrollment token (`AGIL_NODE_TOKEN`), required features (`NODE_FEATURES`), and network settings in `.env`. Configure the LiveKit and TURN credentials for the features you enable. [Media node runbook](agil/core/docs/node-image.md)

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Keep the `node-state` volume after the first start. It holds the node key that the agent uses on subsequent starts.

## Run tests

Run the agent tests from the repository root with Node.js 20 or later. The tests use Node.js built-in modules.

```bash
npm test
```

[License](LICENSE) · [Notices](NOTICE) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md)
