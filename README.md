# Async URL Checker

NestJS API and Vue 3 client for asynchronous HEAD checks of URL lists. Job data lives in memory, so it is reset when the API restarts.

## Stack

- NestJS + TypeScript API
- Vue 3 + TypeScript + Pinia client
- Docker Compose for containerized execution

## Run locally

Use two terminals:

```bash
cd server
npm install
npm run start:dev
```

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite development server proxies `/api` requests to NestJS on port 3000.

### Makefile

If `make` is available, run both development servers with:

```bash
make install
make dev
```

The Vue client is available at `http://localhost:5173`; the NestJS API listens on `http://localhost:3000`.

## Client configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3000/api` | Overrides the URL used for job API requests. |
| `VITE_LOG_LEVEL` | `error` | Controls client workflow logs: `error`, `warn`, or `silent`. |

Workflow logs include only operation names, safe job identifiers, and error types. Submitted URLs and HTTP response bodies are not logged.

## Tests

Run the deterministic client workflow and accessibility tests:

```bash
npm --prefix client run test
```

Run the server end-to-end tests:

```bash
npm --prefix server run test:e2e -- --runInBand
```

Build both applications after tests pass:

```bash
npm --prefix client run build
npm --prefix server run build
```

## Docker

```bash
docker compose up --build
```

The API listens on port 3000. For the production image, serve the generated `client/dist` directory from a web server or reverse proxy.

## API

- `POST /api/jobs` — `{ "urls": ["https://example.com"] }`
- `GET /api/jobs` — job summaries and aggregate statistics
- `GET /api/jobs/:id` — URL-level status, response code, errors, and timing
- `DELETE /api/jobs/:id` — cancels pending URLs in the job

Each job uses at most five simultaneous HEAD requests. Completed HTTP requests wait for a random 0–10 second delay before their results are saved.