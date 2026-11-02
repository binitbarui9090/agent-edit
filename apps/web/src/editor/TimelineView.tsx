import { snapToFrame, ticksToSeconds } from '@agent-edit/shared';
import {
  clipEnd,
  clipsInRange,
  createMediaClip,
  findClip,
  isCompatible,
  isRangeFree,
  timelineDuration,
  trimOperation,
} from '@agent-edit/timeline-engine';
import type {
  MediaAsset,
  TimelineClip,
  TimelineOperation,
  TimelineState,
  TimelineTrack,
} from '@agent-edit/validation';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditorContext } from './EditorContext';
import { commitEdit, selectClips, setZoom, toggleClip, useEditor } from './store';
import { formatRulerLabel, pxToTicks, rulerStep, snap, ticksToPx } from './time';
import { useWaveformPeaks } from './waveforms';
import styles from './TimelineView.module.css';

const ROW_HEIGHT = 44;
const OVERSCAN_PX = 400;
const TRAILING_SPACE_PX = 600;
const CHUNK_PX = 256;

export const MEDIA_DRAG_TYPE = 'application/x-agent-edit-media';

interface MoveGesture {
  kind: 'move';
  clipIds: string[];
  anchorClipId: string;
  deltaTicks: number;
  targetTrackId: string;
  valid: boolean;
}

interface TrimGesture {
  kind: 'trim';
  clipId: string;
  edge: 'start' | 'end';
  op: Extract<TimelineOperation, { op: 'trim_clip' }>;
  valid: boolean;
}

type Gesture = MoveGesture | TrimGesture;

function snapTargets(
  state: TimelineState,
  playhead: number,
  ignore: ReadonlySet<string>,
): number[] {
  const targets = [0, playhead];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (ignore.has(clip.id)) continue;
      targets.push(clip.start, clipEnd(clip));
    }
  }
  return targets;
}

/** Where a set of selected clips would land, with collisions checked against everything else. */
function resolveMove(
  state: TimelineState,
  clipIds: string[],
  rawDelta: number,
  anchorId: string,
  targetTrackId: string,
  playhead: number,
  pxPerSecond: number,
): { delta: number; valid: boolean; ops: TimelineOperation[] } {
  const moving = new Set(clipIds);
  const anchor = findClip(state, anchorId);
  if (!anchor) return { delta: 0, valid: false, ops: [] };

  const targets = snapTargets(state, playhead, moving);
  const startSnap = snap(anchor.clip.start + rawDelta, targets, pxPerSecond);
  const endSnap = snap(clipEnd(anchor.clip) + rawDelta, targets, pxPerSecond);
  let delta = rawDelta;
  if (startSnap.snapped) delta = startSnap.time - anchor.clip.start;
  else if (endSnap.snapped) delta = endSnap.time - clipEnd(anchor.clip);
  delta = snapToFrame(delta, state.frameRate);

  const located = clipIds.map((id) => findClip(state, id)).filter((found) => found !== null);
  const earliest = Math.min(...located.map((found) => found.clip.start));
  if (earliest + delta < 0) delta = -earliest;

  const crossTrack = clipIds.length === 1 && targetTrackId !== anchor.track.id;
  const target = state.tracks.find((track) => track.id === targetTrackId);
  let valid = true;
  const ops: TimelineOperation[] = [];
  for (const { clip, track } of located) {
    const destination = crossTrack && target ? target : track;
    const start = clip.start + delta;
    if (
      destination.locked ||
      !isCompatible(clip.kind, destination.type) ||
      !isRangeFree(destination, start, start + clip.duration, moving)
    ) {
      valid = false;
    }
    if (destination.id !== track.id) {
      ops.push({ op: 'change_track', clipId: clip.id, trackId: destination.id, start });
    } else if (delta !== 0) {
      ops.push({ op: 'move_clip', clipId: clip.id, start });
    }
  }
  return { delta, valid, ops };
}

function Waveform({
  clip,
  pxPerSecond,
  visibleFromPx,
  visibleToPx,
}: {
  clip: Extract<TimelineClip, { kind: 'media' }>;
  pxPerSecond: number;
  visibleFromPx: number;
  visibleToPx: number;
}) {
  const { playback } = useEditorContext();
  const info = playback.get(clip.sourceMediaId);
  const peaks = useWaveformPeaks(clip.sourceMediaId, info?.waveform?.url ?? null);
  const peaksPerSecond = info?.waveform?.peaksPerSecond ?? 0;
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = Math.max(0, Math.round(visibleToPx - visibleFromPx));

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context || !peaks || width === 0 || !peaksPerSecond) return;
    const ratio = window.devicePixelRatio || 1;
    const height = element.clientHeight || 30;
    element.width = width * ratio;
    element.height = height * ratio;
    context.scale(ratio, ratio);
    context.fillStyle = getComputedStyle(element).color;
    const middle = height / 2;
    const pairs = peaks.length / 2;
    const sourceStart = ticksToSeconds(clip.sourceIn);
    const secondsPerPx = clip.speed / pxPerSecond;
    for (let x = 0; x < width; x++) {
      const seconds = sourceStart + (visibleFromPx + x) * secondsPerPx;
      const from = Math.floor(seconds * peaksPerSecond);
      const to = Math.max(from + 1, Math.floor((seconds + secondsPerPx) * peaksPerSecond));
      let min = 0;
      let max = 0;
      for (let i = from; i < to && i < pairs; i++) {
        min = Math.min(min, peaks[i * 2] ?? 0);
        max = Math.max(max, peaks[i * 2 + 1] ?? 0);
      }
      const top = middle - (max / 127) * middle;
      const bottom = middle - (min / 127) * middle;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks, peaksPerSecond, width, visibleFromPx, pxPerSecond, clip.sourceIn, clip.speed]);

  if (!info?.waveform || width === 0) return null;
  return (
    <canvas
      ref={canvas}
      className={styles.waveform}
      style={{ left: visibleFromPx, width }}
      aria-hidden="true"
    />
  );
}

interface ClipViewProps {
  clip: TimelineClip;
  track: TimelineTrack;
  label: string;
  pxPerSecond: number;
  selected: boolean;
  proposed: boolean;
  deltaTicks: number;
  invalid: boolean;
  /** Whole chunks, so scrolling only redraws a waveform when it crosses a boundary. */
  viewFromPx: number;
  viewToPx: number;
  onPointerDown: (
    event: ReactPointerEvent,
    clip: TimelineClip,
    part: 'body' | 'start' | 'end',
  ) => void;
}

const ClipView = memo(function ClipView({
  clip,
  track,
  label,
  pxPerSecond,
  selected,
  proposed,
  deltaTicks,
  invalid,
  viewFromPx,
  viewToPx,
  onPointerDown,
}: ClipViewProps) {
  const left = ticksToPx(clip.start + deltaTicks, pxPerSecond);
  const width = Math.max(2, ticksToPx(clip.duration, pxPerSecond));
  const speed = clip.kind === 'media' && clip.speed !== 1 ? ` ${clip.speed.toFixed(2)}x` : '';
  const visibleFromPx = Math.max(0, viewFromPx - left);
  const visibleToPx = Math.min(width, viewToPx - left);

  return (
    <div
      className={styles.clip}
      data-track-type={track.type}
      data-selected={selected}
      data-proposed={proposed}
      data-enabled={clip.enabled}
      data-invalid={invalid}
      data-clip-id={clip.id}
      data-testid="clip"
      role="button"
      aria-pressed={selected}
      aria-label={`${label}, starts ${ticksToSeconds(clip.start).toFixed(2)} seconds`}
      tabIndex={-1}
      style={{ left, width }}
      onPointerDown={(event) => onPointerDown(event, clip, 'body')}
    >
      {clip.kind === 'media' && track.type !== 'OVERLAYS' && (
        <Waveform
          clip={clip}
          pxPerSecond={pxPerSecond}
          visibleFromPx={visibleFromPx}
          visibleToPx={visibleToPx}
        />
      )}
      <span className={styles.clipLabel}>
        {label}
        {speed}
      </span>
      {!track.locked && (
        <>
          <span
            className={`${styles.handle} ${styles.handleStart}`}
            data-testid="trim-start"
            onPointerDown={(event) => {
              event.stopPropagation();
              onPointerDown(event, clip, 'start');
            }}
          />
          <span
            className={`${styles.handle} ${styles.handleEnd}`}
            data-testid="trim-end"
            onPointerDown={(event) => {
              event.stopPropagation();
              onPointerDown(event, clip, 'end');
            }}
          />
        </>
      )}
    </div>
  );
});

function clipLabel(clip: TimelineClip, media: ReadonlyMap<string, MediaAsset>): string {
  if (clip.kind === 'caption') return clip.text;
  return media.get(clip.sourceMediaId)?.name ?? 'Missing media';
}

const Ruler = memo(function Ruler({
  pxPerSecond,
  fromPx,
  toPx,
}: {
  pxPerSecond: number;
  fromPx: number;
  toPx: number;
}) {
  const step = rulerStep(pxPerSecond);
  const first = Math.floor(fromPx / pxPerSecond / step) * step;
  const marks: number[] = [];
  for (let seconds = first; seconds * pxPerSecond <= toPx; seconds += step) marks.push(seconds);
  return (
    <>
      {marks.map((seconds) => (
        <span key={seconds} className={styles.mark} style={{ left: seconds * pxPerSecond }}>
          {formatRulerLabel(seconds)}
        </span>
      ))}
    </>
  );
});

export function TimelineView() {
  const { engine, media } = useEditorContext();
  const timeline = useEditor((state) => state.timeline);
  const selection = useEditor((state) => state.selection);
  const pxPerSecond = useEditor((state) => state.pxPerSecond);
  const proposedClips = useEditor((state) => state.previewClipIds);
  const scroller = useRef<HTMLDivElement>(null);
  const headers = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setView((current) => ({ ...current, width: element.clientWidth }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pxPerSecondRef = useRef(pxPerSecond);
  pxPerSecondRef.current = pxPerSecond;

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe((time) => {
      const x = ticksToPx(time, pxPerSecondRef.current);
      if (playhead.current) playhead.current.style.transform = `translateX(${x}px)`;
      const element = scroller.current;
      // Follow the playhead during playback, like every NLE.
      if (element && engine.isPlaying) {
        if (x > element.scrollLeft + element.clientWidth - 40 || x < element.scrollLeft) {
          element.scrollLeft = Math.max(0, x - 80);
        }
      }
    });
  }, [engine]);

  useEffect(() => {
    if (playhead.current && engine) {
      playhead.current.style.transform = `translateX(${ticksToPx(engine.time, pxPerSecond)}px)`;
    }
  }, [pxPerSecond, engine]);

  const duration = timeline ? timelineDuration(timeline) : 0;
  const contentWidth = ticksToPx(duration, pxPerSecond) + TRAILING_SPACE_PX;
  const fromPx = view.left - OVERSCAN_PX;
  const toPx = view.left + view.width + OVERSCAN_PX;
  // Rounded to chunks, so a waveform only redraws when scrolling crosses a boundary.
  const chunkFrom = Math.floor(fromPx / CHUNK_PX) * CHUNK_PX;
  const chunkTo = Math.ceil(toPx / CHUNK_PX) * CHUNK_PX;
  const rangeFrom = pxToTicks(Math.max(0, fromPx), pxPerSecond);
  const rangeTo = pxToTicks(toPx, pxPerSecond);

  const selected = useMemo(() => new Set(selection), [selection]);

  const handleClipPointer = useCallback(
    (event: ReactPointerEvent, clip: TimelineClip, part: 'body' | 'start' | 'end') => {
      if (event.button !== 0) return;
      event.preventDefault();
      const state = useEditor.getState();
      const current = state.timeline;
      const element = scroller.current;
      if (!current || !element || !engine) return;
      const located = findClip(current, clip.id);
      if (!located) return;

      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const wasSelected = state.selection.includes(clip.id);
      if (part === 'body' && additive) {
        toggleClip(clip.id, true);
        return;
      }
      if (!wasSelected) selectClips([clip.id]);
      const dragging = part === 'body' && wasSelected ? [...state.selection] : [clip.id];
      if (located.track.locked) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const rect = element.getBoundingClientRect();
      const scale = useEditor.getState().pxPerSecond;
      const scrollAtStart = element.scrollLeft;
      const media = (clipItem: TimelineClip) =>
        clipItem.kind === 'media'
          ? (engineMedia.current.get(clipItem.sourceMediaId)?.probe?.duration ?? null)
          : null;

      let latestOps: TimelineOperation[] = [];
      let moved = false;

      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - startX + (element.scrollLeft - scrollAtStart);
        const dy = move.clientY - startY;
        // Both axes: a straight vertical drag is how a clip changes track.
        if (Math.hypot(dx, dy) < 3 && !moved) return;
        moved = true;
        const rawTicks = pxToTicks(dx, scale);
        if (part === 'body') {
          const rowIndex = Math.floor(
            (move.clientY - rect.top + element.scrollTop - RULER_HEIGHT) / ROW_HEIGHT,
          );
          const row = current.tracks[Math.max(0, Math.min(current.tracks.length - 1, rowIndex))];
          const result = resolveMove(
            current,
            dragging,
            rawTicks,
            clip.id,
            row?.id ?? located.track.id,
            engine.time,
            scale,
          );
          latestOps = result.valid ? result.ops : [];
          setGesture({
            kind: 'move',
            clipIds: dragging,
            anchorClipId: clip.id,
            deltaTicks: result.delta,
            targetTrackId: row?.id ?? located.track.id,
            valid: result.valid,
          });
        } else {
          const targets = snapTargets(current, engine.time, new Set([clip.id]));
          const raw = (part === 'start' ? clip.start : clipEnd(clip)) + rawTicks;
          const snapped = snap(raw, targets, scale).time;
          // Trimming may not run into a neighbour on the same track.
          const others = located.track.clips.filter((other) => other.id !== clip.id);
          const before = others.filter((other) => clipEnd(other) <= clip.start).at(-1);
          const after = others.find((other) => other.start >= clipEnd(clip));
          const bounded =
            part === 'start'
              ? Math.max(snapped, before ? clipEnd(before) : 0)
              : Math.min(snapped, after ? after.start : Number.MAX_SAFE_INTEGER);
          const op = trimOperation(clip, part, bounded, current, media(clip));
          if (op.op === 'trim_clip') {
            latestOps = [op];
            setGesture({ kind: 'trim', clipId: clip.id, edge: part, op, valid: true });
          }
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setGesture(null);
        if (moved && latestOps.length > 0) {
          const summary =
            part === 'body'
              ? dragging.length > 1
                ? `Move ${dragging.length} clips`
                : latestOps[0]?.op === 'change_track'
                  ? 'Move clip to another track'
                  : 'Move clip'
              : 'Trim clip';
          commitEdit(latestOps, summary);
        }
      };

      const onCancel = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setGesture(null);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [engine],
  );

  const engineMedia = useRef(media);
  engineMedia.current = media;

  function seekFromPointer(event: ReactPointerEvent) {
    const element = scroller.current;
    if (!element || !engine) return;
    const toTime = (clientX: number) => {
      const rect = element.getBoundingClientRect();
      return pxToTicks(clientX - rect.left + element.scrollLeft, pxPerSecond);
    };
    engine.seek(toTime(event.clientX));
    const onMove = (move: PointerEvent) => engine.seek(toTime(move.clientX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function dropMedia(event: DragEvent, track: TimelineTrack) {
    const mediaId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!mediaId || !timeline || !scroller.current) return;
    event.preventDefault();
    const asset = media.get(mediaId);
    if (!asset?.probe) return;
    const rect = scroller.current.getBoundingClientRect();
    const raw = pxToTicks(event.clientX - rect.left + scroller.current.scrollLeft, pxPerSecond);
    const clip = createMediaClip(
      { sourceMediaId: mediaId, start: raw, sourceIn: 0, sourceOut: asset.probe.duration },
      timeline.frameRate,
    );
    if (!isCompatible('media', track.type)) {
      useEditor.setState({ error: `${track.name} cannot hold footage` });
      return;
    }
    const ops: TimelineOperation[] = [{ op: 'add_clip', trackId: track.id, clip }];
    if (commitEdit(ops, `Add ${asset.name}`)) selectClips([clip.id]);
  }

  function onWheel(event: React.WheelEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const element = scroller.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const pointerPx = event.clientX - rect.left + element.scrollLeft;
    const seconds = pointerPx / pxPerSecond;
    const next = pxPerSecond * Math.exp(-event.deltaY * 0.002);
    setZoom(next);
    // Keeps the point under the cursor where it is, which makes zooming feel anchored.
    requestAnimationFrame(() => {
      const zoom = useEditor.getState().pxPerSecond;
      element.scrollLeft = seconds * zoom - (event.clientX - rect.left);
    });
  }

  if (!timeline) return null;

  const trackVolumes = (track: TimelineTrack) => {
    const ops: TimelineOperation[] = [
      { op: 'update_track', trackId: track.id, muted: !track.muted },
    ];
    commitEdit(ops, `${track.muted ? 'Unmute' : 'Mute'} ${track.name}`);
  };
  const trackLock = (track: TimelineTrack) => {
    const ops: TimelineOperation[] = [
      { op: 'update_track', trackId: track.id, locked: !track.locked },
    ];
    commitEdit(ops, `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`);
  };

  return (
    <section className={styles.timeline} aria-label="Timeline">
      <div ref={headers} className={styles.headers}>
        <div className={styles.corner} />
        {timeline.tracks.map((track) => (
          <div
            key={track.id}
            className={styles.trackHeader}
            data-track-type={track.type}
            data-header-track={track.type}
          >
            <span className={styles.trackName}>{track.name}</span>
            {track.type !== 'CAPTIONS' && (
              <button
                type="button"
                className={styles.toggle}
                data-active={track.muted}
                aria-pressed={track.muted}
                aria-label={`Mute ${track.name}`}
                onClick={() => trackVolumes(track)}
              >
                M
              </button>
            )}
            <button
              type="button"
              className={styles.toggle}
              data-active={track.locked}
              aria-pressed={track.locked}
              aria-label={`Lock ${track.name}`}
              onClick={() => trackLock(track)}
            >
              L
            </button>
          </div>
        ))}
      </div>
      <div
        ref={scroller}
        className={styles.scroller}
        data-testid="timeline-scroller"
        onWheel={onWheel}
        onScroll={(event) => {
          const { scrollLeft: left, scrollTop } = event.currentTarget;
          if (headers.current) headers.current.scrollTop = scrollTop;
          setView((current) => (current.left === left ? current : { ...current, left }));
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) selectClips([]);
        }}
      >
        <div className={styles.content} style={{ width: contentWidth }}>
          <div className={styles.ruler} data-testid="ruler" onPointerDown={seekFromPointer}>
            <Ruler pxPerSecond={pxPerSecond} fromPx={Math.max(0, fromPx)} toPx={toPx} />
          </div>
          {timeline.tracks.map((track) => {
            const clips = clipsInRange(track.clips, rangeFrom, rangeTo);
            const moveInto =
              gesture?.kind === 'move' &&
              gesture.targetTrackId === track.id &&
              gesture.clipIds.length === 1
                ? findClip(timeline, gesture.clipIds[0]!)
                : null;
            return (
              <div
                key={track.id}
                className={styles.row}
                data-track-type={track.type}
                data-testid={`track-${track.type}`}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) selectClips([]);
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) event.preventDefault();
                }}
                onDrop={(event) => dropMedia(event, track)}
              >
                {clips.map((clip) => {
                  const movingAway =
                    gesture?.kind === 'move' &&
                    gesture.clipIds.length === 1 &&
                    gesture.clipIds[0] === clip.id &&
                    gesture.targetTrackId !== track.id;
                  if (movingAway) return null;
                  let shown = clip;
                  if (gesture?.kind === 'trim' && gesture.clipId === clip.id) {
                    shown = { ...clip, start: gesture.op.start, duration: gesture.op.duration };
                  }
                  const inMove = gesture?.kind === 'move' && gesture.clipIds.includes(clip.id);
                  return (
                    <ClipView
                      key={clip.id}
                      clip={shown}
                      track={track}
                      label={clipLabel(clip, media)}
                      pxPerSecond={pxPerSecond}
                      selected={selected.has(clip.id)}
                      proposed={proposedClips.has(clip.id)}
                      deltaTicks={inMove ? gesture.deltaTicks : 0}
                      invalid={inMove ? !gesture.valid : false}
                      viewFromPx={chunkFrom}
                      viewToPx={chunkTo}
                      onPointerDown={handleClipPointer}
                    />
                  );
                })}
                {moveInto && moveInto.track.id !== track.id && gesture?.kind === 'move' && (
                  <ClipView
                    clip={moveInto.clip}
                    track={track}
                    label={clipLabel(moveInto.clip, media)}
                    pxPerSecond={pxPerSecond}
                    selected
                    proposed={false}
                    deltaTicks={gesture.deltaTicks}
                    invalid={!gesture.valid}
                    viewFromPx={chunkFrom}
                    viewToPx={chunkTo}
                    onPointerDown={handleClipPointer}
                  />
                )}
              </div>
            );
          })}
          <div ref={playhead} className={styles.playhead} data-testid="playhead" />
        </div>
      </div>
    </section>
  );
}

const RULER_HEIGHT = 24;
