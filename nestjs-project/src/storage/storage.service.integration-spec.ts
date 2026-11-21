import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { cleanStorage } from '../test/storage';
import { InvalidPartsError, UploadNotFoundError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MiB = 1024 * 1024;

describe('StorageService (integration)', () => {
  const prefix = `test-storage/${randomUUID()}/`;
  let storage: StorageService;

  beforeAll(async () => {
    // Signed URLs are fetched from inside the test container.
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await cleanStorage(prefix);
  });

  async function putPart(url: string, body: Buffer) {
    return fetch(url, { method: 'PUT', body: Uint8Array.from(body) });
  }

  it('assembles an object from parts uploaded through presigned URLs', async () => {
    const key = `${prefix}assembled`;
    const first = randomBytes(5 * MiB);
    const last = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const firstUrl = await storage.signUploadPart(
      key,
      uploadId,
      1,
      first.length,
      60,
    );
    const lastUrl = await storage.signUploadPart(
      key,
      uploadId,
      2,
      last.length,
      60,
    );
    expect((await putPart(firstUrl, first)).status).toBe(200);
    expect((await putPart(lastUrl, last)).status).toBe(200);

    const parts = await storage.listParts(key, uploadId);
    expect(parts.map(({ partNumber, size }) => ({ partNumber, size }))).toEqual(
      [
        { partNumber: 1, size: first.length },
        { partNumber: 2, size: last.length },
      ],
    );

    await storage.completeMultipartUpload(key, uploadId, parts);

    expect(await storage.getObjectSize(key)).toBe(first.length + last.length);
  });

  it('rejects a part whose body does not match the signed length', async () => {
    const key = `${prefix}wrong-length`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.signUploadPart(key, uploadId, 1, 1024, 60);

    const response = await putPart(url, randomBytes(2048));

    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('SignatureDoesNotMatch');
    expect(await storage.listParts(key, uploadId)).toEqual([]);
  });

  it('refuses to assemble a middle part under the 5 MiB minimum', async () => {
    const key = `${prefix}too-small`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    for (const [partNumber, body] of [
      [1, randomBytes(1024)],
      [2, randomBytes(1024)],
    ] as const) {
      const url = await storage.signUploadPart(
        key,
        uploadId,
        partNumber,
        body.length,
        60,
      );
      await putPart(url, body);
    }

    const parts = await storage.listParts(key, uploadId);
    await expect(
      storage.completeMultipartUpload(key, uploadId, parts),
    ).rejects.toThrow(InvalidPartsError);
  });

  it('serves ranges and the requested disposition from a download URL', async () => {
    const key = `${prefix}download`;
    const body = randomBytes(4096);
    await storage.putObject(key, body, 'video/mp4');

    const url = await storage.signDownload(key, {
      expiresIn: 60,
      disposition: 'attachment; filename="aula.mp4"',
    });
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      body.subarray(0, 100),
    );
  });

  it('returns null for the size of a missing object', async () => {
    expect(await storage.getObjectSize(`${prefix}missing`)).toBeNull();
  });

  it('reports an aborted upload as missing', async () => {
    const key = `${prefix}aborted`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toThrow(
      UploadNotFoundError,
    );
    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, size: 1, etag: '"x"' },
      ]),
    ).rejects.toThrow(UploadNotFoundError);
  });
});
