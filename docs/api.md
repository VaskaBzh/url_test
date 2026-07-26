[Back to README](../README.md) · [Configuration →](configuration.md)

# API Reference

The REST API uses the `/api` prefix. Local development defaults to `http://localhost:3000/api`. Authentication is not required.

## Endpoints

| Method | Path | Success | Description |
|--------|------|---------|-------------|
| `POST` | `/jobs` | `201` | Validate URL input and start a job |
| `GET` | `/jobs` | `200` | List job summaries, newest first |
| `GET` | `/jobs/:id` | `200` | Read URL-level job details |
| `DELETE` | `/jobs/:id` | `204` | Cancel pending URL checks |

`DELETE` is idempotent for terminal jobs and always returns an empty body on success.

## Create a Job

```http
POST /api/jobs
Content-Type: application/json

{"urls":["https://example.com","http://localhost:8080/health"]}
```

Success response:

```json
{"jobId":"73d86e28-3018-4d7b-8c10-7d5b2fb43e9a"}
```

### Request Validation

| Rule | Contract |
|------|----------|
| Body | Non-null JSON object |
| `urls` | Required array containing 1–100 items |
| Item type | Primitive string |
| Item length | 1–2048 characters after trimming |
| URL form | Absolute WHATWG URL using `http` or `https` |
| Compatibility | Unknown body fields are ignored |
| Ordering | Input order and duplicate URLs are preserved |

Localhost, IP addresses, ports, paths, and query strings are accepted. Validation messages identify an item by index, such as `urls[2]`, without reflecting the submitted URL value.

## Job Summary

`GET /api/jobs` returns an array with this shape:

```json
[
  {
    "id": "73d86e28-3018-4d7b-8c10-7d5b2fb43e9a",
    "createdAt": "2026-07-26T12:00:00.000Z",
    "status": "completed",
    "totalUrls": 2,
    "successfulUrls": 1,
    "errorUrls": 1
  }
]
```

## Job Details

`GET /api/jobs/:id` returns the job and its URL checks. Optional timing, HTTP status, and error fields are omitted until they apply.

```json
{
  "id": "73d86e28-3018-4d7b-8c10-7d5b2fb43e9a",
  "createdAt": "2026-07-26T12:00:00.000Z",
  "status": "completed",
  "urlChecks": [
    {
      "url": "https://example.com",
      "status": "success",
      "httpStatus": 200,
      "startedAt": "2026-07-26T12:00:00.010Z",
      "completedAt": "2026-07-26T12:00:01.010Z",
      "durationMs": 1000
    }
  ]
}
```

Any received HTTP status, including `4xx` and `5xx`, is a successful HEAD check with `httpStatus`. Transport failures and timeouts produce URL status `error`.

## Error Responses

Validation failures return `400` and unknown jobs return `404`:

```json
{
  "statusCode": 400,
  "message": "urls[0] must use http or https",
  "error": "Bad Request"
}
```

Unknown job responses use the generic message `Job was not found` and do not reflect the requested id.

## Lifecycle

| Entity | Allowed transitions |
|--------|---------------------|
| Job | `pending → in_progress`, then `completed`, `cancelled`, or `failed` |
| URL | `pending → in_progress → success/error` |
| Pending URL | `pending → cancelled` after job cancellation |

A job may be `completed` even when individual URL checks have status `error`. Job status `failed` is reserved for unexpected internal processor failures. Cancellation takes precedence over a late internal failure.

## See Also

- [Configuration](configuration.md) — environment variables and log profiles
- [Quick Start](../README.md#quick-start) — run the API and client locally