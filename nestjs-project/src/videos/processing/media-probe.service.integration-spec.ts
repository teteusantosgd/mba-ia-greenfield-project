import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { cleanStorage } from '../../test/storage';
import { VideoFixture, videoFixture } from '../../test/video-fixtures';
import {
  InvalidMediaError,
  MediaProbeService,
  UnsupportedContainerError,
} from './media-probe.service';
import { checkPlayback } from './playback-formats';

describe('MediaProbeService (integration)', () => {
  const prefix = `test-media-probe/${randomUUID()}/`;
  let probeService: MediaProbeService;
  let storage: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService],
    }).compile();

    probeService = module.get(MediaProbeService);
    storage = module.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    await cleanStorage(prefix);
  });

  // Same path the worker takes: the file is read over HTTP from the bucket.
  async function signedUrlFor(fixture: VideoFixture): Promise<string> {
    const key = `${prefix}${fixture}`;
    await storage.putObject(
      key,
      await readFile(await videoFixture(fixture)),
      'video/mp4',
    );
    return storage.signDownload(key, { expiresIn: 300, internal: true });
  }

  it('reads duration, dimensions and codecs of an MP4', async () => {
    const result = await probeService.probe(await signedUrlFor('clip.mp4'));

    expect(result.durationSeconds).toBeGreaterThan(2.9);
    expect(result.durationSeconds).toBeLessThan(3.1);
    expect(result.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          codec_type: 'video',
          codec_name: 'h264',
          width: 320,
          height: 240,
        }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]),
    );
  });

  it('extracts a JPEG frame', async () => {
    const jpeg = await probeService.extractThumbnail(
      await signedUrlFor('clip.mp4'),
      0,
      0.3,
    );

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('falls back to the first frame when the position is past the end', async () => {
    const jpeg = await probeService.extractThumbnail(
      await signedUrlFor('clip.mp4'),
      0,
      60,
    );

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it.each(['clip.avi', 'playlist.mp4'] as const)(
    'refuses to open %s with a demuxer outside the accepted containers',
    async (fixture) => {
      await expect(
        probeService.probe(await signedUrlFor(fixture)),
      ).rejects.toThrow(UnsupportedContainerError);
    },
  );

  it('reports a text file as invalid media', async () => {
    await expect(
      probeService.probe(await signedUrlFor('not-a-video.mp4')),
    ).rejects.toThrow(InvalidMediaError);
  });

  it('reports a missing object as an ordinary failure', async () => {
    const url = await storage.signDownload(`${prefix}missing`, {
      expiresIn: 300,
      internal: true,
    });

    const error = await probeService.probe(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidMediaError);
    expect((error as Error).message).not.toContain('X-Amz-Signature');
  });

  it('tells a WebM from a Matroska file with the same codecs', async () => {
    const webm = await probeService.probe(await signedUrlFor('clip.webm'));
    const mkv = await probeService.probe(await signedUrlFor('clip.mkv'));

    expect(webm.docType).toBe('webm');
    expect(mkv.docType).toBe('matroska');
    expect(checkPlayback(webm, 'video/webm')).toMatchObject({ playable: true });
    expect(checkPlayback(webm, 'video/mp4')).toMatchObject({
      reason: 'unsupported_format',
    });
    expect(checkPlayback(mkv, 'video/webm')).toMatchObject({
      reason: 'unsupported_format',
    });
  });
});
