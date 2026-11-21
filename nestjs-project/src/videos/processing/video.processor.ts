import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { FAILURE_REASONS } from '../videos.constants';
import {
  ProcessVideoJobData,
  RECONCILE_INTERVAL_MS,
  VIDEO_JOBS,
  VIDEO_QUEUE,
} from '../video-queue.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoReconciliationService } from './video-reconciliation.service';

@Processor(VIDEO_QUEUE)
export class VideoProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly processing: VideoProcessingService,
    private readonly reconciliation: VideoReconciliationService,
    @InjectQueue(VIDEO_QUEUE) private readonly videoQueue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.videoQueue.upsertJobScheduler(
      VIDEO_JOBS.RECONCILE,
      { every: RECONCILE_INTERVAL_MS },
      { name: VIDEO_JOBS.RECONCILE },
    );
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case VIDEO_JOBS.PROCESS:
        return this.processVideo(job as Job<ProcessVideoJobData>);
      case VIDEO_JOBS.RECONCILE:
        return this.reconciliation.requeueStuckVideos();
      default:
        throw new UnrecoverableError(`Unknown job ${job.name}`);
    }
  }

  private async processVideo(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    try {
      await this.processing.process(videoId);
    } catch (error) {
      const attempt = job.attemptsMade + 1;
      const attempts = job.opts.attempts ?? 1;
      this.logger.warn(
        `Video ${videoId}: attempt ${attempt}/${attempts} failed: ${(error as Error).message}`,
      );
      // Recorded here rather than in a 'failed' listener: that event also
      // fires for attempts that will be retried, and the status has to be in
      // the database before the job leaves the queue.
      if (attempt >= attempts) {
        await this.processing.markFailed(
          videoId,
          FAILURE_REASONS.PROCESSING_FAILED,
        );
      }
      throw error;
    }
  }
}
