---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-18
scope_description: "Backend foundation for video upload and processing: job queue technology, direct-to-storage upload protocol for files up to 10GB, worker runtime, FFmpeg-based metadata/thumbnail extraction, unique video URL, streaming/download delivery, video status lifecycle, object storage layout, and accepted media formats."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload handshake, processing trigger, streaming/download endpoints), the video worker entrypoint, and the new Compose services (object storage, queue, worker).
- `next-frontend/` — Frontend deferred: the phase has no screen bullet in `docs/project-plan.md` and the upload/player UI is not part of this delivery. TD-02 and TD-06 are `Cross-layer` because they fix the HTTP contract a future upload/player screen will consume; no frontend code is produced in this phase. No frontend-only decision in this document.

_Inherited constraints (not reopened here):_ object storage is S3-compatible (MinIO locally, S3 in production) per `docs/diagrams/software-arch.mermaid` and the root `CLAUDE.md`; JWT guard, domain exception filter and error envelope come from `phase-02-auth/TD-02` and `phase-02-auth/TD-07`.

---

## TD-01: Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the message queue as "TBD". Video processing (ffprobe + thumbnail) must run outside the request cycle, survive API restarts, and be consumed by a separate worker container. The queue choice defines a new Compose service, the retry model, and how the worker is wired into NestJS.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with an official NestJS integration (`BullModule`, `@Processor`/`WorkerHost`). Adds one `redis` service to Compose. `@nestjs/bullmq` 12.x declares peer support for `@nestjs/core` ^11 and `bullmq` ^6.
- **Pros:** First-party Nest module and docs. Built-in attempts + exponential backoff, stalled-job detection (worker crash → job returns to the queue), job deduplication by `jobId`, `UnrecoverableError` to skip retries. Fits the "one job per uploaded video" shape exactly.
- **Cons:** New stateful dependency (Redis) used only for the queue in this phase. Enqueue is not transactional with PostgreSQL (dual write between status update and `queue.add`).

### Option B: pg-boss (PostgreSQL-backed queue)
- Job queue stored in the existing PostgreSQL instance (own schema, `SKIP LOCKED`). No new infrastructure service. Requires Node >= 22.12 (container runs Node 25).
- **Pros:** Zero new containers. Enqueue can share a database transaction with the status update. Retries, backoff and dead-letter queues available.
- **Cons:** No official NestJS module — wiring, lifecycle and typing are hand-written. Queue load lands on the application database. The architecture diagram models the queue as its own container, and the phase deliverable expects a queue service in Compose; with pg-boss the "queue" is a schema inside `db`.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport)
- Dedicated AMQP broker; API publishes a message, worker runs as a Nest microservice consuming it.
- **Pros:** True message broker, language-agnostic consumers, official Nest transport, management UI.
- **Cons:** Retry with backoff and dead-lettering must be modelled by hand (DLX + TTL queues). No job state, progress or deduplication out of the box. Heaviest operational footprint for a single job type.

**Recommendation:** **Option A (BullMQ + Redis)** — the workload is a job queue (one unit of work, retried until done), not pub/sub messaging; BullMQ gives retries, backoff, stalled-job recovery and `jobId` deduplication without custom code and has the only first-party Nest integration of the three. The cost is one Redis container, which the diagram already anticipates as a separate queue component.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** `@nestjs/bullmq@^12.0.2`, `bullmq@^6.7.7`

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file cannot travel through the API process: it would hold a Node connection for the whole transfer and buffer or proxy every byte. `docs/project-plan.md` (Pontos de Atenção) also requires that an interrupted upload can be resumed. The handshake lives on both sides — the backend exposes it, a client (future frontend, tests, `api.http`) drives it — hence one cross-layer contract.

**Options:**

### Option A: S3 multipart upload with presigned part URLs
- API creates the video row as a draft plus an S3 multipart upload, and returns the upload id and part size. The client requests presigned `UploadPart` URLs in batches, PUTs each part straight to the storage, then calls a completion endpoint; the API runs `CompleteMultipartUpload`, checks the stored object and triggers processing.
- **Pros:** No file bytes cross the API. Parts upload in parallel and a failed part is retried alone; resuming is "list uploaded parts, request URLs for the missing ones". Works identically on MinIO and S3. S3 limits (5 MiB minimum part, 10,000 parts) accommodate 10GB comfortably.
- **Cons:** Multi-step handshake (init → sign parts → complete). The client must collect each part's `ETag`, so the bucket CORS must expose that header for browser clients. Abandoned uploads leave orphan parts until aborted.

### Option B: Single presigned PUT
- API returns one presigned `PutObject` URL; the client uploads the whole file in a single request.
- **Pros:** Simplest possible contract (one URL, one request).
- **Cons:** S3 caps a single PUT at 5GB — it cannot satisfy the 10GB requirement. No resume: any network failure restarts from byte zero.

### Option C: tus resumable upload protocol
- Open protocol for resumable uploads. Either `@tus/server` mounted in the API (bytes flow through the API into the storage) or a dedicated `tusd` container in front of the storage.
- **Pros:** Standard protocol with mature browser clients (`tus-js-client`, Uppy) and first-class resume.
- **Cons:** Mounted in the API it brings the bytes back through the Node process; as `tusd` it adds a fourth new service plus a hook mechanism to notify the API. More moving parts than the storage's native multipart API for the same outcome.

### Option D: Streaming multipart/form-data through the API
- Classic `POST` with the file body piped by the API to the storage.
- **Pros:** Single request; authorization happens in the same call.
- **Cons:** Explicitly what the phase forbids: the API carries all 10GB, ties up connections, and has no resume.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — the only option that keeps the API out of the data path, supports resume and needs no extra service. The upload session belongs to the channel that created the draft; part size is a parameter informed by the server, and part URLs are signed on demand in batches, so resuming is "list the parts the storage already has, ask for the rest" rather than a special case. Processing is triggered by an explicit completion endpoint (not by bucket event notifications, which differ between MinIO and S3): the API validates the parts, completes the multipart upload, confirms the stored object's size and only then hands the video to processing. Completion is repeatable — if the storage assembled the object but the response was lost, calling it again converges to the same state. Incomplete multipart uploads are expired by the storage itself (lifecycle rule on S3, stale-upload expiry on MinIO); the API reports an expired session as a domain error instead of running its own cleanup job.

**Decision:** A (S3 multipart with presigned part URLs)
**Libraries:** `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0`

---

## TD-03: Video Worker Runtime

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The diagram defines a "Video Worker (FFmpeg)" container that consumes jobs, reads/saves to the storage and updates the database. The decision is where that consumer code lives and how it is started, which determines the Compose service, the Docker image and how much code is shared with the API.

**Options:**

### Option A: Second entrypoint of `nestjs-project` in its own container
- A `worker.ts` entrypoint boots a NestJS standalone application context (no HTTP listener) with the config, database, storage and processing modules. Compose runs it as a `video-worker` service built from the same image, which gains `ffmpeg`.
- **Pros:** Reuses entities, config validation, storage client and DI. API and worker scale and fail independently. One codebase, one test setup; the processor is testable inside the existing Jest infrastructure.
- **Cons:** Module boundaries must be kept clean so the worker does not load HTTP-only pieces (controllers, guards). The shared image carries `ffmpeg` even for the API container.

### Option B: Processor registered inside the API process
- `@Processor` class declared in the API's module graph; jobs run in the same Node process that serves HTTP.
- **Pros:** No extra service or entrypoint.
- **Cons:** No separate worker container, contradicting the target architecture. Long ffmpeg runs compete with request handling and an API deploy interrupts processing.

### Option C: BullMQ sandboxed processor
- Processor file forked into a child process by the API (or by a worker).
- **Pros:** CPU isolation from the event loop.
- **Cons:** Per the NestJS queue docs, sandboxed processors have no access to the IoC container — repositories, config and the storage client would be rebuilt by hand. Still not an independent container when forked from the API.

### Option D: Separate worker subproject
- New package (own `package.json`, own image) dedicated to processing.
- **Pros:** Smallest worker image; hard isolation.
- **Cons:** Duplicates the `Video` entity, database config and storage client, or forces a shared package the monorepo does not have. Two dependency trees to keep aligned for one job type.

**Recommendation:** **Option A (second entrypoint, own container)** — matches the diagram's separate worker container while keeping a single source of truth for the entity and the storage/queue configuration. ffmpeg heavy lifting happens in a child process (TD-04), so the Node event loop of the worker stays free regardless of the option.

**Decision:** A (Second entrypoint of `nestjs-project` in its own container)

---

## TD-04: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration and technical metadata and produce a thumbnail from a frame. Source files can be 10GB, so how the worker accesses the file matters as much as which tool reads it.

**Options:**

### Option A: `ffprobe`/`ffmpeg` binaries via `child_process`, reading from a presigned GET URL
- The worker spawns `ffprobe -print_format json` for metadata and `ffmpeg -ss <t> -frames:v 1` for the thumbnail, passing a short-lived presigned URL as input. FFmpeg reads over HTTP with range requests; only the thumbnail touches local disk before being uploaded.
- **Pros:** No wrapper dependency. No 10GB download to the worker's disk — ffprobe fetches only the container headers and ffmpeg seeks to one frame. Output is structured JSON. Binaries come from the distro package in the image.
- **Cons:** Argument building, timeouts and exit-code handling are our code. How much is read over the network varies with the container (e.g. MP4 with metadata at the end costs extra range requests).

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API around the same binaries.
- **Pros:** Readable command construction, typed helpers for `ffprobe`.
- **Cons:** The package is deprecated on npm ("Package no longer supported"). Adds an unmaintained dependency to wrap two command lines.

### Option C: Download to a temp file, then process locally
- Worker streams the object to local disk and runs ffprobe/ffmpeg against the file.
- **Pros:** Works with any container format regardless of seekability; no dependence on HTTP range behaviour.
- **Cons:** Needs up to 10GB of scratch disk per concurrent job and pays the full transfer before any work starts. Processing time grows linearly with file size for a task that reads a few megabytes.

**Recommendation:** **Option A** — two fixed command lines do not justify a deprecated wrapper, and reading through a presigned URL avoids copying the whole file to the worker's disk. The URL is signed for the storage's internal endpoint, since the worker is the one fetching it. Both processes run with a time limit and with FFmpeg's input protocols restricted, because the input is user-supplied media that may reference other resources. The thumbnail is a JPEG from a frame early in the video rather than the very first one; the extracted metadata covers duration, dimensions, codecs, container and bitrate.

**Decision:** A (`ffprobe`/`ffmpeg` via `child_process`, reading from a presigned GET URL)

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier for its URL. `docs/project-plan.md` asks for a short URL that never conflicts with another video. The identifier is exposed in every public route of this phase and in the watch page of Phase 05, so its format is hard to change later.

**Options:**

### Option A: Random short id (11 chars, base64url) with unique constraint
- `crypto.randomBytes(8)` encoded as base64url yields 11 URL-safe characters (64 bits). Stored in a dedicated column with a unique index; on the rare unique violation the insert is retried with a new id, a bounded number of times.
- **Pros:** Short, non-enumerable, no dependency. Uniqueness is guaranteed by the database, not by probability. The internal UUID primary key stays private.
- **Cons:** Two identifiers per video (internal `id`, public id). The retry must run as a fresh statement — PostgreSQL aborts the surrounding transaction on a unique violation — and has to be tested even though it is practically unreachable.

### Option B: Expose the UUID primary key
- Use the row's `uuid` directly in URLs.
- **Pros:** Nothing to generate or index beyond the PK.
- **Cons:** 36 characters — not the short URL the plan asks for. Couples public URLs to the internal key.

### Option C: Encoded sequence (Sqids/Hashids)
- Numeric sequence encoded into a short string.
- **Pros:** Short and collision-free by construction.
- **Cons:** Reversible encoding — ids are enumerable once the alphabet is known, which exposes volume and lets drafts be guessed. Needs a sequence column the model otherwise does not have.

### Option D: `nanoid`
- Library-generated random id of configurable length.
- **Pros:** Popular, URL-safe alphabet by default.
- **Cons:** ESM-only package in a project that compiles and tests through CommonJS (`ts-jest`); solves nothing `node:crypto` does not already solve.

**Recommendation:** **Option A** — satisfies "short and unique" with the standard library, and uniqueness is enforced by the database rather than assumed from the id's entropy. Non-enumerability matters from Phase 04 on, when unlisted videos are reachable only by whoever holds the link.

**Decision:** A (Random 11-char base64url id with unique constraint)

---

## TD-06: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and the user must be able to download it. The diagram draws streaming as "Frontend → Object Storage". The decision fixes which component serves the bytes and what a player or a download link points to.

**Options:**

### Option A: API redirects (302) to a presigned GET URL
- `GET /videos/:publicId/stream` and `/download` validate the video and answer with a redirect to a short-lived presigned URL. The storage serves `Range` requests natively (`206 Partial Content`); the download variant signs `response-content-disposition=attachment` with the original filename.
- **Pros:** Bytes never pass through the API. Range, caching and connection handling are the storage's job. A stable API URL per video works directly as `<video src>`. Matches the diagram.
- **Cons:** URLs are signed for the hostname the client will use, so the API needs a public storage endpoint setting distinct from the internal one. Access is checked when the redirect is issued, not per byte range; a leaked presigned URL is valid until it expires.

### Option B: API proxies the object with Range support
- The API forwards the `Range` header to `GetObject` and pipes the body back with `206`.
- **Pros:** Storage stays fully private; every request is authorized by the API.
- **Cons:** All video traffic flows through the API process — the same scaling problem as uploading through it, on the read side. Range/conditional-request semantics are reimplemented by us.

### Option C: HLS/DASH packaging
- Worker transcodes into segmented renditions; the player loads a manifest.
- **Pros:** Adaptive bitrate, the industry standard for large-scale video.
- **Cons:** Requires transcoding, which the phase does not list (processing is "extração de duração e metadados"). Multiplies processing time and storage.

**Recommendation:** **Option A (302 to presigned URL)** — delivers progressive streaming and download with the storage doing what it already does well, and it is the shape the architecture diagram prescribes. Presigned URLs are short-lived. In this phase the stream, download and thumbnail routes require authentication and answer only to the owning channel, for videos in `ready` status: every video is still an unpublished draft, and publication/visibility (Phase 04) and anonymous viewing (Phase 05) are the phases that open these routes to other viewers.

**Decision:** A (302 redirect to presigned GET URL, owner-only in this phase)
**Libraries:** `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0`

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row exists before any byte is uploaded and its state is driven by two actors — the API (upload handshake) and the worker (processing). The model must say which states exist, who moves between them, and what happens when processing fails. Depends on TD-01 (retry primitives) and TD-02 (when the upload is considered finished).

**Options:**

### Option A: Single `status` column — `draft → processing → ready | failed`
- `draft` from creation until the upload is completed; `processing` from completion until the worker finishes in `ready` or `failed`. `processing` is the durable intent: the job id is derived from the video id, completion can be repeated, and a periodic reconciliation re-enqueues videos left in `processing` without a live job. Transient errors are retried by the queue with backoff; invalid media fails at once. `failed` stores a reason.
- **Pros:** One column answers "can this video be played?". Each transition has a single owner and is applied conditionally on the current status, so a duplicated or late job cannot move a video backwards. Maps one-to-one to the phase description.
- **Cons:** `draft` covers both "upload not started" and "upload in progress". Status update and enqueue remain two writes; consistency is eventual (repaired by the reconciliation), not transactional.

### Option B: Separate upload and processing status columns
- `upload_status` (`pending | uploading | completed | aborted`) and `processing_status` (`pending | running | done | failed`).
- **Pros:** Finer-grained reporting; upload progress modelled explicitly.
- **Cons:** Sixteen combinations, most of them invalid, guarded only by application code. No capability in this phase consumes the extra granularity.

### Option C: Single status + transactional outbox for the job
- Same states as A, but the "process this video" intent is written to an outbox table in the same transaction and relayed to the queue by a poller.
- **Pros:** Removes the dual-write gap entirely.
- **Cons:** A new table, a relay process and its failure modes, to protect one enqueue per upload that the client can safely retry.

**Recommendation:** **Option A** — the smallest model that expresses the phase. The database status is the source of truth and the queue is derived from it: a crash between the status change and the enqueue leaves a `processing` video that the reconciliation picks up, which closes the dual-write gap without an outbox table and relay. Rolling the status back on an enqueue error was rejected because the error does not prove the job was not accepted. Only the worker moves a video out of `processing`, including to `failed` when retries are exhausted.

**Decision:** A (Single `status` column with reconciliation)

---

## TD-08: Object Storage Layout and Access

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage technology is given (S3 API, MinIO locally). What remains open is how buckets and keys are organised and how objects are reached — choices shared by the API (signing), the worker (read source, write thumbnail), Compose (bucket bootstrap) and the environment schema.

**Options:**

### Option A: One private bucket, keys namespaced by video id
- Single bucket with the source file and the thumbnail under a prefix derived from the video's internal id. Nothing is publicly readable; every read or write from outside goes through a presigned URL. The S3 client uses an internal endpoint (Compose service name) for its own operations and signs each URL for the host its recipient will use.
- **Pros:** One access model for everything. Deleting a video is deleting a prefix. Keys never contain user-supplied filenames. Same configuration shape on MinIO and S3.
- **Cons:** Thumbnails also need a signed URL (one extra redirect per image) until a CDN or public policy is introduced.

### Option B: Two buckets — private videos, public-read thumbnails
- Source files in a private bucket; thumbnails in a bucket with an anonymous read policy.
- **Pros:** Thumbnails load with plain URLs and are cacheable without signing.
- **Cons:** Two buckets and a bucket policy to provision and keep in sync across environments. Thumbnails of drafts become publicly reachable before any visibility rule exists.

### Option C: One bucket, keys derived from the public id or original filename
- Keys such as `{publicId}.mp4`.
- **Pros:** Human-readable bucket listing.
- **Cons:** Leaks the public id into storage paths and ties object names to user input (extension, filename), which complicates validation and renames.

**Recommendation:** **Option A** — a single private bucket keeps authorization in one place (the API decides, the storage enforces via signature) and avoids exposing draft thumbnails. The internal/public endpoint split is required by presigned URLs in a Compose network: containers reach the storage by service name, browsers by the published host. Browser uploads additionally need the storage's CORS to allow the frontend origin and expose `ETag`.

**Decision:** A (One private bucket, keys namespaced by video id)
**Libraries:** `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0`

---

## TD-09: Accepted Media Formats

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Streaming in this phase is progressive delivery of the uploaded file itself (TD-06) — there is no transcoding. A `206` response delivers bytes, but playback only works if the browser can decode the container and codecs. The phase must therefore say which uploads are allowed to reach `ready`. Cross-layer because the upload contract (what a client may declare and send) and the failure reason a client sees both depend on it. Depends on TD-04 (the probe supplies the facts) and TD-07 (rejection is a `failed` video).

**Options:**

### Option A: Anything with a video stream
- The worker accepts any file in which ffprobe finds at least one video stream.
- **Pros:** Simplest rule; no format table to maintain.
- **Cons:** Files browsers cannot play (e.g. HEVC in MKV, ProRes, AVI) become `ready` and then fail silently in the player. "Streaming works" would hold only for some uploads.

### Option B: Allowlist of browser-playable formats
- Upload start accepts only declared video types from a short list; after the upload the worker checks the real container and video codec from the probe against the same list (MP4/WebM families with widely supported codecs). Anything else ends as `failed` with an "unsupported format" reason.
- **Pros:** `ready` means playable by progressive streaming. The declared type is a cheap early rejection; the probe is the authoritative check, so a renamed file does not slip through.
- **Cons:** A list to maintain. Valid videos in other formats are rejected until transcoding exists.

### Option C: Normalise every upload by transcoding
- The worker transcodes every upload to a single playback format.
- **Pros:** Accepts practically any input; uniform output.
- **Cons:** Transcoding is not in the phase scope ("extração de duração e metadados"). A 10GB transcode takes orders of magnitude longer than a probe and doubles storage.

**Recommendation:** **Option B** — without transcoding, restricting `ready` to formats browsers play natively is the only way the streaming capability holds for every video the platform accepts. The same check rejects non-video files and files with no video stream. Option C stays available for a later phase without changing the status model.

**Decision:** B (Allowlist of browser-playable formats)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Job Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-02 | Cross-layer | Upload Protocol for Files up to 10GB | S3 multipart with presigned part URLs | A (S3 multipart with presigned part URLs) |
| TD-03 | Backend | Video Worker Runtime | Second entrypoint of `nestjs-project`, own container | A (Second entrypoint of `nestjs-project` in its own container) |
| TD-04 | Backend | Metadata Extraction and Thumbnail Generation | `ffprobe`/`ffmpeg` via `child_process` over presigned URL | A (`ffprobe`/`ffmpeg` via `child_process`, reading from a presigned GET URL) |
| TD-05 | Backend | Unique Video URL Identifier | Random 11-char base64url id + unique constraint | A (Random 11-char base64url id with unique constraint) |
| TD-06 | Cross-layer | Streaming and Download Delivery | 302 redirect to presigned GET URL, owner-only in this phase | A (302 redirect to presigned GET URL, owner-only in this phase) |
| TD-07 | Backend | Video Status Lifecycle and Failure Handling | Single `status` column, queue retries, reconciliation instead of outbox | A (Single `status` column with reconciliation) |
| TD-08 | Backend | Object Storage Layout and Access | One private bucket, keys by video id | A (One private bucket, keys namespaced by video id) |
| TD-09 | Cross-layer | Accepted Media Formats | Allowlist of browser-playable formats, verified by the probe | B (Allowlist of browser-playable formats) |
