---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-18T22:09:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-21T18:41:24-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-21T18:41:24-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-21T18:41:57-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-18T22:10:12-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-18T22:10:12-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-18T22:10:12-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-18T22:10:12-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-18T22:09:47-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição de informações do vídeo, categorias, visibilidade público/unlisted e fluxo rascunho → publicação (Fase 04); player, página de visualização e acesso anônimo (Fase 05); interface de upload e de vídeo no `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a fase não tem bullet de tela; a interface de upload e o player ficam para as fases que os introduzem. Os contratos cross-layer (TD-02, TD-06, TD-09) ficam prontos para esse consumo.

**Sequencing notes:** Depende de Fase 01 (Configuração Base) e Fase 02 (Cadastro, Login e Gerenciamento de Conta). Vídeos pertencem ao canal criado na Fase 02.

**Neighbors (for boundary detection only):**

- **Fase 02:** cadastro, confirmação, login/logout, recuperação de senha e criação automática do canal.
- **Fase 04:** categorias, edição do vídeo, visibilidade, fluxo rascunho → publicação, painel do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Job Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.7`, `ioredis@^5.11.1` |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Protocol for Files up to 10GB | decided | A (S3 multipart with presigned part URLs) | `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0` |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime | decided | A (Second entrypoint of `nestjs-project` in its own container) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Metadata Extraction and Thumbnail Generation | decided | A (`ffprobe`/`ffmpeg` via `child_process` over presigned GET URL) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (Random 11-char base64url id with unique constraint) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming and Download Delivery | decided | A (302 redirect to presigned GET URL, owner-only in this phase) | `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0` |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Handling | decided | A (Single `status` column with reconciliation) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Object Storage Layout and Access | decided | A (One private bucket, keys namespaced by video id) | `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0` |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Cross-layer | Accepted Media Formats | decided | B (Allowlist of browser-playable formats) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-08 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06, phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the workload is a job queue (one unit of work, retried until done), not pub/sub messaging; BullMQ gives retries, backoff, stalled-job recovery and `jobId` deduplication without custom code and has the only first-party Nest integration of the three. The cost is one Redis container, which the diagram already anticipates as a separate queue component.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.7`, `ioredis@^5.11.1`

**Revisions:**
- 2026-11-21 — Libraries changed to `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.7` and `ioredis@^5.11.1`. `@nestjs/bullmq` 12.x ships as ESM only (`"type": "module"`), and the project's Jest setup (ts-jest, CommonJS) cannot load it; 11.0.5 is CommonJS and declares peers `@nestjs/core` ^11 and `bullmq` ^6. `bullmq` 6 made `ioredis` an optional peer, so it is now a direct dependency. Rationale: found while implementing SI-03.4.

### phase-03-videos/TD-02

**Recommendation:** the only option that keeps the API out of the data path, supports resume and needs no extra service. The upload session belongs to the channel that created the draft; part size is a parameter informed by the server, and part URLs are signed on demand in batches, so resuming is "list the parts the storage already has, ask for the rest" rather than a special case. Processing is triggered by an explicit completion endpoint (not by bucket event notifications, which differ between MinIO and S3): the API validates the parts, completes the multipart upload, confirms the stored object's size and only then hands the video to processing. Completion is repeatable — if the storage assembled the object but the response was lost, calling it again converges to the same state. Incomplete multipart uploads are expired by the storage itself (lifecycle rule on S3, stale-upload expiry on MinIO); the API reports an expired session as a domain error instead of running its own cleanup job.

**Libraries:** `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0`

### phase-03-videos/TD-03

**Recommendation:** matches the diagram's separate worker container while keeping a single source of truth for the entity and the storage/queue configuration. ffmpeg heavy lifting happens in a child process (TD-04), so the Node event loop of the worker stays free regardless of the option.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** two fixed command lines do not justify a deprecated wrapper, and reading through a presigned URL avoids copying the whole file to the worker's disk. The URL is signed for the storage's internal endpoint, since the worker is the one fetching it. Both processes run with a time limit and with FFmpeg's input protocols restricted, because the input is user-supplied media that may reference other resources. The thumbnail is a JPEG from a frame early in the video rather than the very first one; the extracted metadata covers duration, dimensions, codecs, container and bitrate.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** satisfies "short and unique" with the standard library, and uniqueness is enforced by the database rather than assumed from the id's entropy. Non-enumerability matters from Phase 04 on, when unlisted videos are reachable only by whoever holds the link.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** delivers progressive streaming and download with the storage doing what it already does well, and it is the shape the architecture diagram prescribes. Presigned URLs are short-lived. In this phase the stream, download and thumbnail routes require authentication and answer only to the owning channel, for videos in `ready` status: every video is still an unpublished draft, and publication/visibility (Phase 04) and anonymous viewing (Phase 05) are the phases that open these routes to other viewers.

**Libraries:** `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0`

### phase-03-videos/TD-07

**Recommendation:** the smallest model that expresses the phase. The database status is the source of truth and the queue is derived from it: a crash between the status change and the enqueue leaves a `processing` video that the reconciliation picks up, which closes the dual-write gap without an outbox table and relay. Rolling the status back on an enqueue error was rejected because the error does not prove the job was not accepted. Only the worker moves a video out of `processing`, including to `failed` when retries are exhausted.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** a single private bucket keeps authorization in one place (the API decides, the storage enforces via signature) and avoids exposing draft thumbnails. The internal/public endpoint split is required by presigned URLs in a Compose network: containers reach the storage by service name, browsers by the published host. Browser uploads additionally need the storage's CORS to allow the frontend origin and expose `ETag`.

**Libraries:** `@aws-sdk/client-s3@^3.1172.0`, `@aws-sdk/s3-request-presigner@^3.1172.0`

### phase-03-videos/TD-09

**Recommendation:** without transcoding, restricting `ready` to formats browsers play natively is the only way the streaming capability holds for every video the platform accepts. The same check rejects non-video files and files with no video stream. Option C stays available for a later phase without changing the status model.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

**Revisions:**
- 2026-11-21 — Scope of the throttler corrected: `ThrottlerGuard` is registered with the `APP_GUARD` token in `AuthModule`, which makes it a global guard, not one scoped to the module. The 10 req/min limit stays as brute-force protection for the auth endpoints; routes that legitimately issue bursts of calls opt out with `@SkipThrottle()` (first case: the videos routes of phase 03).

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

_Frontend-only inherited TDs (`phase-02-auth-frontend/TD-01`…`TD-07`: BFF session, cookie encryption, refresh single-flight, forms, mutation surface, session hydration, confirmation/reset screens) were returned by `phases-reader` and omitted here: this phase produces no `next-frontend/` code. They remain in `docs/phases/phase-02-auth-frontend/context.md`._

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing confirmation and reset-password screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Source: `testing-guide-nestjs-project` Skill, § 3 Feature Implementation Checklist. Queue processors and the worker entrypoint have no row in the guide; their layers are set per SI in the plan._
