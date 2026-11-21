import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const FIXTURES_DIR = join(tmpdir(), 'streamtube-video-fixtures');

// ffmpeg arguments for each generated file. None of them contains a space.
const RECIPES = {
  // 3 s, 320x240, H.264 + AAC.
  'clip.mp4':
    '-f lavfi -i testsrc=duration=3:size=320x240:rate=25 -f lavfi -i sine=duration=3 ' +
    '-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest',
  // 2 s, VP9 without audio.
  'clip.webm':
    '-f lavfi -i testsrc=duration=2:size=320x240:rate=25 -c:v libvpx-vp9 -deadline realtime -an',
  // The same VP9 stream in a Matroska container instead of WebM.
  'clip.mkv':
    '-f lavfi -i testsrc=duration=2:size=320x240:rate=25 -c:v libvpx-vp9 -deadline realtime -an',
  // MPEG-4 Part 2 in AVI: valid media that browsers do not play.
  'clip.avi': '-f lavfi -i testsrc=duration=2:size=320x240:rate=25 -c:v mpeg4',
  // About 41 MiB, so an upload needs three 16 MiB parts. The noise keeps
  // x264 from compressing the test pattern down to a few kilobytes.
  'large.mp4':
    '-f lavfi -i testsrc2=duration=10:size=640x360:rate=25 -vf noise=alls=60:allf=t ' +
    '-c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 32M -maxrate 32M -bufsize 64M ' +
    '-movflags +faststart',
};

const TEXT_FILES = {
  'not-a-video.mp4': 'this is plain text, not a video\n'.repeat(500),
  // An HLS playlist renamed to .mp4, pointing at a host outside the storage.
  'playlist.mp4':
    '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://example.invalid/segment.ts\n#EXT-X-ENDLIST\n',
};

export type VideoFixture = keyof typeof RECIPES | keyof typeof TEXT_FILES;

/** Path to a generated media file; built once per machine and reused. */
export async function videoFixture(name: VideoFixture): Promise<string> {
  const path = join(FIXTURES_DIR, name);
  if (existsSync(path)) return path;

  await mkdir(FIXTURES_DIR, { recursive: true });
  if (name in TEXT_FILES) {
    await writeFile(path, TEXT_FILES[name as keyof typeof TEXT_FILES]);
  } else {
    const args = RECIPES[name as keyof typeof RECIPES].split(' ');
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', ...args, path]);
  }
  return path;
}
