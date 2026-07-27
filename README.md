# Async URL Checker

Небольшое приложение для асинхронной проверки списка URL через HTTP `HEAD`.

Проект состоит из двух частей:

- `server` - NestJS API;
- `client` - Vue 3 + Pinia интерфейс.

Проверки выполняются в памяти процесса. После перезапуска сервера или контейнера история задач очищается.

## Запуск через Make

Понадобятся Node.js 22+, npm и `make`.

```bash
make install
make dev
```

После запуска:

- веб-интерфейс: `http://localhost:5173`;
- API: `http://localhost:3000/api`.

Полезные команды:

```bash
make server      # запустить только API
make client      # запустить только клиент
make build       # собрать клиент и сервер
```

## Запуск через Docker

Понадобятся Docker и Docker Compose.

```bash
docker compose up --build
```

После сборки приложение будет доступно на `http://localhost:3000`.

Остановить контейнеры можно так:

```bash
make docker-down
```

или напрямую:

```bash
docker compose down
```

## API

Основные эндпоинты:

- `POST /api/jobs` - создать задачу проверки URL;
- `GET /api/jobs` - получить список задач;
- `GET /api/jobs/:id` - получить детали задачи;
- `DELETE /api/jobs/:id` - отменить задачу.

Пример:

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com","https://openai.com"]}'
```

Подробности есть в [docs/api.md](docs/api.md) и [docs/configuration.md](docs/configuration.md).
