import type { ProbeResult, ProbeStream } from './media-probe.service';
import { checkPlayback } from './playback-formats';

const MP4_FAMILY = 'mov,mp4,m4a,3gp,3g2,mj2';

const video = (codec_name: string, extra: Partial<ProbeStream> = {}) => ({
  index: 0,
  codec_type: 'video',
  codec_name,
  width: 320,
  height: 240,
  ...extra,
});
const audio = (codec_name: string) => ({
  index: 1,
  codec_type: 'audio',
  codec_name,
});

function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    formatName: MP4_FAMILY,
    majorBrand: 'isom',
    docType: null,
    durationSeconds: 3,
    bitrate: 100000,
    streams: [video('h264'), audio('aac')],
    ...overrides,
  };
}

describe('checkPlayback', () => {
  it.each([
    ['H.264 + AAC MP4', probe({}), 'video/mp4'],
    [
      'AV1 + Opus MP4',
      probe({ streams: [video('av1'), audio('opus')] }),
      'video/mp4',
    ],
    [
      'H.264 MP4 without audio',
      probe({ streams: [video('h264')] }),
      'video/mp4',
    ],
    [
      'VP9 + Vorbis WebM',
      probe({
        formatName: 'matroska,webm',
        majorBrand: null,
        docType: 'webm',
        streams: [video('vp9'), audio('vorbis')],
      }),
      'video/webm',
    ],
  ] as const)('accepts %s', (_name, result, contentType) => {
    expect(checkPlayback(result, contentType)).toMatchObject({
      playable: true,
    });
  });

  it.each([
    ['HEVC video', probe({ streams: [video('hevc'), audio('aac')] })],
    ['AC-3 audio', probe({ streams: [video('h264'), audio('ac3')] })],
    ['a QuickTime file', probe({ majorBrand: 'qt' })],
    ['an AVI', probe({ formatName: 'avi', streams: [video('mpeg4')] })],
    [
      'a WebM declared as MP4',
      probe({
        formatName: 'matroska,webm',
        majorBrand: null,
        streams: [video('vp9')],
      }),
    ],
  ])('rejects %s as unsupported_format', (_name, result) => {
    expect(checkPlayback(result, 'video/mp4')).toEqual({
      playable: false,
      reason: 'unsupported_format',
    });
  });

  it('rejects a Matroska file with WebM codecs declared as WebM', () => {
    const mkv = probe({
      formatName: 'matroska,webm',
      majorBrand: null,
      docType: 'matroska',
      streams: [video('vp9'), audio('opus')],
    });
    expect(checkPlayback(mkv, 'video/webm')).toMatchObject({
      reason: 'unsupported_format',
    });
  });

  it('rejects an MP4 declared as WebM', () => {
    expect(checkPlayback(probe({}), 'video/webm')).toMatchObject({
      reason: 'unsupported_format',
    });
  });

  it('treats a file whose only picture is cover art as invalid media', () => {
    const result = probe({
      streams: [
        audio('aac'),
        video('mjpeg', { disposition: { attached_pic: 1 } }),
      ],
    });
    expect(checkPlayback(result, 'video/mp4')).toMatchObject({
      reason: 'invalid_media',
    });
  });

  it('treats a zero duration as invalid media', () => {
    expect(
      checkPlayback(probe({ durationSeconds: 0 }), 'video/mp4'),
    ).toMatchObject({
      reason: 'invalid_media',
    });
  });

  it('returns the streams it accepted', () => {
    expect(checkPlayback(probe({}), 'video/mp4')).toMatchObject({
      playable: true,
      video: { codec_name: 'h264' },
      audio: { codec_name: 'aac' },
    });
  });
});
