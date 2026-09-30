# URL Shortener

A small URL shortener API built with **Express 5**, **MongoDB** (via Mongoose) and **Redis**.

Short links are random 7-character base62 codes. Redis sits in front of MongoDB as a
read-through cache (and de-duplicates repeated submissions), while click counts are
buffered in Redis and flushed to MongoDB in batches so redirects stay cheap.

## Features

- Create short URLs with automatic de-duplication (the same URL always maps to the same code).
- 7-character base62 codes generated from `crypto.randomBytes` (~3.5 trillion combinations).
- URL validation: only `http`/`https` URLs up to 2048 characters are accepted.
- Redis read-through cache for redirects and URL lookups, with a configurable TTL.
- Buffered click counting: `INCR` on every redirect, batched into MongoDB on an interval.
- Rate limiting on the create endpoint (10 requests per 15 minutes per IP).
- Fail-open design: if Redis is unavailable the API still serves redirects from MongoDB.

## Requirements

- Node.js 20.19+ (developed on Node 25; required by Mongoose 9)
- MongoDB and Redis — the included `docker-compose.yml` starts both

## Getting started

Start the datastores:

```bash
docker compose up -d
```

Install dependencies and run:

```bash
npm install
npm start
```

The server listens on <http://localhost:3000>.

## Configuration

All settings are environment variables with sensible local defaults:

| Variable                 | Default                                          | Description                                   |
| ------------------------ | ------------------------------------------------ | --------------------------------------------- |
| `MONGO_URI`              | `mongodb://127.0.0.1:27017/urlshortener`          | MongoDB connection string                     |
| `REDIS_URL`              | `redis://127.0.0.1:6379`                          | Redis connection string                       |
| `CACHE_TTL_SECONDS`      | `86400`                                           | TTL (seconds) for cached codes and URL lookups |
| `CLICKS_SYNC_INTERVAL_MS`| `10000`                                           | How often buffered clicks are flushed to MongoDB |

Example:

```bash
MONGO_URI=mongodb://127.0.0.1:27017/urlshortener REDIS_URL=redis://127.0.0.1:6379 npm start
```

The port is hardcoded to `3000` in `index.js`.

## API

### `GET /`

Health check.

```bash
curl http://localhost:3000/
```

```json
{ "message": "URL Shortener API is running" }
```

### `POST /api/shorten`

Create a short URL. Rate limited to 10 requests per 15 minutes per IP.

```bash
curl -X POST http://localhost:3000/api/shorten \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/a/very/long/path"}'
```

```json
{
  "shortCode": "aB3xY9z",
  "shortUrl": "http://localhost:3000/aB3xY9z",
  "originalUrl": "https://example.com/a/very/long/path",
  "deduplicated": false
}
```

Posting a URL that already exists returns the existing code with HTTP `200` and
`"deduplicated": true`, instead of creating a new one.

**Responses**

| Status | Body                                     | When                                   |
| ------ | ---------------------------------------- | -------------------------------------- |
| `201`  | `{ shortCode, shortUrl, originalUrl, deduplicated }` | New short URL created           |
| `200`  | `{ shortCode, shortUrl, originalUrl, deduplicated: true }` | URL already exists        |
| `400`  | `{ "error": "URL is required" }`          | Missing `url` in the body              |
| `400`  | `{ "error": "URL must be a valid http or https URL" }` | Invalid URL   |
| `429`  | `{ "error": "Too many requests, please try again later." }` | Rate limit exceeded |
| `500`  | `{ "error": "Failed to create short URL" }` | Database/cache failure              |

### `GET /:shortCode`

Redirect (HTTP `302`) to the original URL and record a click. Unknown codes return
`404 { "error": "Short URL not found" }`.

```bash
curl -i http://localhost:3000/aB3xY9z
```

### `GET /api/stats/:shortCode`

Click statistics for a short code.

```bash
curl http://localhost:3000/api/stats/aB3xY9z
```

```json
{
  "shortCode": "aB3xY9z",
  "originalUrl": "https://example.com/a/very/long/path",
  "clicks": 128,
  "pendingClicks": 7,
  "createdAt": "2026-09-30T12:00:00.000Z"
}
```

`clicks` is the persisted total in MongoDB; `pendingClicks` is the count still buffered
in Redis and not yet flushed, so `clicks + pendingClicks` is the up-to-date total.

## How it works

### De-duplication and caching

Three Redis keys are used, all with `CACHE_TTL_SECONDS` as their TTL:

| Key           | Value                              | Purpose                                  |
| ------------- | ---------------------------------- | ---------------------------------------- |
| `code:<shortCode>` | original URL                  | Serves redirects without hitting MongoDB |
| `url:<sha256(originalUrl)>` | short code        | Maps a URL back to its code for de-dupe |
| `clicks:<shortCode>` | pending click count          | Click buffer, drained on the sync interval |

`POST /api/shorten` checks the `url:` key first, falls back to a MongoDB lookup on
`originalUrl`, and only then creates a new document. Because `originalUrl` is indexed,
that fallback lookup is cheap.

### Click tracking

Every redirect increments `clicks:<shortCode>` in Redis (a single `INCR`, no read).
A background timer runs every `CLICKS_SYNC_INTERVAL_MS` and drains the buffers: it
`SCAN`s for `clicks:*` keys, reads each one with `GETDEL` (atomic fetch-and-delete, so
no clicks are lost if the process dies mid-drain) and applies the total to MongoDB with
`$inc`. Redis can only hold so much of the keyspace in one pass, hence `SCAN` over `KEYS`.

The timer is `unref`'d so it never keeps the process alive on its own.

### Failure behaviour

Cache access is fail-open. If Redis is not ready or an operation throws, lookups fall
through to MongoDB and click increments are written straight to MongoDB instead. The API
stays up with Redis down — it just becomes slower.

## Project structure

```
.
├── index.js             # Entire application: config, models, helpers, routes
├── docker-compose.yml   # Local MongoDB + Redis
├── package.json
└── .gitignore
```

## Known limitations

- `shortUrl` in responses is hardcoded to `http://localhost:3000`; there is no base-URL
  configuration.
- No tests are set up yet (`npm test` exits with an error).
- Rate limiting is in-memory, so it resets on restart and is not shared between instances.
- The short code is generated without a uniqueness retry loop; a collision returns a
  duplicate-key `500`.

## License

ISC