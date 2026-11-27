# AgilFrame Nodes

**Русский** · [English](README.en.md)

Компоненты для запуска медианод AgilFrame. Нода регистрируется в Core, отправляет данные о состоянии и получает команды управления. Участники звонка подключаются по WebRTC к назначенной SFU. Когда нужен релейный маршрут, трафик передаётся через TURN.

[Проект AgilFrame](https://github.com/GillHD/agilframe) · [Core](https://github.com/GillHD/agilframe-core)

## Компоненты

| Компонент | Назначение |
| --- | --- |
| [Медианода](agil/core/nodes/all-in-one/) | Образ и конфигурация Docker Compose для LiveKit SFU и coturn |
| [Распознавание речи](agil/core/nodes/stt/) | Воркер speech-to-text (STT) |
| [Node Agent](agil/infra/node-agent/) | Регистрация ноды, передача статуса и обработка команд Core |

Для публикации медиапотока с внешнего устройства используется отдельный компонент. [AgilFrame Edge](https://github.com/GillHD/agilframe-edge)

## Запуск медианоды

На Linux-хосте с Docker Engine 24+ и Docker Compose 2.24+ подготовьте одноразовый токен регистрации в Core.

```bash
cd agil/core/nodes/all-in-one
cp .env.example .env
chmod 600 .env
```

Укажите в `.env` адрес Core (`AGIL_CORE_URL`), токен (`AGIL_NODE_TOKEN`), нужные функции (`NODE_FEATURES`) и сетевые параметры. Настройте учётные данные LiveKit и TURN для выбранных функций. [Руководство по настройке медианоды](agil/core/docs/node-image.md)

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

После первого запуска сохраняйте том `node-state`. В нём хранится ключ ноды, который агент использует при последующих запусках.

## Проверка

Из корня репозитория запустите тесты агентов с Node.js 20 или новее. Тестам достаточно встроенных модулей Node.js.

```bash
npm test
```

[Лицензия](LICENSE) · [Уведомления](NOTICE) · [Как внести вклад](CONTRIBUTING.md) · [Безопасность](SECURITY.md)
