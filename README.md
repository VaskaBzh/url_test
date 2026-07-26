# Async URL Checker

> Run asynchronous HTTP HEAD checks for a list of URLs and inspect each result through a small web interface or REST API.

The project combines a NestJS API with a Vue 3 + Pinia client. Jobs are processed in memory with bounded per-job concurrency, predictable validation errors, explicit lifecycle transitions, configurable structured logging, and a random publication delay for completed checks.

## Quick Start

Install dependencies:

```bash
npm --prefix server install
npm --prefix client install
```

Start the API and client in separate terminals:

```bash
npm --prefix server run start:dev
```

```bash
npm --prefix client run dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:3000/api`.

## Makefile

If `make` is available, you can use:

```bash
make install
make dev
```

The Vue client stays on `http://localhost:5173`; the NestJS API listens on `http://localhost:3000/api`.

## Client Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3000/api` | Overrides the base URL used for job API requests. |
| `VITE_LOG_LEVEL` | `error` | Controls client workflow logs: `error`, `warn`, or `silent`. |

Client workflow logs include only operation names, safe job identifiers, and error types. Submitted URLs and HTTP response bodies are not logged.

## Docker

For a production-style local run:

```bash
docker compose up --build
```

Open `http://localhost:3000`; the container serves both the built client and the API.

## Key Features

- **Asynchronous jobs** — submit multiple URLs and poll job-level and URL-level progress.
- **Bounded processing** — each job runs at most five HEAD requests concurrently.
- **Stable API contracts** — invalid payloads return predictable `400` responses; unknown jobs return generic `404` responses.
- **Explicit lifecycle rules** — job and URL transitions are validated before state changes.
- **Safe cancellation** — pending URLs are cancelled while already-started requests may finish.
- **Configurable logs** — choose verbose, standard, or minimal output with `LOG_LEVEL`.

Each completed HTTP request waits for a random `0..10` second delay before its result is published.

## Example

Create a job:

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com","https://openai.com"]}'
```

Response:

```json
{"jobId":"73d86e28-3018-4d7b-8c10-7d5b2fb43e9a"}
```

## Documentation

| Guide | Description |
|-------|-------------|
| [API Reference](docs/api.md) | Endpoints, validation, responses, and lifecycle |
| [Configuration](docs/configuration.md) | Environment variables, logging, and runtime limits |

## Verification

Run the client workflow tests:

```bash
npm --prefix client run test
```

Run the server quality checks:

```bash
npm --prefix server run lint
npm --prefix server test -- --runInBand
npm --prefix server run test:e2e -- --runInBand
npm --prefix server run build
npm --prefix client run build
```

Job history is process-local and is cleared whenever the API restarts.

## License

This repository is private and unlicensed (`UNLICENSED`).