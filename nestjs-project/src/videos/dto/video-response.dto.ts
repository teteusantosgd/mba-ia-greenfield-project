import { ApiProperty } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';
import { countParts } from '../upload-parts';
import { PART_SIZE_BYTES } from '../videos.constants';

class VideoMetadataDto {
  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  container: string;

  @ApiProperty({ type: Number, nullable: true, example: 4500000 })
  bitrate: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ example: 52428800 })
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 312.4 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  failure_reason: string | null;

  @ApiProperty()
  created_at: Date;
}

class UploadPlanDto {
  @ApiProperty({ example: PART_SIZE_BYTES })
  part_size: number;

  @ApiProperty({ example: 4 })
  part_count: number;
}

export class StartUploadResponseDto extends VideoResponseDto {
  @ApiProperty()
  upload: UploadPlanDto;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.public_id,
    title: video.title,
    status: video.status,
    original_filename: video.original_filename,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    metadata: video.metadata,
    failure_reason: video.failure_reason,
    created_at: video.created_at,
  };
}

export function toStartUploadResponse(video: Video): StartUploadResponseDto {
  return {
    ...toVideoResponse(video),
    upload: {
      part_size: PART_SIZE_BYTES,
      part_count: countParts(video.size_bytes),
    },
  };
}
