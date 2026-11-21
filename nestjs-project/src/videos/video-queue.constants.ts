import type { JobsOptions } from 'bullmq';

export const VIDEO_QUEUE = 'video-processing';

export const VIDEO_JOBS = {
  PROCESS: 'process-video',
  RECONCILE: 'reconcile-processing',
} as const;

export interface ProcessVideoJobData {
  videoId: string;
}

// jobId is set per call to the video id, so a repeated add is a no-op.
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: true,
} satisfies JobsOptions;

export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

// Longer than the time between the status update and the job being added,
// and than the gap a test suite needs between creating a video and processing it.
export const STUCK_PROCESSING_AFTER_MS = 10 * 60 * 1000;
