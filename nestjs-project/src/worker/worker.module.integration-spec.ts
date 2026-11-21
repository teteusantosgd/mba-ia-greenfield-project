import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_QUEUE } from '../videos/video-queue.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let module: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = 'test-worker-module';
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
  }, 60_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    delete process.env.QUEUE_PREFIX;
  });

  it('builds the Video metadata without the HTTP modules', async () => {
    const dataSource = module.get(DataSource);

    await expect(dataSource.getRepository(Video).count()).resolves.toEqual(
      expect.any(Number),
    );
  });

  it('registers the reconciliation scheduler on bootstrap', async () => {
    const scheduler = await queue.getJobScheduler('reconcile-processing');

    expect(scheduler).toMatchObject({ every: 300000 });
  });
});
