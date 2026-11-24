import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { cleanStorage } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { UsersService } from '../src/users/users.service';
import type {
  PartUrlsResponseDto,
  UploadStatusResponseDto,
} from '../src/videos/dto/upload-response.dto';
import type {
  StartUploadResponseDto,
  VideoResponseDto,
} from '../src/videos/dto/video-response.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  ProcessVideoJobData,
  VIDEO_QUEUE,
} from '../src/videos/video-queue.constants';
import {
  MAX_VIDEO_SIZE_BYTES,
  PART_SIZE_BYTES,
} from '../src/videos/videos.constants';

const MP4_UPLOAD = {
  filename: 'aula.mp4',
  size_bytes: 52428800,
  content_type: 'video/mp4',
};

const errorOf = (res: Response) => (res.body as { error: string }).error;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<ProcessVideoJobData>;
  let ownerToken: string;
  let strangerToken: string;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = 'test-videos-e2e';
    // The test fetches the signed URLs from inside the container.
    process.env.STORAGE_PUBLIC_ENDPOINT = process.env.STORAGE_ENDPOINT;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_QUEUE),
    );
  });

  afterAll(async () => {
    await cleanStorage('videos/');
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    ownerToken = await signIn('owner@example.com');
    strangerToken = await signIn('stranger@example.com');
  });

  async function signIn(email: string): Promise<string> {
    const password = 'password123';
    const user = await app
      .get(UsersService)
      .createUserWithChannel(email, await argon2.hash(password));
    await dataSource
      .getRepository(User)
      .update(user.id, { is_confirmed: true });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  function api() {
    return request(app.getHttpServer());
  }

  function startUpload(body: object = MP4_UPLOAD) {
    return api()
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);
  }

  async function createDraft(sizeBytes = MP4_UPLOAD.size_bytes) {
    const res = await startUpload({ ...MP4_UPLOAD, size_bytes: sizeBytes });
    expect(res.status).toBe(201);
    return res.body as StartUploadResponseDto;
  }

  async function putParts(
    publicId: string,
    partNumbers: number[],
    content: Buffer,
  ) {
    const res = await api()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: partNumbers })
      .expect(201);

    for (const part of (res.body as PartUrlsResponseDto).urls) {
      const start = (part.part_number - 1) * PART_SIZE_BYTES;
      const response = await fetch(part.url, {
        method: 'PUT',
        body: Uint8Array.from(content.subarray(start, start + part.size)),
      });
      expect(response.status).toBe(200);
    }
  }

  function findStored(publicId: string) {
    return dataSource.getRepository(Video).findOneOrFail({
      where: { public_id: publicId },
      relations: { channel: true },
    });
  }

  describe('POST /videos', () => {
    it('creates a draft and returns the upload plan', async () => {
      const res = await startUpload().expect(201);
      const body = res.body as StartUploadResponseDto;

      expect(body).toMatchObject({
        title: 'aula',
        status: 'draft',
        original_filename: 'aula.mp4',
        size_bytes: 52428800,
        duration_seconds: null,
        metadata: null,
        failure_reason: null,
        upload: { part_size: PART_SIZE_BYTES, part_count: 4 },
      });
      expect(body.id).toMatch(/^[A-Za-z0-9_-]{11}$/);

      const video = await findStored(body.id);
      const owner = await dataSource
        .getRepository(User)
        .findOneByOrFail({ email: 'owner@example.com' });
      expect(video.channel.user_id).toBe(owner.id);
      expect(video.upload_id).toEqual(expect.any(String));
    });

    it('accepts exactly 10 GiB and signs its last part', async () => {
      const res = await startUpload({
        ...MP4_UPLOAD,
        size_bytes: MAX_VIDEO_SIZE_BYTES,
      }).expect(201);
      const draft = res.body as StartUploadResponseDto;
      expect(draft.upload.part_count).toBe(640);

      const urls = await api()
        .post(`/videos/${draft.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ part_numbers: [639, 640] })
        .expect(201);
      expect((urls.body as PartUrlsResponseDto).urls).toMatchObject([
        { part_number: 639, size: PART_SIZE_BYTES },
        { part_number: 640, size: PART_SIZE_BYTES },
      ]);
    });

    it.each([
      ['a size above 10 GiB', { size_bytes: 10737418241 }],
      ['an unsupported content type', { content_type: 'video/x-matroska' }],
      ['an empty filename', { filename: '' }],
      ['a fractional size', { size_bytes: 10.5 }],
      ['a title above 100 characters', { title: 'a'.repeat(101) }],
      ['a NUL in the filename', { filename: 'au\u0000la.mp4' }],
    ])('rejects %s with VALIDATION_ERROR', async (_case, override) => {
      const res = await startUpload({ ...MP4_UPLOAD, ...override }).expect(400);
      expect(errorOf(res)).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token', async () => {
      await api().post('/videos').send(MP4_UPLOAD).expect(401);
    });

    it('is not limited by the auth throttler', async () => {
      for (let i = 0; i < 11; i++) {
        await startUpload().expect(201);
      }
    });
  });

  describe('part URLs and upload status', () => {
    it('signs URLs that accept the part, and lists the part afterwards', async () => {
      const content = randomBytes(PART_SIZE_BYTES + 100);
      const video = await createDraft(content.length);

      const res = await api()
        .post(`/videos/${video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ part_numbers: [1, 2] })
        .expect(201);
      const signed = res.body as PartUrlsResponseDto;
      expect(signed.expires_in).toBe(3600);
      expect(
        signed.urls.map(({ part_number, size }) => [part_number, size]),
      ).toEqual([
        [1, PART_SIZE_BYTES],
        [2, 100],
      ]);

      await putParts(video.id, [1], content);

      const status = await api()
        .get(`/videos/${video.id}/upload`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(status.body as UploadStatusResponseDto).toEqual({
        part_size: PART_SIZE_BYTES,
        part_count: 2,
        uploaded_parts: [{ part_number: 1, size: PART_SIZE_BYTES }],
      });
    });

    it('rejects a part number above the part count', async () => {
      const video = await createDraft();

      const res = await api()
        .post(`/videos/${video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ part_numbers: [5] })
        .expect(400);
      expect(errorOf(res)).toBe('INVALID_PART_NUMBER');
    });

    it.each([
      ['an empty list', []],
      ['repeated numbers', [1, 1]],
      ['zero', [0]],
    ])('rejects %s with VALIDATION_ERROR', async (_case, partNumbers) => {
      const video = await createDraft();

      const res = await api()
        .post(`/videos/${video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ part_numbers: partNumbers })
        .expect(400);
      expect(errorOf(res)).toBe('VALIDATION_ERROR');
    });

    it("hides another user's video", async () => {
      const video = await createDraft();

      const urls = await api()
        .post(`/videos/${video.id}/upload/part-urls`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ part_numbers: [1] })
        .expect(404);
      expect(errorOf(urls)).toBe('VIDEO_NOT_FOUND');

      const status = await api()
        .get(`/videos/${video.id}/upload`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(404);
      expect(errorOf(status)).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 410 once the storage dropped the multipart session', async () => {
      const draft = await createDraft();
      const video = await findStored(draft.id);
      await app
        .get(StorageService)
        .abortMultipartUpload(video.source_key, video.upload_id!);

      const res = await api()
        .get(`/videos/${draft.id}/upload`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(410);
      expect(errorOf(res)).toBe('UPLOAD_EXPIRED');
    });
  });

  describe('POST /videos/:id/upload/complete', () => {
    function complete(publicId: string, token = ownerToken) {
      return api()
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`);
    }

    it('moves the video to processing and enqueues a single job', async () => {
      const content = randomBytes(PART_SIZE_BYTES + 100);
      const draft = await createDraft(content.length);
      await putParts(draft.id, [1, 2], content);

      const first = await complete(draft.id).expect(200);
      expect((first.body as VideoResponseDto).status).toBe('processing');
      const again = await complete(draft.id).expect(200);
      expect((again.body as VideoResponseDto).status).toBe('processing');

      const video = await findStored(draft.id);
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(
        await app.get(StorageService).getObjectSize(video.source_key),
      ).toBe(content.length);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.map(({ id, name, data }) => ({ id, name, data }))).toEqual([
        { id: video.id, name: 'process-video', data: { videoId: video.id } },
      ]);
    });

    it('returns 409 UPLOAD_INCOMPLETE while a part is missing', async () => {
      const content = randomBytes(PART_SIZE_BYTES + 100);
      const draft = await createDraft(content.length);
      await putParts(draft.id, [1], content);

      const res = await complete(draft.id).expect(409);
      expect(errorOf(res)).toBe('UPLOAD_INCOMPLETE');

      const video = await findStored(draft.id);
      expect(video.status).toBe(VideoStatus.DRAFT);
    });

    it("hides another user's video", async () => {
      const draft = await createDraft();

      const res = await complete(draft.id, strangerToken).expect(404);
      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('playback', () => {
    async function readyVideo(filename = 'aula.mp4') {
      const content = randomBytes(1024);
      const res = await startUpload({
        ...MP4_UPLOAD,
        filename,
        size_bytes: content.length,
      }).expect(201);
      const draft = res.body as StartUploadResponseDto;
      await putParts(draft.id, [1], content);
      await api()
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      // Skips the worker: these tests are about delivery, not processing.
      const video = await findStored(draft.id);
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await app
        .get(StorageService)
        .putObject(thumbnailKey, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
      await dataSource.getRepository(Video).update(video.id, {
        status: VideoStatus.READY,
        thumbnail_key: thumbnailKey,
        duration_seconds: 3,
      });
      return { publicId: draft.id, content };
    }

    function get(path: string, token = ownerToken) {
      return api().get(path).set('Authorization', `Bearer ${token}`);
    }

    it('returns the video details', async () => {
      const { publicId } = await readyVideo();

      const res = await get(`/videos/${publicId}`).expect(200);
      expect(res.body as VideoResponseDto).toMatchObject({
        id: publicId,
        status: 'ready',
        duration_seconds: 3,
      });
    });

    it('redirects the stream to a URL that serves byte ranges without the token', async () => {
      const { publicId, content } = await readyVideo();

      const res = await get(`/videos/${publicId}/stream`).expect(302);
      const media = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-99' },
      });

      expect(media.status).toBe(206);
      expect(Buffer.from(await media.arrayBuffer())).toEqual(
        content.subarray(0, 100),
      );
    });

    it('redirects the download to an attachment with the original name', async () => {
      const { publicId, content } = await readyVideo('Aula de ção.mp4');

      const res = await get(`/videos/${publicId}/download`).expect(302);
      const file = await fetch(res.headers.location);

      expect(file.headers.get('content-disposition')).toBe(
        `attachment; filename="Aula de __o.mp4"; filename*=UTF-8''Aula%20de%20%C3%A7%C3%A3o.mp4`,
      );
      expect(Buffer.from(await file.arrayBuffer())).toEqual(content);
    });

    it('redirects the thumbnail to the JPEG', async () => {
      const { publicId } = await readyVideo();

      const res = await get(`/videos/${publicId}/thumbnail`).expect(302);
      const image = await fetch(res.headers.location);

      expect(image.headers.get('content-type')).toBe('image/jpeg');
    });

    it('returns 409 VIDEO_NOT_READY while the video is processing', async () => {
      const content = randomBytes(1024);
      const draft = await createDraft(content.length);
      await putParts(draft.id, [1], content);
      await api()
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      for (const asset of ['stream', 'download', 'thumbnail']) {
        const res = await get(`/videos/${draft.id}/${asset}`).expect(409);
        expect(errorOf(res)).toBe('VIDEO_NOT_READY');
      }
    });

    it("hides another user's video", async () => {
      const { publicId } = await readyVideo();

      for (const path of ['', '/stream', '/download', '/thumbnail']) {
        const res = await get(
          `/videos/${publicId}${path}`,
          strangerToken,
        ).expect(404);
        expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
      }
    });
  });
});
