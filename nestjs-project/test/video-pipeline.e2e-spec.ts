import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as argon2 from 'argon2';
import { getQueueToken } from '@nestjs/bullmq';
import {
  INestApplication,
  INestApplicationContext,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { cleanStorage } from '../src/test/storage';
import { videoFixture } from '../src/test/video-fixtures';
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
import { VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_QUEUE } from '../src/videos/video-queue.constants';
import { PART_SIZE_BYTES } from '../src/videos/videos.constants';
import { WorkerModule } from '../src/worker/worker.module';

const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');

describe('Video pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let token: string;

  beforeAll(async () => {
    // Both have to be set before the modules compile: the queue prefix keeps
    // the Compose worker away from this suite's jobs, and the signed URLs
    // must be reachable from inside the test container.
    process.env.QUEUE_PREFIX = 'test-video-pipeline';
    process.env.STORAGE_PUBLIC_ENDPOINT = process.env.STORAGE_ENDPOINT;

    const apiModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = apiModule.createNestApplication();
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

    const workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    worker = await workerModule.init();

    const dataSource = app.get(DataSource);
    await cleanAllTables(dataSource);
    app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();

    const user = await app
      .get(UsersService)
      .createUserWithChannel(
        'pipeline@example.com',
        await argon2.hash('password123'),
      );
    await dataSource
      .getRepository(User)
      .update(user.id, { is_confirmed: true });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'pipeline@example.com', password: 'password123' })
      .expect(200);
    token = (login.body as { access_token: string }).access_token;
  }, 60_000);

  afterAll(async () => {
    await app
      .get<Queue>(getQueueToken(VIDEO_QUEUE))
      .obliterate({ force: true });
    await worker.close();
    await app.close();
    await cleanStorage('videos/');
  });

  function api() {
    return {
      get: (path: string) =>
        request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`),
      post: (path: string) =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`),
    };
  }

  async function sendParts(
    publicId: string,
    partNumbers: number[],
    content: Buffer,
  ) {
    const res = await api()
      .post(`/videos/${publicId}/upload/part-urls`)
      .send({ part_numbers: partNumbers })
      .expect(201);
    const { urls } = res.body as PartUrlsResponseDto;
    for (const part of urls) {
      const start = (part.part_number - 1) * PART_SIZE_BYTES;
      const body = content.subarray(start, start + part.size);
      const put = await fetch(part.url, {
        method: 'PUT',
        body: Uint8Array.from(body),
      });
      expect(put.status).toBe(200);
    }
  }

  async function waitForProcessingResult(
    publicId: string,
  ): Promise<VideoResponseDto> {
    for (let i = 0; i < 150; i++) {
      const res = await api().get(`/videos/${publicId}`).expect(200);
      const video = res.body as VideoResponseDto;
      if (video.status !== VideoStatus.PROCESSING) return video;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Video ${publicId} is still processing`);
  }

  it('takes an MP4 from a resumed upload to playback', async () => {
    const content = await readFile(await videoFixture('large.mp4'));

    const started = await api()
      .post('/videos')
      .send({
        filename: 'aula.mp4',
        size_bytes: content.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const draft = started.body as StartUploadResponseDto;
    expect(draft.upload.part_count).toBe(3);

    // The client sends the first part and loses its state. It resumes from
    // what the storage reports instead of starting over.
    await sendParts(draft.id, [1], content);
    const progress = await api().get(`/videos/${draft.id}/upload`).expect(200);
    const { part_count, uploaded_parts } =
      progress.body as UploadStatusResponseDto;
    const uploaded = new Set(uploaded_parts.map((part) => part.part_number));
    const missing = [...Array(part_count).keys()]
      .map((index) => index + 1)
      .filter((partNumber) => !uploaded.has(partNumber));
    expect(missing).toEqual([2, 3]);
    await sendParts(draft.id, missing, content);

    await api().post(`/videos/${draft.id}/upload/complete`).expect(200);

    const video = await waitForProcessingResult(draft.id);
    expect(video).toMatchObject({
      status: 'ready',
      metadata: { width: 640, height: 360, video_codec: 'h264' },
    });
    expect(Math.abs(video.duration_seconds! - 10)).toBeLessThan(0.1);

    const stream = await api().get(`/videos/${draft.id}/stream`).expect(302);
    const range = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=1000-1999' },
    });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      content.subarray(1000, 2000),
    );

    const download = await api()
      .get(`/videos/${draft.id}/download`)
      .expect(302);
    const file = Buffer.from(
      await (await fetch(download.headers.location)).arrayBuffer(),
    );
    expect(sha256(file)).toBe(sha256(content));

    const thumbnail = await api()
      .get(`/videos/${draft.id}/thumbnail`)
      .expect(302);
    const image = Buffer.from(
      await (await fetch(thumbnail.headers.location)).arrayBuffer(),
    );
    expect(image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 60_000);
});
