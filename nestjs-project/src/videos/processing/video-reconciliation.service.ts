import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  STUCK_PROCESSING_AFTER_MS,
  VIDEO_JOBS,
  VIDEO_QUEUE,
} from '../video-queue.constants';

@Injectable()
export class VideoReconciliationService {
  private readonly logger = new Logger(VideoReconciliationService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectQueue(VIDEO_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
  ) {}

  // A video whose job is still in the queue keeps it: the jobId dedupes the add.
  async requeueStuckVideos(): Promise<void> {
    const stuck = await this.videoRepository.find({
      select: { id: true },
      where: {
        status: VideoStatus.PROCESSING,
        updated_at: LessThan(new Date(Date.now() - STUCK_PROCESSING_AFTER_MS)),
      },
    });
    if (stuck.length === 0) {
      return;
    }

    await this.videoQueue.addBulk(
      stuck.map(({ id }) => ({
        name: VIDEO_JOBS.PROCESS,
        data: { videoId: id },
        opts: { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: id },
      })),
    );
    this.logger.log(`Found ${stuck.length} video(s) stuck in processing`);
  }
}
