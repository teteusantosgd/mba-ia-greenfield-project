# phase-03-videos — Progress

**Status:** completed
**SIs:** 14/14 completed

### SI-03.1 — Infraestrutura de storage, fila e FFmpeg no Compose
- **Status:** completed
- **Tests:** no tests (Infra). Verified by hand: `minio` and `redis` healthy, `storage-init` exits 0 on first and second run, CORS preflight from `http://localhost:3001` with `PUT` answers 204 with `Access-Control-Allow-Origin`, `ffprobe -version` prints 5.1.9 in `nestjs-api`
- **Observations:**
  - `npm install` resolved `@aws-sdk/*` to `^3.1175.0` (newest at install time, same major line as the plan).
  - `.env` received the new `STORAGE_*` / `REDIS_*` / `QUEUE_PREFIX` keys copied from `.env.example`.
  - After the first code review: `redis` got a named volume (`redis-data`), and `nestjs-api` also waits for `minio` healthy, as the plan states.
  - Redis loses the reconciliation scheduler if its data goes away; the worker registers it again on its next start.

### SI-03.2 — Configuração e serviço de object storage
- **Status:** completed
- **Tests:** 18 passing (storage service integration 6, storage module 1, env schema 11)
- **Observations:**
  - The wrong-length PUT is rejected because `content-length` is in `X-Amz-SignedHeaders` (checked on a generated URL).
  - `src/config/env.validation.integration-spec.ts` had two `no-unsafe-*` lint errors from before this phase; the new tests in the file avoid the pattern, and `feature/lint-cleanup` fixed the old ones.
  - After the first code review: `EntityTooSmall` (middle part under 5 MiB) maps to `InvalidPartsError` like `InvalidPart`; `cleanStorage` fails when `DeleteObjects` reports per-key errors; the internal S3 client is named `internalClient`; the wrong-length test asserts `SignatureDoesNotMatch`.
  - Not applied: translating `NoSuchUpload` on abort. MinIO answers 204 when aborting an upload that no longer exists, so the branch cannot be exercised, and no caller handles it.

### SI-03.3 — Entidade Video e migration
- **Status:** completed
- **Tests:** 7 passing (video entity 5, migrations 2), plus the users/channels/auth suites (118 in the DB-touching modules)
- **Observations:**
  - The migrations spec failed before this phase on an already migrated database (`type "verification_tokens_type_enum" already exists`): dropping the tables left the enum types behind. It now drops the managed enum types too, and drops the tables in a single statement because parallel `DROP ... CASCADE` deadlocks on the new `videos → channels` FK.
  - The dev database had tables without a `migrations` table (created by `synchronize` in older specs); it was reset with `DROP SCHEMA public CASCADE` and migrated from scratch.

### SI-03.4 — Infraestrutura compartilhada da API e do worker, e conexão com a fila
- **Status:** completed
- **Tests:** 2 passing (CoreModule integration) + env schema defaults for `REDIS_*`/`QUEUE_PREFIX`
- **Observations:**
  - `@nestjs/bullmq` 12.x is ESM-only and does not load under the project's CommonJS Jest; switched to `@nestjs/bullmq@^11.0.5` (peers Nest 11 and bullmq 6). `bullmq` 6 made `ioredis` an optional peer, so `ioredis@^5.11.1` is now a direct dependency. Recorded as a Revision on `phase-03-videos/TD-01`, in `context.md`, `library-refs.md` and SI-03.1 of the plan.

### SI-03.5 — Início do upload com pré-cadastro do rascunho
- **Status:** completed
- **Tests:** unit (startUpload: 7), integration (draft + open multipart), e2e (201 shape, 5 validation cases, 401, 11 calls not throttled)
- **Observations:**
  - The draft is written with `repository.insert` instead of `save`: the id is set by the service, and `save` would run a SELECT first to decide between insert and update.
  - A test module that loads `VideosModule` without `UsersModule` must register `User` (`Channel#user` is part of the metadata), same constraint the plan already noted for the worker.

### SI-03.6 — URLs de parte e estado do upload para retomada
- **Status:** completed
- **Tests:** integration (real PUT through the signed URL, listing, expired session), e2e (201/200 shapes, `INVALID_PART_NUMBER`, 3 validation cases, 404 for another user, 410)
- **Observations:** none

### SI-03.7 — Conclusão do upload e enfileiramento do processamento
- **Status:** completed
- **Tests:** unit (completeUpload: 8), integration (two concurrent completions → one job, object size, `upload_id` cleared), e2e (200 twice + single job, 409 `UPLOAD_INCOMPLETE` keeps draft, 404)
- **Observations:** none

### SI-03.8 — Leitura de metadados e extração de frame com FFmpeg
- **Status:** completed
- **Tests:** 18 passing (checkPlayback unit 13, MediaProbeService integration 5)
- **Observations:**
  - `execFile` errors include the whole command line, signed URL included; they are translated into messages that keep only the reason ffmpeg prints after the input name.

### SI-03.9 — Processamento do vídeo: metadados, thumbnail e status final
- **Status:** completed
- **Tests:** 11 passing (unit 7, integration 4: MP4 ready with thumbnail `image/jpeg`, AVI `unsupported_format`, text `invalid_media`, ready video untouched)
- **Observations:** none

### SI-03.10 — Worker de vídeo: consumer da fila e container próprio
- **Status:** completed
- **Tests:** 4 passing (VideoProcessor integration 2, WorkerModule integration 2)
- **Observations:**
  - Deviation from the plan: `VideoProcessor` is registered in `WorkerModule`, not in `VideoProcessingModule`. Any test module importing `VideoProcessingModule` would otherwise start a BullMQ worker on the default `bull` prefix and take jobs from the Compose worker. `VideoProcessingModule` registers the queue and exports the services; `WorkerModule` adds the processor.
  - The Compose `video-worker` started, registered the scheduler and, on its first reconciliation, picked a `processing` row left by a test in the shared database (expected; documented in `nestjs-project/CLAUDE.md`).

### SI-03.11 — Reconciliação de vídeos presos em processamento
- **Status:** completed
- **Tests:** 2 passing (reconciliation integration) + scheduler `every: 300000` asserted in the WorkerModule spec
- **Observations:** none

### SI-03.12 — Consulta do vídeo, streaming, download e thumbnail
- **Status:** completed
- **Tests:** unit (playback URLs: 6), e2e (details, stream 302 → 206 without the Bearer, download `Content-Disposition` with non-ASCII name, thumbnail JPEG, 409 for each asset while processing, 404 on all four routes for another user)
- **Observations:**
  - The service exposes `getStreamUrl`, `getDownloadUrl` and `getThumbnailUrl` instead of one `getPlaybackUrl(asset)`; each route maps to one method.

### SI-03.13 — Fluxo completo de upload a reprodução
- **Status:** completed
- **Tests:** 1 passing (`test/video-pipeline.e2e-spec.ts`: 41 MiB MP4 in 3 parts, resume after part 1, ready, 206, SHA-256 of the download, thumbnail JPEG)
- **Observations:**
  - `src/metadata.ts` is a stub (the plugin runs as a TypeScript transformer), so nothing to regenerate there. `openapi.json` was exported from the `nest build` output; the auth DTOs, empty in the previous export, now have their properties too.
  - `ArrayMaxSize` on `part_numbers` does not show up as `maxItems` in the generated schema (plugin limitation); the limit is enforced at runtime.
  - Container smoke test (API on `start:dev`, Compose `video-worker`, host curl): a 5 s 640x360 H.264/AAC MP4 registered, uploaded through the presigned part URLs, completed and ended `ready` with `duration_seconds: 5` and the expected metadata; stream `Range: bytes=0-99` → 206; download SHA-256 equal to the source; no `X-Amz-Signature` in the worker log.

### SI-03.14 — Documentação de IA e arquitetura da fase
- **Status:** completed
- **Tests:** no tests (documentation)
- **Observations:**
  - Root `CLAUDE.md` still says `next-frontend/` is not initialized, which is stale since phase 02 of the frontend; out of scope here.

## Final verification (before the second code review)

- `npx jest --runInBand`: 36 suites, 221 tests passing
- `npm run test:e2e`: 5 suites, 77 tests passing
- `npx tsc --noEmit`: exit 0
- `npx nest build`: exit 0, `dist/main.js` and `dist/worker.js` present
- `eslint` (without `--fix`): 150 errors, all in files that predate this phase (auth, channels, common/filters, mail, users, `env.validation.integration-spec.ts`, `create-test-data-source.ts`, `test/auth.e2e-spec.ts`); zero in files added or changed by this phase. `npm run lint` therefore still exits non-zero — follow-up for a separate PR.

## Second code review (SI-03.3 to SI-03.13) — applied

- **FFmpeg input:** `-format_whitelist mov,matroska` on ffprobe and ffmpeg. Without it, an HLS playlist uploaded as `.mp4` made ffprobe fetch a segment from an arbitrary host (reproduced in the container). AVI and playlists now fail with `UnsupportedContainerError` → `unsupported_format`.
- **Errors without the signed URL:** stderr is only used to classify; messages are fixed (`timed out`, `got HTTP 404 from the storage`, `exited with code N`), with timeout, missing binary and buffer overflow checked before media classification.
- **Thumbnail:** maps the video stream accepted by the probe (`-map 0:<index>`) and falls back to the first frame when the 10 % position yields nothing; `ready` is only written after a non-empty JPEG.
- **WebM vs Matroska:** ffprobe names both `matroska,webm`; the probe reads the EBML `DocType` (`webm`/`matroska`) with a 64-byte range request, and `video/webm` requires `webm`. Covered with a generated `.mkv` with VP9.
- **Resume after a lost completion:** `GET /videos/:id/upload` with the session gone but the object assembled reports every part as uploaded (the client then repeats `complete`) instead of `410`. Unit tests for that and for `CompleteMultipartUpload` losing the race after both calls listed the parts.
- **Worker shutdown:** the Compose service now runs `nest build --path tsconfig.worker.json && exec node dist-worker/worker.js` with `stop_grace_period: 3m`. Before, `npm` → `sh -c` → `nest --watch` never delivered `SIGTERM` to node (stop took 1 s, exit 1). Validated with an active job: MinIO paused so ffprobe hangs, `docker compose stop video-worker` waited 60 s (ffprobe timeout), exited 0, the attempt was recorded as a normal failure, and after restart the retry took the video to `ready`. Trade-off: no hot reload in the container (`docker compose restart video-worker`); `npm run start:worker` keeps watch mode.
- **Retry test:** attempts with a 2 s fixed backoff; asserts the job is delayed and the video still `processing` between attempts, then `failed`/`processing_failed`.
- **Input:** `filename` and `title` reject NUL (Postgres refuses it in text columns); the derived title is cut by code point.
- **Pipeline e2e:** duration checked within 0.1 s; helper renamed `waitForProcessingResult`.
- **`npm run test:e2e`** now passes `--runInBand` (the new e2e suites share the database with `auth.e2e-spec.ts`).
- **Smaller:** `%` replaced in the ASCII `filename` fallback; JSDoc of `requeueStuckVideos` and the CoreModule comment removed; reconciliation log reports candidates, not re-enqueued jobs; ffmpeg arguments written as explicit arrays.
- **Not applied — dedicated test database and bucket.** The shared `streamtube` database with `cleanAllTables` is the convention inherited from phases 01/02 (`nestjs-project/CLAUDE.md` → Test execution); moving every suite to its own database is a separate task. The Compose worker cannot race the reconciliation spec: a stuck fixture row takes three attempts and over 30 s to change status, and the spec reads it within milliseconds.

## Verification after the second code review

- `npx jest --runInBand`: 36 suites, 231 tests passing
- `npm run test:e2e`: 5 suites, 78 tests passing
- `npx tsc --noEmit`: exit 0
- `npx nest build`: exit 0, `dist/main.js` and `dist/worker.js` present; `openapi.json` re-exported from the build
- `eslint`: 150 errors, all in the 11 files that predate this phase; none in files of this phase. Fixed by `feature/lint-cleanup` (see the delivery review below).

## Delivery review (against the challenge acceptance criteria) — applied

Two reviewers checked the branch against the acceptance criteria and the automatic-failure list of the challenge.

- **Lint:** `npm run lint` failed on 150 errors from phases 01/02. They are fixed in `feature/lint-cleanup` (its own PR to `dev`), on which this branch is rebased. That branch types the mocks and response bodies in the old specs, reads `code`/`detail` from `driverError` in `ChannelsService`, and turns `unbound-method` off only in test files, as the typescript-eslint docs recommend for Jest.
- **`npm test`:** now passes `--runInBand`, like `test:e2e`. In parallel the integration suites clean the shared tables under each other and fail with FK violations.
- **`POST /videos` (201):** `duration_seconds`, `metadata` and `failure_reason` were missing from the body. `insert()` leaves nullable columns without a default `undefined`. The mapper now returns `null` for them, and the e2e asserts the three keys.
- **WebM DocType:** read with an EBML header parser (`src/videos/processing/ebml-header.ts`). It handles multi-byte sizes and a DocType anywhere in the first KiB, with the same timeout as ffprobe. It replaces the 64-byte scan.
- **Thumbnail:** an `InvalidMediaError` from ffmpeg (readable headers, undecodable frames) fails the video as `invalid_media` instead of being retried.
- **Reconciliation scheduler:** its jobs are removed on completion and failure, so Redis does not keep one per run.
- **OpenAPI:** the `401` response is declared once on `VideosController` and applies to all eight routes. `openapi.json` was re-exported.
- **10 GiB limit:** e2e for exactly `MAX_VIDEO_SIZE_BYTES`: 201 with 640 parts and signed URLs for parts 639–640.
- **Docs:**
  - Root `CLAUDE.md`: current state of `next-frontend/`, the API signing storage URLs instead of uploading, and owner-only access to `/videos`.
  - README: phase 03 infra, first-run sequence and endpoints.
  - Revisions on TD-02 (no client ETags), TD-04 (`-format_whitelist` and DocType) and TD-08 (CORS without `ExposeHeaders`), mirrored in `context.md`.
  - A revision note on SI-03.10.
- **Second round:**
  - The root `CLAUDE.md` and the README tell `401` (no token) from `404` (another channel's video) and mark the C4 diagram as the target architecture.
  - `software-arch.mermaid` shows the client sending parts to the storage and the API signing URLs.
  - ffmpeg finishing without a frame at both positions fails the video as `invalid_media`.
  - The EBML parser rejects a child element that overruns the declared header size.
  - The README lists phase 03 as done.
- **Not changed:** `src/storage/storage.module.spec.ts`, the module compilation test, stays. It is listed in SI-03.2 and every module of phases 01/02 has the same test.

## Final verification (commit `8e3816b`, Compose with every service healthy and `storage-init` exited 0)

- `npx tsc --noEmit`: exit 0
- `npm run lint`: exit 0, 0 errors, 23 warnings (`no-unsafe-argument`, configured as `warn`); `--fix` changed no file
- `npm test`: exit 0, 37 suites, 237 tests passing
- `npm run test:e2e`: exit 0, 5 suites, 79 tests passing
- `npx nest build`: exit 0, `dist/main.js` and `dist/worker.js` present
- `video-worker` restarted on this code without errors; no `X-Amz-Signature` in its log
