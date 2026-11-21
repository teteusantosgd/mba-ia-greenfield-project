import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { cleanStorage } from '../../test/storage';
import { videoFixture } from '../../test/video-fixtures';
import { User } from '../../users/entities/user.entity';
import { WorkerModule } from '../../worker/worker.module';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_JOBS,
  VIDEO_QUEUE,
} from '../video-queue.constants';

async function waitForStatus(
  repository: Repository<Video>,
  id: string,
  status: VideoStatus,
): Promise<Video> {
  for (let i = 0; i < 100; i++) {
    const video = await repository.findOneByOrFail({ id });
    if (video.status === status) return video;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Video ${id} never reached ${status}`);
}

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let queue: Queue;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = 'test-video-processor';
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();

    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 60_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    await cleanStorage('videos/');
    delete process.env.QUEUE_PREFIX;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Worker', nickname: 'worker', user_id: user.id });
    channelId = channel.id;
  });

  async function processingVideo(): Promise<Video> {
    const id = randomUUID();
    return videoRepository.save({
      id,
      public_id: id.slice(0, 11),
      channel_id: channelId,
      title: 'clip',
      status: VideoStatus.PROCESSING,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1,
      source_key: `videos/${id}/source`,
    });
  }

  it('processes a queued video until it is ready', async () => {
    const video = await processingVideo();
    const content = await readFile(await videoFixture('clip.mp4'));
    await storage.putObject(video.source_key, content, 'video/mp4');

    await queue.add(
      VIDEO_JOBS.PROCESS,
      { videoId: video.id },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
    );

    const ready = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.READY,
    );
    expect(ready.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  }, 30_000);

  it('keeps the video in processing between attempts and fails it after the last one', async () => {
    // No source object: every ffprobe run gets a 404 from the storage.
    const video = await processingVideo();

    const job = await queue.add(
      VIDEO_JOBS.PROCESS,
      { videoId: video.id },
      {
        ...PROCESS_VIDEO_JOB_OPTIONS,
        jobId: video.id,
        attempts: 2,
        backoff: { type: 'fixed', delay: 2000 },
      },
    );

    for (let i = 0; i < 50 && !(await job.isDelayed()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await job.isDelayed()).toBe(true);
    const betweenAttempts = await videoRepository.findOneByOrFail({
      id: video.id,
    });
    expect(betweenAttempts.status).toBe(VideoStatus.PROCESSING);

    const failed = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.FAILED,
    );
    expect(failed.failure_reason).toBe('processing_failed');
  }, 30_000);
});
