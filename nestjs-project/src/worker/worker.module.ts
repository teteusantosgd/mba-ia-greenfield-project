import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { VideoProcessingModule } from '../videos/processing/video-processing.module';
import { VideoProcessor } from '../videos/processing/video.processor';

// Root of the video worker. The processor lives only here, so the API and the
// test modules that import VideoProcessingModule never consume the queue.
@Module({
  imports: [CoreModule, VideoProcessingModule],
  providers: [VideoProcessor],
})
export class WorkerModule {}
