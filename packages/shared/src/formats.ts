export const ASPECT_RATIOS = {
  '16:9': { w: 16, h: 9, label: 'Landscape' },
  '9:16': { w: 9, h: 16, label: 'Vertical' },
  '1:1': { w: 1, h: 1, label: 'Square' },
  '4:5': { w: 4, h: 5, label: 'Portrait' },
} as const;

export type AspectRatio = keyof typeof ASPECT_RATIOS;

export const ASPECT_RATIO_KEYS = Object.keys(ASPECT_RATIOS) as [AspectRatio, ...AspectRatio[]];

/** Every preset divides exactly by its aspect ratio and has even sides, as yuv420p requires. */
export const RESOLUTION_PRESETS: Record<
  AspectRatio,
  ReadonlyArray<{ label: string; width: number; height: number }>
> = {
  '16:9': [
    { label: '720p', width: 1280, height: 720 },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '1440p', width: 2560, height: 1440 },
    { label: '4K', width: 3840, height: 2160 },
  ],
  '9:16': [
    { label: '720p', width: 720, height: 1280 },
    { label: '1080p', width: 1080, height: 1920 },
    { label: '1440p', width: 1440, height: 2560 },
    { label: '4K', width: 2160, height: 3840 },
  ],
  '1:1': [
    { label: '720', width: 720, height: 720 },
    { label: '1080', width: 1080, height: 1080 },
    { label: '1440', width: 1440, height: 1440 },
    { label: '2160', width: 2160, height: 2160 },
  ],
  '4:5': [
    { label: '720', width: 720, height: 900 },
    { label: '1080', width: 1080, height: 1350 },
    { label: '1440', width: 1440, height: 1800 },
    { label: '2160', width: 2160, height: 2700 },
  ],
};

export function isValidResolution(aspect: AspectRatio, width: number, height: number): boolean {
  const { w, h } = ASPECT_RATIOS[aspect];
  return width % 2 === 0 && height % 2 === 0 && width * h === height * w;
}
