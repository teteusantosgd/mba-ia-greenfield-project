import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  InvalidMediaError,
  MediaProbeService,
  ProbeResult,
  UnsupportedContainerError,
} from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

const PLAYABLE_PROBE: ProbeResult = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  majorBrand: 'isom',
  docType: null,
  durationSeconds: 20,
  bitrate: 500000,
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 320,
      height: 240,
    },
  ],
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videoRepository: { findOneBy: jest.Mock; update: jest.Mock };
  let mediaProbe: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let storage: { signDownload: jest.Mock; putObject: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        content_type: 'video/mp4',
        source_key: 'videos/video-1/source',
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mediaProbe = {
      probe: jest.fn().mockResolvedValue(PLAYABLE_PROBE),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    };
    storage = {
      signDownload: jest.fn().mockResolvedValue('http://minio/signed'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: MediaProbeService, useValue: mediaProbe },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(VideoProcessingService);
  });

  it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
    'leaves a %s video alone',
    async (status) => {
      videoRepository.findOneBy.mockResolvedValue({ id: 'video-1', status });

      await service.process('video-1');

      expect(mediaProbe.probe).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    },
  );

  it('fails the video as invalid_media when ffprobe cannot read it', async () => {
    mediaProbe.probe.mockRejectedValue(new InvalidMediaError());

    await service.process('video-1');

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'invalid_media' },
    );
  });

  it('fails the video as invalid_media when ffmpeg cannot decode a frame', async () => {
    mediaProbe.extractThumbnail.mockRejectedValue(new InvalidMediaError());

    await service.process('video-1');

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'invalid_media' },
    );
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('fails the video as unsupported_format when browsers cannot play it', async () => {
    mediaProbe.probe.mockResolvedValue({
      ...PLAYABLE_PROBE,
      streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc' }],
    });

    await service.process('video-1');

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'unsupported_format' },
    );
    expect(mediaProbe.extractThumbnail).not.toHaveBeenCalled();
  });

  it('fails the video as unsupported_format when the container is not accepted', async () => {
    mediaProbe.probe.mockRejectedValue(new UnsupportedContainerError());

    await service.process('video-1');

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'unsupported_format' },
    );
  });

  it('takes the thumbnail at 10% of the duration', async () => {
    await service.process('video-1');

    expect(mediaProbe.extractThumbnail).toHaveBeenCalledWith(
      'http://minio/signed',
      0,
      2,
    );
  });

  it('lets infrastructure errors reach the queue', async () => {
    mediaProbe.probe.mockRejectedValue(new Error('ffprobe timed out'));

    await expect(service.process('video-1')).rejects.toThrow(
      'ffprobe timed out',
    );
    expect(videoRepository.update).not.toHaveBeenCalled();
  });
});
