import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ticksToSeconds } from '@agent-edit/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidMediaError, parseProbe, probeFile } from './probe.js';
import { ProcessTracker } from './process-tracker.js';
import {
  THUMBNAIL_COUNT,
  extractAudio,
  generateProxy,
  generateThumbnails,
  generateWaveform,
} from './steps.js';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
let dir: string;

function make(name: string, args: string[]): string {
  const path = join(dir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
  return path;
}

const VIDEO = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4'];
const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];
let withAudio: string;
let silentVideo: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ae-engine-'));
  withAudio = make('a.mp4', [...VIDEO, ...TONE, '-c:v', 'libx264', '-c:a', 'aac', '-shortest']);
  silentVideo = make('silent.mp4', [...VIDEO, '-c:v', 'libx264']);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('probeFile', () => {
  it('reads metadata from a real file, ignoring any extension', async () => {
    const probe = await probeFile(FFPROBE, withAudio);
    expect(probe).toMatchObject({
      width: 640,
      height: 360,
      frameRate: { num: 30, den: 1 },
      videoCodec: 'h264',
      audioCodec: 'aac',
      isVariableFrameRate: false,
    });
    expect(ticksToSeconds(probe.duration)).toBeCloseTo(4, 0);
  });

  it.each([
    ['mkv', ['-c:v', 'libx264', '-c:a', 'aac']],
    ['mov', ['-c:v', 'libx264', '-c:a', 'aac']],
    ['webm', ['-c:v', 'libvpx-vp9', '-cpu-used', '8', '-deadline', 'realtime', '-c:a', 'libopus']],
  ])('accepts %s', async (extension, codecs) => {
    const path = make(`c.${extension}`, [...VIDEO, ...TONE, ...codecs, '-shortest']);
    const probe = await probeFile(FFPROBE, path);
    expect(probe.width).toBe(640);
    expect(probe.audioChannels).toBeGreaterThan(0);
  });

  it('reports displayed dimensions for rotated footage', async () => {
    const rotated = join(dir, 'rotated.mp4');
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-display_rotation',
      '90',
      '-i',
      silentVideo,
      '-c',
      'copy',
      rotated,
    ]);
    const probe = await probeFile(FFPROBE, rotated);
    expect(Math.abs(probe.rotation)).toBe(90);
    expect([probe.width, probe.height]).toEqual([360, 640]);
  });

  it('rejects garbage bytes named like a video', async () => {
    const path = join(dir, 'fake.mp4');
    writeFileSync(path, Buffer.alloc(4096, 0x41));
    await expect(probeFile(FFPROBE, path)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('rejects an audio-only file', async () => {
    const path = make('audio.mp4', [...TONE, '-c:a', 'aac']);
    await expect(probeFile(FFPROBE, path)).rejects.toThrow('No video stream');
  });
});

describe('hostile input', () => {
  // These are the real attack: the name says mp4, the content references other local files.
  it('refuses an HLS playlist disguised as mp4', async () => {
    const path = join(dir, 'playlist.mp4');
    writeFileSync(
      path,
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile://${withAudio}\n#EXT-X-ENDLIST\n`,
    );
    await expect(probeFile(FFPROBE, path)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('refuses an ffconcat script that FFmpeg would otherwise follow to a sibling file', async () => {
    const path = join(dir, 'concat.mp4');
    // A relative path counts as "safe" to the concat demuxer, so FFmpeg's defaults do not stop it.
    writeFileSync(path, `ffconcat version 1.0\nfile '${basename(withAudio)}'\n`);

    const withoutGuard = execFileSync(FFPROBE, [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'csv=p=0',
      path,
    ]).toString();
    expect(withoutGuard).toContain('h264');

    await expect(probeFile(FFPROBE, path)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('does not treat a file path as a command', async () => {
    const path = join(dir, 'x; touch pwned; $(touch pwned2).mp4');
    writeFileSync(path, readFileSync(withAudio));
    const probe = await probeFile(FFPROBE, path);
    expect(probe.width).toBe(640);
    expect(readdirSync(dir).filter((f) => f.startsWith('pwned'))).toEqual([]);
  });
});

describe('parseProbe', () => {
  it('ignores cover art when looking for video', () => {
    expect(() =>
      parseProbe({
        format: { duration: '10' },
        streams: [
          { codec_type: 'video', width: 500, height: 500, disposition: { attached_pic: 1 } },
          { codec_type: 'audio', codec_name: 'mp3' },
        ],
      }),
    ).toThrow(InvalidMediaError);
  });

  it('flags variable frame rate', () => {
    const probe = parseProbe({
      format: { duration: '10' },
      streams: [
        {
          codec_type: 'video',
          width: 10,
          height: 10,
          avg_frame_rate: '2400/100',
          r_frame_rate: '30/1',
        },
      ],
    });
    expect(probe.isVariableFrameRate).toBe(true);
  });

  it('rejects unknown duration', () => {
    expect(() =>
      parseProbe({
        format: {},
        streams: [{ codec_type: 'video', width: 10, height: 10, avg_frame_rate: '30/1' }],
      }),
    ).toThrow('Unknown duration');
  });
});

describe('generateProxy', () => {
  it('produces a seekable browser-playable proxy with real, rising progress', async () => {
    const big = make('big.mp4', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30:duration=3',
      ...TONE,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
    ]);
    const output = join(dir, 'proxy.mp4');
    const seen: number[] = [];
    await generateProxy(FFMPEG, big, output, {
      duration: 3,
      hasAudio: true,
      onProgress: (p) => seen.push(p),
    });

    const probe = await probeFile(FFPROBE, output);
    expect(probe).toMatchObject({
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBeLessThanOrEqual(1);

    const keyframes = execFileSync(FFPROBE, [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      output,
    ])
      .toString()
      .trim()
      .split('\n')
      .map((line) => Number.parseFloat(line))
      .filter(Number.isFinite);
    expect(keyframes.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < keyframes.length; i++) {
      expect(keyframes[i]! - keyframes[i - 1]!).toBeLessThanOrEqual(1.1);
    }

    // +faststart: the moov atom precedes the media data, so playback needs no full download.
    const head = readFileSync(output).subarray(0, 64 * 1024);
    expect(head.indexOf('moov')).toBeGreaterThan(-1);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat'));
  });

  it('does not upscale small footage and handles no audio', async () => {
    const output = join(dir, 'proxy-silent.mp4');
    await generateProxy(FFMPEG, silentVideo, output, { duration: 4, hasAudio: false });
    const probe = await probeFile(FFPROBE, output);
    expect(probe).toMatchObject({ height: 360, audioCodec: null });
  });

  it('is killed by its abort signal and reports it', async () => {
    const controller = new AbortController();
    const running = generateProxy(FFMPEG, withAudio, join(dir, 'aborted.mp4'), {
      duration: 4,
      hasAudio: true,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow('Aborted');
  });

  it('kills a process that stops making progress', async () => {
    await expect(
      generateProxy(FFMPEG, withAudio, join(dir, 'stalled.mp4'), {
        duration: 4,
        hasAudio: true,
        stallTimeoutMs: 1,
      }),
    ).rejects.toThrow('made no progress');
  });
});

describe('generateThumbnails', () => {
  it('produces evenly spaced images', async () => {
    const out = mkdtempSync(join(dir, 'thumbs-'));
    const seen: number[] = [];
    const files = await generateThumbnails(FFMPEG, withAudio, out, {
      duration: 4,
      onProgress: (p) => seen.push(p),
    });
    expect(files).toHaveLength(THUMBNAIL_COUNT);
    expect(seen.at(-1)).toBe(1);
    for (const file of files) {
      expect(readFileSync(file).subarray(0, 2).toString('hex')).toBe('ffd8');
    }
  });
});

describe('generateWaveform', () => {
  it('writes peaks whose count and amplitude match the audio', async () => {
    const output = join(dir, 'peaks.bin');
    const { peakCount } = await generateWaveform(FFMPEG, withAudio, output, {
      duration: 4,
      peaksPerSecond: 50,
    });
    expect(peakCount).toBeGreaterThan(190);
    expect(peakCount).toBeLessThan(210);
    const bytes = readFileSync(output);
    const peaks = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    expect(peaks.length).toBe(peakCount * 2);
    const middle = peaks.subarray(100, 300);
    expect(Math.max(...middle)).toBeGreaterThan(5);
    expect(Math.min(...middle)).toBeLessThan(-5);
    for (let i = 0; i < peakCount * 2; i += 2) expect(peaks[i]!).toBeLessThanOrEqual(peaks[i + 1]!);
  });

  it('reports failure when the source has no audio', async () => {
    await expect(
      generateWaveform(FFMPEG, silentVideo, join(dir, 'none.bin'), {
        duration: 4,
        peaksPerSecond: 50,
      }),
    ).rejects.toThrow('FFmpeg exited');
  });
});

describe('extractAudio', () => {
  it('produces mono 16 kHz FLAC', async () => {
    const output = join(dir, 'speech.flac');
    await extractAudio(FFMPEG, withAudio, output, { duration: 4 });
    expect(statSync(output).size).toBeGreaterThan(0);
    const streams = execFileSync(FFPROBE, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,channels,sample_rate',
      '-of',
      'csv=p=0',
      output,
    ]).toString();
    expect(streams.trim()).toBe('flac,16000,1');
  });
});

describe('ProcessTracker', () => {
  const endless = ['-nostdin', '-f', 'lavfi', '-i', 'testsrc2=rate=1', '-f', 'null', '-'];
  const running: ChildProcess[] = [];
  let records: string;

  function start(binary: string, args: string[]) {
    const child = spawn(binary, args, { stdio: 'ignore' });
    running.push(child);
    return child;
  }

  function alive(child: ChildProcess) {
    return child.exitCode === null && child.signalCode === null;
  }

  /** A real PID that is guaranteed to be dead, standing in for a crashed worker. */
  const deadPid = () => spawnSync('true').pid;

  function record(child: ChildProcess, binary: string, ownerPid: number) {
    const path = join(records, `${child.pid}.json`);
    writeFileSync(path, JSON.stringify({ pid: child.pid, ownerPid, binary }));
    return path;
  }

  beforeAll(() => {
    records = join(dir, 'processes');
    mkdirSync(records, { recursive: true });
  });

  afterAll(() => {
    for (const child of running) child.kill('SIGKILL');
  });

  it('kills FFmpeg whose owner is dead and forgets it', async () => {
    const orphan = start(FFMPEG, endless);
    await expect.poll(() => orphan.pid).toBeDefined();
    const path = record(orphan, 'ffmpeg', deadPid());
    expect(await new ProcessTracker(records).reap()).toBe(1);
    await expect.poll(() => alive(orphan)).toBe(false);
    expect(readdirSync(records)).not.toContain(path.split('/').pop());
  });

  it('leaves FFmpeg alone while its owner is alive', async () => {
    const owned = start(FFMPEG, endless);
    record(owned, 'ffmpeg', process.pid);
    expect(await new ProcessTracker(records).reap()).toBe(0);
    expect(alive(owned)).toBe(true);
    owned.kill('SIGKILL');
    rmSync(join(records, `${owned.pid}.json`));
  });

  it('never kills an unrelated process that has reused the PID', async () => {
    const innocent = start('sleep', ['30']);
    const path = record(innocent, 'ffmpeg', deadPid());
    expect(await new ProcessTracker(records).reap()).toBe(0);
    expect(alive(innocent)).toBe(true);
    expect(readdirSync(records)).not.toContain(path.split('/').pop());
  });

  it('survives corrupt records and a missing directory', async () => {
    writeFileSync(join(records, 'broken.json'), '{nope');
    expect(await new ProcessTracker(records).reap()).toBe(0);
    expect(readdirSync(records)).not.toContain('broken.json');
    expect(await new ProcessTracker(join(dir, 'does-not-exist')).reap()).toBe(0);
  });

  it('removes its record when the process exits normally', async () => {
    const tracked = join(dir, 'tracked');
    const tracker = new ProcessTracker(tracked);
    const output = join(dir, 'tracked.mp4');
    await generateProxy(FFMPEG, silentVideo, output, { duration: 4, hasAudio: false, tracker });
    await expect.poll(() => readdirSync(tracked)).toEqual([]);
  });
});
