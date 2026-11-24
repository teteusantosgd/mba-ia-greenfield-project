# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -fs http://localhost:9000/minio/health/live` — expect exit code 0; `docker compose ps -a storage-init` must show `Exited (0)` (bucket created)
- **Video worker:** `docker compose logs video-worker` — expect `WorkerModule dependencies initialized` with no restart loop

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# First run, in this order
cp .env.example .env
docker compose up -d --build
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npm run migration:run
docker compose restart video-worker   # it keeps restarting until node_modules exists

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — same image and volume as `nestjs-api`; builds the worker into `dist-worker/` and runs it with `exec node`, so node is PID 1 and gets the `SIGTERM` (npm and `nest start --watch` do not forward it). Consumes the `video-processing` queue; no HTTP port. **No hot reload: after changing worker code run `docker compose restart video-worker`.** `stop_grace_period: 3m` lets it finish the active job on `docker compose stop`. For watch mode, stop the service and run `npm run start:worker` in `nestjs-api` instead — never both, or two workers share the queue
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7.4 for BullMQ, port `6379`
- `minio` — S3-compatible storage, API on `9000`, console on `9001` (login = `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`). Image `pgsty/minio`, a community fork: `minio/minio` is no longer published on Docker Hub
- `storage-init` — one-shot `mc` container that creates the bucket and exits
- `mailpit` — SMTP on `1025`, web UI on `8025`

The image includes `ffmpeg`/`ffprobe` (`Dockerfile.dev`). After changing the Dockerfile run `docker compose up -d --build`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run start:worker                     # Video worker with hot-reload (output in dist-worker/, so it does not wipe the API's dist/); stop the video-worker service first
npm run build                            # Compile API and worker to dist/
npm run start:prod                       # Run compiled API
npm run start:worker:prod                # Run compiled worker (dist/worker.js)
npm run migration:run                    # Apply pending migrations

npm test                                 # Unit + integration tests, serially
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests, serially

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database, so they run serially: `npm test` and `npm run test:e2e` already pass `--runInBand`.

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Suites that touch the video queue set their own `QUEUE_PREFIX` before compiling the Nest module, so the Compose `video-worker` (prefix `bull`) never takes their jobs, and they obliterate their queue at the end. Suites that fetch presigned URLs from inside the container set `STORAGE_PUBLIC_ENDPOINT` to the internal endpoint. The Compose worker shares the database with the tests: its reconciliation only picks videos stuck in `processing` for more than 10 minutes, so it does not race the suites, but it may reprocess rows a suite left behind.

Generated media for tests (`src/test/video-fixtures.ts`) is built with ffmpeg once into the container's temp dir and reused. Storage objects created by tests are removed with `cleanStorage(prefix)` (`src/test/storage.ts`).

## Environment Variables

Validated by `src/config/env.validation.ts`; defaults in `.env.example`.

| Variable | Default | Notes |
|----------|---------|-------|
| `STORAGE_ENDPOINT` | `http://minio:9000` | Used by the API and the worker inside the Compose network |
| `STORAGE_PUBLIC_ENDPOINT` | `http://localhost:9000` | Host in the presigned URLs handed to the browser |
| `STORAGE_REGION` | `us-east-1` | |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | — (required) | Also the MinIO root credentials in Compose |
| `STORAGE_BUCKET` | `streamtube` | Created by `storage-init` |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | |
| `QUEUE_PREFIX` | `bull` | BullMQ key prefix; tests override it |

## OpenAPI Export

`npm run openapi:export` runs through ts-node, which skips the `@nestjs/swagger` CLI plugin, so DTOs inferred from `class-validator` come out empty. To regenerate `openapi.json` with the plugin applied:

```bash
docker compose exec nestjs-api sh -c 'npx nest build && node -e "require(\"./dist/openapi-export\").exportSpec()"'
```

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- `CoreModule` (`src/core/`) holds the global config, TypeORM and BullMQ connection; both `AppModule` (API) and `WorkerModule` (`src/worker/`, entrypoint `src/worker.ts`) import it
- `src/videos/` is the HTTP side (upload, playback); `src/videos/processing/` is what the worker runs. `VideoProcessor` is registered only in `WorkerModule`, so the API process never consumes the queue
- `src/storage/` wraps the S3 client (multipart, presigned URLs) for both processes
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
