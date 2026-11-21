import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import type { AcceptedContentType } from '../videos.constants';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export interface VideoMetadata {
  width: number | null;
  height: number | null;
  video_codec: string;
  audio_codec: string | null;
  container: string;
  bitrate: number | null;
}

@Entity('videos')
@Index('UQ_videos_public_id', ['public_id'], { unique: true })
export class Video {
  // Assigned by the service: the storage keys are derived from it before the row exists.
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11 })
  public_id: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: AcceptedContentType;

  // pg returns bigint as a string; uploads are capped at 10 GB, well within Number.MAX_SAFE_INTEGER.
  @Column({
    type: 'bigint',
    transformer: {
      to: (value: number) => value,
      from: (value: string) => Number(value),
    },
  })
  size_bytes: number;

  @Column({ type: 'varchar', length: 255 })
  source_key: string;

  @Column({ type: 'text', nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
