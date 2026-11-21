import { PART_SIZE_BYTES } from './videos.constants';

export function countParts(sizeBytes: number): number {
  return Math.ceil(sizeBytes / PART_SIZE_BYTES);
}

export function expectedPartSize(
  sizeBytes: number,
  partNumber: number,
): number {
  return Math.min(
    PART_SIZE_BYTES,
    sizeBytes - (partNumber - 1) * PART_SIZE_BYTES,
  );
}
