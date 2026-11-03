// Footage with real speech from macOS `say`, including repeated takes and real pauses.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];

export const LINES = [
  'Welcome back to the channel. Today we are looking at software architecture for growing teams.',
  'The most important decision is where you draw the boundaries between your services.',
  'The most important decision is where you draw the boundaries between your services.',
  'A good boundary lets one team ship without waiting for another team, and that is why it matters so much.',
  'Here is the mistake I see most often. People split their system too early, before they understand the domain.',
  'Here is the mistake I see most often. People split their system too early, before they understand the domain.',
  'Start with a simple modular design. Keep the modules honest with clear interfaces. Only pull a service out when you can name the reason, and when a real team will own it from that day on. That one habit will save you years of pain.',
];

export function makeSpeechVideo(dir, output) {
  const parts = LINES.map((line, index) => {
    const aiff = join(dir, `line${index}.aiff`);
    execFileSync('say', ['-v', 'Samantha', '-o', aiff, line]);
    const wav = join(dir, `line${index}.wav`);
    // Each line is followed by a real pause, so silence detection has something true to find.
    execFileSync('ffmpeg', [
      ...quiet,
      '-i',
      aiff,
      '-af',
      'apad=pad_dur=2',
      '-ar',
      '48000',
      '-ac',
      '1',
      wav,
    ]);
    return wav;
  });
  const list = join(dir, 'list.txt');
  execFileSync('sh', [
    '-c',
    `printf "file '%s'\\n" ${parts.map((p) => `"${p}"`).join(' ')} > "${list}"`,
  ]);
  const voice = join(dir, 'speech.wav');
  execFileSync('ffmpeg', [...quiet, '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', voice]);
  execFileSync('ffmpeg', [
    ...quiet,
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-i',
    voice,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '15',
    '-c:a',
    'aac',
    output,
  ]);
}

export function makeCutaway(output) {
  execFileSync('ffmpeg', [
    ...quiet,
    '-f',
    'lavfi',
    '-i',
    'smptebars=size=1280x720:rate=30:duration=12',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '15',
    output,
  ]);
}
