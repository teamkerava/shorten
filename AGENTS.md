# AGENTS.md — short-url-worker (Cloudflare Workers URL shortener + image host)

> **Keep me fresh (agent rule):** any change to behavior, routes, bindings, limits,
> commands, or layout must update this file in the _same_ commit. One line per
> fact, no fluff. The pre-commit hook reminds you if you forget (non-blocking).

## Commands

| Action    | Command                                                            |
| --------- | ------------------------------------------------------------------ |
| Install   | `bun install`                                                      |
| Dev       | `bun start` (`wrangler dev`, port 8787, emulates KV/R2 locally)    |
| Deploy    | `bun run deploy`                                                   |
| Tests     | `bun test` (single file `src/index.test.ts`; baseline 29 pass)     |
| Typecheck | `bun run typecheck` (`tsc --noEmit`, strict)                       |
| Lint      | `bun run lint` (ESLint 9 flat config); fix with `bun run lint:fix` |
| Format    | `bun run format` (Prettier 3); check with `bun run format:check`   |

- TypeScript is pinned to v5 (`^5.9`): `typescript-eslint` does not support TS 7 yet. Don't upgrade without verifying `bun run lint` passes.
- Pre-commit (`.husky/pre-commit`) runs `lint-staged` (Prettier + ESLint on staged files) then `tsc --noEmit`; both block. Never pass filenames to `tsc` (hard-errors `TS5112` alongside `tsconfig.json`).
- `wrangler` CLI requires **Node ≥ 22** — use bun for tests/typecheck/lint instead.

## Layout

- `src/index.ts` wires the router (`itty-router` `AutoRouter`) and re-exports lib helpers for tests. Handlers in `src/routes/shorten.ts` (`POST /api/shorten`, `GET`+`POST /:code`) and `src/routes/upload.ts` (`POST /api/upload`, `GET`+`POST /img/:code`); shared code in `src/lib/{types,utils}.ts`. Dedup helpers: `parseStoredLink` (shorten), `readImageState` + `imageCacheControl` + shared `serveImage(consume)` (upload).
- `public/` is served by the platform **before** the Worker runs (`[assets]` + `ASSETS` binding). `GET /` never reaches the Worker. Frontend (`app.js`) is vanilla JS, no build step; docs edited directly in `public/docs.html`.
- `index.html`/`docs.html` carry Open Graph + Twitter Card tags with absolute prod URLs (`https://url.imuroin.net/...`) plus `public/og-image.png` (1200×630). Keep absolute URLs in sync if the domain changes. Header links to `github.com/teamkerava/shorten`.
- Short-link (`/:code`) embeds resolve to the _target's_ preview (bare 301); `/img/:code` embeds as raw image. One-time entries embed as the confirm page (no leak, `no-store` + `noindex`).
- Active tab persists in a `shorten.defaultTab` cookie (1yr, `SameSite=Lax`). Image pane: clipboard paste, client-side type/size check, thumbnail, XHR upload with progress + cancel, and a "deleted automatically after 30 days" note (load-bearing, see bindings). Tabs use `tablist`/`tab`/`tabpanel` roles; dropzone is a labelled `button`.

## Gotchas (read before touching read paths)

- **One-time links burn only on POST.** `GET` renders `oneTimeConfirmResponse` (no target/image bytes, `no-store` + `noindex`); the form `POST` deletes then redirects/serves. Frontend previews one-time images via local `URL.createObjectURL`, never the server URL.
- **R2 `customMetadata`: write lowercase (`onetime`), accept both cases on read** (`readImageState`).
- **KV values have two formats**: legacy plain-string URLs and current JSON `{ url, createdAt, expiresAt, oneTime? }` (`parseStoredLink` handles both — don't drop legacy support).
- **Short-URL KV entries carry native `expirationTtl`** matching duration (60s minimum); manual 410 path stays for legacy entries without TTL.
- **Deletes are best-effort** (try/catch). Concurrent first-readers can race the burn — KV/R2 have no atomic take.
- **One-time redirects can't use `Response.redirect()`** — built manually with `no-store`.
- **Trailing-slash history**: `Response.redirect()` normalizes `https://example.com` → `https://example.com/`; tests assert the normalized form.
- **Test mocks must include `delete`** on KV/R2 envs. Call pattern: `worker.fetch(request, mockEnv as any, {} as any)`.
- **Rate limits**: `POST /api/shorten` 30/10min/IP, `POST /api/upload` 20/10min/IP — fixed-window counters in `SHORT_URLS` (`rl:` keys, KV TTL). 429 + `Retry-After`; unidentifiable IPs fail open.
- Error messages are deliberately snarky; keep status codes stable (tests + frontend `data.error` depend on them, not message text).

## Bindings (`wrangler.toml`; setup commands in its comments)

- KV `SHORT_URLS` (id `69c7cf8a99a54eadb89c230c8f4b5a06`), R2 `IMAGE_R2` (`short-url-images`), `ASSETS` (static files). No AI binding.
- R2 dashboard-side lifecycle policy deletes all objects after 30 days; `upload.ts` rejects image durations over 30d (`MAX_IMAGE_TTL_HOURS`). Cap is load-bearing.

## API

| Method | Path           | Notes                                                                                                                                                                                                              |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/shorten` | Body `{ url, duration?, oneTime? }` → `{ code, shortUrl, expiresAt, oneTime? }`, 201. `duration` is any `parseDuration` value (`15m`, `1h`, `24h` default, `1w`, `36h`, `10d`, bare hours). 429 when rate-limited. |
| `POST` | `/api/upload`  | Multipart `image` + `duration?` + `oneTime?` (`"true"`/`"1"`/`"on"`). 10 MB max, png/jpeg/gif/webp only. Image TTL capped at 30d (`MAX_IMAGE_TTL_HOURS`) + R2 lifecycle delete. 429 when rate-limited.             |
| `GET`  | `/:code`       | 301 (regular) / 200 confirm page (one-time) / 404 / 410 expired.                                                                                                                                                   |
| `POST` | `/:code`       | Consumes one-time (301 + `no-store` + delete); regular behaves like `GET`.                                                                                                                                         |
| `GET`  | `/img/:code`   | Image bytes (regular) / 200 confirm page (one-time); non-one-time `Cache-Control: max-age` capped at remaining TTL (max 86400s).                                                                                   |
| `POST` | `/img/:code`   | Consumes one-time (bytes + `no-store` + delete); regular behaves like `GET`.                                                                                                                                       |
| `GET`  | `/api/docs`    | Serves `public/docs.html` via `ASSETS`.                                                                                                                                                                            |
