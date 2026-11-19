import { ASPECT_RATIOS, ASPECT_RATIO_KEYS, RESOLUTION_PRESETS } from '@agent-edit/shared';
import type { ProjectSettings } from '@agent-edit/validation';

const pending = new Set<string>();

/** Marks a project whose first footage should go straight on the timeline once it can play. */
export function requestAutoPlace(projectId: string): void {
  pending.add(projectId);
}

export function consumeAutoPlace(projectId: string): boolean {
  return pending.delete(projectId);
}

const METADATA_TIMEOUT_MS = 4000;
const ASPECT_TOLERANCE = 0.02;

function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const finish = (value: { width: number; height: number } | null) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), METADATA_TIMEOUT_MS);
    video.preload = 'metadata';
    video.onloadedmetadata = () =>
      finish(video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
    // The browser may not decode this codec. The server still can, and only the format guess is lost.
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/**
 * A project shaped like the file it starts from, so a phone video is not letterboxed in a landscape
 * frame. Falls back to the given settings when the browser cannot read the file or its shape is not
 * one a project can have. Uses the smallest preset that loses no resolution.
 */
export async function settingsForFile(
  file: File,
  fallback: ProjectSettings,
): Promise<ProjectSettings> {
  const size = await readDimensions(file);
  if (!size) return fallback;
  const ratio = size.width / size.height;
  const aspectRatio = ASPECT_RATIO_KEYS.find((key) => {
    const { w, h } = ASPECT_RATIOS[key];
    return Math.abs(ratio - w / h) / (w / h) < ASPECT_TOLERANCE;
  });
  if (!aspectRatio) return fallback;
  const presets = RESOLUTION_PRESETS[aspectRatio];
  const preset =
    presets.find((item) => item.width >= size.width && item.height >= size.height) ??
    presets.at(-1)!;
  return { ...fallback, aspectRatio, width: preset.width, height: preset.height };
}

export function projectNameFromFile(file: File): string {
  const name = file.name.replace(/\.[^.]+$/, '').trim();
  return (name || 'Untitled').slice(0, 120);
}
