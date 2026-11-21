import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageModule } from '../../storage/storage.module';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VIDEO_QUEUE } from '../video-queue.constants';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoReconciliationService } from './video-reconciliation.service';

@Module({
  imports: [
    // The worker loads no HTTP module, so Video's relations (Channel → User)
    // have to be registered here for TypeORM to build the metadata.
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    StorageModule,
  ],
  providers: [
    MediaProbeService,
    VideoProcessingService,
    VideoReconciliationService,
  ],
  exports: [BullModule, VideoProcessingService, VideoReconciliationService],
})
export class VideoProcessingModule {}
