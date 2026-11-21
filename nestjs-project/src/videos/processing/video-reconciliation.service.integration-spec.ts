import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { CoreModule } from '../../core/core.module';
import { cleanAllTables } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { VIDEO_QUEUE } from '../video-queue.constants';
import { VideoProcessingModule } from './video-processing.module';
import { VideoReconciliationService } from './video-reconciliation.service';

describe('VideoReconciliationService (integration)', () => {
  let module: TestingModule;
  let service: VideoReconciliationService;
  let queue: Queue;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = 'test-reconciliation';
    module = await Test.createTestingModule({
      imports: [CoreModule, VideoProcessingModule],
    }).compile();
    await module.init();

    service = module.get(VideoReconciliationService);
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 60_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    delete process.env.QUEUE_PREFIX;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'reconcile@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Reconcile', nickname: 'reconcile', user_id: user.id });
    channelId = channel.id;
  });

  async function processingVideoUpdated(minutesAgo: number): Promise<string> {
    const id = randomUUID();
    await videoRepository.insert({
      id,
      public_id: id.slice(0, 11),
      channel_id: channelId,
      title: 'stuck',
      status: VideoStatus.PROCESSING,
      original_filename: 'stuck.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      source_key: `videos/${id}/source`,
    });
    // UpdateDateColumn would overwrite updated_at on a repository update.
    await dataSource.query(
      `UPDATE videos SET updated_at = now() - make_interval(mins => $1) WHERE id = $2`,
      [minutesAgo, id],
    );
    return id;
  }

  async function queuedVideoIds(): Promise<string[]> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.map((job) => job.id!).sort();
  }

  it('enqueues videos stuck in processing and leaves recent ones alone', async () => {
    const stuck = await processingVideoUpdated(15);
    await processingVideoUpdated(1);

    await service.requeueStuckVideos();

    expect(await queuedVideoIds()).toEqual([stuck]);
  });

  it('does not duplicate a job that is still queued', async () => {
    const stuck = await processingVideoUpdated(15);

    await service.requeueStuckVideos();
    await service.requeueStuckVideos();

    expect(await queuedVideoIds()).toEqual([stuck]);
  });
});
