import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { CoreModule } from '../core/core.module';
import { cleanAllTables } from '../test/create-test-data-source';
import { cleanStorage } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadExpiredException } from './video.exceptions';
import { VIDEO_QUEUE } from './video-queue.constants';
import { PART_SIZE_BYTES } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = 'test-videos-service';
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';

    module = await Test.createTestingModule({
      // Channel → User has to be in the metadata; the API gets it from UsersModule.
      imports: [CoreModule, VideosModule, TypeOrmModule.forFeature([User])],
    }).compile();
    await module.init();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
  });

  afterAll(async () => {
    await cleanStorage('videos/');
    await queue.obliterate({ force: true });
    await module.close();
    delete process.env.QUEUE_PREFIX;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });

    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Uploader', nickname: 'uploader', user_id: user.id });
    userId = user.id;
    channelId = channel.id;
  });

  async function uploadAllParts(video: Video, content: Buffer) {
    const partNumbers = [
      ...Array(Math.ceil(content.length / PART_SIZE_BYTES)).keys(),
    ].map((index) => index + 1);
    const parts = await service.signPartUrls(
      userId,
      video.public_id,
      partNumbers,
    );
    for (const part of parts) {
      const start = (part.partNumber - 1) * PART_SIZE_BYTES;
      const body = content.subarray(start, start + part.size);
      const response = await fetch(part.url, {
        method: 'PUT',
        body: Uint8Array.from(body),
      });
      expect(response.status).toBe(200);
    }
  }

  it('stores the draft in the uploader channel with an open multipart upload', async () => {
    const video = await service.startUpload(userId, {
      filename: 'aula.mp4',
      size_bytes: 1024,
      content_type: 'video/mp4',
    });

    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(stored).toMatchObject({
      channel_id: channelId,
      status: VideoStatus.DRAFT,
      title: 'aula',
      source_key: `videos/${video.id}/source`,
    });
    expect(stored.upload_id).toEqual(expect.any(String));
    expect(video.created_at).toBeInstanceOf(Date);
    await expect(
      storage.listParts(stored.source_key, stored.upload_id!),
    ).resolves.toEqual([]);
  });

  it('lists the parts sent through the signed URLs', async () => {
    const content = randomBytes(PART_SIZE_BYTES + 1024);
    const video = await service.startUpload(userId, {
      filename: 'aula.mp4',
      size_bytes: content.length,
      content_type: 'video/mp4',
    });

    const [first] = await service.signPartUrls(userId, video.public_id, [1]);
    await fetch(first.url, {
      method: 'PUT',
      body: Uint8Array.from(content.subarray(0, first.size)),
    });

    const status = await service.getUploadStatus(userId, video.public_id);
    expect(status.partCount).toBe(2);
    expect(
      status.parts.map(({ partNumber, size }) => ({ partNumber, size })),
    ).toEqual([{ partNumber: 1, size: PART_SIZE_BYTES }]);
  });

  it('reports an aborted multipart session as expired', async () => {
    const video = await service.startUpload(userId, {
      filename: 'aula.mp4',
      size_bytes: 1024,
      content_type: 'video/mp4',
    });
    await storage.abortMultipartUpload(video.source_key, video.upload_id!);

    await expect(
      service.getUploadStatus(userId, video.public_id),
    ).rejects.toThrow(UploadExpiredException);
  });

  it('assembles the object, moves the video to processing and enqueues it once', async () => {
    const content = randomBytes(PART_SIZE_BYTES + 2048);
    const video = await service.startUpload(userId, {
      filename: 'aula.mp4',
      size_bytes: content.length,
      content_type: 'video/mp4',
    });
    await uploadAllParts(video, content);

    const results = await Promise.all([
      service.completeUpload(userId, video.public_id),
      service.completeUpload(userId, video.public_id),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      VideoStatus.PROCESSING,
      VideoStatus.PROCESSING,
    ]);
    expect(await storage.getObjectSize(video.source_key)).toBe(content.length);

    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(stored.upload_id).toBeNull();

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: video.id,
      name: 'process-video',
      data: { videoId: video.id },
    });
  });
});
