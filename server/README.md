# TripHub server

Go backend for TripHub: REST API (`/api/v1`, see [`docs/API.md`](../docs/API.md)), user uploads (`/uploads/`)
and the embedded web frontend (SPA). Single static binary; data lives in Postgres + `DATA_DIR`.

## Run

```bash
# Postgres 16 must be reachable (default DSN below)
cd server
go run ./cmd/triphub                 # listens on :8080
go run ./cmd/triphub -version
```

To ship the web UI inside the binary, build `web/` and copy its output into `internal/webui/dist/`
before `go build` (without it `/` shows a “前端尚未构建” notice page; the API works regardless).

```bash
go build -trimpath -ldflags "-s -w -X triphub/internal/version.Version=v1.0.0" -o triphub ./cmd/triphub
```

The binary embeds CA roots and zoneinfo, so it runs in a `FROM scratch` image.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TRIPHUB_ADDR` | `:8080` | Listen address |
| `TRIPHUB_DB_DSN` | `postgres://triphub:triphub@localhost:5432/triphub?sslmode=disable` | Postgres DSN (schema is auto-migrated) |
| `TRIPHUB_DATA_DIR` | `./data` | Uploads (`uploads/YYYY/MM/…`) and the generated `jwt_secret` |
| `TRIPHUB_JWT_SECRET` | *(generated)* | HMAC secret; generated once and stored at `DATA_DIR/jwt_secret` if empty |
| `TRIPHUB_ADMIN_USERNAME` / `TRIPHUB_ADMIN_PASSWORD` | – | Create this admin if missing (or promote an existing user) |
| `TRIPHUB_AMAP_KEY` | – | 高德 Web 服务 key: POI search, reverse geocoding, nearby search. Without it search falls back to offline province/city search |
| `TRIPHUB_CORS_ORIGINS` | – | Comma-separated allowed origins (`*` for any), e.g. `http://localhost:5173`. Empty = same-origin only |
| `TRIPHUB_MAX_UPLOAD_MB` | `20` | Max size of one uploaded image |
| `TRIPHUB_SITE_NAME` | `TripHub` | Initial site name (admin settings override it) |
| `TRIPHUB_TILES_NORMAL` / `TRIPHUB_TILES_SATELLITE` / `TRIPHUB_TILES_SATELLITE_LABEL` | 高德 raster tiles | Comma-separated tile URL templates returned by `GET /site` |
| `TRIPHUB_AI_BASE_URL` | – | OpenAI-compatible endpoint, e.g. `https://api.deepseek.com/v1`, `http://localhost:11434/v1` (Ollama) |
| `TRIPHUB_AI_API_KEY` | – | API key (optional for local models) |
| `TRIPHUB_AI_MODEL` | – | Model name, e.g. `deepseek-chat`, `qwen2.5:7b`. AI is enabled when base URL and model are set |
| `TRIPHUB_AI_TIMEOUT` | `30s` | AI request timeout (Go duration or seconds) |

## Layout

```
cmd/triphub          main: config, DB connect + migrate, admin seed, HTTP server, graceful shutdown
internal/config      environment configuration
internal/model       GORM models
internal/db          Postgres connection + AutoMigrate + extra indexes
internal/auth        bcrypt, JWT access tokens, rotating refresh tokens, rate limiter
internal/geo         WGS84⇄GCJ02, haversine, Douglas-Peucker, offline TopoJSON atlas lookup/search
internal/amap        高德 Web API client (search, around, regeo) with cache + circuit breaker
internal/ai          OpenAI-compatible chat client + robust JSON extraction
internal/media       image processing/storage, thumbnails, EXIF
internal/service     business logic: permissions, exp/levels, notifications, stats, places, footprints,
                     recommendations, AI itinerary
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
