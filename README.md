# Short URL Generator

A serverless URL shortener built with Cloudflare Workers, TypeScript, and Cloudflare native services.

![Tech Stack](https://img.shields.io/badge/tech-Cloudflare%20Workers%20%7C%20TypeScript%20%7C%20R2%20%7C%20KV-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Free Plan](https://img.shields.io/badge/cost-Free%20Plan%20%7C%20$0%20/month-brightgreen)

## Features

### URL Shortening (Core)

- Shorten any HTTPS URL with optional expiration
- Customizable expiration: `15m`, `1h`, `1d`, `1w`, or custom
- One-time (burn-after-reading) links via `oneTime: true`
- Automatic URL validation and normalization

### Image Upload Service

- Upload images via multipart/form-data
- Images stored in Cloudflare R2 bucket
- Get short links: `/img/:code`
- One-time (burn-after-reading) image links via `oneTime` form field
- Serve optimized images with proper headers

## Prerequisites

- [bun](https://bun.sh/) (v1.0+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v4.0+)

## Cloudflare Setup

### 1. Log in to Cloudflare

```bash
wrangler login
```

### 2. Create KV Namespace

```bash
wrangler kv namespace create SHORT_URLS
```

Add the returned ID to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SHORT_URLS"
id = "YOUR_KV_NAMESPACE_ID"
```

### 3. Create R2 Bucket (for Image Upload)

```bash
wrangler r2 bucket create short-url-images
```

## Local Development

```bash
bun install
bun start
```

Runs `wrangler dev` on port 8787 with local emulation.

## Web Interface

Access the interface at `http://localhost:8787/`

You can toggle between:

- **URL Shortener**: Paste URL, get short link
- **Image Uploader**: Select image, get short link to R2 object

## API Reference

### `POST /api/shorten`

Shorten a URL.

```bash
curl -X POST https://your-worker.workers.dev/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","duration":"24h","oneTime":true}'
```

- `url` (required): http(s) only.
- `duration` (optional): `15m`, `1h`, `24h` (default), `1w`, or custom like `36h`.
- `oneTime` (optional): `true` burns the link after the recipient reveals it (`GET` shows a confirm page safe for previews/bots, `POST` burns).

```json
{
  "code": "abc123",
  "shortUrl": "https://your-worker.workers.dev/abc123",
  "expiresAt": "2024-01-01T00:00:00.000Z",
  "oneTime": true
}
```

### `POST /api/upload`

Upload an image, get a link back. Max 10 MB: png jpeg gif webp.

```bash
curl -X POST https://your-worker.workers.dev/api/upload \
  -F image=@cat.png -F duration=24h -F oneTime=true
```

- `image` (required): the file.
- `duration` (optional): same values as above.
- `oneTime` (optional, `true`/`1`): burns the link after the recipient reveals it (`GET` shows a confirm page safe for previews/bots, `POST` burns).

```json
{
  "code": "a1b2c3d4.png",
  "shortUrl": "https://your-worker.workers.dev/img/a1b2c3d4.png",
  "originalMimeType": "image/png",
  "expiresAt": "2024-01-02T00:00:00.000Z"
}
```

### `GET /:code`

`301` to target. `404` if unknown (or already burned). `410` if expired. One-time links return a `200` confirm page on `GET` (`no-store`); `POST` burns then `301` redirects (`no-store`).

### `GET /img/:code`

Serves the image. `404` if missing (or already burned). `410` if expired. One-time images return a `200` confirm page on `GET` (`no-store`); `POST` burns then serves (`no-store`).

### `POST /:code`, `POST /img/:code`

Consume a one-time link/image (the confirm-page form posts here). Behaves like the `GET` for regular entries.

### Notes

Links expire — default `24h`. Expired entries return `410` and are deleted on access. Errors look like `{"error": "..."}` with a matching status code. Full version at `GET /api/docs`.

## Deployment

```bash
bun run deploy
```

Or individually:

```bash
npx wrangler deploy
```

## Development

- Typecheck: `bun run typecheck` (TypeScript strict; pinned to v5, see AGENTS.md)
- Lint: `bun run lint` (ESLint 9 flat config); fix with `bun run lint:fix`
- Format: `bun run format` (Prettier 3); check with `bun run format:check`
- Tests: `bun test`
- Pre-commit runs `lint-staged` (ESLint + Prettier on staged files) then `tsc --noEmit` via husky.
