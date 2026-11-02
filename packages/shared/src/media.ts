const MIB = 1024 * 1024;

/** Extension is only a first filter. The worker trusts what FFprobe finds inside the file. */
export const UPLOAD_CONTENT_TYPES = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
} as const;

export type UploadExtension = keyof typeof UPLOAD_CONTENT_TYPES;

export function uploadExtension(fileName: string): UploadExtension | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  // hasOwn, not `in`: a name ending in ".constructor" must not match through the prototype.
  return Object.hasOwn(UPLOAD_CONTENT_TYPES, extension) ? (extension as UploadExtension) : null;
}

export const MIN_PART_SIZE = 8 * MIB;
/** S3 allows 10,000 parts. Staying below it leaves no edge case at the limit. */
const TARGET_MAX_PARTS = 9000;
export const MAX_SIGN_BATCH = 100;
export const MAX_UPLOAD_CONCURRENCY = 4;

export function partSizeFor(fileSize: number): number {
  const needed = Math.ceil(fileSize / TARGET_MAX_PARTS);
  return Math.max(MIN_PART_SIZE, Math.ceil(needed / MIB) * MIB);
}

export function partCountFor(fileSize: number, partSize: number): number {
  return Math.max(1, Math.ceil(fileSize / partSize));
}

export const PROCESSING_STEPS = ['probe', 'thumbnails', 'waveform', 'proxy', 'audio'] as const;
export type ProcessingStep = (typeof PROCESSING_STEPS)[number];

export const STEP_LABELS: Record<ProcessingStep, string> = {
  probe: 'Metadata',
  thumbnails: 'Thumbnails',
  waveform: 'Waveform',
  proxy: 'Proxy',
  audio: 'Audio',
};

/** Without these the footage cannot be edited, so their failure fails the asset. */
export const REQUIRED_STEPS: readonly ProcessingStep[] = ['probe', 'proxy'];

export const WAVEFORM_PEAKS_PER_SECOND = 50;
