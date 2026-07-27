[← API Reference](api.md) · [Back to README](../README.md)

# Configuration

The service works without a mandatory `.env` file. Environment variables override local defaults when deployment needs a different port, browser origin, API location, or log volume.

## Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port for the NestJS API and production client |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Browser origin allowed by Cross-Origin Resource Sharing (CORS) |
| `LOG_LEVEL` | `standard` | Runtime log profile: `verbose`, `standard`, or `minimal` |

### Log Profiles

| Profile | Enabled levels | Intended use |
|---------|----------------|--------------|
| `verbose` | `fatal`, `error`, `warn`, `log`, `debug`, `verbose` | Local investigation and detailed lifecycle traces |
| `standard` | `fatal`, `error`, `warn`, `log` | Normal development and production default |
| `minimal` | `fatal`, `error`, `warn` | Reduced production output |

Lifecycle logs contain job ids, URL indexes, counts, state transitions, and error types. They do not contain request bodies, complete URLs, query strings, or URL credentials.

## Client Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `/api` | Base URL used by the Vue API client |

Set `VITE_API_URL` at client build time when the browser must call an API at another origin.

## Processing Limits

| Limit | Value |
|-------|-------|
| URLs per job | 1–100 |
| URL length | 2048 characters after trimming |
| Concurrent checks per job | 5 |
| HEAD request timeout | 15 seconds |
| Result delay | Random 0–10 seconds |

Job data is stored only in the API process. Restarting the server or container clears all job history.

## Docker

```bash
docker compose up --build
```

Docker Compose exposes port `3000`. The production image builds the Vue client, copies it into the NestJS static directory, and serves the web interface and `/api` from the same container.

## See Also

- [API Reference](api.md) — request and response contracts
- [Verification](../README.md#verification) — build and test commands
