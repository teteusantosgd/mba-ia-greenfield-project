---
libs:
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-11-21T18:42:00-03:00"
  bullmq:
    version: "^6.7.7"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-11-21T18:42:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1172.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-21T18:42:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1172.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-21T18:42:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-21T18:41:24-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-21T18:41:24-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase, pulled via Context7 on 2026-11-21. Versions checked against the registry the same day: `@nestjs/bullmq` 12.0.2 declares peers `@nestjs/common`/`@nestjs/core` `^10 || ^11 || ^12` and `bullmq` `^3 … ^6`, so it runs on the installed NestJS 11; `@aws-sdk/client-s3` 3.1172.0 requires Node >= 20 (container runs Node 25). No library is added for ffmpeg (`node:child_process`) or for the public id (`node:crypto`).

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` (Context7, `content/application/queues.md`). Maps to `phase-03-videos/TD-01` (queue) and `TD-03` (worker runtime).

### Connection and queue registration

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});

BullModule.registerQueue({ name: 'audio' });
```

`forRootAsync` behaves like any async provider, so it can inject a `registerAs` config (`inject: [queueConfig.KEY]`) the same way `TypeOrmModule.forRootAsync` does in this project. Queue options can also be passed asynchronously with `registerQueueAsync()`.

### Producer

```typescript
@Injectable()
export class AudioService {
  constructor(@InjectQueue('audio') private audioQueue: Queue) {}
}
```

The name passed to `@InjectQueue()` must match the one given to `registerQueue()`.

### Consumer

```typescript
@Processor('audio')
export class AudioConsumer extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    await job.updateProgress(50);
    return {};
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {}
}
```

- A class decorated with `@Processor()` and registered as a provider starts a BullMQ `Worker` in the process that loads it. Registering the processor only in the worker's root module keeps the API process a pure producer (TD-03).
- Worker events (`active`, `completed`, `failed`, …) are handled with `@OnWorkerEvent(name)` inside the processor class.
- Sandboxed (forked) processors exist but have no access to the IoC container — not used here (TD-03 Option C was rejected).

### Graceful shutdown

Call `app.enableShutdownHooks()` on the application (or standalone context) so the worker closes its BullMQ connections on `SIGTERM` instead of leaving active jobs to be detected as stalled.

## bullmq

**Source:** `/websites/bullmq_io` (Context7). Maps to `phase-03-videos/TD-01` and `TD-07`.

### Retries with backoff

```typescript
await queue.add(
  'test-retry',
  { foo: 'bar' },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
);
```

Exponential backoff waits `2 ^ (attempts - 1) * delay` ms between tries (1s, 2s, 4s for the example).

### Failing without retry

```typescript
import { Worker, UnrecoverableError } from 'bullmq';

throw new UnrecoverableError('Unrecoverable');
```

Throwing `UnrecoverableError` moves the job straight to the failed set, overriding `attempts`. This is the primitive for "invalid media fails at once" (TD-07, TD-09).

### Deduplication by job id

Adding a job whose `jobId` already exists is a no-op: only the first one is enqueued. Removed jobs (`removeOnComplete` / `removeOnFail`) no longer count as existing, so a job id can be reused after its job is cleaned up. A job id derived from the video id makes the completion endpoint and the reconciliation safe to repeat (TD-02, TD-07).

### Job schedulers (periodic jobs)

```typescript
await queue.upsertJobScheduler('my-scheduler-id', { every: 1000 });
```

`upsertJobScheduler(id, { every }, template?)` creates or updates a scheduler that produces a job every `every` ms; calling it again with the same id updates it instead of duplicating it. Candidate primitive for the periodic reconciliation of TD-07.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7, `clients/client-s3`). Maps to `phase-03-videos/TD-02`, `TD-06`, `TD-08`.

### Client for an S3-compatible endpoint

```typescript
const client = new S3Client({
  endpoint: 'http://localhost:8080',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

`forcePathStyle: true` puts the bucket in the URL path, which MinIO requires when it is addressed by a plain hostname (`minio:9000`).

### Multipart upload commands

- `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`.
- `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` — `PartNumber` is an integer from 1 to 10,000; presigned for the client (see below).
- `ListPartsCommand({ Bucket, Key, UploadId })` → parts already stored, with `PartNumber`, `ETag` and `Size` (basis for resume).
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` — parts must be sent in ascending `PartNumber` order; an invalid list returns `400` (`InvalidPart` / `InvalidPartOrder`).
- `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType` (used to confirm the assembled object).

Each `UploadPart` response carries an `ETag`; browser clients can only read it if the bucket CORS exposes the `ETag` header — the SDK's own `lib-storage` fails with "Missing Bucket CORS configuration for ETag header?" otherwise.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7, `packages/s3-request-presigner`). Maps to `phase-03-videos/TD-02`, `TD-04`, `TD-06`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, new GetObjectCommand(params), {
  expiresIn: 3600,
});
```

- Works for any command (`UploadPartCommand`, `GetObjectCommand`, …). `expiresIn` defaults to 900 seconds.
- The URL is signed for the host of the client's `endpoint`, so URLs meant for a browser must come from a client configured with the public endpoint, and URLs for the worker from one configured with the internal endpoint (TD-04, TD-08).
- `GetObjectCommand` accepts `ResponseContentDisposition` (e.g. `attachment; filename="..."`) and `ResponseContentType`, which become signed query parameters — the storage then answers with those headers (download in TD-06). `Range` requests against the presigned URL are served by the storage with `206`.
- The presigner sets `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` and never signs `content-type`: the body of a presigned `UploadPart` is not covered by the signature. The completion step therefore cannot trust part sizes reported by the client and must check `ListParts` / `HeadObject` instead (TD-02).
