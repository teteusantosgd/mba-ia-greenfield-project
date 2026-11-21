---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-21T18:42:10-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-21T18:41:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-21T18:41:24-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-21T18:41:24-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-18T22:10:12-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB direto para o object storage, com pré-cadastro do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano por um worker consumindo uma fila (duração, metadados e thumbnail a partir de um frame), URL única por vídeo e reprodução por streaming e download — com storage, fila e worker subindo no Docker Compose junto com a API.

---

## Step Implementations

### SI-03.1 — Infraestrutura de storage, fila e FFmpeg no Compose

**Description:** Sobe o object storage e o Redis no Compose, cria o bucket na subida e instala o FFmpeg na imagem compartilhada por API e worker. É a base de todos os SIs seguintes e não tem código de aplicação.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `minio` com `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (fork comunitário do MinIO; a imagem `minio/minio` não está mais publicada no Docker Hub), portas `9000`/`9001`, volume nomeado, healthcheck e `MINIO_API_CORS_ALLOW_ORIGIN` com a origem do frontend; e o serviço `storage-init` com `pgsty/mc:RELEASE.2026-08-04T00-00-00Z`, que espera o `minio` saudável, registra o alias e roda `mc mb --ignore-existing` no bucket. Credenciais e nome do bucket vêm das mesmas variáveis do `.env` que a aplicação lê (`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`) (per `phase-03-videos/TD-08`)
2. Adicionar o serviço `redis` com `redis:7.4-alpine`, volume nomeado e healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`)
3. Fazer `nestjs-api` depender de `minio` (healthy), `storage-init` (completed) e `redis` (healthy)
4. Instalar `ffmpeg` no `Dockerfile.dev` (pacote Debian, traz `ffprobe`) (per `phase-03-videos/TD-04`)
5. Instalar `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.7`, `ioredis@^5.11.1`, `@aws-sdk/client-s3@^3.1172.0` e `@aws-sdk/s3-request-presigner@^3.1172.0` no `package.json`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d --build` deixa `minio` e `redis` com status `healthy` e `storage-init` encerrado com código 0
- O bucket `streamtube` existe depois da subida, e uma segunda subida não falha por ele já existir
- Um preflight `OPTIONS` ao MinIO com `Origin` do frontend e `Access-Control-Request-Method: PUT` é aceito
- `docker compose exec nestjs-api ffprobe -version` imprime a versão do FFmpeg

---

### SI-03.2 — Configuração e serviço de object storage

**Description:** Encapsula o acesso S3 num `StorageService` usado pela API e pelo worker: multipart upload, URLs pré-assinadas, leitura de metadados e gravação de objetos. Separa o endpoint interno (rede do Compose) do endpoint público usado para assinar URLs entregues ao navegador.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage')` com `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `bucket`; adicionar `STORAGE_ENDPOINT` (default `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `STORAGE_REGION` (default `us-east-1`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (required) e `STORAGE_BUCKET` (default `streamtube`) ao `env.validation.ts` e ao `.env.example` (per `phase-01-configuracao-base/TD-03`, `phase-03-videos/TD-08`)
2. Criar `src/storage/storage.service.ts` — dois `S3Client` com `forcePathStyle: true`: um no endpoint interno (operações e URLs para o worker) e um no público (só para assinar URLs do cliente); métodos `createMultipartUpload`, `signUploadPart` (assina `ContentLength` da parte em `signableHeaders`), `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `getObjectSize`, `signDownload` (com `ResponseContentDisposition` opcional e escolha de endpoint) e `putObject` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-08`). A limpeza de objetos dos testes fica num helper de teste, fora do service
3. Converter `NoSuchUpload` e `InvalidPart` do SDK em erros próprios do storage, para o service de vídeos traduzir em `UPLOAD_EXPIRED` e `UPLOAD_INCOMPLETE`; `getObjectSize` devolve `null` para `NotFound`; criar `src/test/storage.ts` com a limpeza de objetos e multiparts pendentes por prefixo
4. Criar `src/storage/storage.module.ts` — `StorageModule` que provê e exporta `StorageService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Env schema (`STORAGE_*`) | Integration: required keys and defaults | `src/config/env.validation.integration-spec.ts` |
| `StorageService` | Integration: real MinIO — multipart round trip via presigned PUT, PUT with the wrong length rejected, `listParts`, `getObjectSize`, presigned GET with `Range` → 206 and `Content-Disposition`, `NoSuchUpload` mapping | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — o MinIO e o SDK precisam estar no ambiente

**Acceptance criteria:**

- A aplicação não sobe sem `STORAGE_ACCESS_KEY` ou `STORAGE_SECRET_KEY`, e a mensagem de validação cita a chave ausente
- Um arquivo enviado em duas partes por URLs pré-assinadas e concluído pelo service vira um objeto com o tamanho exato da soma das partes
- Um `PUT` numa URL de parte com corpo de tamanho diferente do assinado é recusado pelo storage e a parte não aparece na listagem
- Uma URL de download pré-assinada responde `206` com o trecho pedido quando recebe `Range: bytes=0-99`
- Uma URL de download com nome de arquivo responde com `Content-Disposition: attachment; filename="<nome>"`
- Listar partes de um upload abortado gera o erro de upload inexistente, não um erro genérico do SDK

---

### SI-03.3 — Entidade Video e migration

**Description:** Cria a tabela `videos` ligada ao canal, com o ciclo de status, as chaves do storage, os campos de processamento e o identificador público único.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos do Data Model; `status` como enum com `enumName: 'video_status'`; `size_bytes` como `bigint` com transformer para `number`; `@Index('UQ_videos_public_id', ['public_id'], { unique: true })`; `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` com `@JoinColumn({ name: 'channel_id' })`, sem lado inverso em `Channel` (ver Data Model) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL (enum, FK, índices)
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`
4. Incluir `videos` em `cleanAllTables` (antes de `channels`); em `src/database/migrations.integration-spec.ts`, registrar `Video` e a nova migration, incluir `videos` e o tipo `video_status` na limpeza inicial e cobrir o revert de `CreateVideos`, restaurando o schema no `afterAll`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`, default `draft`, enum rejects unknown status, `size_bytes` above 2^32 round-trips as number, cascade on channel delete | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: apply and revert including `CreateVideos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — ambiente com as dependências instaladas

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum `video_status`, a FK para `channels` e os índices `UQ_videos_public_id` e `IDX_videos_channel_id`
- `npm run migration:revert` remove a tabela e o enum sem afetar `channels`
- Inserir dois vídeos com o mesmo `public_id` falha por violação de unicidade
- Um vídeo inserido sem `status` fica `draft`
- Apagar o canal apaga os vídeos dele

---

### SI-03.4 — Infraestrutura compartilhada da API e do worker, e conexão com a fila

**Description:** Extrai a configuração global (Config, TypeORM) do `AppModule` para um módulo que o worker também importa, e acrescenta a conexão BullMQ com o Redis. Sem isso o worker duplicaria a validação de ambiente e a conexão com o banco.

**Technical actions:**

1. Criar `src/config/queue.config.ts` — `registerAs('queue')` com `host`, `port` e `prefix`; adicionar `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) e `QUEUE_PREFIX` (default `bull`) ao `env.validation.ts` e ao `.env.example` (per `phase-01-configuracao-base/TD-03`)
2. Criar `src/core/core.module.ts` — `CoreModule` com o `ConfigModule.forRoot` e o `TypeOrmModule.forRootAsync` que hoje estão em `AppModule` (inclui `storageConfig` e `queueConfig` no `load`) e `BullModule.forRootAsync` com `connection` e `prefix` vindos de `queueConfig` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
3. Trocar as duas importações globais de `AppModule` por `CoreModule`
4. Criar `src/videos/video-queue.constants.ts` — `VIDEO_QUEUE = 'video-processing'`, `VIDEO_JOBS = { PROCESS: 'process-video', RECONCILE: 'reconcile-processing' } as const`, o tipo `ProcessVideoJobData` e as opções de job do Events/Messages

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Env schema (`REDIS_*`, `QUEUE_PREFIX`) | Integration: defaults | `src/config/env.validation.integration-spec.ts` |
| `CoreModule` | Integration: module compiles and connects to Postgres and Redis | `src/core/core.module.integration-spec.ts` |

**Dependencies:** SI-03.2 — `storageConfig` entra no `load` do `CoreModule`

**Acceptance criteria:**

- A API sobe com `CoreModule` e as rotas da Fase 02 continuam respondendo como antes (suíte e2e da Fase 02 verde)
- Sem `REDIS_HOST` no ambiente, a configuração resolve `redis:6379` e prefixo `bull`
- `QUEUE_PREFIX` diferente isola as filas: um job adicionado com prefixo `test-a` não aparece numa fila aberta com prefixo `test-b`

---

### SI-03.5 — Início do upload com pré-cadastro do rascunho

**Description:** `POST /videos` cria o vídeo como `draft` no canal do usuário e abre o multipart upload no storage, devolvendo o tamanho de parte que o cliente deve usar. É o pré-cadastro da capacidade "rascunho ao iniciar o upload".

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId)` — o canal é do domínio `channels`; o service de vídeos não consulta a tabela de canais diretamente
2. Criar `src/videos/videos.service.ts` com `startUpload(userId, dto)`: gera o `id`, abre o multipart em `videos/{id}/source` e insere o vídeo com um `public_id` novo (`randomBytes(8).toString('base64url')`, gerado junto da inserção); repete a inserção (até 5 vezes, cada uma num comando próprio, fora de transação) só quando a violação de unicidade for em `UQ_videos_public_id`, e aborta o multipart se a inserção falhar de vez (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)
3. Constantes em `src/videos/videos.constants.ts` (`PART_SIZE_BYTES`, `MAX_VIDEO_SIZE_BYTES`, `ACCEPTED_CONTENT_TYPES`) e o título padrão a partir do nome do arquivo, com corte e fallback do Data Model (per `phase-03-videos/TD-09`)
4. Criar `src/videos/dto/create-video.dto.ts` e `src/videos/dto/video-response.dto.ts`; `src/videos/videos.controller.ts` com `@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()` e `@ApiBearerAuth('access-token')` na classe, e `POST /videos` documentado (per `### API Contracts` → POST /videos, Revision de `phase-02-auth/TD-08`)
5. Registrar `VideosModule` (com `StorageModule` e `ChannelsModule`) em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.startUpload` | Unit: retry on `UQ_videos_public_id` violation, no retry on other errors, multipart aborted when insert fails, title fallback | `src/videos/videos.service.spec.ts` |
| `VideosService.startUpload` | Integration: draft persisted in the user's channel, multipart open in MinIO, default title from filename | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` + DTO | E2E: 201 shape, 400 per validation rule, 401 without token | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — `CoreModule`

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", size_bytes: 52428800, content_type: "video/mp4" }` retorna `201` com `status: "draft"`, `title: "aula"`, `id` de 11 caracteres URL-safe e `upload: { part_size: 16777216, part_count: 4 }`
- O vídeo criado pertence ao canal do usuário autenticado e tem `upload_id` preenchido
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `content_type: "video/x-matroska"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- Onze chamadas seguidas de `POST /videos` pelo mesmo usuário em menos de um minuto retornam `201` (fora do throttler)

---

### SI-03.6 — URLs de parte e estado do upload para retomada

**Description:** Entrega ao cliente as URLs pré-assinadas de cada parte, em lotes, e o estado atual do upload (partes que o storage já recebeu), que é o que permite retomar uma transferência interrompida sem reenviar o que já chegou.

**Technical actions:**

1. Adicionar a `VideosService` a busca do vídeo do usuário (`findOwnedVideo(userId, publicId)`, uma consulta com `channel: { user_id }`), que lança `VideoNotFoundException` quando o vídeo não existe ou é de outro canal; exceções do módulo em `src/videos/video.exceptions.ts`, estendendo `DomainException`
2. Adicionar `VideosService.signPartUrls(userId, publicId, partNumbers)` — rejeita vídeo fora de `draft` (`UPLOAD_ALREADY_COMPLETED`) e número acima de `part_count` (`INVALID_PART_NUMBER`); assina cada parte no endpoint público, com o tamanho exato da parte e validade de 3600 s (per `phase-03-videos/TD-02`)
3. Adicionar `VideosService.getUploadStatus(userId, publicId)` — lista as partes no storage e traduz o erro de upload inexistente em `UPLOAD_EXPIRED`
4. Criar `src/videos/dto/request-part-urls.dto.ts` (`@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique()`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) e expor `POST /videos/:id/upload/part-urls` e `GET /videos/:id/upload` no controller (per `### API Contracts`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (part URLs, upload status) | Integration: URLs accept a real PUT, status lists the uploaded part, expired session → `UPLOAD_EXPIRED` | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` + DTO | E2E: 201/200 shapes, `INVALID_PART_NUMBER`, 404 for another user's video, 400 validation | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 — o vídeo e o multipart nascem no início do upload

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com `{ part_numbers: [1, 2] }` retorna `201` com duas URLs, o `size` de cada parte e `expires_in: 3600`
- Um `PUT` com o conteúdo da parte na URL recebida responde `200`, e em seguida `GET /videos/:id/upload` lista essa parte com o tamanho enviado
- `POST /videos/:id/upload/part-urls` com um número maior que `part_count` retorna `400` com `error: "INVALID_PART_NUMBER"`
- `POST /videos/:id/upload/part-urls` com `{ part_numbers: [] }` retorna `400` com `error: "VALIDATION_ERROR"`
- Qualquer uma das duas rotas com o `id` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id/upload` depois que a sessão de multipart foi abortada no storage retorna `410` com `error: "UPLOAD_EXPIRED"`

---

### SI-03.7 — Conclusão do upload e enfileiramento do processamento

**Description:** `POST /videos/:id/upload/complete` monta o objeto no storage, confirma o tamanho, passa o vídeo para `processing` e publica o job de processamento. É o ponto que liga o upload ao processamento automático.

**Technical actions:**

1. Adicionar `VideosService.completeUpload(userId, publicId)`: vídeo fora de `draft` devolve o estado atual; lista as partes, exige `1..part_count` contíguas com o tamanho esperado de cada uma (senão `UPLOAD_INCOMPLETE`), conclui o multipart com os ETags devolvidos pela listagem e confere `getObjectSize` (per `phase-03-videos/TD-02`)
2. Recuperar pelo objeto quando a sessão sumiu: se `listParts` ou `completeMultipartUpload` responderem que o upload não existe (resposta perdida, ou outra conclusão concorrente que chegou antes) e o objeto existir com `size_bytes`, seguir para a mudança de status; se nem o objeto existir, `UPLOAD_EXPIRED`; lista de partes recusada pelo storage vira `UPLOAD_INCOMPLETE`
3. Gravar `status = 'processing'` e `upload_id = null` com `UPDATE ... WHERE id = :id AND status = 'draft'`; só a chamada cujo `UPDATE` afetou uma linha adiciona `process-video` (`jobId` = `id`, opções do Events/Messages); a que perdeu a disputa relê e devolve o status atual; erro ao enfileirar não reverte o status (per `phase-03-videos/TD-07`)
4. Registrar a fila com `BullModule.registerQueue({ name: VIDEO_QUEUE })` no `VideosModule`, injetar com `@InjectQueue(VIDEO_QUEUE)` e expor a rota no controller com `@HttpCode(200)` (per `phase-03-videos/TD-01`, `### API Contracts` → POST /videos/:id/upload/complete)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: missing part, wrong part size, already completed returns current state, lost-response path, losing the status race does not enqueue, enqueue error keeps `processing` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: real MinIO + Redis — object assembled, status `processing`, job `process-video` with `jobId` = video id, two concurrent calls leave one job | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` | E2E: 200 with `processing`, 409 `UPLOAD_INCOMPLETE`, 404 for another user's video | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6 — o cliente só chega aqui depois de enviar as partes; SI-03.4 — conexão com a fila

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` depois de todas as partes enviadas retorna `200` com `status: "processing"`
- Depois da conclusão, a fila `video-processing` tem um job `process-video` cujo `id` é o `id` interno do vídeo e cujo payload é `{ videoId }`
- Repetir `POST /videos/:id/upload/complete`, em sequência ou em paralelo, retorna `200` com o mesmo status e deixa um único job
- `POST /videos/:id/upload/complete` com uma parte faltando retorna `409` com `error: "UPLOAD_INCOMPLETE"` e o vídeo continua `draft`
- O objeto `videos/{id}/source` existe no bucket com exatamente `size_bytes` bytes

---

### SI-03.8 — Leitura de metadados e extração de frame com FFmpeg

**Description:** Isola as chamadas a `ffprobe` e `ffmpeg` e a regra de formatos aceitos para reprodução, para o processamento do worker depender de uma interface pequena e testável com arquivos de vídeo reais gerados no próprio teste.

**Technical actions:**

1. Criar `src/videos/processing/media-probe.service.ts` — `probe(url)` executa `ffprobe -v error -print_format json -show_format -show_streams` via `execFile` (URL como argumento próprio, nunca por shell) e devolve duração, nomes de formato, `major_brand`, bitrate e os streams; `extractThumbnail(url, atSeconds)` executa `ffmpeg -ss <t> -i <url> -frames:v 1 -f image2 -c:v mjpeg pipe:1` com saída binária e `maxBuffer` dimensionado para um JPEG, sem arquivo temporário (per `phase-03-videos/TD-04`)
2. Rodar os dois com `timeout` e `-protocol_whitelist http,https,tcp,tls` antes do `-i`; classificar a falha: arquivo irreconhecível é erro de mídia; binário ausente, timeout e erro HTTP/conexão são erro comum (transitório). A mensagem não carrega stderr bruto (per `phase-03-videos/TD-04`)
3. Criar `src/videos/processing/playback-formats.ts` — `checkPlayback(probe, contentType)` ignora streams de capa (`disposition.attached_pic`), exige stream de vídeo e duração maior que zero (senão `invalid_media`), e aceita só container compatível com o `content_type` declarado: `video/mp4` = família `mov,mp4` com `major_brand` diferente de `qt` e vídeo H.264/AV1, áudio AAC/MP3/Opus; `video/webm` = família `matroska,webm` com vídeo VP8/VP9/AV1, áudio Vorbis/Opus — o resto é `unsupported_format` (per `phase-03-videos/TD-09`)
4. Criar `src/test/video-fixtures.ts` — gera, de forma determinística, vídeos com `ffmpeg -f lavfi -i testsrc` (MP4 H.264, WebM VP9, AVI MPEG-4, e um MP4 entre 32 e 48 MiB para o fluxo completo) e um arquivo que não é vídeo, num diretório temporário

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `checkPlayback` | Unit: accepted combinations, unsupported codec, container that does not match `content_type`, only an attached picture, zero duration | `src/videos/processing/playback-formats.spec.ts` |
| `MediaProbeService` | Integration: real ffprobe/ffmpeg over HTTP (presigned MinIO URL) — duration and dimensions of a generated MP4, JPEG frame bytes, non-video file → media error | `src/videos/processing/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem; SI-03.2 — URLs pré-assinadas para ler o arquivo pelo storage

**Acceptance criteria:**

- O probe de um MP4 H.264 de 3 s, 320x240, gerado no teste, devolve duração entre 2,9 e 3,1 s, `width: 320`, `height: 240` e `video_codec: "h264"`
- O frame extraído desse vídeo começa com os bytes `FF D8` (JPEG)
- Um arquivo de texto renomeado para `.mp4` produz erro de mídia, não erro de execução
- Um AVI com MPEG-4 é classificado como `unsupported_format`; um WebM VP9 declarado como `video/webm` é aceito, e o mesmo arquivo declarado como `video/mp4` é `unsupported_format`
- Uma URL para um objeto inexistente produz erro comum (transitório), não erro de mídia

---

### SI-03.9 — Processamento do vídeo: metadados, thumbnail e status final

**Description:** Implementa o que o worker faz com cada job: lê o vídeo pelo storage, grava duração e metadados, gera e salva a thumbnail e fecha o ciclo em `ready` ou `failed`. Fica separado do runtime do worker para ser testado sem fila.

**Technical actions:**

1. Criar `src/videos/processing/video-processing.service.ts` com `process(videoId)`: ignora vídeo que não está em `processing`; assina GET no endpoint interno (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`); roda `probe` e `checkPlayback`; para mídia inválida ou fora do formato grava `failed` com o motivo e encerra sem lançar erro (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
2. Para vídeo aceito: extrair a thumbnail em 10% da duração, salvar em `videos/{id}/thumbnail.jpg` com `putObject` e gravar `ready`, `duration_seconds`, `metadata` e `thumbnail_key` num único `UPDATE ... WHERE id = :id AND status = 'processing'`
3. Adicionar `markFailed(videoId, reason)` — `UPDATE ... SET status = 'failed', failure_reason = :reason WHERE id = :id AND status = 'processing'`; erros de infraestrutura (storage, banco, FFmpeg ausente, timeout, HTTP) propagam para a fila tentar de novo
4. Criar `src/videos/processing/video-processing.module.ts` — `TypeOrmModule.forFeature([Video, Channel, User])` (o worker não importa os módulos HTTP, mas o metadata de `Video` referencia `Channel` → `User`), `StorageModule`, `MediaProbeService` e `VideoProcessingService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: skips non-`processing`, media error → `failed`/`invalid_media`, rejected format → `failed`/`unsupported_format`, infrastructure error propagates | `src/videos/processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: real Postgres + MinIO + FFmpeg — generated MP4 ends `ready` with duration, metadata and thumbnail object; AVI ends `failed` | `src/videos/processing/video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — entidade `Video`; SI-03.8 — `MediaProbeService` e `checkPlayback`

**Acceptance criteria:**

- Processar um vídeo `processing` com um MP4 H.264 válido deixa-o `ready`, com `duration_seconds` preenchido, `metadata.width`/`metadata.height` iguais às do arquivo e `thumbnail_key = videos/{id}/thumbnail.jpg`
- O objeto `videos/{id}/thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`
- Processar um AVI MPEG-4 deixa o vídeo `failed` com `failure_reason: "unsupported_format"`
- Processar um arquivo que não é vídeo deixa o vídeo `failed` com `failure_reason: "invalid_media"`
- Processar de novo um vídeo que já está `ready` não altera nenhuma coluna

---

### SI-03.10 — Worker de vídeo: consumer da fila e container próprio

**Description:** Coloca o processamento para rodar de verdade: um segundo entrypoint do projeto, sem HTTP, que consome a fila `video-processing` num container `video-worker` do Compose. Só o worker registra o consumer; a API apenas publica jobs.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_QUEUE)` estendendo `WorkerHost`; `process(job)` confere `job.name` antes de ler o payload e despacha `process-video` para `VideoProcessingService.process`; se a tentativa falhar e for a última (`job.attemptsMade + 1 >= job.opts.attempts`), chama `markFailed(videoId, 'processing_failed')` e relança (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`, `### Events/Messages`)
2. Registrar `BullModule.registerQueue({ name: VIDEO_QUEUE })` e o `VideoProcessor` no `VideoProcessingModule`
3. Criar `src/worker/worker.module.ts` (`CoreModule` + `VideoProcessingModule`) e `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` com `enableShutdownHooks()` (per `phase-03-videos/TD-03`)
4. Criar `tsconfig.worker.json` (estende `tsconfig.build.json`, `outDir: ./dist-worker`) e o script `start:worker` (`nest start --watch --entryFile worker --path tsconfig.worker.json`) — saída separada para o worker não apagar o `dist/` da API ao recompilar; excluir `dist-worker` do `tsconfig.json`, do ESLint e do Git; `start:worker:prod` roda `node dist/worker` a partir do `npm run build` normal
5. Adicionar o serviço `video-worker` ao `compose.yaml` — mesmo build e volume do `nestjs-api`, `command: npm run start:worker`, `restart: unless-stopped` (num checkout limpo ele reinicia até o `npm install` feito no `nestjs-api` aparecer no volume), dependente de `db`, `redis` e `minio` saudáveis

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: in-process worker with an isolated `QUEUE_PREFIX` — job → video `ready`; job whose processing keeps failing → `failed`/`processing_failed` after the last attempt | `src/videos/processing/video.processor.integration-spec.ts` |
| `WorkerModule` | Integration: module compiles with its own entity registrations and connects to Postgres and Redis | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.9 — o service que o consumer chama; SI-03.7 — o job que a API publica

**Acceptance criteria:**

- `docker compose up -d` deixa o container `video-worker` em execução, e o log mostra o worker conectado à fila `video-processing`
- Um vídeo concluído pela API fica `ready` sem nenhuma ação manual, processado pelo container `video-worker`
- O processo da API não consome jobs: com o `video-worker` parado, o job fica em espera na fila e o vídeo continua `processing`
- Um job cujo processamento falha em todas as tentativas deixa o vídeo `failed` com `failure_reason: "processing_failed"`
- Ao receber `SIGTERM` (`docker compose stop video-worker`), o worker termina o job em andamento antes de sair, e nenhum job fica ativo sem consumidor

---

### SI-03.11 — Reconciliação de vídeos presos em processamento

**Description:** Fecha a janela entre gravar `processing` e publicar o job: um job periódico do worker reenfileira vídeos que ficaram em `processing` sem job. O status no banco é a fonte de verdade e a fila é derivada dele.

**Technical actions:**

1. Criar `src/videos/processing/video-reconciliation.service.ts` — `requeueStuckVideos()` busca vídeos em `processing` com `updated_at` mais antigo que 10 minutos e adiciona `process-video` para cada um com `jobId` = `id` (per `phase-03-videos/TD-07`)
2. No bootstrap do `VideoProcessor` (`onApplicationBootstrap`), registrar o scheduler com `upsertJobScheduler('reconcile-processing', { every: 300000 }, { name: 'reconcile-processing' })`, e despachar o job `reconcile-processing` para `requeueStuckVideos()` no `process(job)` (per `### Events/Messages` → reconcile-processing)
3. Registrar `VideoReconciliationService` no `VideoProcessingModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconciliationService` | Integration: real Postgres + Redis — stuck video gets a job, recent `processing` video does not, existing job is not duplicated | `src/videos/processing/video-reconciliation.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — o reenfileiramento usa o consumer e a fila do worker

**Acceptance criteria:**

- Um vídeo em `processing` com `updated_at` de 15 minutos atrás e sem job ganha um job `process-video` na execução da reconciliação
- Um vídeo em `processing` atualizado há 1 minuto não é reenfileirado
- Rodar a reconciliação duas vezes seguidas deixa um único job por vídeo
- Depois da subida do worker, a fila tem o scheduler `reconcile-processing` com intervalo de 300000 ms

---

### SI-03.12 — Consulta do vídeo, streaming, download e thumbnail

**Description:** Expõe o estado do vídeo e as três rotas de entrega. Os bytes nunca passam pela API: cada rota confere dono e status e redireciona para uma URL pré-assinada, e o storage atende `Range` para o streaming.

**Technical actions:**

1. Adicionar `VideosService.getVideo(userId, publicId)` (reusa `findOwnedVideo`) e `VideosService.getPlaybackUrl(userId, publicId, kind)` para `stream`, `download` e `thumbnail` — exige `ready` (`VIDEO_NOT_READY`) e assina no endpoint público com validade de 2 horas; `download` envia `attachment` com `filename` ASCII e `filename*` UTF-8 (RFC 6266) (per `phase-03-videos/TD-06`)
2. Expor `GET /videos/:id`, `GET /videos/:id/stream`, `GET /videos/:id/download` e `GET /videos/:id/thumbnail` no controller; as três últimas respondem com `@Redirect()` e a URL devolvida pelo service, e o Swagger documenta o `302` com o header `Location` (per `### API Contracts`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (playback URLs) | Unit: `VIDEO_NOT_READY` for each non-ready status, disposition only on download, non-ASCII filename | `src/videos/videos.service.spec.ts` |
| `VideosController` | E2E: 200 details, 302 with signed `Location`, following the redirect (without the Bearer) with `Range` → 206, download `Content-Disposition`, 409 before ready, 404 for another user | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6 — `findOwned`; SI-03.9 — só vídeos `ready` têm o que entregar

**Acceptance criteria:**

- `GET /videos/:id` do dono retorna `200` com `status`, `duration_seconds` e `metadata`
- `GET /videos/:id/stream` de um vídeo `ready` retorna `302`, e a URL do `Location` responde `206` com `Content-Range` a um `GET` com `Range: bytes=0-1023`
- `GET /videos/:id/download` retorna `302`, e a URL do `Location` responde com `Content-Disposition` `attachment` contendo o nome original (em `filename*` quando não é ASCII)
- `GET /videos/:id/thumbnail` retorna `302` para um objeto `image/jpeg`
- `GET /videos/:id/stream` de um vídeo `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:id/stream` com o token de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.13 — Fluxo completo de upload a reprodução

**Description:** Prova a fase de ponta a ponta com toda a infraestrutura real: upload em partes direto no storage, processamento pelo worker consumindo a fila, e reprodução e download do resultado. Também atualiza o contrato OpenAPI exportado e os exemplos do `api.http`.

**Technical actions:**

1. Criar `test/video-pipeline.e2e-spec.ts` — sobe a API e um contexto do `WorkerModule` no mesmo processo, com `QUEUE_PREFIX` exclusivo da suíte e `STORAGE_PUBLIC_ENDPOINT` igual ao endpoint interno, definidos antes de compilar os módulos (as URLs precisam ser alcançáveis de dentro do container de testes); envia a primeira parte do MP4 de 32–48 MiB do `video-fixtures`, consulta `GET /videos/:id/upload` como um cliente que retoma, envia o resto, conclui e espera `ready`; limpa objetos, multiparts e a fila da suíte no fim
2. Regenerar `src/metadata.ts` e `openapi.json` pelo caminho que aplica o plugin do Swagger (build do Nest) e conferir no JSON os campos dos DTOs de vídeo (per `openapi-docs-nestjs/TD-02`)
3. Adicionar a seção de vídeos ao `api.http` (início, URLs de parte, estado do upload, conclusão, consulta, stream, download, thumbnail)
4. Smoke com o container `video-worker` real (fora do Jest): com a stack do Compose no ar, um vídeo enviado pelo `api.http`/`curl` chega a `ready` processado pelo container — registrado em `progress.md`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Upload → fila → worker → reprodução | E2E: real Postgres, MinIO, Redis and FFmpeg | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.10 — worker; SI-03.12 — rotas de entrega

**Acceptance criteria:**

- Um MP4 enviado em partes de 16 MiB, com uma interrupção depois da primeira parte e retomada a partir de `GET /videos/:id/upload`, chega a `ready` sem chamadas além do fluxo documentado
- O vídeo `ready` tem `duration_seconds` igual à duração do arquivo gerado (tolerância de 0,1 s) e thumbnail acessível por `GET /videos/:id/thumbnail`
- O stream responde `206` a um `Range` e o download devolve exatamente os bytes enviados (mesmo SHA-256)
- `openapi.json` lista as oito rotas de `/videos` com seus códigos de resposta

---

### SI-03.14 — Documentação de IA e arquitetura da fase

**Description:** Atualiza os documentos que o workflow de IA lê para refletir o código entregue: serviços novos do Compose, módulo de vídeos, fila e worker. Documentação que cite arquivo ou comportamento inexistente quebra as próximas fases.

**Technical actions:**

1. Atualizar `CLAUDE.md` (raiz) — fila definida como BullMQ + Redis no lugar de "TBD", estrutura do repositório e seção de vídeos (upload em partes, worker, storage)
2. Atualizar `nestjs-project/CLAUDE.md` — serviços `minio`, `storage-init`, `redis` e `video-worker`, sequência de primeira subida (`up`, `npm install`, `migration:run`, worker), verificação de prontidão de cada um, scripts `start:worker`, variáveis `STORAGE_*`/`REDIS_*`/`QUEUE_PREFIX`, e como os testes isolam a fila e convivem com o worker do Compose
3. Atualizar `docs/diagrams/software-arch.mermaid` — `Message Queue` de "TBD" para "BullMQ / Redis"

**Tests:** _(empty — documentação; conferida contra o código no fechamento da fase)_

**Dependencies:** SI-03.13 — documenta o estado final

**Acceptance criteria:**

- Todo arquivo, script, serviço e variável citados nos dois `CLAUDE.md` existem no repositório com o nome citado
- O diagrama de arquitetura não tem mais componente "TBD"

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Um vídeo pertence a um canal; o `id` interno nunca aparece na API (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK. Gerado pelo service antes de criar o multipart upload, porque compõe as chaves do storage |
| public_id | varchar(11) | not null, unique (`UQ_videos_public_id`). 8 bytes aleatórios em base64url; identificador da URL (per `phase-03-videos/TD-05`) |
| channel_id | uuid | not null, FK → `channels.id` ON DELETE CASCADE |
| title | varchar(100) | not null. Default: nome do arquivo sem extensão, aparado e cortado em 100 caracteres; se sobrar vazio, o nome completo cortado em 100 |
| status | enum `video_status` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-07`) |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null |
| size_bytes | bigint | not null. Tamanho declarado no início; conferido na conclusão do upload |
| source_key | varchar(255) | not null. `videos/{id}/source` (per `phase-03-videos/TD-08`) |
| upload_id | text | nullable. `UploadId` do multipart upload; `null` depois da conclusão |
| thumbnail_key | varchar(255) | nullable. `videos/{id}/thumbnail.jpg`, preenchido quando o vídeo fica `ready` |
| duration_seconds | double precision | nullable |
| metadata | jsonb | nullable. `{ width, height, video_codec, audio_codec, container, bitrate }` (per `phase-03-videos/TD-04`) |
| failure_reason | varchar(50) | nullable. Um dos valores da tabela de motivos no Error Catalog |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), atualizado a cada escrita |

**Relations:** `Video` belongs to `Channel` (many-to-one, `Video.channel`, `@JoinColumn({ name: 'channel_id' })`). O lado inverso (`Channel.videos`) fica de fora nesta fase: nenhuma consulta parte do canal, e declará-lo obrigaria todos os DataSources de teste da Fase 02 que registram `Channel` a registrar `Video` também. A listagem de vídeos do canal (Fase 04) é quem introduz o lado inverso.
**Indexes:** unique em `public_id` (`UQ_videos_public_id`); index em `channel_id` (`IDX_videos_channel_id`).

### API Contracts

Todas as rotas exigem `Authorization: Bearer <access_token>` (guard global, per `phase-02-auth/TD-02`), ficam fora do throttler (`@SkipThrottle()` e `@ApiBearerAuth('access-token')` no controller inteiro, per Revision de `phase-02-auth/TD-08`) e usam o envelope de erro `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). `:id` é sempre o `public_id`. Campos JSON em `snake_case`, como nas respostas da Fase 02.

**Representação de vídeo** (`VideoResponseDto`), usada nas respostas abaixo:

- id: string — `public_id`, 11 caracteres
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- original_filename: string
- content_type: string
- size_bytes: number
- duration_seconds: number | null
- metadata: `{ width, height, video_codec, audio_codec, container, bitrate }` | null
- failure_reason: string | null
- created_at: string (ISO-8601)

---

#### POST /videos (SI-03.5)

Pré-cadastra o vídeo como `draft` no canal do usuário e abre o multipart upload (per `phase-03-videos/TD-02`).

**Request headers:**
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 a 255 caracteres
- size_bytes: integer, required — 1 a 10737418240 (10 GiB)
- content_type: string, required — `video/mp4` ou `video/webm` (per `phase-03-videos/TD-09`)
- title: string, optional — 1 a 100 caracteres; default: `filename` sem extensão

**Response 201:**
- vídeo (`status: draft`)
- upload: `{ part_size: number, part_count: number }` — `part_size` = 16 MiB; `part_count` = `ceil(size_bytes / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: body inválido, tamanho acima de 10 GiB ou `content_type` fora da lista
- 401: token ausente ou inválido

---

#### POST /videos/:id/upload/part-urls (SI-03.6)

Assina URLs de `UploadPart` para o cliente enviar as partes direto ao storage. Pode ser chamado quantas vezes for preciso (lotes, retomada).

**Request body:**
- part_numbers: integer[], required — 1 a 100 itens, sem repetição, cada um ≥ 1

**Response 201:**
- urls: `[{ part_number: number, size: number, url: string }]` — `size` é o tamanho exato que a parte deve ter (`part_size`, ou o resto na última); a URL assina o `Content-Length`, e um `PUT` com outro tamanho é recusado pelo storage
- expires_in: number — segundos de validade das URLs (3600)

**Error responses:**
- 400 VALIDATION_ERROR: lista vazia, com mais de 100 itens ou com valores repetidos
- 400 INVALID_PART_NUMBER: algum número maior que `part_count`
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 UPLOAD_ALREADY_COMPLETED: upload já concluído

---

#### GET /videos/:id/upload (SI-03.6)

Estado do upload para retomada: quais partes o storage já tem.

**Response 200:**
- part_size: number
- part_count: number
- uploaded_parts: `[{ part_number: number, size: number }]` — ordenado por `part_number`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_ALREADY_COMPLETED
- 410 UPLOAD_EXPIRED: o storage não tem mais a sessão de multipart

---

#### POST /videos/:id/upload/complete (SI-03.7)

Conclui o multipart a partir das partes que o próprio storage lista (o cliente não envia ETags), confere o tamanho do objeto montado, muda o status para `processing` e enfileira o processamento (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`). Repetível e seguro sob chamadas concorrentes: chamado de novo depois da conclusão, devolve o estado atual sem efeito colateral, e só a chamada que efetivamente muda o status publica o job.

**Request body:** nenhum.

**Response 200:**
- vídeo (`status: processing`, ou o status atual quando o upload já tinha sido concluído)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_INCOMPLETE: faltam partes, alguma parte tem tamanho diferente do esperado, ou o storage recusou a lista de partes
- 410 UPLOAD_EXPIRED: sessão de multipart expirada e objeto inexistente

---

#### GET /videos/:id (SI-03.12)

**Response 200:**
- vídeo

**Error responses:**
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:id/stream (SI-03.12)

**Response 302:** `Location` com URL pré-assinada de `GetObject` do arquivo original, válida por 2 horas. O storage atende `Range` com `206 Partial Content` (per `phase-03-videos/TD-06`).

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: status diferente de `ready`

---

#### GET /videos/:id/download (SI-03.12)

**Response 302:** `Location` com URL pré-assinada de `GetObject` com `response-content-disposition` `attachment`, com `filename` em ASCII e `filename*` em UTF-8 (RFC 6266) a partir de `original_filename`, válida por 2 horas.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### GET /videos/:id/thumbnail (SI-03.12)

**Response 302:** `Location` com URL pré-assinada da thumbnail JPEG, válida por 2 horas.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — Upload de vídeos

- `filename`: required, string, 1–255 caracteres
- `size_bytes`: required, inteiro, 1–10737418240
- `content_type`: required, `video/mp4` | `video/webm`
- `title`: optional, string, 1–100 caracteres
- `part_numbers`: required, array de 1–100 inteiros únicos ≥ 1; o limite superior (`part_count`) é regra de domínio e vira `INVALID_PART_NUMBER`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (outro canal) | Owner |
|----------|-----------|-----------------------------|-------|
| POST /videos | ✗ 401 | ✓ (cria no próprio canal) | — |
| POST /videos/:id/upload/part-urls | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:id/upload | ✗ 401 | ✗ 404 | ✓ |
| POST /videos/:id/upload/complete | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:id | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:id/stream | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:id/download | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:id/thumbnail | ✗ 401 | ✗ 404 | ✓ |

Vídeo de outro canal responde `404 VIDEO_NOT_FOUND`, não `403`: nesta fase todo vídeo é um rascunho não publicado e a API não confirma a existência dele (per `phase-03-videos/TD-06`).

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `public_id` inexistente ou de outro canal |
| VIDEO_NOT_READY | 409 | Stream, download ou thumbnail de vídeo fora do status `ready` |
| INVALID_PART_NUMBER | 400 | Número de parte maior que `part_count` |
| UPLOAD_ALREADY_COMPLETED | 409 | Pedido de URLs de parte ou de estado do upload depois da conclusão |
| UPLOAD_INCOMPLETE | 409 | Conclusão com partes faltando, parte com tamanho diferente do esperado, ou lista de partes recusada pelo storage |
| UPLOAD_EXPIRED | 410 | Sessão de multipart expirada no storage (per `phase-03-videos/TD-02`) |

`VALIDATION_ERROR` (400) segue herdado da Fase 02.

**Motivos de falha de processamento** (`videos.failure_reason`, não são respostas HTTP — aparecem na representação do vídeo com `status: failed`):

| failure_reason | Quando |
|----------------|--------|
| `invalid_media` | `ffprobe` não reconhece o arquivo, não há stream de vídeo (capa embutida não conta) ou a duração não é utilizável |
| `unsupported_format` | Container ou codec fora da lista de reprodução no navegador, ou container que não corresponde ao `content_type` declarado (per `phase-03-videos/TD-09`) |
| `processing_failed` | Erro transitório que persistiu depois de todas as tentativas da fila (per `phase-03-videos/TD-07`) |

### Events/Messages

Fila BullMQ `video-processing` no Redis (per `phase-03-videos/TD-01`). Os jobs não são visíveis para o frontend; o cliente acompanha o resultado pelo `status` do vídeo.

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` e `VideoReconciliationService` (per `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessor` no container `video-worker` (per `phase-03-videos/TD-03`)
**Trigger:** upload concluído com sucesso (vídeo passa a `processing`), ou reconciliação encontrou um vídeo preso em `processing`.
**Job options:** `jobId` = `videoId` (deduplicação); `attempts: 3`; `backoff: { type: 'exponential', delay: 10000 }`; `removeOnComplete: true`; `removeOnFail: true`.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). O consumer é idempotente: só processa vídeo em `processing`, e as transições para `ready`/`failed` são `UPDATE ... WHERE status = 'processing'`. Mídia inválida ou fora do formato vira `failed` sem nova tentativa; erro transitório é relançado para a fila tentar de novo. Na última tentativa (`job.attemptsMade + 1 >= job.opts.attempts`, avaliado dentro do `process`), o consumer grava `failed` com `processing_failed` antes de relançar o erro — o estado terminal fica no banco antes de o job sair da fila, sem depender do evento `failed`, que também dispara nas tentativas intermediárias. Um job que falha por stall acima do limite sai da fila sem esse registro; o vídeo continua `processing` e volta pela reconciliação.

#### video-processing / reconcile-processing

**Payload:**

```json
{}
```

**Producer:** job scheduler `reconcile-processing` (`upsertJobScheduler`, cadência de 5 minutos enquanto houver um worker ativo), registrado pelo worker no bootstrap (per `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessor` → `VideoReconciliationService`
**Trigger:** periódico. Reenfileira `process-video` para vídeos em `processing` com `updated_at` mais antigo que 10 minutos; a deduplicação por `jobId` impede job duplicado quando o original ainda existe (esperando, atrasado ou ativo). O corte de 10 minutos também evita que o worker do Compose pegue vídeos que as suítes de teste acabaram de criar no banco compartilhado.
**Delivery semantics:** best-effort; uma execução perdida é coberta pela seguinte.

---

## Dependency Map

```
SI-03.1 (root — infra)
├── SI-03.2 — storage service precisa do MinIO e do SDK
│   └── SI-03.4 — CoreModule carrega storageConfig
├── SI-03.3 — entidade e migration
└── SI-03.8 — FFmpeg na imagem (+ SI-03.2 para ler pelo storage)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 — início do upload
    └── SI-03.6 — URLs de parte e estado do upload
        └── SI-03.7 — conclusão e enfileiramento (+ SI-03.4)

SI-03.3 + SI-03.8
└── SI-03.9 — processamento do vídeo

SI-03.7 + SI-03.9
└── SI-03.10 — worker e container
    └── SI-03.11 — reconciliação

SI-03.6 + SI-03.9
└── SI-03.12 — consulta, streaming, download e thumbnail

SI-03.10 + SI-03.12
└── SI-03.13 — fluxo completo, OpenAPI e api.http
    └── SI-03.14 — documentação
```

Ordem linear de implementação: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14

---

## Deliverables

- [ ] SI-03.1 — Infraestrutura de storage, fila e FFmpeg no Compose
- [ ] SI-03.2 — Configuração e serviço de object storage
- [ ] SI-03.3 — Entidade Video e migration
- [ ] SI-03.4 — Infraestrutura compartilhada da API e do worker, e conexão com a fila
- [ ] SI-03.5 — Início do upload com pré-cadastro do rascunho
- [ ] SI-03.6 — URLs de parte e estado do upload para retomada
- [ ] SI-03.7 — Conclusão do upload e enfileiramento do processamento
- [ ] SI-03.8 — Leitura de metadados e extração de frame com FFmpeg
- [ ] SI-03.9 — Processamento do vídeo: metadados, thumbnail e status final
- [ ] SI-03.10 — Worker de vídeo: consumer da fila e container próprio
- [ ] SI-03.11 — Reconciliação de vídeos presos em processamento
- [ ] SI-03.12 — Consulta do vídeo, streaming, download e thumbnail
- [ ] SI-03.13 — Fluxo completo de upload a reprodução
- [ ] SI-03.14 — Documentação de IA e arquitetura da fase

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
