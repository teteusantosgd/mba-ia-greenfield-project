import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

// The input is always a presigned storage URL. Only the demuxers of the
// accepted containers may run: playlist formats such as HLS or concat would
// otherwise make ffmpeg fetch whatever URLs the uploaded file lists.
const PROTOCOLS = 'http,https,tcp,tls';
const FORMATS = 'mov,matroska';

const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 120_000;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
}

export interface ProbeResult {
  formatName: string;
  majorBrand: string | null;
  // Matroska files only: 'webm' or 'matroska'.
  docType: string | null;
  durationSeconds: number;
  bitrate: number | null;
  streams: ProbeStream[];
}

interface FfprobeOutput {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    tags?: { major_brand?: string };
  };
}

export class InvalidMediaError extends Error {
  constructor() {
    super('FFmpeg could not read the file as media');
    this.name = 'InvalidMediaError';
  }
}

export class UnsupportedContainerError extends Error {
  constructor() {
    super('The file is in a container the platform does not accept');
    this.name = 'UnsupportedContainerError';
  }
}

interface ExecError {
  code?: number | string;
  killed?: boolean;
  stderr?: string | Buffer;
}

// stderr and the execFile error message both carry the signed URL, so they
// are only used to classify the failure, never passed on.
function translateExecError(tool: string, error: unknown): Error {
  const { code, killed, stderr = '' } = error as ExecError;
  const output = stderr.toString();

  if (code === 'ENOENT') return new Error(`${tool} is not installed`);
  if (killed) return new Error(`${tool} timed out`);
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new Error(`${tool} output exceeded ${MAX_THUMBNAIL_BYTES} bytes`);
  }
  if (output.includes('Format not on whitelist')) {
    return new UnsupportedContainerError();
  }
  if (output.includes('Invalid data found when processing input')) {
    return new InvalidMediaError();
  }
  const http = /Server returned (\d{3})/.exec(output);
  if (http) return new Error(`${tool} got HTTP ${http[1]} from the storage`);
  return new Error(`${tool} exited with code ${code}`);
}

function toNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

// ffprobe reports Matroska and WebM alike as "matroska,webm". Only the
// DocType element (ID 0x4282) of the EBML header at the start of the file
// tells them apart.
async function readMatroskaDocType(url: string): Promise<string | null> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-63' } });
  if (!response.ok) {
    throw new Error(`Storage answered ${response.status} to the header read`);
  }
  const header = Buffer.from(await response.arrayBuffer());
  const at = header.indexOf(Buffer.from([0x42, 0x82]));
  if (at < 0) return null;
  const length = header[at + 2] & 0x7f;
  return header.subarray(at + 3, at + 3 + length).toString('ascii');
}

@Injectable()
export class MediaProbeService {
  async probe(url: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      // prettier-ignore
      ({ stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-protocol_whitelist', PROTOCOLS,
        '-format_whitelist', FORMATS,
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        url,
      ], { timeout: PROBE_TIMEOUT_MS }));
    } catch (error) {
      throw translateExecError('ffprobe', error);
    }

    const { format = {}, streams = [] } = JSON.parse(stdout) as FfprobeOutput;
    const formatName = format.format_name ?? '';
    return {
      formatName,
      majorBrand: format.tags?.major_brand?.trim() ?? null,
      docType: formatName.includes('matroska')
        ? await readMatroskaDocType(url)
        : null,
      durationSeconds: toNumber(format.duration) ?? 0,
      bitrate: toNumber(format.bit_rate),
      streams,
    };
  }

  /**
   * JPEG of the given video stream at `atSeconds`, or of its first frame when
   * the position falls past the last one (a video track shorter than the
   * audio, or a duration that overstates it).
   */
  async extractThumbnail(
    url: string,
    streamIndex: number,
    atSeconds: number,
  ): Promise<Buffer> {
    for (const position of [atSeconds, 0]) {
      const jpeg = await this.extractFrame(url, streamIndex, position);
      if (jpeg.length > 0) return jpeg;
    }
    throw new Error('ffmpeg produced no frame for the thumbnail');
  }

  private async extractFrame(
    url: string,
    streamIndex: number,
    atSeconds: number,
  ): Promise<Buffer> {
    try {
      // prettier-ignore
      const { stdout } = await execFileAsync('ffmpeg', [
        '-v', 'error',
        '-protocol_whitelist', PROTOCOLS,
        '-format_whitelist', FORMATS,
        // Before -i, so ffmpeg seeks by byte range instead of decoding up to it.
        '-ss', atSeconds.toFixed(3),
        '-i', url,
        '-map', `0:${streamIndex}`,
        '-frames:v', '1',
        '-f', 'image2',
        '-c:v', 'mjpeg',
        'pipe:1',
      ], {
        encoding: 'buffer',
        timeout: THUMBNAIL_TIMEOUT_MS,
        maxBuffer: MAX_THUMBNAIL_BYTES,
      });
      return stdout;
    } catch (error) {
      throw translateExecError('ffmpeg', error);
    }
  }
}
