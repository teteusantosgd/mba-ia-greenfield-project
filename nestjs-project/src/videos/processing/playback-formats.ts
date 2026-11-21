import type { AcceptedContentType, FailureReason } from '../videos.constants';
import { FAILURE_REASONS } from '../videos.constants';
import type { ProbeResult, ProbeStream } from './media-probe.service';

interface PlaybackFormat {
  isContainer: (probe: ProbeResult) => boolean;
  videoCodecs: string[];
  audioCodecs: string[];
}

// What Chrome, Firefox and Safari all play in a <video> tag without transcoding.
const PLAYBACK_FORMATS: Record<AcceptedContentType, PlaybackFormat> = {
  'video/mp4': {
    // ffprobe reports QuickTime .mov files under the same family as MP4.
    isContainer: (probe) =>
      probe.formatName.split(',').includes('mp4') && probe.majorBrand !== 'qt',
    videoCodecs: ['h264', 'av1'],
    audioCodecs: ['aac', 'mp3', 'opus'],
  },
  'video/webm': {
    // A .mkv file with VP9 has the same format name as a WebM.
    isContainer: (probe) => probe.docType === 'webm',
    videoCodecs: ['vp8', 'vp9', 'av1'],
    audioCodecs: ['vorbis', 'opus'],
  },
};

export type PlaybackCheck =
  | { playable: true; video: ProbeStream; audio: ProbeStream | null }
  | { playable: false; reason: FailureReason };

export function checkPlayback(
  probe: ProbeResult,
  contentType: AcceptedContentType,
): PlaybackCheck {
  // Cover art inside an MP4 or MP3 shows up as a video stream too.
  const video = probe.streams.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  if (!video || !(probe.durationSeconds > 0)) {
    return { playable: false, reason: FAILURE_REASONS.INVALID_MEDIA };
  }

  const audio =
    probe.streams.find((stream) => stream.codec_type === 'audio') ?? null;
  const format = PLAYBACK_FORMATS[contentType];
  const playable =
    format.isContainer(probe) &&
    format.videoCodecs.includes(video.codec_name) &&
    (!audio || format.audioCodecs.includes(audio.codec_name));

  return playable
    ? { playable: true, video, audio }
    : { playable: false, reason: FAILURE_REASONS.UNSUPPORTED_FORMAT };
}
