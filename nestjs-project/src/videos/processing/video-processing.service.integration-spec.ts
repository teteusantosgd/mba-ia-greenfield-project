import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { CoreModule } from '../../core/core.module';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { cleanStorage } from '../../test/storage';
import { VideoFixture, videoFixture } from '../../test/video-fixtures';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [CoreModule, VideoProcessingModule],
    }).compile();
    await module.init();

    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 60_000);

  afterAll(async () => {
    await cleanStorage('videos/');
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'processing@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Processing', nickname: 'processing', user_id: user.id });
    channelId = channel.id;
  });

  async function uploadedVideo(
    fixture: VideoFixture,
    contentType: Video['content_type'] = 'video/mp4',
  ): Promise<Video> {
    const id = randomUUID();
    const content = await readFile(await videoFixture(fixture));
    const video = videoRepository.create({
      id,
      public_id: id.slice(0, 11),
      channel_id: channelId,
      title: fixture,
      status: VideoStatus.PROCESSING,
      original_filename: fixture,
      content_type: contentType,
      size_bytes: content.length,
      source_key: `videos/${id}/source`,
    });
    await storage.putObject(video.source_key, content, contentType);
    return videoRepository.save(video);
  }

  it('marks an H.264 MP4 ready with its metadata and a thumbnail', async () => {
    const video = await uploadedVideo('clip.mp4');

    await service.process(video.id);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored).toMatchObject({
      status: VideoStatus.READY,
      thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
      metadata: {
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      },
    });
    expect(stored.duration_seconds).toBeCloseTo(3, 0);

    const thumbnailUrl = await storage.signDownload(stored.thumbnail_key!, {
      expiresIn: 60,
      internal: true,
    });
    const thumbnail = await fetch(thumbnailUrl);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('marks an AVI as unsupported_format', async () => {
    const video = await uploadedVideo('clip.avi');

    await service.process(video.id);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'unsupported_format',
    });
  });

  it('marks a text file as invalid_media', async () => {
    const video = await uploadedVideo('not-a-video.mp4');

    await service.process(video.id);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'invalid_media',
    });
  });

  it('does not touch a video that is already ready', async () => {
    const video = await uploadedVideo('clip.mp4');
    await service.process(video.id);
    const ready = await videoRepository.findOneByOrFail({ id: video.id });

    await service.process(video.id);

    expect(await videoRepository.findOneByOrFail({ id: video.id })).toEqual(
      ready,
    );
  });
});
