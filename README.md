# AgilFrame Nodes

Образ медианоды, STT и Node Agent.

[AgilFrame](https://github.com/users/GillHD/projects/1) · [Core и документация](https://github.com/GillHD/agilframe-core)

Исходная версия компонентов: [e49af79](https://github.com/GillHD/agilframe-core/commit/e49af79496ed8d4e200f520e2f7dd162bf789a7d). [Лицензия](LICENSE) · [Уведомления](NOTICE)

## Компоненты

- [Медианода и Compose](agil/core/nodes/all-in-one/) с LiveKit SFU и coturn.
- [Воркер STT](agil/core/nodes/stt/).
- [Node Agent](agil/infra/node-agent/).
- Контроллер для публикации с внешних устройств доступен в [AgilFrame Edge](https://github.com/GillHD/agilframe-edge).

В корне запустите `npm test`. Тесты агентов работают без установки npm-зависимостей. Для развёртывания в каталоге `agil/core/nodes/all-in-one` скопируйте `.env.example` в `.env` и задайте адрес Core, токен регистрации и сеть по руководству. Проверьте конфигурацию командой `docker compose config --quiet`, затем запустите ноду. [Руководство](agil/core/docs/node-image.md)

Нода регистрируется в Core и получает команды. WebRTC идёт к назначенной SFU или через TURN, когда выбран релейный маршрут.
