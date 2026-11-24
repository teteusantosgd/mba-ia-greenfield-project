import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import type { FailureReason } from '../videos.constants';
import { FAILURE_REASONS } from '../videos.constants';
import {
  InvalidMediaError,
  MediaProbeService,
  ProbeResult,
  UnsupportedContainerError,
} from './media-probe.service';
import { checkPlayback } from './playback-formats';

// Long enough for ffprobe and ffmpeg to finish reading a 10 GB file.
const SOURCE_URL_TTL_SECONDS = 60 * 60;

// Past the opening frames, which are often black or a fade-in.
const THUMBNAIL_POSITION = 0.1;

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (video?.status !== VideoStatus.PROCESSING) {
      return;
    }

    const sourceUrl = await this.storage.signDownload(video.source_key, {
      expiresIn: SOURCE_URL_TTL_SECONDS,
      internal: true,
    });

    let probe: ProbeResult;
    try {
      probe = await this.mediaProbe.probe(sourceUrl);
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        return this.markFailed(videoId, FAILURE_REASONS.INVALID_MEDIA);
      }
      if (error instanceof UnsupportedContainerError) {
        return this.markFailed(videoId, FAILURE_REASONS.UNSUPPORTED_FORMAT);
      }
      throw error;
    }

    const check = checkPlayback(probe, video.content_type);
    if (!check.playable) {
      return this.markFailed(videoId, check.reason);
    }

    let thumbnail: Buffer;
    try {
      thumbnail = await this.mediaProbe.extractThumbnail(
        sourceUrl,
        check.video.index,
        probe.durationSeconds * THUMBNAIL_POSITION,
      );
    } catch (error) {
      // Readable headers, but frames ffmpeg cannot decode.
      if (error instanceof InvalidMediaError) {
        return this.markFailed(videoId, FAILURE_REASONS.INVALID_MEDIA);
      }
      throw error;
    }
    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await this.storage.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: probe.durationSeconds,
        thumbnail_key: thumbnailKey,
        metadata: {
          width: check.video.width ?? null,
          height: check.video.height ?? null,
          video_codec: check.video.codec_name,
          audio_codec: check.audio?.codec_name ?? null,
          container: probe.formatName,
          bitrate: probe.bitrate,
        },
      },
    );
  }

  async markFailed(videoId: string, reason: FailureReason): Promise<void> {
    const { affected } = await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
    if (affected) {
      this.logger.warn(`Video ${videoId} failed: ${reason}`);
    }
  }
}
