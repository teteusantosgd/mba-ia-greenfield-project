export const PART_SIZE_BYTES = 16 * 1024 * 1024;

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

export const ACCEPTED_CONTENT_TYPES = ['video/mp4', 'video/webm'] as const;

export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

export const MAX_TITLE_LENGTH = 100;

export const MAX_PART_URLS_PER_REQUEST = 100;

export const PART_URL_TTL_SECONDS = 60 * 60;

export const PLAYBACK_URL_TTL_SECONDS = 2 * 60 * 60;

export const PUBLIC_ID_ATTEMPTS = 5;

export const FAILURE_REASONS = {
  INVALID_MEDIA: 'invalid_media',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  PROCESSING_FAILED: 'processing_failed',
} as const;

export type FailureReason =
  (typeof FAILURE_REASONS)[keyof typeof FAILURE_REASONS];
