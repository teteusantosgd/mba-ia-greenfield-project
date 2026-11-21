import { randomBytes, randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidPartsError,
  UploadNotFoundError,
} from '../storage/storage.errors';
import { StoredPart, StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { countParts, expectedPartSize } from './upload-parts';
import {
  InvalidPartNumberException,
  UploadAlreadyCompletedException,
  UploadExpiredException,
  UploadIncompleteException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './video.exceptions';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  VIDEO_JOBS,
  VIDEO_QUEUE,
} from './video-queue.constants';
import {
  MAX_TITLE_LENGTH,
  PART_URL_TTL_SECONDS,
  PLAYBACK_URL_TTL_SECONDS,
  PUBLIC_ID_ATTEMPTS,
} from './videos.constants';

const PUBLIC_ID_CONSTRAINT = 'UQ_videos_public_id';

export type UploadedPart = Pick<StoredPart, 'partNumber' | 'size'>;

export interface SignedPart {
  partNumber: number;
  size: number;
  url: string;
}

function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

function isPublicIdCollision(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { constraint?: string }).constraint ===
      PUBLIC_ID_CONSTRAINT
  );
}

// RFC 6266: an ASCII `filename` for old clients plus the exact name in
// `filename*`. encodeURIComponent leaves ' ( ) * unescaped, which RFC 5987
// does not allow.
function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Cut by code point, as Postgres counts varchar length, so an emoji at the
// limit is not split in half.
function titleFromFilename(filename: string): string {
  const name = filename.replace(/\.[^.]*$/, '').trim();
  return Array.from(name || filename)
    .slice(0, MAX_TITLE_LENGTH)
    .join('');
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectQueue(VIDEO_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
  ) {}

  async startUpload(userId: string, dto: CreateVideoDto): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    const uploadId = await this.storage.createMultipartUpload(
      sourceKey,
      dto.content_type,
    );

    const video = this.videoRepository.create({
      id,
      channel_id: channel.id,
      title: dto.title ?? titleFromFilename(dto.filename),
      original_filename: dto.filename,
      content_type: dto.content_type,
      size_bytes: dto.size_bytes,
      source_key: sourceKey,
      upload_id: uploadId,
    });

    try {
      await this.insertWithPublicId(video);
    } catch (error) {
      await this.storage.abortMultipartUpload(sourceKey, uploadId);
      throw error;
    }
    return video;
  }

  async findOwnedVideo(userId: string, publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async signPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignedPart[]> {
    const video = await this.findDraft(userId, publicId);
    const partCount = countParts(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => {
        const size = expectedPartSize(video.size_bytes, partNumber);
        const url = await this.storage.signUploadPart(
          video.source_key,
          video.upload_id!,
          partNumber,
          size,
          PART_URL_TTL_SECONDS,
        );
        return { partNumber, size, url };
      }),
    );
  }

  async getUploadStatus(
    userId: string,
    publicId: string,
  ): Promise<{ partCount: number; parts: UploadedPart[] }> {
    const video = await this.findDraft(userId, publicId);
    const partCount = countParts(video.size_bytes);
    try {
      const parts = await this.storage.listParts(
        video.source_key,
        video.upload_id!,
      );
      return { partCount, parts };
    } catch (error) {
      if (!(error instanceof UploadNotFoundError)) {
        throw error;
      }
    }

    // A completion assembled the object but did not get to update the
    // status. Every part is in, and calling complete again finishes it.
    if (
      (await this.storage.getObjectSize(video.source_key)) !== video.size_bytes
    ) {
      throw new UploadExpiredException();
    }
    const parts = Array.from({ length: partCount }, (_, index) => ({
      partNumber: index + 1,
      size: expectedPartSize(video.size_bytes, index + 1),
    }));
    return { partCount, parts };
  }

  async completeUpload(userId: string, publicId: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      return video;
    }

    await this.assembleSource(video);

    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    // Only the call that moved the video out of draft publishes the job. If
    // the add fails, the video stays in processing and the reconciliation
    // job enqueues it later.
    if (affected) {
      await this.videoQueue.add(
        VIDEO_JOBS.PROCESS,
        { videoId: video.id },
        { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
      );
    }

    return this.videoRepository.findOneByOrFail({ id: video.id });
  }

  async getStreamUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.findReady(userId, publicId);
    return this.storage.signDownload(video.source_key, {
      expiresIn: PLAYBACK_URL_TTL_SECONDS,
    });
  }

  async getDownloadUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.findReady(userId, publicId);
    return this.storage.signDownload(video.source_key, {
      expiresIn: PLAYBACK_URL_TTL_SECONDS,
      disposition: attachmentDisposition(video.original_filename),
    });
  }

  async getThumbnailUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.findReady(userId, publicId);
    return this.storage.signDownload(video.thumbnail_key!, {
      expiresIn: PLAYBACK_URL_TTL_SECONDS,
    });
  }

  private async findReady(userId: string, publicId: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findDraft(userId: string, publicId: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadAlreadyCompletedException();
    }
    return video;
  }

  private async insertWithPublicId(video: Video): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      video.public_id = generatePublicId();
      try {
        await this.videoRepository.insert(video);
        return;
      } catch (error) {
        if (attempt === PUBLIC_ID_ATTEMPTS || !isPublicIdCollision(error)) {
          throw error;
        }
      }
    }
  }

  private async assembleSource(video: Video): Promise<void> {
    try {
      const parts = await this.storage.listParts(
        video.source_key,
        video.upload_id!,
      );
      if (!this.hasAllParts(video, parts)) {
        throw new UploadIncompleteException();
      }
      await this.storage.completeMultipartUpload(
        video.source_key,
        video.upload_id!,
        parts,
      );
    } catch (error) {
      if (error instanceof InvalidPartsError) {
        throw new UploadIncompleteException();
      }
      if (!(error instanceof UploadNotFoundError)) {
        throw error;
      }
      // The session is also gone when an earlier call completed it but its
      // response was lost, or when a concurrent call got there first. In
      // both cases the assembled object is already in the bucket.
    }

    const size = await this.storage.getObjectSize(video.source_key);
    if (size === null) {
      throw new UploadExpiredException();
    }
    if (size !== video.size_bytes) {
      throw new UploadIncompleteException();
    }
  }

  private hasAllParts(video: Video, parts: StoredPart[]): boolean {
    return (
      parts.length === countParts(video.size_bytes) &&
      parts.every(
        (part, index) =>
          part.partNumber === index + 1 &&
          part.size === expectedPartSize(video.size_bytes, part.partNumber),
      )
    );
  }
}
