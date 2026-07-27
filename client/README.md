# Async URL Checker Client

Vue 3, TypeScript, and Pinia frontend for creating URL-check jobs and following their asynchronous progress.

## Requirements

- Node.js `^20.19.0`, `^22.12.0`, or a newer supported release
- npm

## Install

```bash
npm ci
```

## Development

```bash
npm run dev
```

The Vite development server starts at `http://localhost:5173` and proxies `/api` requests to the backend on port 3000.

## Regression tests

Run the deterministic frontend suite once:

```bash
npm test
```

Run the suite in watch mode while developing:

```bash
npm run test:watch
```

The suite covers Pinia loading, submission, cancellation, polling, stale-response isolation, and the public `JobForm` submit contract. API calls, timers, and asynchronous races are controlled by mocks, so the backend and network are not required.

## Production build

```bash
npm run build
```

The build command performs Vue and TypeScript checks before creating `dist/`.
