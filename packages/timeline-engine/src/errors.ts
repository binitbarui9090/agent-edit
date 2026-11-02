export type TimelineErrorCode =
  | 'clip_not_found'
  | 'track_not_found'
  | 'duplicate_id'
  | 'track_locked'
  | 'incompatible_track'
  | 'invalid_operation'
  | 'overlap'
  | 'off_grid'
  | 'source_out_of_range'
  | 'media_not_found';

/** A rejected edit. Expected in normal use, for example when a stale plan targets a removed clip. */
export class TimelineError extends Error {
  constructor(
    readonly code: TimelineErrorCode,
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
    this.name = 'TimelineError';
  }
}
