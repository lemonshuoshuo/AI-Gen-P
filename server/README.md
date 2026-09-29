# TripHub server

Go backend for TripHub: REST API (`/api/v1`, see [`docs/API.md`](../docs/API.md)), user uploads (`/uploads/`)
and the embedded web frontend (SPA). Single static binary; data lives in Postgres + `DATA_DIR`.

## Run

```bash
# Postgres 16 must be reachable (default DSN below)
cd server
go run ./cmd/triphub                 # listens on :8080
go run ./cmd/triphub -version
go run ./cmd/triphub -healthcheck    # exit 0 if the server on TRIPHUB_ADDR answers /api/v1/health, else 1
```

`-healthcheck` is the Docker `HEALTHCHECK` of the `FROM scratch` images (no shell or curl there): it reads only
`TRIPHUB_ADDR` (a wildcard host such as `:8080` or `0.0.0.0:8080` is probed at `127.0.0.1`), ignores `HTTP(S)_PROXY`
and gives up after 3 s. On SIGTERM / Ctrl-C the server lets requests in flight finish for up to 40 s (keep the
compose `stop_grace_period` above that), then closes the remaining connections; a second signal exits at once.

Forgotten password (e.g. the admin's): set a new one from the server shell. It reads the same
`TRIPHUB_*` environment (DB DSN), signs the user out everywhere and prints the password.

```bash
docker compose exec app /triphub reset-password -user admin              # random password
TRIPHUB_DB_DSN=... ./triphub reset-password -user alice -password 'new-pass-123'
./triphub reset-password -user alice -admin                               # also make admin + unban
```

Admins reset other users' passwords in the admin console (`POST /api/v1/admin/users/:id/reset-password`).

To ship the web UI inside the binary, build `web/` and copy its output into `internal/webui/dist/`
before `go build` (without it `/` shows a “前端尚未构建” notice page; the API works regardless).

```bash
go build -trimpath -ldflags "-s -w -X triphub/internal/version.Version=v1.2.1" -o triphub ./cmd/triphub
```

The binary embeds CA roots and zoneinfo, so it runs in a `FROM scratch` image.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TRIPHUB_ADDR` | `:8080` | Listen address |
| `TRIPHUB_DB_DSN` | `postgres://triphub:triphub@localhost:5432/triphub?sslmode=disable` | Postgres DSN (schema is auto-migrated). Parts the DSN leaves out are taken from the standard libpq variables (`PGPASSWORD`, `PGHOST`, …); prefer `PGPASSWORD` over putting a password with URL-reserved characters (`/ # ? % @`, spaces) in the URL, or URL-encode them |
| `TRIPHUB_DATA_DIR` | `./data` | Uploads (`uploads/YYYY/MM/…`) and the generated `jwt_secret` |
| `TRIPHUB_JWT_SECRET` | *(generated)* | HMAC secret; generated once and stored at `DATA_DIR/jwt_secret` if empty. If set, it must be at least 32 characters (startup fails otherwise), e.g. `openssl rand -hex 32` |
| `TRIPHUB_ADMIN_USERNAME` / `TRIPHUB_ADMIN_PASSWORD` | – | Create this admin if missing; the password must meet the password policy (8–64 characters, not a placeholder such as the one in `.env.example`), otherwise startup fails. Never changes an existing account's password; an existing normal user is promoted only if the password matches its current one (otherwise a warning is logged). Forgot it? Use `reset-password` |
| `TRIPHUB_AMAP_KEY` | – | 高德 key of the **「Web服务」** platform: POI search (keyword search + input tips, merged), reverse geocoding (AOIs / POIs for map picks and auto names), nearby search, route planning (leg distances and times of a planned route). Without it (or while it fails) search falls back to Tianditu or offline province/city search and legs are estimated from straight-line distances; failures are reported as `amap_error` and in `GET /api/v1/admin/diagnostics` |
| `TRIPHUB_TIANDITU_KEY` | – | Optional 天地图 key of type 「服务端」: free fallback for place search (`/v2/search`) and reverse geocoding (`/geocoder`) when AMap is not configured, fails or finds nothing. Coordinates (CGCS2000 ≈ WGS-84) are converted to GCJ-02 |
| `TRIPHUB_CORS_ORIGINS` | – | Comma-separated allowed origins (`*` for any), e.g. `http://localhost:5173`. Empty = same-origin only |
| `TRIPHUB_TRUSTED_PROXIES` | loopback + private ranges | Comma-separated IPs / CIDRs whose `X-Forwarded-For` / `X-Real-IP` is trusted for the client IP (rate limits, logs). `none` = trust nobody (use it when clients reach the app through a port forwarder such as rootless Docker, frp, or docker-proxy for IPv6) |
| `TRIPHUB_MAX_UPLOAD_MB` | `20` | Max size of one uploaded image |
| `TRIPHUB_SITE_NAME` | `TripHub` | Initial site name (admin settings override it) |
| `TRIPHUB_TILES_NORMAL` / `TRIPHUB_TILES_SATELLITE` / `TRIPHUB_TILES_SATELLITE_LABEL` | 高德 raster tiles | Comma-separated tile URL templates returned by `GET /site` |
| `TRIPHUB_TILES_ATTRIBUTION` | `© 高德地图` | Basemap copyright / 审图号 shown in the map corner (`GET /site` `map.attribution`, HTML allowed); set it when using other tiles |
| `TRIPHUB_AI_BASE_URL` | – | OpenAI-compatible endpoint, e.g. `https://api.deepseek.com`, `http://localhost:11434/v1` (Ollama). With or without `/v1`, trailing slashes, or the full `…/chat/completions` URL |
| `TRIPHUB_AI_API_KEY` | – | API key (optional for local models) |
| `TRIPHUB_AI_MODEL` | – | Model name, e.g. `deepseek-flash`, `qwen-plus`, `qwen2.5:7b`. AI is enabled when base URL and model are set |
| `TRIPHUB_AI_TIMEOUT` | `120s` | Timeout of an AI plan (Go duration or seconds); recommendation reranking waits at most 20 s and falls back to rules |
| `TRIPHUB_AI_THINKING` | `off` | Reasoning mode: `off` sends `"thinking":{"type":"disabled"}` to DeepSeek hosts and `"enable_thinking":false` to DashScope / Qwen hosts (nothing to others); `on` / `low` / `high` / `max` enable DeepSeek thinking (with `reasoning_effort` for the last three) |
| `TRIPHUB_AI_EXTRA_BODY` | – | JSON object merged into every chat request body (provider-specific options), overriding the thinking fields. A 400 / 422 that names an optional field (thinking, response_format, extra fields) is retried once without them |
| `GOMEMLIMIT` | unlimited (compose: `800MiB`) | Go runtime soft memory limit, e.g. `1500MiB` (units `MiB` / `GiB`), so the server leaves memory to Postgres on small hosts |

## Layout

```
cmd/triphub          main: config, DB connect + migrate, admin seed, HTTP server, graceful shutdown, -healthcheck
internal/config      environment configuration
internal/model       GORM models
internal/db          Postgres connection + AutoMigrate + extra indexes
internal/auth        bcrypt, JWT access tokens, rotating refresh tokens, rate limiter
internal/geo         WGS84⇄GCJ02, haversine, Douglas-Peucker, offline TopoJSON atlas lookup/search
internal/amap        高德 Web API client (search + input tips, around, detail, regeo with AOIs/POIs, direction) with cache,
                     circuit breaker and Chinese error explanations
internal/tianditu    天地图 client (place search V2.0, reverse geocoding): optional fallback, same caching / breaker style
internal/lru         small LRU cache with TTL used by the map clients
internal/ai          OpenAI-compatible chat client: thinking switch per provider, streaming (SSE), retries without
                     unknown optional fields, Chinese error messages, robust JSON extraction
internal/media       image processing/storage, thumbnails, EXIF
internal/service     business logic: permissions, exp/levels, notifications, stats, places, footprints,
                     recommendations, AI itinerary, route legs
internal/handler     Gin handlers, middleware, DTOs (+ integration test)
internal/webui       embedded SPA (dist/)
```

## Tests

```bash
go vet ./... && go test ./...
# integration test against a real Postgres (DROPS the public schema of that database!)
docker exec triphub-pg psql -U triphub -c "CREATE DATABASE triphub_test"
TRIPHUB_TEST_DSN="postgres://triphub:triphub@localhost:5432/triphub_test?sslmode=disable" go test ./... -count=1
```
