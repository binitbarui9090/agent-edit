import { ticksToSeconds } from '@agent-edit/shared';
import type { CaptionClip, TimelineState } from '@agent-edit/validation';

export function timelineCaptions(state: TimelineState): CaptionClip[] {
  return state.tracks
    .filter((track) => track.type === 'CAPTIONS')
    .flatMap((track) => track.clips)
    .filter((clip): clip is CaptionClip => clip.kind === 'caption' && clip.enabled)
    .sort((a, b) => a.start - b.start);
}

function srtTime(ticks: number): string {
  const totalMs = Math.round(ticksToSeconds(ticks) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const seconds = Math.floor(totalMs / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(totalMs % 1000, 3)}`;
}

export function captionsToSrt(state: TimelineState): string {
  return timelineCaptions(state)
    .map(
      (clip, index) =>
        `${index + 1}\n${srtTime(clip.start)} --> ${srtTime(clip.start + clip.duration)}\n${clip.text.trim()}\n`,
    )
    .join('\n');
}
