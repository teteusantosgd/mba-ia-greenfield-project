import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { UploadNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  UploadExpiredException,
  UploadIncompleteException,
  VideoNotReadyException,
} from './video.exceptions';
import { VIDEO_QUEUE } from './video-queue.constants';
import { PART_SIZE_BYTES } from './videos.constants';
import { VideosService } from './videos.service';

function uniqueViolation(constraint: string): QueryFailedError {
  const driverError = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint,
  });
  return new QueryFailedError('INSERT INTO "videos"', [], driverError);
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: Record<string, jest.Mock>;
  let storage: Record<string, jest.Mock>;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
      insert: jest.fn().mockResolvedValue({}),
      findOne: jest.fn(),
      findOneByOrFail: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listParts: jest.fn(),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      getObjectSize: jest.fn(),
      signDownload: jest.fn().mockResolvedValue('http://storage/signed'),
    };
    queue = { add: jest.fn().mockResolvedValue({}) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getQueueToken(VIDEO_QUEUE), useValue: queue },
        { provide: StorageService, useValue: storage },
        {
          provide: ChannelsService,
          useValue: {
            findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('startUpload', () => {
    const dto = {
      filename: 'aula.mp4',
      size_bytes: 1024,
      content_type: 'video/mp4' as const,
    };

    it('tries a new public id when the generated one is taken', async () => {
      videoRepository.insert
        .mockRejectedValueOnce(uniqueViolation('UQ_videos_public_id'))
        .mockResolvedValueOnce({});

      const video = await service.startUpload('user-1', dto);

      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      expect(video.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('does not retry other insert errors and aborts the multipart upload', async () => {
      videoRepository.insert.mockRejectedValueOnce(
        uniqueViolation('PK_videos'),
      );

      await expect(service.startUpload('user-1', dto)).rejects.toThrow(
        QueryFailedError,
      );

      expect(videoRepository.insert).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
    });

    it('gives up after five collisions', async () => {
      videoRepository.insert.mockRejectedValue(
        uniqueViolation('UQ_videos_public_id'),
      );

      await expect(service.startUpload('user-1', dto)).rejects.toThrow(
        QueryFailedError,
      );
      expect(videoRepository.insert).toHaveBeenCalledTimes(5);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['aula.mp4', 'aula'],
      ['  aula final .webm', 'aula final'],
      ['.mp4', '.mp4'],
    ])('derives the title from %j', async (filename, title) => {
      const video = await service.startUpload('user-1', { ...dto, filename });
      expect(video.title).toBe(title);
    });

    it('does not split an emoji when cutting the title', async () => {
      const filename = `${'a'.repeat(99)}🎬🎬.mp4`;
      const video = await service.startUpload('user-1', { ...dto, filename });
      expect(video.title).toBe(`${'a'.repeat(99)}🎬`);
    });

    it('cuts the derived title at 100 characters', async () => {
      const filename = `${'a'.repeat(120)}.mp4`;
      const video = await service.startUpload('user-1', { ...dto, filename });
      expect(video.title).toBe('a'.repeat(100));
    });
  });

  describe('completeUpload', () => {
    const size = PART_SIZE_BYTES + 10;
    const draft = {
      id: 'video-1',
      public_id: 'abc',
      status: VideoStatus.DRAFT,
      size_bytes: size,
      source_key: 'videos/video-1/source',
      upload_id: 'upload-1',
    } as Video;
    const allParts = [
      { partNumber: 1, size: PART_SIZE_BYTES, etag: '"a"' },
      { partNumber: 2, size: 10, etag: '"b"' },
    ];

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue({ ...draft });
      videoRepository.findOneByOrFail.mockResolvedValue({
        ...draft,
        status: VideoStatus.PROCESSING,
      });
      storage.listParts.mockResolvedValue(allParts);
      storage.getObjectSize.mockResolvedValue(size);
    });

    it('rejects an upload with a missing part', async () => {
      storage.listParts.mockResolvedValue([allParts[0]]);

      await expect(service.completeUpload('user-1', 'abc')).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a part with an unexpected size', async () => {
      storage.listParts.mockResolvedValue([
        allParts[0],
        { ...allParts[1], size: 9 },
      ]);

      await expect(service.completeUpload('user-1', 'abc')).rejects.toThrow(
        UploadIncompleteException,
      );
    });

    it('returns a video that already left draft without touching storage', async () => {
      const processing = { ...draft, status: VideoStatus.PROCESSING };
      videoRepository.findOne.mockResolvedValue(processing);

      await expect(service.completeUpload('user-1', 'abc')).resolves.toBe(
        processing,
      );
      expect(storage.listParts).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('moves on when the session is gone but the object is complete', async () => {
      storage.listParts.mockRejectedValue(new UploadNotFoundError('key'));

      const video = await service.completeUpload('user-1', 'abc');

      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('recovers when another call completed the upload between listing and completing', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new UploadNotFoundError('key'),
      );

      const video = await service.completeUpload('user-1', 'abc');

      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('reports an expired upload when neither session nor object exist', async () => {
      storage.listParts.mockRejectedValue(new UploadNotFoundError('key'));
      storage.getObjectSize.mockResolvedValue(null);

      await expect(service.completeUpload('user-1', 'abc')).rejects.toThrow(
        UploadExpiredException,
      );
    });

    it('enqueues the job only when it wins the status update', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await service.completeUpload('user-1', 'abc');

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('enqueues with the video id as job id', async () => {
      await service.completeUpload('user-1', 'abc');

      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        expect.objectContaining({ jobId: 'video-1', attempts: 3 }),
      );
    });

    it('keeps the video in processing when the enqueue fails', async () => {
      queue.add.mockRejectedValue(new Error('redis down'));

      await expect(service.completeUpload('user-1', 'abc')).rejects.toThrow(
        'redis down',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(videoRepository.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('playback URLs', () => {
    const ready = {
      id: 'video-1',
      status: VideoStatus.READY,
      original_filename: 'aula.mp4',
      source_key: 'videos/video-1/source',
      thumbnail_key: 'videos/video-1/thumbnail.jpg',
    } as Video;

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue({ ...ready });
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'refuses every URL while the video is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue({ ...ready, status });

        await expect(service.getStreamUrl('user-1', 'abc')).rejects.toThrow(
          VideoNotReadyException,
        );
        await expect(service.getDownloadUrl('user-1', 'abc')).rejects.toThrow(
          VideoNotReadyException,
        );
        await expect(service.getThumbnailUrl('user-1', 'abc')).rejects.toThrow(
          VideoNotReadyException,
        );
      },
    );

    it('signs the stream and thumbnail without a disposition', async () => {
      await service.getStreamUrl('user-1', 'abc');
      await service.getThumbnailUrl('user-1', 'abc');

      expect(storage.signDownload).toHaveBeenNthCalledWith(
        1,
        'videos/video-1/source',
        { expiresIn: 7200 },
      );
      expect(storage.signDownload).toHaveBeenNthCalledWith(
        2,
        'videos/video-1/thumbnail.jpg',
        { expiresIn: 7200 },
      );
    });

    it('asks for an attachment with the original name on download', async () => {
      await service.getDownloadUrl('user-1', 'abc');

      expect(storage.signDownload).toHaveBeenCalledWith(
        'videos/video-1/source',
        {
          expiresIn: 7200,
          disposition: `attachment; filename="aula.mp4"; filename*=UTF-8''aula.mp4`,
        },
      );
    });

    it('keeps a non-ASCII name in filename* and an ASCII fallback in filename', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...ready,
        original_filename: 'Aula "1" (ção).mp4',
      });

      await service.getDownloadUrl('user-1', 'abc');

      const [, options] = storage.signDownload.mock.calls[0] as [
        string,
        { disposition: string },
      ];
      expect(options.disposition).toBe(
        `attachment; filename="Aula _1_ (__o).mp4"; ` +
          `filename*=UTF-8''Aula%20%221%22%20%28%C3%A7%C3%A3o%29.mp4`,
      );
    });
  });

  describe('getUploadStatus', () => {
    const size = PART_SIZE_BYTES + 10;

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.DRAFT,
        size_bytes: size,
        source_key: 'videos/video-1/source',
        upload_id: 'upload-1',
      });
      storage.listParts.mockRejectedValue(new UploadNotFoundError('key'));
    });

    it('lists every part when the session is gone but the object was assembled', async () => {
      storage.getObjectSize.mockResolvedValue(size);

      await expect(service.getUploadStatus('user-1', 'abc')).resolves.toEqual({
        partCount: 2,
        parts: [
          { partNumber: 1, size: PART_SIZE_BYTES },
          { partNumber: 2, size: 10 },
        ],
      });
    });

    it('reports the upload as expired when the object is missing too', async () => {
      storage.getObjectSize.mockResolvedValue(null);

      await expect(service.getUploadStatus('user-1', 'abc')).rejects.toThrow(
        UploadExpiredException,
      );
    });
  });
});
